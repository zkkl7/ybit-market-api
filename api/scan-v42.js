const BASE_SCAN_URL =
  (typeof process !== "undefined" && process.env?.SCAN_V41_URL) ||
  "https://ybit-market-api.vercel.app/api/scan";

const BYBIT_BASE = "https://api.bybit.com";
const VERSION = "OI-RADAR-V4.5";
const V45_MAX_MICROSTRUCTURE_SYMBOLS = 12;
const V45_FETCH_CONCURRENCY = 4;
const V45_FETCH_TIMEOUT_MS = 2500;

const TRADFI_SYMBOLS = new Set([
  // 已有
  "AAPLUSDT",
  "SOXSUSDT",
  "METAUSDT",
  "MSFTUSDT",
  "MRVLUSDT",
  "SOFIUSDT",
  "QQQUSDT",
  "ARMUSDT",
  "MSTUUSDT",
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

const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

const numeric = value =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? null
    : Number(value);

function classifyCvdBias(windows) {
  const values = [windows.cvd1m, windows.cvd3m, windows.cvd5m]
    .filter(Number.isFinite);
  if (values.length < 2) return "UNAVAILABLE";
  const positive = values.filter(value => value > 0).length;
  const negative = values.filter(value => value < 0).length;
  if (positive >= 2) return "BULLISH";
  if (negative >= 2) return "BEARISH";
  return "NEUTRAL";
}

function parseRecentTrades(list, nowMs = Date.now()) {
  const trades = Array.isArray(list) ? list : [];
  const totals = { takerBuyVolume: 0, takerSellVolume: 0 };
  const windows = { cvd1m: 0, cvd3m: 0, cvd5m: 0 };
  let newestAt = null;
  let sampleCount = 0;

  for (const trade of trades) {
    const at = numeric(trade.time ?? trade.T ?? trade.execTime);
    const volume = numeric(trade.size ?? trade.v ?? trade.execQty);
    const side = String(trade.side ?? trade.S ?? "").toUpperCase();
    if (!Number.isFinite(at) || !Number.isFinite(volume) || volume < 0) continue;
    newestAt = newestAt === null ? at : Math.max(newestAt, at);
    const signed = side === "BUY" ? volume : side === "SELL" ? -volume : 0;
    const age = Math.max(0, nowMs - at);
    if (age <= 60_000) windows.cvd1m += signed;
    if (age <= 180_000) windows.cvd3m += signed;
    if (age <= 300_000) {
      windows.cvd5m += signed;
      sampleCount++;
      if (side === "BUY") totals.takerBuyVolume += volume;
      if (side === "SELL") totals.takerSellVolume += volume;
    }
  }

  const totalVolume = totals.takerBuyVolume + totals.takerSellVolume;
  const buySellImbalance = totalVolume > 0
    ? (totals.takerBuyVolume - totals.takerSellVolume) / totalVolume
    : 0;
  const cvdBias = classifyCvdBias(windows);
  let orderFlowBias = "NEUTRAL";
  if (cvdBias === "BULLISH" && buySellImbalance >= 0.05) orderFlowBias = "BULLISH";
  if (cvdBias === "BEARISH" && buySellImbalance <= -0.05) orderFlowBias = "BEARISH";

  return {
    takerBuyVolume: round(totals.takerBuyVolume, 8),
    takerSellVolume: round(totals.takerSellVolume, 8),
    buySellImbalance: round(buySellImbalance, 4),
    cvd1m: round(windows.cvd1m, 8),
    cvd3m: round(windows.cvd3m, 8),
    cvd5m: round(windows.cvd5m, 8),
    cvdBias,
    orderFlowBias,
    sourceAt: newestAt,
    sampleCount,
  };
}

function depthImbalance(rows, topN) {
  const selected = Array.isArray(rows) ? rows.slice(0, topN) : [];
  return selected.reduce((sum, level) => sum + (numeric(level?.[1]) ?? 0), 0);
}

function parseOrderBook(result, nowMs = Date.now()) {
  const bids = result?.b ?? result?.bids ?? [];
  const asks = result?.a ?? result?.asks ?? [];
  const score = topN => {
    const bidDepth = depthImbalance(bids, topN);
    const askDepth = depthImbalance(asks, topN);
    const total = bidDepth + askDepth;
    return total > 0 ? (bidDepth - askDepth) / total : 0;
  };
  const obiTop10 = score(10);
  const obiTop20 = score(20);
  const sourceAt = numeric(result?.ts ?? result?.cts ?? result?.time);
  const obiScore = round(obiTop20, 4);
  return {
    obiScore,
    obiTop10: round(obiTop10, 4),
    obiTop20,
    orderBookBias: obiScore >= 0.08 ? "BULLISH" : obiScore <= -0.08 ? "BEARISH" : "NEUTRAL",
    sourceAt,
    ageMs: Number.isFinite(sourceAt) ? Math.max(0, nowMs - sourceAt) : null,
    depthLevels: Math.min(20, bids.length, asks.length),
  };
}

async function fetchJsonWithTimeout(url, fetchImpl, timeoutMs = V45_FETCH_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "Bybit-OI-Radar/4.5" },
      }),
      timeout,
    ]);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    const data = JSON.parse(text);
    if (data.retCode !== 0) throw new Error(`${data.retCode}: ${data.retMsg}`);
    return data.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchMicrostructure(symbol, fetchImpl = fetch, nowMs = Date.now()) {
  const params = new URLSearchParams({ category: "linear", symbol });
  const tradeUrl = `${BYBIT_BASE}/v5/market/recent-trade?${params}&limit=1000`;
  const bookUrl = `${BYBIT_BASE}/v5/market/orderbook?${params}&limit=25`;
  const [trades, book] = await Promise.allSettled([
    fetchJsonWithTimeout(tradeUrl, fetchImpl),
    fetchJsonWithTimeout(bookUrl, fetchImpl),
  ]);

  const flow = trades.status === "fulfilled"
    ? { status: "ok", ...parseRecentTrades(trades.value?.list, nowMs) }
    : { status: "unavailable", error: trades.reason?.message || "request_failed" };
  const orderBook = book.status === "fulfilled"
    ? { status: "ok", ...parseOrderBook(book.value, nowMs) }
    : { status: "unavailable", error: book.reason?.message || "request_failed" };

  return { symbol, collectedAt: nowMs, flow, orderBook };
}

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

function entryTiming(row, direction, setupQuality, setupState, xsum) {
  const numeric = value => value == null || value === "" ? NaN : Number(value);
  const p5 = numeric(row.price5mPct);
  const p15 = numeric(row.price15mPct);
  const p1 = numeric(row.price1hPct);
  const p24 = numeric(row.price24hPct);

  const o15 = Number(row.oi15mPct ?? 0);
  const o30 = Number(row.oi30mPct ?? 0);
  const latestOi = Number(
    row.latestOiStep ?? row.oi15mPct ?? 0
  );

  const retention = Number(row.oiHighRetention ?? 0);
  const funding = numeric(row.fundingPct);

  const price = numeric(row.price);
  const support = numeric(row.priceStructure?.support);
  const keyLevel = numeric(row.priceStructure?.keyLevel);

  const freshOi =
    o15 >= 0.3 &&
    o30 > 0 &&
    latestOi > 0;

  const retainedOi =
    o30 > 0 &&
    latestOi >= -0.1 &&
    retention >= 0.97;

  let score = 35;

  const reasons = [];
  const riskFlags = [];

  /*
   * Setup 本身只提供一部分 timing 分。
   * Setup 很强 ≠ 现在就值得追。
   */
  if (setupQuality >= 85) {
    score += 10;
    reasons.push("setup强");
  } else if (setupQuality >= 72) {
    score += 7;
    reasons.push("setup合格");
  } else if (setupQuality >= 62) {
    score += 4;
  } else {
    score -= 10;
    riskFlags.push("SETUP_WEAK");
  }

  /*
   * OI freshness
   */
  if (freshOi) {
    score += 18;
    reasons.push("15M/30M OI持续增仓");
  } else if (o30 > 0 && latestOi > 0) {
    score += 8;
    reasons.push("OI仍为正但15M不足");
  } else {
    score -= 15;
    riskFlags.push("OI_NOT_FRESH");
  }

  if (retention >= 0.97) {
    score += 8;
    reasons.push("OI高保留");
  } else if (retention < 0.94) {
    score -= 10;
    riskFlags.push("OI_LEAK");
  }

  /*
   * 跨所只做加分。
   * LOCAL_ONLY 不再因为没采到数据严重扣 timing。
   */
  if (xsum?.confirmation === "CONFIRMED") {
    score += 8;
    reasons.push("跨所确认");
  } else if (xsum?.confirmation === "MIXED") {
    score += 2;
  }

  let extendedByPrice = false;
  let extremeFundingConflict = false;

  if (direction === "LONG") {
    /*
     * 1H 位置
     */
    if (p1 >= -1 && p1 <= 4.5) {
      score += 12;
      reasons.push("1H位置仍合理");
    } else if (p1 > 4.5 && p1 < 8) {
      score += 5;
      riskFlags.push("PRICE_WARM");
    } else if (p1 >= 8) {
      score -= 20;
      extendedByPrice = true;
      riskFlags.push("PRICE_1H_EXTENDED");
    } else if (p1 < -2) {
      score -= 8;
    }

    /*
     * 15M 位置
     */
    if (p15 >= -0.8 && p15 <= 2.2) {
      score += 10;
      reasons.push("15M未过度拉升");
    } else if (p15 > 2.2 && p15 < 4) {
      score += 3;
      riskFlags.push("PRICE_15M_WARM");
    } else if (p15 >= 4) {
      score -= 15;
      extendedByPrice = true;
      riskFlags.push("PRICE_15M_EXTENDED");
    } else if (p15 < -1.5) {
      score -= 8;
    }

    /*
     * 5M 当前触发位置
     */
    if (p5 >= 0.1 && p5 <= 1.2) {
      score += 8;
      reasons.push("5M温和推进");
    } else if (p5 >= -0.8 && p5 < 0.1) {
      score += 7;
      reasons.push("5M健康回踩");
    } else if (p5 > 1.5) {
      score -= 10;
      riskFlags.push("5M_SPIKE");
    } else if (p5 < -1) {
      score -= 10;
      riskFlags.push("5M_BREAKDOWN");
    }

    /*
     * 关键位
     */
    if (
      Number.isFinite(price) &&
      Number.isFinite(keyLevel) &&
      price >= keyLevel * 0.995
    ) {
      score += 8;
      reasons.push("价格位于关键位附近/上方");
    } else if (
      Number.isFinite(price) &&
      Number.isFinite(support) &&
      price >= support
    ) {
      score += 4;
    }

    /*
     * 24H 已经大涨，同时1H还在继续拉，
     * 即使结构正确，也不追。
     */
    if (p24 >= 30 && p1 >= 3) {
      score -= 12;
      extendedByPrice = true;
      riskFlags.push("24H_EXTENDED");
    } else if (p24 >= 20) {
      score -= 4;
      riskFlags.push("24H_WARM");
    }

    /*
     * Long 最怕正 funding 已经极度拥挤。
     * 负 funding 反而可以是 squeeze fuel。
     */
    if (funding >= 0.3) {
      score -= 20;
      extremeFundingConflict = true;
      riskFlags.push("EXTREME_LONG_FUNDING");
    } else if (funding >= 0.1) {
      score -= 10;
      riskFlags.push("LONG_FUNDING_CROWDED");
    } else if (funding <= -0.05) {
      score += 3;
      reasons.push("负Funding提供潜在挤空燃料");
    }
  } else {
    /*
     * SHORT 完全镜像处理。
     */
    if (p1 <= 1 && p1 >= -4.5) {
      score += 12;
      reasons.push("1H位置仍合理");
    } else if (p1 < -4.5 && p1 > -8) {
      score += 5;
      riskFlags.push("PRICE_WARM");
    } else if (p1 <= -8) {
      score -= 20;
      extendedByPrice = true;
      riskFlags.push("PRICE_1H_EXTENDED");
    } else if (p1 > 2) {
      score -= 8;
    }

    if (p15 <= 0.8 && p15 >= -2.2) {
      score += 10;
      reasons.push("15M未过度下跌");
    } else if (p15 < -2.2 && p15 > -4) {
      score += 3;
      riskFlags.push("PRICE_15M_WARM");
    } else if (p15 <= -4) {
      score -= 15;
      extendedByPrice = true;
      riskFlags.push("PRICE_15M_EXTENDED");
    } else if (p15 > 1.5) {
      score -= 8;
    }

    if (p5 <= -0.1 && p5 >= -1.2) {
      score += 8;
      reasons.push("5M温和下破");
    } else if (p5 > -0.1 && p5 <= 0.8) {
      score += 7;
      reasons.push("5M反抽可控");
    } else if (p5 < -1.5) {
      score -= 10;
      riskFlags.push("5M_SPIKE");
    } else if (p5 > 1) {
      score -= 10;
      riskFlags.push("5M_REBOUND");
    }

    if (
      Number.isFinite(price) &&
      Number.isFinite(keyLevel) &&
      price <= keyLevel * 1.005
    ) {
      score += 8;
      reasons.push("价格位于关键位附近/下方");
    }

    if (row.priceStructure?.lowerLows === true) {
      score += 5;
      reasons.push("lower lows延续");
    }

    if (p24 <= -30 && p1 <= -3) {
      score -= 12;
      extendedByPrice = true;
      riskFlags.push("24H_EXTENDED");
    } else if (p24 <= -20) {
      score -= 4;
      riskFlags.push("24H_WARM");
    }

    /*
     * Short 最怕 Funding 已经极负，
     * 因为空头过度拥挤，容易被 squeeze。
     */
    if (funding <= -0.3) {
      score -= 20;
      extremeFundingConflict = true;
      riskFlags.push("EXTREME_SHORT_FUNDING");
    } else if (funding <= -0.1) {
      score -= 10;
      riskFlags.push("SHORT_FUNDING_CROWDED");
    } else if (funding >= 0.05) {
      score += 3;
      reasons.push("正Funding对空头有利");
    }
  }

  /*
   * OI spike + 价格已经同步冲出去：
   * 通常不是最佳新开仓位置。
   */
  if (
    row.isOiSpike === true &&
    Math.abs(p15) >= 2
  ) {
    score -= 12;
    riskFlags.push("OI_SPIKE_CHASE_RISK");
  }

  /*
   * V4.1 已经判断 EXTENDED 的直接高风险。
   */
  if (row.executionRisk === "EXTENDED") {
    score -= 25;
    riskFlags.push("SOURCE_EXTENDED");
  }

  score = Math.max(0, Math.min(100, score));

  const hardNoChase =
    row.executionRisk === "EXTENDED" ||
    extendedByPrice ||
    extremeFundingConflict;

  /*
   * 三种真正的 entry trigger
   */
  const breakout =
    direction === "LONG"
      ? (
          p5 >= 0.1 &&
          p5 <= 1.2 &&
          (
            !Number.isFinite(keyLevel) ||
            !Number.isFinite(price) ||
            price >= keyLevel * 0.995
          )
        )
      : (
          p5 <= -0.1 &&
          p5 >= -1.2 &&
          (
            !Number.isFinite(keyLevel) ||
            !Number.isFinite(price) ||
            price <= keyLevel * 1.005
          )
        );

  const retest =
    direction === "LONG"
      ? (
          p5 >= -0.8 &&
          p5 < 0.1 &&
          retention >= 0.97 &&
          (
            !Number.isFinite(support) ||
            !Number.isFinite(price) ||
            price >= support
          )
        )
      : (
          p5 > -0.1 &&
          p5 <= 0.8 &&
          retention >= 0.97 &&
          (
            row.priceStructure?.lowerLows === true ||
            !Number.isFinite(keyLevel) ||
            !Number.isFinite(price) ||
            price <= keyLevel * 1.005
          )
        );

  /*
   * EARLY_ENTRY：
   * 价格还没启动很多，但 OI 已经开始建仓。
   */
  const early =
    direction === "LONG"
      ? (
          p1 >= -0.5 &&
          p1 <= 3 &&
          p15 >= -0.5 &&
          p15 <= 1.5 &&
          p5 >= -0.3 &&
          p5 <= 0.8
        )
      : (
          p1 <= 0.5 &&
          p1 >= -3 &&
          p15 <= 0.5 &&
          p15 >= -1.5 &&
          p5 <= 0.3 &&
          p5 >= -0.8
        );

  const validTimingData = [p5, p15, p1, p24, funding, price].every(Number.isFinite) && price > 0;
  if (!validTimingData) riskFlags.push("TIMING_DATA_MISSING");

  let entrySignal = "WAIT";

  if (hardNoChase) {
    entrySignal = "NO_CHASE";
  } else if (!validTimingData || setupState === "WATCH") {
    entrySignal = "WAIT";
  } else if (
    score >= 75 &&
    breakout &&
    freshOi
  ) {
    entrySignal = "BREAKOUT_ENTRY";
  } else if (
    score >= 72 &&
    retest &&
    retainedOi
  ) {
    entrySignal = "RETEST_ENTRY";
  } else if (
    score >= 78 &&
    early &&
    freshOi
  ) {
    entrySignal = "EARLY_ENTRY";
  } else if (score >= 62) {
    entrySignal = "ARMED";
  }

  return {
    timingScore: round(score, 1),
    entrySignal,
    timingReason: reasons.join("；"),
    timingRiskFlags: [...new Set(riskFlags)],
    freshOi,
    retainedOi,
  };
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

function v45Confirmation(row, direction, entrySignal) {
  const price = numeric(row.price);
  const keyLevel = numeric(row.priceStructure?.keyLevel);
  const support = numeric(row.priceStructure?.support);
  const p5 = numeric(row.price5mPct);
  const p15 = numeric(row.price15mPct);
  const oi15 = numeric(row.oi15mPct);
  const oi30 = numeric(row.oi30mPct);
  const flow = row.v45Microstructure?.flow || {};
  const book = row.v45Microstructure?.orderBook || {};
  const flowBias = flow.status === "ok" ? flow.orderFlowBias : "UNAVAILABLE";
  const cvdBias = flow.status === "ok" ? flow.cvdBias : "UNAVAILABLE";
  const orderBookBias = book.status === "ok" ? book.orderBookBias : "UNAVAILABLE";
  const directionBias = direction === "LONG" ? "BULLISH" : "BEARISH";
  const oppositeBias = direction === "LONG" ? "BEARISH" : "BULLISH";
  const priceDirectional = direction === "LONG"
    ? (p5 ?? -Infinity) >= 0 && (p15 ?? -Infinity) >= -0.3
    : (p5 ?? Infinity) <= 0 && (p15 ?? Infinity) <= 0.3;
  const priceAgainst = direction === "LONG"
    ? (p5 ?? 0) < 0 && (p15 ?? 0) < 0
    : (p5 ?? 0) > 0 && (p15 ?? 0) > 0;
  const strictPriceReclaim = Number.isFinite(price) && Number.isFinite(keyLevel)
    ? direction === "LONG"
      ? price >= keyLevel * 0.999
      : price <= keyLevel * 1.001
    : false;
  const supportHeld = Number.isFinite(price) && Number.isFinite(support)
    ? direction === "LONG" ? price >= support : true
    : row.priceStructure?.supportHeld === true;
  const alignedFlow = flowBias === directionBias;
  const opposingFlow = flowBias === oppositeBias || cvdBias === oppositeBias;
  const imbalance = numeric(flow.buySellImbalance);
  const strongAlignedFlow = alignedFlow && Number.isFinite(imbalance) &&
    (direction === "LONG" ? imbalance >= 0.12 : imbalance <= -0.12);
  const alignedBook = orderBookBias === directionBias;
  const opposingBook = orderBookBias === oppositeBias;
  const oiRising = (oi15 ?? 0) > 0 && (oi30 ?? 0) > 0;
  const adverseOiFlowPrice = oiRising && opposingFlow && priceAgainst;

  let priceConfirmScore = 20;
  if (strictPriceReclaim) priceConfirmScore += 45;
  if (row.priceStructure?.keyLevelReclaimed === true) priceConfirmScore += 10;
  if (priceDirectional) priceConfirmScore += 15;
  if (supportHeld) priceConfirmScore += 5;
  if (alignedFlow) priceConfirmScore += 10;
  if (opposingFlow) priceConfirmScore -= 20;
  if (alignedBook) priceConfirmScore += 5;
  if (opposingBook) priceConfirmScore -= 5;
  if (adverseOiFlowPrice) priceConfirmScore -= 25;
  priceConfirmScore = round(clamp(priceConfirmScore), 1);

  const behaviorConfirmed = strictPriceReclaim ||
    (strongAlignedFlow && !priceAgainst);
  const executable = ["EARLY_ENTRY", "BREAKOUT_ENTRY", "RETEST_ENTRY"].includes(entrySignal);
  const entryStage = executable && behaviorConfirmed && !adverseOiFlowPrice
    ? "CONFIRMED"
    : "PROBE";
  const signalPrefix = entrySignal.endsWith("_ENTRY")
    ? entrySignal.replace(/_ENTRY$/, "")
    : entrySignal;
  const v45EntrySignal = executable
    ? `${signalPrefix}_${entryStage}`
    : entrySignal;

  let directionConfidence = priceConfirmScore;
  if (alignedFlow) directionConfidence += 15;
  if (opposingFlow) directionConfidence -= 20;
  if (alignedBook) directionConfidence += 5;
  if (opposingBook) directionConfidence -= 5;
  if (row.directionalBias === directionBias) directionConfidence += 10;
  if (row.directionalBias === "NEUTRAL") directionConfidence -= 5;
  if (adverseOiFlowPrice) directionConfidence -= 20;
  directionConfidence = round(clamp(directionConfidence), 1);

  const riskFlags = [];
  if (!strictPriceReclaim) riskFlags.push("KEY_LEVEL_NOT_RECLAIMED");
  if (opposingFlow) riskFlags.push("ORDER_FLOW_OPPOSES_DIRECTION");
  if (adverseOiFlowPrice) riskFlags.push("OI_UP_CVD_AND_PRICE_AGAINST_DIRECTION");
  if (flow.status !== "ok") riskFlags.push("ORDER_FLOW_UNAVAILABLE");
  if (book.status !== "ok") riskFlags.push("ORDER_BOOK_UNAVAILABLE");

  return {
    entryStage,
    v45EntryStage: entryStage,
    v45EntrySignal,
    v45Confirmation: entryStage === "CONFIRMED" ? "CONFIRMED" : "UNCONFIRMED",
    priceConfirmScore,
    strictPriceReclaim,
    takerBuyVolume: flow.status === "ok" ? flow.takerBuyVolume : null,
    takerSellVolume: flow.status === "ok" ? flow.takerSellVolume : null,
    buySellImbalance: flow.status === "ok" ? flow.buySellImbalance : null,
    cvd1m: flow.status === "ok" ? flow.cvd1m : null,
    cvd3m: flow.status === "ok" ? flow.cvd3m : null,
    cvd5m: flow.status === "ok" ? flow.cvd5m : null,
    cvdBias,
    orderFlowBias: flowBias,
    obiScore: book.status === "ok" ? book.obiScore : null,
    obiTop10: book.status === "ok" ? book.obiTop10 : null,
    obiTop20: book.status === "ok" ? book.obiTop20 : null,
    orderBookBias,
    directionConfidence,
    invalidationReason: riskFlags.length ? riskFlags.join(";") : null,
    v45RiskFlags: riskFlags,
    v45DataFreshness: {
      collectedAt: row.v45Microstructure?.collectedAt ?? null,
      orderFlowStatus: flow.status || "unavailable",
      orderFlowSourceAt: flow.sourceAt ?? null,
      orderFlowSampleCount: flow.sampleCount ?? 0,
      orderBookStatus: book.status || "unavailable",
      orderBookSourceAt: book.sourceAt ?? null,
      orderBookAgeMs: book.ageMs ?? null,
      orderBookDepthLevels: book.depthLevels ?? 0,
    },
    adverseOiFlowPrice,
    strongAlignedFlow,
  };
}

function classifyV45Runner(candidate, legacyRunner) {
  let v45RunnerPotential = legacyRunner.runnerPotential;
  const reasons = [];
  const neutralPositionBuild = candidate.sourceExecutionState === "POSITION_BUILD" &&
    candidate.sourceDirectionalBias === "NEUTRAL";
  const directionalConfirmation = candidate.strictPriceReclaim || candidate.strongAlignedFlow;

  if (candidate.adverseOiFlowPrice) {
    v45RunnerPotential = "LOW";
    reasons.push("OI_UP_CVD_AND_PRICE_AGAINST_DIRECTION");
  } else if (candidate.entryStage !== "CONFIRMED" && v45RunnerPotential === "HIGH") {
    v45RunnerPotential = "MEDIUM";
    reasons.push("ENTRY_STAGE_PROBE");
  }
  if (neutralPositionBuild && !directionalConfirmation && v45RunnerPotential === "HIGH") {
    v45RunnerPotential = "MEDIUM";
    reasons.push("POSITION_BUILD_NEUTRAL_UNCONFIRMED");
  }

  return {
    v45RunnerPotential,
    v45RunnerReasons: reasons,
  };
}

function classifyRunner(candidate) {
  const numeric = value => value == null || value === "" ? NaN : Number(value);
  const reasons = [];
  const riskFlags = Array.isArray(candidate.timingRiskFlags)
    ? candidate.timingRiskFlags
    : [];
  const direction = String(candidate.direction || "").toUpperCase();
  const entrySignal = candidate.entrySignal ?? "WAIT";
  const finalScore = numeric(
    candidate.finalCandidateScore ?? candidate.candidateQuality
  );
  const xsum = candidate.crossExchangeSummary || {};
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

  if (xsum.confirmation === "CONFIRMED") {
    score += 15;
    reasons.push("CROSS_CONFIRMED");
  } else if (xsum.confirmation === "LOCAL_ONLY") {
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

  const directionalPrice =
    Number.isFinite(price1h) &&
    Math.abs(price1h) <= 3 &&
    ((direction === "LONG" && price1h >= 0) ||
      (direction === "SHORT" && price1h <= 0));
  if (directionalPrice) {
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
    "EXTREME_LONG_FUNDING",
    "EXTREME_SHORT_FUNDING",
    "LONG_FUNDING_CROWDED",
    "SHORT_FUNDING_CROWDED",
  ].includes(flag))) {
    score -= 15;
    reasons.push("FUNDING_CROWDED");
  }

  score = round(Math.max(0, Math.min(100, score)), 1);

  const obviousRiskCount = [
    riskFlags.includes("SETUP_WEAK"),
    riskFlags.some(flag => [
      "PRICE_WARM",
      "PRICE_15M_WARM",
      "PRICE_1H_EXTENDED",
      "PRICE_15M_EXTENDED",
    ].includes(flag)),
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

function evaluateCandidate(row, direction) {
  const market = marketClassification(row.symbol);

  const persistent =
    direction === "LONG"
      ? longPersistence(row)
      : shortPersistence(row);

  const xsum =
    crossExchangeSummary(row, direction);

  let score =
    persistent.score +
    xsum.scoreAdjustment;

  if (row.executionRisk === "EXTENDED") {
    score -= 25;
  }

  if (market.marketType === "TRADFI_PERP") {
    score -= 12;
  }

  const persistenceOk =
    direction === "LONG"
      ? (
          persistent.oiContinuation ||
          persistent.priceContinuation
        )
      : persistent.persistence;

  /*
   * candidateState 继续保留。
   * 它代表 SETUP 状态，而不是最终入场状态。
   */
  const state = candidateState(
    row,
    direction,
    score,
    persistenceOk
  );

  const candidateQuality = round(
    Math.max(0, Math.min(100, score)),
    1
  );

  /*
   * 新的 Timing Layer
   */
const timing = entryTiming(
  row,
  direction,
  candidateQuality,
  state,
  xsum
);

const riskFlags = timing.timingRiskFlags || [];

const hasExtendedRisk = riskFlags.some(flag =>
  [
    "PRICE_1H_EXTENDED",
    "PRICE_15M_EXTENDED",
    "24H_EXTENDED",
    "SOURCE_EXTENDED",
  ].includes(flag)
);

const hasBreakdownRisk = riskFlags.includes("5M_BREAKDOWN");

const oi15 = row.oi15mPct ?? 0;
const oi30 = row.oi30mPct ?? 0;
const oi1h = row.oi1hPct ?? 0;

const strongOiContinuation =
  oi15 >= 3 &&
  oi30 >= 5 &&
  oi1h >= 5;

const manualChaseAlert =
  timing.entrySignal === "NO_CHASE" &&
  hasExtendedRisk &&
  strongOiContinuation &&
  !hasBreakdownRisk
    ? {
        enabled: true,
        type: "TREND_CONTINUATION",
        riskLevel: "HIGH",
        message:
          "高风险趋势延续候选，当前仍为 NO_CHASE，非正式 Entry，请人工决定是否参与",
      }
    : {
        enabled: false,
        type: null,
        riskLevel: null,
        message: null,
      };

  const v45 = v45Confirmation(row, direction, timing.entrySignal);

  const candidate = {
    symbol: row.symbol,
    direction,

    /*
     * SETUP 层
     */
    candidateState: state,
    candidateQuality,

    persistenceScore: round(
      Math.max(
        0,
        Math.min(100, persistent.score)
      ),
      1
    ),

    reason: reasonFor(
      row,
      direction,
      persistent,
      xsum
    ),

    /*
     * ENTRY 层
     */
    entrySignal: timing.entrySignal,
    timingScore: timing.timingScore,
    timingReason: timing.timingReason,
    timingRiskFlags: timing.timingRiskFlags,

    ...v45,
    
    manualChaseAlert,

    marketType: market.marketType,
    riskTag: market.riskTag,

    keyMetrics: {
      price: row.price ?? null,

      price5mPct:
        row.price5mPct ?? null,

      price15mPct:
        row.price15mPct ?? null,

      price1hPct:
        row.price1hPct ?? null,

      price24hPct:
        row.price24hPct ?? null,

      oi15mPct:
        row.oi15mPct ?? null,

      oi30mPct:
        row.oi30mPct ?? null,

      oi1hPct:
        row.oi1hPct ?? null,

      oi2hPct:
        row.oi2hPct ?? null,

      latestOiStep:
        row.latestOiStep ?? null,

      oiHighRetention:
        row.oiHighRetention ?? null,

      fundingPct:
        row.fundingPct ?? null,

      support:
        row.priceStructure?.support ?? null,

      recentLow:
        row.priceStructure?.recentLow ?? null,

      keyLevel:
        row.priceStructure?.keyLevel ?? null,
    },

    crossExchangeSummary: xsum,

    executionRisk:
      row.executionRisk ||
      market.riskTag ||
      null,

    sourceExecutionState:
      row.executionState,

    sourceDirectionalBias:
      row.directionalBias ?? "NEUTRAL",
  };

  if (market.marketType !== "CRYPTO_PERP") return candidate;
  const legacyRunner = classifyRunner(candidate);
  return {
    ...candidate,
    ...legacyRunner,
    ...classifyV45Runner(candidate, legacyRunner),
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
    .filter(x => x.candidateState !== "WATCH")
    .sort((a, b) => b.candidateQuality - a.candidateQuality);

  const evaluatedShorts = rows
    .filter(isShortEligible)
    .map(row => evaluateCandidate(row, "SHORT"))
    .filter(x => x.candidateState !== "WATCH")
    .sort((a, b) => b.candidateQuality - a.candidateQuality);

  const longCandidatePool = evaluatedLongs
    .filter(x => x.marketType === "CRYPTO_PERP")
    .slice(0, 10);

  const shortCandidatePool = evaluatedShorts
    .filter(x => x.marketType === "CRYPTO_PERP")
    .slice(0, 10);

  const tradFiLongCandidatePool = evaluatedLongs
    .filter(x => x.marketType === "TRADFI_PERP")
    .slice(0, 10);

  const tradFiShortCandidatePool = evaluatedShorts
    .filter(x => x.marketType === "TRADFI_PERP")
    .slice(0, 10);

  const executableSignals = new Set(["EARLY_ENTRY", "BREAKOUT_ENTRY", "RETEST_ENTRY"]);
  const pickEntries = pool => [...pool]
    .filter(candidate => executableSignals.has(candidate.entrySignal))
    .sort((a, b) => b.timingScore - a.timingScore)
    .slice(0, 3);

  return {
    longEntryCandidates: pickEntries(longCandidatePool),
    shortEntryCandidates: pickEntries(shortCandidatePool),
    tradFiLongEntryCandidates: pickEntries(tradFiLongCandidatePool),
    tradFiShortEntryCandidates: pickEntries(tradFiShortCandidatePool),
    // 保留原来的兼容输出
    longCandidates: longCandidatePool.slice(0, 3),
    shortCandidates: shortCandidatePool.slice(0, 3),
    tradFiLongCandidates: tradFiLongCandidatePool.slice(0, 3),
    tradFiShortCandidates: tradFiShortCandidatePool.slice(0, 3),

    // V4.3 历史层使用
    longCandidatePool,
    shortCandidatePool,
    tradFiLongCandidatePool,
    tradFiShortCandidatePool,
  };
}

function v45TargetSymbols(lists, maxSymbols = V45_MAX_MICROSTRUCTURE_SYMBOLS) {
  const ordered = [
    ...(lists.longEntryCandidates || []),
    ...(lists.shortEntryCandidates || []),
    ...(lists.longCandidatePool || []),
    ...(lists.shortCandidatePool || []),
  ];
  return [...new Set(ordered.map(candidate => candidate.symbol).filter(Boolean))]
    .slice(0, maxSymbols);
}

async function enrichMicrostructure(base, fetchImpl = fetch, nowMs = Date.now()) {
  const preliminary = buildCandidateLists(base);
  const configuredMax = typeof process !== "undefined"
    ? Number(process.env?.V45_MAX_MICROSTRUCTURE_SYMBOLS)
    : NaN;
  const maxSymbols = Number.isInteger(configuredMax) && configuredMax >= 0
    ? Math.min(configuredMax, 30)
    : V45_MAX_MICROSTRUCTURE_SYMBOLS;
  const symbols = v45TargetSymbols(preliminary, maxSymbols);
  const bySymbol = new Map();

  for (let index = 0; index < symbols.length; index += V45_FETCH_CONCURRENCY) {
    const batch = symbols.slice(index, index + V45_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(symbol =>
      fetchMicrostructure(symbol, fetchImpl, nowMs).catch(error => ({
        symbol,
        collectedAt: nowMs,
        flow: { status: "unavailable", error: error.message },
        orderBook: { status: "unavailable", error: error.message },
      }))
    ));
    for (const result of results) bySymbol.set(result.symbol, result);
  }

  return {
    ...base,
    executionStates: (base.executionStates || []).map(row => ({
      ...row,
      v45Microstructure: bySymbol.get(row.symbol),
    })),
    v45MicrostructureDiagnostics: {
      requestedSymbols: symbols.length,
      orderFlowAvailable: [...bySymbol.values()].filter(value => value.flow?.status === "ok").length,
      orderBookAvailable: [...bySymbol.values()].filter(value => value.orderBook?.status === "ok").length,
      maxSymbols,
      fetchConcurrency: V45_FETCH_CONCURRENCY,
    },
  };
}

function v45AbSummary(lists) {
  const pools = [
    ...(lists.longCandidatePool || []),
    ...(lists.shortCandidatePool || []),
  ];
  const executable = new Set(["EARLY_ENTRY", "BREAKOUT_ENTRY", "RETEST_ENTRY"]);
  const oldEntriesNowProbe = pools.filter(candidate =>
    executable.has(candidate.entrySignal) && candidate.entryStage === "PROBE"
  );
  const oldHighNowDowngraded = pools.filter(candidate =>
    candidate.runnerPotential === "HIGH" && candidate.v45RunnerPotential !== "HIGH"
  );
  const compact = candidate => ({
    symbol: candidate.symbol,
    direction: candidate.direction,
    oldEntrySignal: candidate.entrySignal,
    oldRunnerPotential: candidate.runnerPotential ?? null,
    v45EntryStage: candidate.v45EntryStage,
    v45RunnerPotential: candidate.v45RunnerPotential ?? null,
    directionConfidence: candidate.directionConfidence,
    invalidationReason: candidate.invalidationReason,
  });
  return {
    oldEntryCount: pools.filter(candidate => executable.has(candidate.entrySignal)).length,
    confirmedCount: pools.filter(candidate => candidate.entryStage === "CONFIRMED").length,
    probeCount: pools.filter(candidate => candidate.entryStage === "PROBE").length,
    oldEntriesNowProbe: oldEntriesNowProbe.map(compact),
    oldHighNowDowngraded: oldHighNowDowngraded.map(compact),
  };
}

export default async function handler(req, res) {
  try {
    const response = await fetch(BASE_SCAN_URL, {
      headers: { Accept: "application/json", "User-Agent": "Bybit-OI-Radar/4.4" },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`V4.1 upstream HTTP ${response.status}: ${text.slice(0, 160)}`);
    const sourceBase = JSON.parse(text);
    const base = await enrichMicrostructure(sourceBase, fetch, Date.now());
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
        v45Confirmation: {
          mode: "sidecar",
          preservesV44EntrySignal: true,
          longKeyLevelThreshold: 0.999,
          shortKeyLevelThreshold: 1.001,
          behaviorNotClockBased: true,
          orderBookCanTriggerEntry: false,
        },
      },
      scoreMeaning: "V4.4 candidateQuality, timingScore, entrySignal and runner fields are preserved. V4.5 entryStage and v45RunnerPotential add behavior-based directional confirmation without waiting a fixed number of candles.",
      ...lists,
      v45AbSummary: v45AbSummary(lists),
    });
  } catch (error) {
    return res.status(500).json({ status: "error", version: VERSION, message: error.message });
  }
}

export {
  marketClassification,
  crossExchangeSummary,
  classifyRunner,
  classifyV45Runner,
  parseRecentTrades,
  parseOrderBook,
  v45Confirmation,
  evaluateCandidate,
  buildCandidateLists,
  fetchMicrostructure,
  enrichMicrostructure,
  v45AbSummary,
};
