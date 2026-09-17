const BASE_SCAN_URL =
  (typeof process !== "undefined" && process.env?.SCAN_V41_URL) ||
  "https://ybit-market-api.vercel.app/api/scan";

const VERSION = "OI-RADAR-V4.2";

const TRADFI_SYMBOLS = new Set([
  // 已有
  "SOFIUSDT",
  "NBISUSDT",
  "NVDAUSDT",
  "HOODUSDT",
  "SNDKUSDT",
  "SKHYUSDT",
  "AVGOUSDT",
  "CRWVUSDT",
  "BEUSDT",
  "BMNRUSDT",
  "UVXYUSDT",

  // 这次漏掉的
  "CRWDUSDT",
  "SPCHUSDT",

  // Bybit 官方明确列出的 TradFi perpetual
  "CBRSUSDT",
  "ONDSUSDT",
  "SMCIUSDT",
  "PURRUSDT",
  "MSTRUSDT",
  "RKLBUSDT",
  "QNTXUSDT",
  "STXXUSDT",
  "OPENAIUSDT",
  "COINUSDT",
  "FLNCUSDT",
  "HPEUSDT",
  "ANTHROPICUSDT",
  "CRCLUSDT",
  "COHRUSDT",
  "ALABUSDT",
  "AEHRUSDT",
  "LITEUSDT",
  "ASTSUSDT",
  "AXTIUSDT",
  "CIENUSDT",
  "BNCUSDT",
  "NOKIAUSDT",
  "BBXUSDT",
  "ADBEUSDT",
  "POETUSDT",
  "AAOIUSDT",
  "CRDOUSDT",
  "MVLLUSDT",
  "RDWUSDT",
  "DRAMUSDT",
  "IRENUSDT",
  "USARUSDT",
  "HIMSUSDT",
  "FWDIUSDT",

  // Bybit 官方教程里明确作为股票/ETF perpetual 示例
  "TSLAUSDT",
  "GOOGLUSDT",
  "MUUSDT",
  "SOXLUSDT",
  "KORUUSDT",
  "SAMSUNGUSDT",
  "SKHYNIXUSDT",
  "HYUNDAIUSDT",
]);

const round = (value, decimals = 1) =>
  Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;

function marketClassification(symbol = "") {
  const upper = String(symbol).toUpperCase();
  const isTradFi = upper.endsWith("STOCKUSDT") || TRADFI_SYMBOLS.has(upper);
  return isTradFi
    ? { marketType: "TRADFI_PERP", riskTag: "TRADFI_EVENT_SENSITIVE" }
    : { marketType: "CRYPTO_PERP", riskTag: null };
}

function crossExchangeSummary(row, direction) {
  const x = row.crossExchange;
  if (!x || x.status !== "ok") {
    return { status: x?.status || "unavailable", confirmation: "LOCAL_ONLY", scoreAdjustment: -4 };
  }

  const h1 = Number(x.oi1hPct);
  const m15 = Number(x.oi15mPct);
  const m5 = Number(x.oi5mPct);
  const bybitShare = Number(x.bybitOiSharePct);
  let confirmation = "MIXED";
  let scoreAdjustment = 0;

  if (direction === "LONG") {
    if (h1 > 0 && m15 > 0) {
      confirmation = "CONFIRMED";
      scoreAdjustment += 10;
      if (m5 > 0) scoreAdjustment += 3;
    } else if (h1 < 0 || m15 < -0.5) {
      scoreAdjustment -= 10;
    }
  } else {
    // For shorts, rising aggregate OI confirms fresh positioning; falling OI is weaker/deleveraging.
    if (h1 > 0 && m15 > 0) {
      confirmation = "CONFIRMED";
      scoreAdjustment += 10;
      if (m5 > 0) scoreAdjustment += 3;
    } else if (h1 < 0 || m15 < -0.5) {
      scoreAdjustment -= 10;
    }
  }

  if (Number.isFinite(bybitShare) && bybitShare > 70) scoreAdjustment -= 3;

  return {
    status: "ok",
    confirmation,
    scoreAdjustment,
    oi5mPct: Number.isFinite(m5) ? m5 : null,
    oi15mPct: Number.isFinite(m15) ? m15 : null,
    oi1hPct: Number.isFinite(h1) ? h1 : null,
    bybitOiSharePct: Number.isFinite(bybitShare) ? bybitShare : null,
    aggregatedFundingPct: Number.isFinite(Number(x.aggregatedFundingPct))
      ? Number(x.aggregatedFundingPct)
      : null,
  };
}

function latestFlowCounts(row) {
  const steps = Array.isArray(row.flow5m?.recentSteps) ? row.flow5m.recentSteps.slice(-6) : [];
  return {
    longBuild: steps.filter(x => x.state === "LONG_BUILD").length,
    shortBuild: steps.filter(x => x.state === "SHORT_BUILD").length,
    deleveraging: steps.filter(x => x.state === "DELEVERAGING").length,
    shortCovering: steps.filter(x => x.state === "SHORT_COVERING").length,
  };
}

function longPersistence(row) {
  const o15 = row.oi15mPct ?? 0;
  const o30 = row.oi30mPct ?? 0;
  const o1 = row.oi1hPct ?? 0;
  const latest = row.latestOiStep ?? o15;
  const maxStep = Math.max(row.maxPositiveOiStep ?? 0, 0.01);
  const p5 = row.price5mPct ?? 0;
  const p15 = row.price15mPct ?? 0;
  const p1 = row.price1hPct ?? 0;
  const retention = row.oiHighRetention ?? 0;
  const structure = row.priceStructure || {};
  const flow = latestFlowCounts(row);

  const oiContinuation = o15 >= 0.3 && latest > 0 &&
    (latest >= Math.min(0.5, maxStep * 0.35) || (row.consecutivePositive ?? 0) >= 2);
  const priceContinuation = structure.supportHeld === true || structure.keyLevelReclaimed === true ||
    (p15 >= 0 && p1 >= 0 && (row.flow5m?.recentPrice30mPct ?? 0) >= 0);

  let score = 0;
  score += Math.min(Math.max(o1, 0) * 2.5, 15);
  score += Math.min(Math.max(o30, 0) * 2, 10);
  score += oiContinuation ? 20 : (o15 > 0 ? 8 : -15);
  score += Math.min((row.buildQuality ?? 0) * 0.12, 12);
  score += (row.consecutivePositive ?? 0) >= 3 ? 8 : 0;
  score += retention >= 0.97 ? 8 : retention >= 0.94 ? 3 : -8;
  score += priceContinuation ? 14 : -6;
  score += flow.longBuild >= 2 ? 8 : flow.shortBuild >= 2 ? -8 : 0;
  score += p5 > 0 && o15 > 0 ? 3 : 0;

  if (!oiContinuation && !priceContinuation) score -= 18;
  if (latest <= 0 || o15 <= 0) score -= 10;
  if ((row.flow5m?.recentOi30mPct ?? 0) < -0.5) score -= 10;

  return { score, oiContinuation, priceContinuation };
}

function shortPersistence(row) {
  const o15 = row.oi15mPct ?? 0;
  const o30 = row.oi30mPct ?? 0;
  const o1 = row.oi1hPct ?? 0;
  const p5 = row.price5mPct ?? 0;
  const p15 = row.price15mPct ?? 0;
  const p1 = row.price1hPct ?? 0;
  const retention = row.oiHighRetention ?? 0;
  const structure = row.priceStructure || {};
  const flow = latestFlowCounts(row);
  const recentOi = row.flow5m?.recentOi30mPct ?? 0;
  const recentPrice = row.flow5m?.recentPrice30mPct ?? 0;

  const directContinuation = o15 >= 0.3 && o30 > 0 && o1 > 0;
  const reboundWithRetention = p5 > 0 && retention >= 0.97 && recentOi >= -0.2 &&
    (flow.shortBuild >= 2 || recentPrice < 0);
  const persistence = directContinuation || reboundWithRetention;

  let score = 0;
  score += p1 < 0 ? Math.min(Math.abs(p1) * 3, 18) : -8;
  score += p15 < 0 ? Math.min(Math.abs(p15) * 4, 14) : 0;
  score += Math.min(Math.max(o1, 0) * 2.2, 16);
  score += Math.min(Math.max(o30, 0) * 2, 10);
  score += persistence ? 20 : -18;
  score += retention >= 0.97 ? 8 : retention >= 0.94 ? 3 : -8;
  score += recentPrice < 0 && recentOi > 0 ? 10 : 0;
  score += flow.shortBuild >= 3 ? 10 : flow.shortBuild >= 2 ? 6 : 0;
  score += structure.lowerLows === true ? 10 : 0;

  if (o15 <= 0 && !reboundWithRetention) score -= 15;
  if (recentOi < -0.5) score -= 12;
  if (flow.deleveraging >= 2) score -= 10;

  return { score, persistence, directContinuation, reboundWithRetention };
}

function candidateState(row, direction, score, persistent) {
  if (!persistent || score < 52) return "WATCH";
  const p5 = row.price5mPct ?? 0;
  const o15 = row.oi15mPct ?? 0;

  if (direction === "LONG") {
    if (score >= 72 && p5 >= 0.1 && o15 >= 0.3) return "ENTRY_NOW";
    if (score >= 62 && (p5 < 0.1 || row.priceStructure?.supportHeld || row.priceStructure?.keyLevelReclaimed))
      return "RETEST_ENTRY";
    return "PRE_ENTRY";
  }

  if (score >= 72 && p5 <= -0.1 && o15 >= 0.3) return "ENTRY_NOW";
  if (score >= 62 && p5 > -0.1) return "RETEST_ENTRY";
  return "PRE_ENTRY";
}

function reasonFor(row, direction, persistent, xsum) {
  const bits = [];
  if (direction === "LONG") {
    if (persistent.oiContinuation) bits.push("最新15M OI继续增仓");
    if (persistent.priceContinuation) bits.push("价格结构仍在守位/抬高");
    if ((row.flow5m?.recentPrice30mPct ?? 0) > 0 && (row.flow5m?.recentOi30mPct ?? 0) > 0)
      bits.push("近30M Price↑+OI↑");
  } else {
    if (persistent.directContinuation) bits.push("15M/30M/1H OI延续且价格走弱");
    if (persistent.reboundWithRetention) bits.push("反抽时OI仍高保留");
    if ((row.flow5m?.recentPrice30mPct ?? 0) < 0 && (row.flow5m?.recentOi30mPct ?? 0) > 0)
      bits.push("近30M Price↓+OI↑");
    if (row.priceStructure?.lowerLows) bits.push("持续lower lows");
  }
  if (xsum.confirmation === "CONFIRMED") bits.push("跨所OI延续确认");
  else if (xsum.confirmation === "MIXED") bits.push("跨所信号混合");
  else bits.push("跨所未确认");
  return bits.join("；") || "结构尚未形成持续性优势";
}

function evaluateCandidate(row, direction) {
  const market = marketClassification(row.symbol);
  const persistent = direction === "LONG" ? longPersistence(row) : shortPersistence(row);
  const xsum = crossExchangeSummary(row, direction);
  let score = persistent.score + xsum.scoreAdjustment;

  if (row.executionRisk === "EXTENDED") score -= 25;
  if (market.marketType === "TRADFI_PERP") score -= 12;

  const persistenceOk = direction === "LONG"
    ? (persistent.oiContinuation || persistent.priceContinuation)
    : persistent.persistence;
  const state = candidateState(row, direction, score, persistenceOk);

  return {
    symbol: row.symbol,
    direction,
    candidateState: state,
    candidateQuality: round(Math.max(0, Math.min(100, score)), 1),
    persistenceScore: round(Math.max(0, Math.min(100, persistent.score)), 1),
    reason: reasonFor(row, direction, persistent, xsum),
    marketType: market.marketType,
    riskTag: market.riskTag,
    keyMetrics: {
      price: row.price ?? null,
      price5mPct: row.price5mPct ?? null,
      price15mPct: row.price15mPct ?? null,
      price1hPct: row.price1hPct ?? null,
      oi15mPct: row.oi15mPct ?? null,
      oi30mPct: row.oi30mPct ?? null,
      oi1hPct: row.oi1hPct ?? null,
      oi2hPct: row.oi2hPct ?? null,
      latestOiStep: row.latestOiStep ?? null,
      oiHighRetention: row.oiHighRetention ?? null,
      fundingPct: row.fundingPct ?? null,
      support: row.priceStructure?.support ?? null,
      recentLow: row.priceStructure?.recentLow ?? null,
      keyLevel: row.priceStructure?.keyLevel ?? null,
    },
    crossExchangeSummary: xsum,
    executionRisk: row.executionRisk || market.riskTag || null,
    sourceExecutionState: row.executionState,
  };
}

function isLongEligible(row) {
  if (["PRICE_REFUSAL", "REBUILD", "CORRELATION_FLIP"].includes(row.executionState)) return true;
  if (row.executionState !== "POSITION_BUILD") return false;
  return (row.price1hPct ?? 0) >= -0.5 &&
    (row.oi30mPct ?? 0) > 0 && (row.oi1hPct ?? 0) > 0 &&
    ((row.flow5m?.recentPrice30mPct ?? 0) >= 0 || row.priceStructure?.supportHeld || row.priceStructure?.keyLevelReclaimed);
}

function isShortEligible(row) {
  return ["SHORT_BUILD", "SHORT_CONTROL"].includes(row.executionState);
}

function buildCandidateLists(base) {
  const crossBySymbol = new Map(
    (base.candidates || []).map(row => [row.symbol, row.crossExchange])
  );

  const rows = (base.executionStates || []).map(row => ({
    ...row,
    crossExchange:
      row.crossExchange ||
      crossBySymbol.get(row.symbol),
  }));

  const evaluatedLongs = rows
    .filter(isLongEligible)
    .map(row => evaluateCandidate(row, "LONG"))
    .filter(x => x.candidateState !== "WATCH");

  const evaluatedShorts = rows
    .filter(isShortEligible)
    .map(row => evaluateCandidate(row, "SHORT"))
    .filter(x => x.candidateState !== "WATCH");

  const longCandidates = evaluatedLongs
    .filter(x => x.marketType === "CRYPTO_PERP")
    .sort((a, b) => b.candidateQuality - a.candidateQuality)
    .slice(0, 3);

  const shortCandidates = evaluatedShorts
    .filter(x => x.marketType === "CRYPTO_PERP")
    .sort((a, b) => b.candidateQuality - a.candidateQuality)
    .slice(0, 3);

  const tradFiLongCandidates = evaluatedLongs
    .filter(x => x.marketType === "TRADFI_PERP")
    .sort((a, b) => b.candidateQuality - a.candidateQuality)
    .slice(0, 3);

  const tradFiShortCandidates = evaluatedShorts
    .filter(x => x.marketType === "TRADFI_PERP")
    .sort((a, b) => b.candidateQuality - a.candidateQuality)
    .slice(0, 3);

  return {
    longCandidates,
    shortCandidates,
    tradFiLongCandidates,
    tradFiShortCandidates,
  };
}

export default async function handler(req, res) {
  try {
    const response = await fetch(BASE_SCAN_URL, {
      headers: { Accept: "application/json", "User-Agent": "Bybit-OI-Radar/4.2" },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`V4.1 upstream HTTP ${response.status}: ${text.slice(0, 160)}`);
    const base = JSON.parse(text);
    const lists = buildCandidateLists(base);

    return res.status(200).json({
      ...base,
      version: VERSION,
      executionRules: {
        ...(base.executionRules || {}),
        version: VERSION,
        candidatePersistence: {
          principle: "Past structure -> latest 15M continuation -> cross-exchange continuation -> R:R",
          longNeedsLatestOiOrPriceStructure: true,
          shortNeedsLatestOiOrRetainedRebound: true,
          tradFiPerpsSeparated: true,
        },
      },
      scoreMeaning: "V4.2 candidateQuality ranks persistence/tradeability; legacy score remains radar attention only.",
      ...lists,
    });
  } catch (error) {
    return res.status(500).json({ status: "error", version: VERSION, message: error.message });
  }
}

export { marketClassification, crossExchangeSummary, evaluateCandidate, buildCandidateLists };
