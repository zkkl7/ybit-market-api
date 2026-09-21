import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LATEST_PATH = path.join(ROOT, "data", "latest.json");
const HISTORY_PATH = path.join(ROOT, "data", "history.json");

const MAX_SNAPSHOTS = 8;

const clamp = (n, min = 0, max = 100) =>
  Math.max(min, Math.min(max, n));

const round = (n, d = 1) =>
  Number.isFinite(n) ? Number(n.toFixed(d)) : null;

function classifyRunner(candidate) {
  const numeric = value => value == null || value === "" ? NaN : Number(value);
  const reasons = [];
  const riskFlags = Array.isArray(candidate.timingRiskFlags)
    ? candidate.timingRiskFlags
    : [];
  const direction = String(candidate.direction || "").toUpperCase();
  const entrySignal = candidate.entrySignal ?? "WAIT";
  const finalScore = numeric(candidate.finalCandidateScore ?? candidate.candidateQuality);
  const confirmation = candidate.crossExchangeSummary?.confirmation;
  const metrics = candidate.keyMetrics || {};
  const oi30 = numeric(metrics.oi30mPct);
  const oi1h = numeric(metrics.oi1hPct);
  const price1h = numeric(metrics.price1hPct);
  const price24h = numeric(metrics.price24hPct);
  let score = 0;

  if (Number.isFinite(finalScore) && finalScore >= 80) {
    score += 25;
    reasons.push("FINAL_SCORE_80_PLUS");
  } else if (Number.isFinite(finalScore) && finalScore >= 70) {
    score += 15;
    reasons.push("FINAL_SCORE_70_PLUS");
  }
  if (riskFlags.length === 0) {
    score += 15;
    reasons.push("NO_TIMING_RISK_FLAGS");
  }
  if (confirmation === "CONFIRMED") {
    score += 15;
    reasons.push("CROSS_CONFIRMED");
  } else if (confirmation === "LOCAL_ONLY") {
    score -= 10;
    reasons.push("LOCAL_ONLY");
  }
  if (entrySignal === "RETEST_ENTRY") {
    score += 10;
    reasons.push("RETEST_ENTRY");
  } else if (entrySignal === "EARLY_ENTRY") {
    score += 12;
    reasons.push("EARLY_ENTRY");
  }
  if (Number.isFinite(oi30) && oi30 >= 2) {
    score += 10;
    reasons.push("OI_30M_STRONG");
  }
  if (Number.isFinite(oi1h) && oi1h >= 3) {
    score += 10;
    reasons.push("OI_1H_STRONG");
  }
  if (Number.isFinite(oi30) && Number.isFinite(oi1h) && oi30 > 0 && oi1h > 0) {
    score += 5;
    reasons.push("OI_BUILD_CONTINUING");
  }
  if (
    Number.isFinite(price1h) && Math.abs(price1h) <= 3 &&
    ((direction === "LONG" && price1h >= 0) ||
      (direction === "SHORT" && price1h <= 0))
  ) {
    score += 10;
    reasons.push("PRICE_1H_DIRECTIONAL_HEALTHY");
  }
  if (riskFlags.includes("SETUP_WEAK")) {
    score -= 20;
    reasons.push("SETUP_WEAK");
  }
  if (riskFlags.some(flag => ["PRICE_WARM", "PRICE_15M_WARM"].includes(flag))) {
    score -= 15;
    reasons.push("PRICE_WARM");
  }
  if (riskFlags.includes("24H_EXTENDED")) {
    score -= 20;
    reasons.push("PRICE_24H_EXTENDED");
  }
  if (Number.isFinite(price1h) && Math.abs(price1h) > 5) {
    score -= 15;
    reasons.push("PRICE_1H_OVER_5");
  }
  if (Number.isFinite(price24h) && Math.abs(price24h) > 25) {
    score -= 15;
    reasons.push("PRICE_24H_OVER_25");
  }
  if (riskFlags.some(flag => [
    "EXTREME_LONG_FUNDING", "EXTREME_SHORT_FUNDING",
    "LONG_FUNDING_CROWDED", "SHORT_FUNDING_CROWDED",
  ].includes(flag))) {
    score -= 15;
    reasons.push("FUNDING_CROWDED");
  }

  score = round(clamp(score), 1);
  const obviousRiskCount = [
    riskFlags.includes("SETUP_WEAK"),
    riskFlags.some(flag => ["PRICE_WARM", "PRICE_15M_WARM", "PRICE_1H_EXTENDED", "PRICE_15M_EXTENDED"].includes(flag)),
    riskFlags.some(flag => ["24H_EXTENDED", "SOURCE_EXTENDED"].includes(flag)),
  ].filter(Boolean).length;
  let tradeStyle = score >= 55 ? "RUNNER" : "SCALP";
  if (entrySignal === "NO_CHASE" || obviousRiskCount >= 2) {
    tradeStyle = "WATCH";
    reasons.push(entrySignal === "NO_CHASE" ? "NO_CHASE" : "MULTIPLE_TIMING_RISKS");
  }

  return {
    tradeStyle,
    runnerPotential: score >= 70 ? "HIGH" : score >= 55 ? "MEDIUM" : "LOW",
    runnerScore: score,
    runnerReasons: [...new Set(reasons)],
  };
}

function classifyV45Runner(candidate, legacyRunner) {
  let v45RunnerPotential = legacyRunner.runnerPotential;
  const reasons = [];
  const neutralPositionBuild = candidate.sourceExecutionState === "POSITION_BUILD" &&
    candidate.sourceDirectionalBias === "NEUTRAL";
  const directionalConfirmation = candidate.strictPriceReclaim || candidate.strongAlignedFlow;

  if (candidate.adverseOiFlowPrice || candidate.strongOpposingFlow) {
    v45RunnerPotential = "LOW";
    reasons.push(candidate.adverseOiFlowPrice
      ? "OI_UP_CVD_AND_PRICE_AGAINST_DIRECTION"
      : "CVD_AND_ORDER_FLOW_OPPOSE_DIRECTION");
  } else if (candidate.entryStage !== "CONFIRMED" && v45RunnerPotential === "HIGH") {
    v45RunnerPotential = "MEDIUM";
    reasons.push("ENTRY_STAGE_PROBE");
  } else if (candidate.executionTier === "MIXED" && v45RunnerPotential === "HIGH") {
    v45RunnerPotential = "MEDIUM";
    reasons.push("EXECUTION_TIER_MIXED");
  }
  if (neutralPositionBuild && !directionalConfirmation && v45RunnerPotential === "HIGH") {
    v45RunnerPotential = "MEDIUM";
    reasons.push("POSITION_BUILD_NEUTRAL_UNCONFIRMED");
  }

  return { v45RunnerPotential, v45RunnerReasons: reasons };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function stateRank(state) {
  switch (state) {
    case "ENTRY_NOW":
      return 3;
    case "RETEST_ENTRY":
      return 2;
    case "PRE_ENTRY":
      return 1;
    case "WATCH":
      return 0;
    default:
      return 1;
  }
}

function compactCandidate(c) {
  return {
    symbol: c.symbol,
    direction: c.direction,
    candidateState: c.candidateState,
    candidateQuality: c.candidateQuality,
    finalCandidateScore:
      c.finalCandidateScore ?? c.candidateQuality,

    entrySignal: c.entrySignal ?? null,
    timingScore: c.timingScore ?? null,
    timingRiskFlags: c.timingRiskFlags ?? [],

    entryStage: c.entryStage ?? null,
    executionTier: c.executionTier ?? null,
    v45EntrySignal: c.v45EntrySignal ?? null,
    priceConfirmScore: c.priceConfirmScore ?? null,
    executionScore: c.executionScore ?? c.directionConfidence ?? null,
    strictReclaim: c.strictPriceReclaim ?? null,
    nearReclaim: c.nearReclaim ?? null,
    microPersistence: c.microPersistence ?? null,
    cvdBias: c.cvdBias ?? null,
    orderFlowBias: c.orderFlowBias ?? null,
    micropriceBias: c.micropriceBias ?? null,
    obiScore: c.obiScore ?? null,
    invalidationReason: c.invalidationReason ?? null,
    v46RiskFlags: c.v46RiskFlags ?? c.v45RiskFlags ?? [],
    v45RunnerPotential: c.v45RunnerPotential ?? null,
    v45DataFreshness: c.v45DataFreshness ?? null,

    price: c.keyMetrics?.price ?? null,

    oi15mPct: c.keyMetrics?.oi15mPct ?? null,
    oi30mPct: c.keyMetrics?.oi30mPct ?? null,
    oi1hPct: c.keyMetrics?.oi1hPct ?? null,

    crossConfirmation:
      c.crossExchangeSummary?.confirmation ?? null,

    marketType: c.marketType ?? null,
  };
}

function findCandidate(snapshot, symbol) {
  return snapshot?.candidates?.find(
    c => c.symbol === symbol
  ) ?? null;
}

function calculateHistory(candidate, snapshots) {
  const previous = [...snapshots].slice(-2).reverse();

  const prev1 = findCandidate(previous[0], candidate.symbol);
  const prev2 = findCandidate(previous[1], candidate.symbol);

  const currentQuality =
    Number(candidate.candidateQuality) || 0;

  const prev1Quality =
    prev1?.candidateQuality ?? 50;

  const prev2Quality =
    prev2?.candidateQuality ?? 50;

  /*
   * 历史质量基础分：
   * 当前 50%
   * 上一轮 30%
   * 上两轮 20%
   *
   * 新候选不会直接被打死，
   * 缺失轮次用中性 50 分。
   */
  let historyScore =
    currentQuality * 0.5 +
    prev1Quality * 0.3 +
    prev2Quality * 0.2;

  let seenInLast3 = 1;

  if (
    prev1 &&
    prev1.direction === candidate.direction
  ) {
    seenInLast3++;
    historyScore += 8;
  }

  if (
    prev2 &&
    prev2.direction === candidate.direction
  ) {
    seenInLast3++;
    historyScore += 5;
  }

  /*
   * 方向突然反转属于高风险。
   */
  if (
    prev1 &&
    prev1.direction !== candidate.direction
  ) {
    historyScore -= 20;
  }

  /*
   * 上轮消失、这轮重新出现：
   * 不直接否定，但认为连续性较差。
   */
  if (!prev1 && prev2) {
    historyScore -= 8;
  }

  const currentOi15 =
    candidate.keyMetrics?.oi15mPct ?? null;

  const currentOi30 =
    candidate.keyMetrics?.oi30mPct ?? null;

  /*
   * Long/Short 都需要 fresh positioning，
   * 因此 OI 连续为正都属于加分。
   */
  if (
    prev1 &&
    currentOi15 > 0 &&
    prev1.oi15mPct > 0
  ) {
    historyScore += 5;
  }

  if (
    prev1 &&
    currentOi30 > 0 &&
    prev1.oi30mPct > 0
  ) {
    historyScore += 4;
  }

  /*
   * OI 开始明显泄漏。
   */
  if (currentOi15 < -0.5) {
    historyScore -= 12;
  }

  if (currentOi30 < -1) {
    historyScore -= 10;
  }

  /*
   * 状态轨迹。
   */
  if (prev1) {
    const nowRank = stateRank(candidate.candidateState);
    const oldRank = stateRank(prev1.candidateState);

    if (nowRank > oldRank) {
      historyScore += 5;
    } else if (nowRank === oldRank) {
      historyScore += 2;
    } else {
      historyScore -= 8;
    }
  }

  /*
   * candidateQuality 自身趋势。
   */
  let historyTrend = "NEW";

  if (prev1) {
    const delta1 =
      currentQuality - prev1.candidateQuality;

    if (prev2) {
      const delta2 =
        prev1.candidateQuality -
        prev2.candidateQuality;

      if (delta1 >= 0 && delta2 >= 0) {
        historyTrend = "STABLE_UP";
      } else if (
        delta1 <= -8 &&
        delta2 <= 0
      ) {
        historyTrend = "WEAKENING";
      } else {
        historyTrend = "STABLE";
      }
    } else {
      if (delta1 >= 5) {
        historyTrend = "IMPROVING";
      } else if (delta1 <= -8) {
        historyTrend = "WEAKENING";
      } else {
        historyTrend = "STABLE";
      }
    }
  } else if (prev2) {
    historyTrend = "REAPPEARED";
  }

  historyScore = clamp(historyScore);

  /*
   * 当前结构仍占主要权重。
   * 历史不会完全压过当前市场变化。
   */
  const finalCandidateScore =
    currentQuality * 0.65 +
    historyScore * 0.35;

  return {
    historyStabilityScore:
      round(historyScore, 1),

    finalCandidateScore:
      round(finalCandidateScore, 1),

    historyTrend,

    seenInLast3,

    previousCandidateQuality:
      prev1?.candidateQuality ?? null,

    twoSnapshotsAgoCandidateQuality:
      prev2?.candidateQuality ?? null,
  };
}

function enrichPool(pool, snapshots, includeRunner = false) {
  return (pool || [])
    .map(candidate => {
      const enriched = {
        ...candidate,
        ...calculateHistory(candidate, snapshots),
      };
      if (!includeRunner) return enriched;
      const legacyRunner = classifyRunner(enriched);
      return {
        ...enriched,
        ...legacyRunner,
        ...classifyV45Runner(enriched, legacyRunner),
      };
    })
    .sort(
      (a, b) =>
        (b.finalCandidateScore ?? 0) -
        (a.finalCandidateScore ?? 0)
    );
}

const latest = readJson(LATEST_PATH, null);

if (!latest?.radar) {
  throw new Error(
    "data/latest.json is missing or invalid"
  );
}

const history = readJson(HISTORY_PATH, {
  version: "RADAR-HISTORY-V1",
  snapshots: [],
});

const snapshots = Array.isArray(history.snapshots)
  ? history.snapshots
  : [];

const radar = latest.radar;

/*
 * 优先使用 Top10 pool。
 * 如果 Vercel 还没部署新代码，
 * 暂时兼容旧的 Top3 数组。
 */
const longPool =
  radar.longCandidatePool ??
  radar.longCandidates ??
  [];

const shortPool =
  radar.shortCandidatePool ??
  radar.shortCandidates ??
  [];

const tradFiLongPool =
  radar.tradFiLongCandidatePool ??
  radar.tradFiLongCandidates ??
  [];

const tradFiShortPool =
  radar.tradFiShortCandidatePool ??
  radar.tradFiShortCandidates ??
  [];

const enrichedLong =
  enrichPool(longPool, snapshots, true);

const enrichedShort =
  enrichPool(shortPool, snapshots, true);

const enrichedTradFiLong =
  enrichPool(tradFiLongPool, snapshots);

const enrichedTradFiShort =
  enrichPool(tradFiShortPool, snapshots);

/*
 * Top10 pool 也保留历史评分，
 * 方便之后排查为什么某币没进前三。
 */
radar.longCandidatePool = enrichedLong;
radar.shortCandidatePool = enrichedShort;

radar.tradFiLongCandidatePool =
  enrichedTradFiLong;

radar.tradFiShortCandidatePool =
  enrichedTradFiShort;

/*
 * 最终执行候选按 finalCandidateScore 取前三。
 */
radar.longCandidates =
  enrichedLong.slice(0, 3);

radar.shortCandidates =
  enrichedShort.slice(0, 3);

const syncEntryRunnerFields = (entries, enrichedPool) =>
  (entries || []).map(entry => {
    const enriched = enrichedPool.find(candidate =>
      candidate.symbol === entry.symbol && candidate.direction === entry.direction
    );
    if (!enriched) return entry;
    const {
      finalCandidateScore, tradeStyle, runnerPotential, runnerScore, runnerReasons,
      entryStage, executionTier, v45EntryStage, v45EntrySignal, v45Confirmation,
      priceConfirmScore, takerBuyVolume, takerSellVolume, buySellImbalance,
      cvd1m, cvd3m, cvd5m, cvdBias, orderFlowBias,
      obiScore, obiTop10, obiTop20, orderBookBias,
      executionScore, strictPriceReclaim, nearReclaim, microPersistence,
      micropriceBias, directionConfidence, invalidationReason, v45RiskFlags, v46RiskFlags,
      v45RunnerPotential, v45RunnerReasons, v45DataFreshness,
    } = enriched;
    return {
      ...entry,
      finalCandidateScore,
      tradeStyle,
      runnerPotential,
      runnerScore,
      runnerReasons,
      entryStage,
      executionTier,
      v45EntryStage,
      v45EntrySignal,
      v45Confirmation,
      priceConfirmScore,
      executionScore,
      strictPriceReclaim,
      nearReclaim,
      microPersistence,
      takerBuyVolume,
      takerSellVolume,
      buySellImbalance,
      cvd1m,
      cvd3m,
      cvd5m,
      cvdBias,
      orderFlowBias,
      obiScore,
      obiTop10,
      obiTop20,
      orderBookBias,
      micropriceBias,
      directionConfidence,
      invalidationReason,
      v45RiskFlags,
      v46RiskFlags,
      v45RunnerPotential,
      v45RunnerReasons,
      v45DataFreshness,
    };
  });

radar.longEntryCandidates = syncEntryRunnerFields(
  radar.longEntryCandidates,
  enrichedLong
);
radar.shortEntryCandidates = syncEntryRunnerFields(
  radar.shortEntryCandidates,
  enrichedShort
);

radar.tradFiLongCandidates =
  enrichedTradFiLong.slice(0, 3);

radar.tradFiShortCandidates =
  enrichedTradFiShort.slice(0, 3);

const v45Pools = [...enrichedLong, ...enrichedShort];
const executableSignals = new Set(["EARLY_ENTRY", "BREAKOUT_ENTRY", "RETEST_ENTRY"]);
const compactV45Ab = candidate => ({
  symbol: candidate.symbol,
  direction: candidate.direction,
  oldEntrySignal: candidate.entrySignal,
  oldRunnerPotential: candidate.runnerPotential ?? null,
  v45EntryStage: candidate.v45EntryStage,
  v45RunnerPotential: candidate.v45RunnerPotential ?? null,
  directionConfidence: candidate.directionConfidence,
  invalidationReason: candidate.invalidationReason,
});
radar.v45AbSummary = {
  oldEntryCount: v45Pools.filter(candidate => executableSignals.has(candidate.entrySignal)).length,
  confirmedCount: v45Pools.filter(candidate => candidate.entryStage === "CONFIRMED").length,
  probeCount: v45Pools.filter(candidate => candidate.entryStage === "PROBE").length,
  oldEntriesNowProbe: v45Pools.filter(candidate =>
    executableSignals.has(candidate.entrySignal) && candidate.entryStage === "PROBE"
  ).map(compactV45Ab),
  oldHighNowDowngraded: v45Pools.filter(candidate =>
    candidate.runnerPotential === "HIGH" && candidate.v45RunnerPotential !== "HIGH"
  ).map(compactV45Ab),
};

radar.historyRanking = {
  version: "V4.3-HISTORY-1",
  snapshotWindow: 3,
  retainedSnapshots: MAX_SNAPSHOTS,
  currentWeight: 0.65,
  historyWeight: 0.35,
  principle:
    "Current setup quality + multi-snapshot persistence",
};

/*
 * 写回 latest.json
 */
fs.writeFileSync(
  LATEST_PATH,
  JSON.stringify(latest, null, 2) + "\n"
);

/*
 * 当前轮只记录候选池中的标的。
 * 去重 symbol，避免 long/short 异常重复。
 */
const combined = [
  ...enrichedLong,
  ...enrichedShort,
  ...enrichedTradFiLong,
  ...enrichedTradFiShort,
];

const unique = [];
const seen = new Set();

for (const candidate of combined) {
  const key = `${candidate.symbol}:${candidate.direction}`;

  if (seen.has(key)) continue;

  seen.add(key);
  unique.push(compactCandidate(candidate));
}

const currentSnapshot = {
  fetchedAt:
    latest.snapshot?.fetchedAt ??
    new Date().toISOString(),

  scannedAt:
    radar.scannedAt ?? null,

  candidates: unique,
};

/*
 * 防止手动重复跑同一个快照。
 */
const withoutDuplicate = snapshots.filter(
  s => s.fetchedAt !== currentSnapshot.fetchedAt
);

const nextSnapshots = [
  ...withoutDuplicate,
  currentSnapshot,
].slice(-MAX_SNAPSHOTS);

const nextHistory = {
  version: "RADAR-HISTORY-V1",
  updatedAt: new Date().toISOString(),
  snapshots: nextSnapshots,
};

fs.writeFileSync(
  HISTORY_PATH,
  JSON.stringify(nextHistory, null, 2) + "\n"
);

console.log(
  `History enrichment complete. snapshots=${nextSnapshots.length}`
);

console.log(
  "Crypto longs:",
  radar.longCandidates.map(c => ({
    symbol: c.symbol,
    quality: c.candidateQuality,
    history: c.historyStabilityScore,
    final: c.finalCandidateScore,
    trend: c.historyTrend,
    seen: c.seenInLast3,
  }))
);

console.log(
  "Crypto shorts:",
  radar.shortCandidates.map(c => ({
    symbol: c.symbol,
    quality: c.candidateQuality,
    history: c.historyStabilityScore,
    final: c.finalCandidateScore,
    trend: c.historyTrend,
    seen: c.seenInLast3,
  }))
);
