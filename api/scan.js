const BASE = "https://api.bybit.com";
const COINALYZE_BASE = "https://api.coinalyze.net/v1";
const COINALYZE_MAX_MARKETS = 18;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


// ============================================================
// BYBIT
// ============================================================

async function bybit(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${BASE}${path}?${qs.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Bybit-OI-Radar/4.1",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text.slice(0, 160)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Non JSON: ${text.slice(0, 160)}`
    );
  }

  if (data.retCode !== 0) {
    throw new Error(
      `${data.retCode}: ${data.retMsg}`
    );
  }

  return data.result;
}


// ============================================================
// HELPERS
// ============================================================

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function pct(now, old) {
  now = num(now);
  old = num(old);

  if (
    now === null ||
    old === null ||
    old === 0
  ) {
    return null;
  }

  return ((now / old) - 1) * 100;
}


function round(value, decimals = 2) {
  if (
    value === null ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Number(
    value.toFixed(decimals)
  );
}


function avg(values) {
  const valid =
    values.filter(Number.isFinite);

  if (!valid.length) {
    return null;
  }

  return (
    valid.reduce(
      (sum, value) => sum + value,
      0
    ) / valid.length
  );
}


// ============================================================


// ============================================================
// COINALYZE CROSS-EXCHANGE VALIDATION
// Output-only evidence: never changes discovery, ranking or execution.
// 18 markets keep 18 OI + 18 funding + 2 metadata calls within 40/min.
// ============================================================
async function coinalyze(path, params, apiKey) {
  const qs = new URLSearchParams(params);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
  let response;
  try {
    response = await fetch(COINALYZE_BASE + path + "?" + qs, {
      headers: { Accept: "application/json", api_key: apiKey,
        "User-Agent": "Bybit-OI-Radar/4.1" },
      signal: controller?.signal,
    });
  } finally {
    if (timeout !== null && typeof clearTimeout === "function") clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) throw new Error("Coinalyze HTTP " + response.status + ": " + text.slice(0, 120));
  try { return JSON.parse(text); }
  catch { throw new Error("Coinalyze non-JSON response: " + text.slice(0, 120)); }
}

function unavailableCrossExchange(status, reason = null) {
  return { status, source: "Coinalyze", reason,
    aggregatedOiUsd: null, aggregatedFundingRate: null,
    oi5mPct: null, oi15mPct: null, oi1hPct: null,
    bybitOiUsd: null, bybitOiSharePct: null, exchanges: [] };
}

function selectCoinalyzeMarkets(candidates, markets, exchanges, limit = COINALYZE_MAX_MARKETS) {
  const exchangeNames = new Map(exchanges.map(x => [x.code, x.name]));
  const bybitCodes = new Set(exchanges.filter(x => /bybit/i.test(x.name || "")).map(x => x.code));
  const priority = ["Bybit", "Binance", "OKX", "Bitget", "Gate", "Kraken", "Deribit"];
  const selected = new Map();
  for (const candidate of candidates.slice(0, Math.floor(limit / 2))) {
    const bybitMarket = markets.find(x => bybitCodes.has(x.exchange) &&
      x.symbol_on_exchange === candidate.symbol && x.is_perpetual === true);
    if (!bybitMarket) continue;
    const eligible = markets.filter(x => x.base_asset === bybitMarket.base_asset &&
      x.is_perpetual === true && x.margined === "STABLE" &&
      ["USD", "USDT", "USDC"].includes(x.quote_asset)).sort((a, b) => {
        const rank = x => { const n = (exchangeNames.get(x.exchange) || "").toLowerCase();
          const i = priority.findIndex(p => n.includes(p.toLowerCase())); return i < 0 ? 999 : i; };
        return rank(a) - rank(b);
      });
    const pair = [bybitMarket, ...eligible.filter(x => x.symbol !== bybitMarket.symbol)].slice(0, 2);
    if (pair.length >= 2) selected.set(candidate.symbol, pair);
  }
  return { selected, exchangeNames };
}

function buildCrossExchange(markets, oiSeries, fundingRows, exchangeNames) {
  const oiBySymbol = new Map(oiSeries.map(x => [x.symbol, Array.isArray(x.history) ? x.history : []]));
const fundingBySymbol = new Map(
  fundingRows.map(x => [
    x.symbol,
    Number.isFinite(num(x.value)) ? num(x.value) / 100 : null
  ])
);
  const histories = markets.map(market => ({ market, history: oiBySymbol.get(market.symbol) || [] }));
  if (histories.some(x => x.history.length < 13))
    return unavailableCrossExchange("insufficient_data", "Missing 5M OI history for one or more exchanges.");
  const commonTimes = histories.map(x => new Set(x.history.map(p => Number(p.t))))
    .reduce((common, times) => new Set([...common].filter(t => times.has(t))));
  const latest = Math.max(...commonTimes);
  if (!Number.isFinite(latest))
    return unavailableCrossExchange("insufficient_data", "No common OI timestamp across exchanges.");
  const totals = new Map();
  for (const offset of [0, 300, 900, 3600]) {
    const at = latest - offset;
    if (!commonTimes.has(at)) continue;
    totals.set(at, histories.reduce((sum, x) => {
      const point = x.history.find(p => Number(p.t) === at);
      return sum + (num(point?.c) || 0);
    }, 0));
  }
  const current = totals.get(latest);
  if (!Number.isFinite(current) || current <= 0)
    return unavailableCrossExchange("insufficient_data", "Aggregated OI is unavailable.");
  const exchangeRows = histories.map(({ market, history }) => {
    const oiUsd = num(history.find(p => Number(p.t) === latest)?.c);
    return { exchange: exchangeNames.get(market.exchange) || market.exchange,
      symbol: market.symbol, symbolOnExchange: market.symbol_on_exchange,
      oiUsd: round(oiUsd, 2), oiSharePct: oiUsd !== null ? round(oiUsd / current * 100, 2) : null,
      fundingRate: fundingBySymbol.get(market.symbol) ?? null };
  });
  const bybit = exchangeRows.find(x => /bybit/i.test(x.exchange));
  const funded = exchangeRows.filter(x => Number.isFinite(x.oiUsd) && Number.isFinite(x.fundingRate));
  const fundingOi = funded.reduce((sum, x) => sum + x.oiUsd, 0);
  const fundingValue = funded.reduce((sum, x) => sum + x.oiUsd * x.fundingRate, 0);
  const changeAt = seconds => { const prior = totals.get(latest - seconds);
    return Number.isFinite(prior) && prior > 0 ? round(pct(current, prior), 2) : null; };
  return { status: "ok", source: "Coinalyze", sampleAt: latest * 1000,
    marketCount: exchangeRows.length, aggregatedOiUsd: round(current, 2),
    aggregatedFundingRate: fundingOi > 0 ? round(fundingValue / fundingOi, 8) : null,
    aggregatedFundingPct: fundingOi > 0 ? round((fundingValue / fundingOi) * 100, 4) : null,
    oi5mPct: changeAt(300), oi15mPct: changeAt(900), oi1hPct: changeAt(3600),
    bybitOiUsd: bybit?.oiUsd ?? null, bybitOiSharePct: bybit?.oiSharePct ?? null,
    exchanges: exchangeRows };
}

async function addCrossExchangeValidation(candidates, apiKey, now = Date.now()) {
  if (!apiKey) {
    candidates.forEach(row => { row.crossExchange = unavailableCrossExchange(
      "not_configured", "COINALYZE_API_KEY is not set."); });
    return { status: "not_configured", enrichedCount: 0, marketCount: 0 };
  }
  try {
    const [markets, exchanges] = await Promise.all([
      coinalyze("/future-markets", {}, apiKey), coinalyze("/exchanges", {}, apiKey)]);
    const { selected, exchangeNames } = selectCoinalyzeMarkets(candidates, markets, exchanges);
    const selectedMarkets = [...selected.values()].flat().slice(0, COINALYZE_MAX_MARKETS);
    if (!selectedMarkets.length) {
      candidates.forEach(row => { row.crossExchange = unavailableCrossExchange(
        "not_supported", "No matching cross-exchange perpetual markets."); });
      return { status: "not_supported", enrichedCount: 0, marketCount: 0 };
    }
    const symbols = selectedMarkets.map(x => x.symbol).join(",");
    const to = Math.floor(now / 1000), from = to - 2 * 3600;
    const [oiSeries, fundingRows] = await Promise.all([
      coinalyze("/open-interest-history", { symbols, interval: "5min", from: String(from),
        to: String(to), convert_to_usd: "true" }, apiKey),
      coinalyze("/funding-rate", { symbols }, apiKey),
    ]);
    let enrichedCount = 0;
    for (const row of candidates) {
      const rowMarkets = selected.get(row.symbol);
      if (!rowMarkets) {
        row.crossExchange = unavailableCrossExchange("rate_limit_budget",
          "Not selected within the 18-market Coinalyze request budget.");
        continue;
      }
      row.crossExchange = buildCrossExchange(rowMarkets, oiSeries, fundingRows, exchangeNames);
      if (row.crossExchange.status === "ok") enrichedCount++;
    }
    return { status: "ok", enrichedCount, marketCount: selectedMarkets.length };
  } catch (error) {
    candidates.forEach(row => { row.crossExchange = unavailableCrossExchange(
      "unavailable", "Coinalyze validation is temporarily unavailable."); });
    return { status: "unavailable", enrichedCount: 0, marketCount: 0, error: error.message };
  }
}

// OI PARSER — V3.1
//
// Bybit App 当前 OI 口径：
// singleOpenInterest
//
// 新增：
// 15M / 30M / 1H / 2H
// buildQuality
// consecutivePositive
// latestStep
// maxPositiveStep
// spikeRatio
// isOiSpike
// ============================================================

function parseOI(list = []) {
  const rows = [...list]
    .map((item) => ({
      ts: Number(item.timestamp),
      oi: num(item.singleOpenInterest),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.ts) &&
        item.oi !== null && item.oi > 0
    )
    .sort(
      (a, b) =>
        b.ts - a.ts
    );


  // current + 8 * 15M = 2H
  if (rows.length < 9) {
    return null;
  }

  // Do not label missing/duplicate 15M samples as a complete 2H window.
  if (rows.slice(0, 8).some((row, i) => row.ts - rows[i + 1].ts !== 900000)) {
    return null;
  }


  const current =
    rows[0].oi;


  const change = (bars) => {
    if (rows.length <= bars) {
      return null;
    }

    return pct(
      current,
      rows[bars].oi
    );
  };


  // ==========================================================
  // 最近4个15M OI step
  //
  // oldest -> newest
  // ==========================================================

  const steps = [];

  for (let i = 4; i >= 1; i--) {
    steps.push(
      round(
        pct(
          rows[i - 1].oi,
          rows[i].oi
        ),
        2
      )
    );
  }


  const validSteps =
    steps.filter(Number.isFinite);


  const positiveSteps =
    validSteps.filter(
      (value) => value > 0
    ).length;


  const negativeSteps =
    validSteps.filter(
      (value) => value < 0
    ).length;


  // ==========================================================
  // LATEST STEP
  // ==========================================================

  const latestStep =
    validSteps.length
      ? validSteps[validSteps.length - 1]
      : null;


  const priorSteps =
    validSteps.slice(0, -1);


  const priorPositiveSteps =
    priorSteps.filter(
      (value) => value > 0
    ).length;


  // ==========================================================
  // CONSECUTIVE POSITIVE
  //
  // 从最新15M向前数连续正增长
  // ==========================================================

  let consecutivePositive = 0;

  for (
    let i = validSteps.length - 1;
    i >= 0;
    i--
  ) {
    if (validSteps[i] > 0) {
      consecutivePositive++;
    } else {
      break;
    }
  }


  // ==========================================================
  // CONSECUTIVE NEGATIVE
  // ==========================================================

  let consecutiveNegative = 0;

  for (
    let i = validSteps.length - 1;
    i >= 0;
    i--
  ) {
    if (validSteps[i] < 0) {
      consecutiveNegative++;
    } else {
      break;
    }
  }


  // ==========================================================
  // MAX POSITIVE STEP
  // ==========================================================

  const positiveValues =
    validSteps.filter(
      (value) => value > 0
    );


  const maxPositiveStep =
    positiveValues.length
      ? Math.max(...positiveValues)
      : 0;


  // ==========================================================
  // BUILD QUALITY
  //
  // 0 - 100
  //
  // 奖励 OI 连续性，
  // 而不是单纯奖励单根幅度。
  // ==========================================================

  let buildQuality = 0;


  buildQuality +=
    positiveSteps * 15;


  buildQuality +=
    consecutivePositive * 10;


  if (priorPositiveSteps >= 2) {
    buildQuality += 10;
  }


  if (positiveSteps === 4) {
    buildQuality += 10;
  }


  buildQuality =
    Math.min(
      buildQuality,
      100
    );


  // ==========================================================
  // OI SPIKE
  //
  // 典型：
  //
  // -0.48
  // -0.30
  // -0.02
  // +19.26
  //
  // 最新一根贡献绝大部分1H OI增长，
  // 前面没有连续建仓。
  // ==========================================================

  const oi1h =
    change(4);


  let spikeRatio = null;

  let isOiSpike = false;


  if (
    latestStep !== null &&
    latestStep >= 3 &&
    oi1h !== null &&
    oi1h > 0
  ) {

    spikeRatio =
      latestStep /
      oi1h;


    if (
      spikeRatio >= 0.75 &&
      priorPositiveSteps <= 1
    ) {
      isOiSpike = true;
    }
  }


  return {

    current,

    oiSampleAt: rows[0].ts,
    oiHighRetention: round(current / Math.max(...rows.slice(0, 9).map(r => r.oi)), 4),
    // Evidence only; the cross-scan REBUILD state remains reserved.
    oiRebuildEvidence: rows[0].oi > rows[1].oi && rows[1].oi > rows[2].oi &&
      pct(rows[0].oi, rows[2].oi) >= 0.5 &&
      pct(rows[2].oi, Math.max(...rows.slice(3, 9).map(r => r.oi))) <= -1,


    oi15mPct:
      round(
        change(1),
        2
      ),


    oi30mPct:
      round(
        change(2),
        2
      ),


    oi1hPct:
      round(
        change(4),
        2
      ),


    oi2hPct:
      round(
        change(8),
        2
      ),


    steps,


    positiveSteps,

    negativeSteps,

    priorPositiveSteps,

    consecutivePositive,

    consecutiveNegative,

    latestStep:
      round(
        latestStep,
        2
      ),

    maxPositiveStep:
      round(
        maxPositiveStep,
        2
      ),

    buildQuality,

    spikeRatio:
      spikeRatio !== null
        ? round(
            spikeRatio,
            2
          )
        : null,

    isOiSpike,
  };
}


// ============================================================
// KLINE PARSER
// ============================================================

function parseKline(list = [], now = Date.now()) {
  const rows = [...list]
    .map((item) => ({
      ts: Number(item[0]),
      open: num(item[1]),
      high: num(item[2]),
      low: num(item[3]),
      close: num(item[4]),
      volume: num(item[5]),
      turnover: num(item[6]),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.ts) &&
        item.ts + 300000 <= now &&
        [item.open, item.high, item.low, item.close].every(v => v !== null && v > 0) &&
        item.high >= Math.max(item.open, item.close) &&
        item.low <= Math.min(item.open, item.close)
    )
    .sort(
      (a, b) =>
        b.ts - a.ts
    );


  if (rows.length < 15) {
    return null;
  }

  if (rows.slice(0, 14).some((row, i) => row.ts - rows[i + 1].ts !== 300000)) {
    return null;
  }


  const current =
    rows[0].close;


  const change = (bars) => {
    if (rows.length < bars) {
      return null;
    }

    return pct(
      current,
      rows[bars - 1].open
    );
  };


  const recentVolume =
    rows
      .slice(0, 3)
      .map(
        (item) =>
          item.volume
      )
      .filter(
        Number.isFinite
      );


  const baselineVolume =
    rows
      .slice(3, 15)
      .map(
        (item) =>
          item.volume
      )
      .filter(
        Number.isFinite
      );


  const recentAverage =
    avg(recentVolume);


  const baselineAverage =
    avg(baselineVolume);


  let volumeRatio = null;


  if (
    recentAverage !== null &&
    baselineAverage !== null &&
    baselineAverage > 0
  ) {
    volumeRatio =
      recentAverage /
      baselineAverage;
  }


  return {

    // Use completed bars: 1/3/12 bars mean exactly 5M/15M/1H.
    priceSampleAt: rows[0].ts + 300000,
    priceStructure: priceStructure(rows),

    price5mPct:
      round(
        change(1),
        2
      ),


    price15mPct:
      round(
        change(3),
        2
      ),


    price1hPct:
      round(
        change(12),
        2
      ),


    volume15mRatio:
      round(
        volumeRatio,
        2
      ),
  };
}

// ============================================================
// V4.1 — 5M PRICE × OI FLOW
//
// Reconstruct recent Price/OI history directly from Bybit.
// No persisted 5M snapshots are required.
//
// We try both possible OI timestamp alignments:
// 1. OI timestamp == candle close time
// 2. OI timestamp == candle start time
//
// Whichever produces more valid aligned samples is used.
// ============================================================

function pearson(xs = [], ys = []) {

  if (
    xs.length !== ys.length ||
    xs.length < 3
  ) {
    return null;
  }


  const mx = avg(xs);
  const my = avg(ys);


  if (
    mx === null ||
    my === null
  ) {
    return null;
  }


  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;


  for (
    let i = 0;
    i < xs.length;
    i++
  ) {

    const dx =
      xs[i] - mx;

    const dy =
      ys[i] - my;


    numerator +=
      dx * dy;

    dx2 +=
      dx * dx;

    dy2 +=
      dy * dy;
  }


  if (
    dx2 === 0 ||
    dy2 === 0
  ) {
    return null;
  }


  return (
    numerator /
    Math.sqrt(
      dx2 * dy2
    )
  );
}


// ============================================================
// 5M FLOW PARSER
// ============================================================

function parsePriceOiFlow5m(
  klineList = [],
  oiList = [],
  now = Date.now()
) {

  // ----------------------------------------------------------
  // CLOSED 5M PRICE CANDLES
  // ----------------------------------------------------------

  const prices =
    [...klineList]

      .map(
        (item) => ({

          start:
            Number(item[0]),

          closeAt:
            Number(item[0]) +
            300000,

          open:
            num(item[1]),

          high:
            num(item[2]),

          low:
            num(item[3]),

          close:
            num(item[4]),

          volume:
            num(item[5]),
        })
      )

      .filter(
        (row) =>
          Number.isFinite(
            row.start
          ) &&

          row.closeAt <= now &&

          [
            row.open,
            row.high,
            row.low,
            row.close,
          ].every(
            (value) =>
              value !== null &&
              value > 0
          )
      )

      .sort(
        (a, b) =>
          b.start -
          a.start
      );


  // ----------------------------------------------------------
  // 5M OI
  // ----------------------------------------------------------

  const oiRows =
    [...oiList]

      .map(
        (item) => ({

          ts:
            Number(
              item.timestamp
            ),

          oi:
            num(
              item.singleOpenInterest
            ),
        })
      )

      .filter(
        (row) =>
          Number.isFinite(
            row.ts
          ) &&

          row.oi !== null &&
          row.oi > 0 &&
          row.ts <= now
      )

      .sort(
        (a, b) =>
          b.ts -
          a.ts
      );


  if (
    prices.length < 14 ||
    oiRows.length < 14
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // TIMESTAMP ALIGNMENT
  //
  // Bybit explicitly documents Kline timestamp as startTime,
  // while OI only exposes timestamp.
  //
  // Therefore try both:
  // OI timestamp = candle close
  // OI timestamp = candle start
  //
  // Use the alignment producing more samples.
  // ----------------------------------------------------------

  const priceByClose =
    new Map(

      prices.map(
        (row) => [
          row.closeAt,
          row
        ]
      )
    );


  const priceByStart =
    new Map(

      prices.map(
        (row) => [
          row.start,
          row
        ]
      )
    );


  const align =
    (priceMap) =>

      oiRows

        .map(
          (oiRow) => {

            const price =
              priceMap.get(
                oiRow.ts
              );


            if (!price) {
              return null;
            }


            return {

              ts:
                oiRow.ts,

              oi:
                oiRow.oi,

              price:
                price.close,

              low:
                price.low,

              high:
                price.high,

              volume:
                price.volume,
            };
          }
        )

        .filter(Boolean)

        .sort(
          (a, b) =>
            a.ts -
            b.ts
        );


  const closeAligned =
    align(
      priceByClose
    );


  const startAligned =
    align(
      priceByStart
    );


  const aligned =
    closeAligned.length >=
    startAligned.length

      ? closeAligned

      : startAligned;


  const alignmentMode =
    closeAligned.length >=
    startAligned.length

      ? "OI_TO_CANDLE_CLOSE"

      : "OI_TO_CANDLE_START";


  if (
    aligned.length < 13
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // Require continuous 5M timestamps.
  // ----------------------------------------------------------

  const recentAligned =
    aligned.slice(-25);


  if (
    recentAligned
      .slice(1)
      .some(
        (row, index) =>
          row.ts -
          recentAligned[index].ts !==
          300000
      )
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // BUILD 5M TRANSITIONS
  // oldest -> newest
  // ----------------------------------------------------------

  const steps = [];


  for (
    let i = 1;
    i < recentAligned.length;
    i++
  ) {

    const prev =
      recentAligned[i - 1];

    const curr =
      recentAligned[i];


    const pricePct =
      pct(
        curr.price,
        prev.price
      );


    const oiPct =
      pct(
        curr.oi,
        prev.oi
      );


    if (
      !Number.isFinite(
        pricePct
      ) ||

      !Number.isFinite(
        oiPct
      )
    ) {
      continue;
    }


    let state =
      "MIXED";


    // --------------------------------------------------------
    // OI UP + PRICE DOWN
    // --------------------------------------------------------

    if (
      oiPct >= 0.15 &&
      pricePct <= -0.10
    ) {

      state =
        "SHORT_BUILD";
    }


    // --------------------------------------------------------
    // OI DOWN + PRICE DOWN
    // --------------------------------------------------------

    else if (
      oiPct <= -0.15 &&
      pricePct <= -0.10
    ) {

      state =
        "DELEVERAGING";
    }


    // --------------------------------------------------------
    // OI DOWN + PRICE UP
    // --------------------------------------------------------

    else if (
      oiPct <= -0.15 &&
      pricePct >= 0.10
    ) {

      state =
        "SHORT_COVERING";
    }


    // --------------------------------------------------------
    // OI UP + PRICE UP
    // --------------------------------------------------------

    else if (
      oiPct >= 0.15 &&
      pricePct >= 0.10
    ) {

      state =
        "LONG_BUILD";
    }


    // --------------------------------------------------------
    // OI UP + PRICE QUIET
    // --------------------------------------------------------

    else if (
      oiPct >= 0.15 &&
      Math.abs(
        pricePct
      ) < 0.10
    ) {

      state =
        "POSITION_BUILD";
    }


    steps.push({

      ts:
        curr.ts,

      price:
        round(
          curr.price,
          10
        ),

      oi:
        round(
          curr.oi,
          4
        ),

      pricePct:
        round(
          pricePct,
          3
        ),

      oiPct:
        round(
          oiPct,
          3
        ),

      state,
    });
  }


  if (
    steps.length < 12
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // WINDOW HELPERS
  // ----------------------------------------------------------

  const sum =
    (rows, key) =>

      rows.reduce(
        (total, row) =>

          total +

          (
            Number.isFinite(
              row[key]
            )

              ? row[key]

              : 0
          ),

        0
      );


  const recent6 =
    steps.slice(-6);


  const prior6 =
    steps.slice(
      -12,
      -6
    );


  // ----------------------------------------------------------
  // CORRELATION
  // ----------------------------------------------------------

  const correlation30m =
    pearson(

      recent6.map(
        (row) =>
          row.pricePct
      ),

      recent6.map(
        (row) =>
          row.oiPct
      )
    );


  const correlationPrior30m =
    pearson(

      prior6.map(
        (row) =>
          row.pricePct
      ),

      prior6.map(
        (row) =>
          row.oiPct
      )
    );


  const recent12 =
    steps.slice(-12);


  const correlation60m =
    pearson(

      recent12.map(
        (row) =>
          row.pricePct
      ),

      recent12.map(
        (row) =>
          row.oiPct
      )
    );


  const recentPrice30m =
    sum(
      recent6,
      "pricePct"
    );


  const recentOi30m =
    sum(
      recent6,
      "oiPct"
    );


  const priorPrice30m =
    sum(
      prior6,
      "pricePct"
    );


  const priorOi30m =
    sum(
      prior6,
      "oiPct"
    );


  const shortBuildRecent =
    recent6.filter(
      (row) =>
        row.state ===
        "SHORT_BUILD"
    ).length;


  const shortCoverRecent =
    recent6.filter(
      (row) =>
        row.state ===
        "SHORT_COVERING"
    ).length;


  const deleverageRecent =
    recent6.filter(
      (row) =>
        row.state ===
        "DELEVERAGING"
    ).length;


  const priorShortBuild =
    prior6.filter(
      (row) =>
        row.state ===
        "SHORT_BUILD"
    ).length;


  const priorDeleveraging =
    prior6.filter(
      (row) =>
        row.state ===
        "DELEVERAGING"
    ).length;


  // ==========================================================
  // CORRELATION FLIP
  //
  // Example:
  //
  // earlier:
  // OI ↓ + Price ↓
  // → positive correlation / deleveraging
  //
  // later:
  // OI ↓ + Price ↑
  // → negative correlation / short covering
  //
  // Require actual state sequence, not correlation alone.
  // ==========================================================

  const correlationFlip =

    correlationPrior30m !==
      null &&

    correlation30m !==
      null &&


    correlationPrior30m >=
      0.15 &&

    correlation30m <=
      -0.20 &&


    recentPrice30m >=
      0.25 &&

    recentOi30m <=
      -0.35 &&


    shortCoverRecent >=
      2 &&


    (
      priorShortBuild >=
        1 ||

      priorDeleveraging >=
        2
    );


  // ==========================================================
  // REBUILD
  //
  // Previous phase:
  // OI reduction / short covering.
  //
  // Latest 15M:
  // OI starts building again,
  // but price refuses to make a fresh low.
  // ==========================================================

  const last3 =
    steps.slice(-3);


  const beforeLast3 =
    steps.slice(
      -9,
      -3
    );


  const rebuildOi =
    sum(
      last3,
      "oiPct"
    );


  const rebuildPrice =
    sum(
      last3,
      "pricePct"
    );


  const previousReduction =
    beforeLast3.filter(

      (row) =>
        row.state ===
          "SHORT_COVERING" ||

        row.state ===
          "DELEVERAGING"
    ).length;


  const latestPoint =
    recentAligned[
      recentAligned.length -
      1
    ];


  const priorPoints =
    recentAligned.slice(
      -9,
      -3
    );


  const previousLow =
    priorPoints.length

      ? Math.min(
          ...priorPoints.map(
            (row) =>
              row.low
          )
        )

      : null;


  const priceRefusedNewLow =

    previousLow !==
      null &&

    latestPoint.low >=
      previousLow *
      0.9985;


  const rebuild =

    rebuildOi >=
      0.40 &&

    rebuildPrice >=
      -0.15 &&

    previousReduction >=
      2 &&

    priceRefusedNewLow;


  return {

    alignmentMode,


    sampleCount:
      recentAligned.length,


    stepCount:
      steps.length,


    correlation30m:

      correlation30m !==
        null

        ? round(
            correlation30m,
            3
          )

        : null,


    correlationPrior30m:

      correlationPrior30m !==
        null

        ? round(
            correlationPrior30m,
            3
          )

        : null,


    correlation60m:

      correlation60m !==
        null

        ? round(
            correlation60m,
            3
          )

        : null,


    priorPrice30mPct:
      round(
        priorPrice30m,
        3
      ),


    priorOi30mPct:
      round(
        priorOi30m,
        3
      ),


    recentPrice30mPct:
      round(
        recentPrice30m,
        3
      ),


    recentOi30mPct:
      round(
        recentOi30m,
        3
      ),


    shortBuildRecent,

    shortCoverRecent,

    deleverageRecent,

    priorShortBuild,

    priorDeleveraging,


    correlationFlip,

    rebuild,


    rebuildOiPct:
      round(
        rebuildOi,
        3
      ),


    rebuildPricePct:
      round(
        rebuildPrice,
        3
      ),


    priceRefusedNewLow,


    // Keep only last hour in JSON output.
    recentSteps:
      steps.slice(-12),
  };
}
// ============================================================
// V4 price evidence from completed 5M candles, newest first.
// A quiet price alone is not refusal; require a support retest + recovery,
// or two closes reclaiming the preceding 15M high.
function priceStructure(rows) {
  const support = Math.min(...rows.slice(3, 12).map(r => r.low));
  const recentLow = Math.min(...rows.slice(0, 3).map(r => r.low));
  const keyLevel = Math.max(...rows.slice(3, 6).map(r => r.high));
  const supportHeld = recentLow >= support * 0.9985 &&
    recentLow <= support * 1.0015 &&
    rows[0].close >= support && rows[1].close >= support &&
    pct(rows[0].close, recentLow) >= 0.3 && rows[0].close >= rows[1].close;
  const keyLevelReclaimed = rows[2].close <= keyLevel &&
    rows[1].close > keyLevel && rows[0].close > keyLevel;
  const lowerLows = rows[0].low < rows[1].low * 0.9995 &&
    rows[1].low < rows[2].low * 0.9995 &&
    rows[0].close < rows[1].close && rows[1].close < rows[2].close;
  return { support, recentLow, keyLevel, supportHeld, keyLevelReclaimed, lowerLows };
}

// Discovery stays direction-agnostic. V4 execution takes precedence over
// the legacy signal/trigger, which are retained separately for comparison.
const EXECUTION_RULES = Object.freeze({
  version: "OI-RADAR-V4.1",
  price5mNoisePct: 0.1,
  price15mNoisePct: 0.2,
  price1hNoisePct: 0.5,
  oi15mNoisePct: 0.3,
  oi30mNoisePct: 0.5,
  oiHighRetention: 0.97,
  minBuildQuality: 40,
  minRefusalVolume: 1.1,
  maxPriceAgeMs: 900000,
  maxOiAgeMs: 2100000,
});

function oiIsFalling(x) {
  return (x.oi15mPct <= -0.3 && x.oi30mPct <= -0.5) ||
    (x.oi15mPct <= 0 && x.oi1hPct <= -1 && x.oi2hPct <= -1);
}

function executionState(x, now = Date.now()) {
  const r = EXECUTION_RULES;
  const evidence = {

    oiHigh:
      false,

    oiRebuilding:
      false,

    priceRefusal:
      false,

    squeezeEligible:
      false,


    correlationFlip:
      x.flow5m?.correlationFlip ===
      true,


    rebuild:
      x.flow5m?.rebuild ===
      true,


    extensions: {

      CORRELATION_FLIP:
        x.flow5m?.correlationFlip ===
        true,

      REBUILD:
        x.flow5m?.rebuild ===
        true,
    },
  };
  const result = (state, bias, reason) => ({
    executionState: state, directionalBias: bias, stateReason: reason,
    executionEvidence: evidence,
  });
  const required = ["oi15mPct", "oi30mPct", "oi1hPct", "oi2hPct",
    "price5mPct", "price15mPct", "price1hPct", "oiSampleAt", "priceSampleAt"];
  if (required.some(key => !Number.isFinite(x[key])) ||
      now - x.priceSampleAt > r.maxPriceAgeMs || now - x.oiSampleAt > r.maxOiAgeMs ||
      x.priceSampleAt > now || x.oiSampleAt > now ||
      Math.abs(x.priceSampleAt - x.oiSampleAt) > r.maxOiAgeMs) {
    return result("INSUFFICIENT_DATA", "NEUTRAL", "Missing, stale or unaligned Price/OI samples; execution withheld.");
  }
  const { oi15mPct: o15, oi30mPct: o30, oi1hPct: o1, oi2hPct: o2,
    price5mPct: p5, price15mPct: p15, price1hPct: p1 } = x;
  const falling = oiIsFalling(x);
  const rising = o15 >= r.oi15mNoisePct && (o30 >= r.oi30mNoisePct || o1 >= 1);
  const priceDown = (p15 <= -r.price15mNoisePct && p5 <= 0) ||
    (p1 <= -r.price1hNoisePct && p15 <= 0 && p5 < r.price5mNoisePct);
  const priceUp = (p15 >= r.price15mNoisePct && p5 >= 0) ||
    (p1 >= r.price1hNoisePct && p15 >= 0 && p5 > -r.price5mNoisePct);
  evidence.oiHigh = Number.isFinite(x.oiHighRetention) &&
    x.oiHighRetention >= r.oiHighRetention && (o1 >= 3 || o2 >= 5);
  evidence.oiRebuilding =

    (
      x.oiRebuildEvidence ===
        true ||

      evidence.rebuild
    ) &&

    x.buildQuality >=
      r.minBuildQuality;
  // ==========================================================
  // V4.1 — CORRELATION FLIP
  //
  // This must be evaluated before generic OI falling logic,
  // otherwise it would only appear as SHORT_COVERING.
  // ==========================================================

  if (
    evidence.correlationFlip
  ) {

    return result(

      "CORRELATION_FLIP",

      "BULLISH",

      "5M Price/OI relationship flipped from prior same-direction deleveraging into price-up / OI-down short covering."
    );
  }


  // ==========================================================
  // V4.1 — REBUILD
  //
  // OI comes back after deleveraging / covering,
  // while price refuses to make another low.
  // ==========================================================

  if (
    evidence.rebuild
  ) {

    const rebuildRefusal =

      p5 >=
        r.price5mNoisePct &&

      p15 >=
        0 &&

      p1 <
        5 &&

      x.volume15mRatio >=
        r.minRefusalVolume &&

      (
        x.priceStructure
          ?.supportHeld ===
          true ||

        x.priceStructure
          ?.keyLevelReclaimed ===
          true ||

        x.flow5m
          ?.priceRefusedNewLow ===
          true
      );


    // --------------------------------------------------------
    // REBUILD + PRICE REFUSAL
    // --------------------------------------------------------

    if (
      rebuildRefusal
    ) {

      evidence.priceRefusal =
        true;


      evidence.squeezeEligible =

        Number.isFinite(
          x.fundingRate
        ) &&

        x.fundingRate <=
          -0.0005;


      return result(

        "PRICE_REFUSAL",

        "BULLISH",

        "5M OI rebuilt after deleveraging/covering while price refused a fresh low; price and volume confirm the rebuild."
      );
    }


    return result(

      "REBUILD",

      "BULLISH",

      "5M OI is rebuilding after a prior deleveraging/covering sequence while price refuses a fresh low."
    );
  }
  // Falling OI wins over the historical high: a covering bounce is not new longs.
  if (falling) {
    if (priceUp) return result("SHORT_COVERING", "BULLISH", "OI declining while price rises; covering-compatible bounce, not fresh long accumulation.");
    if (priceDown) return result("DELEVERAGING", "BEARISH", "OI and price declining together; positions are being reduced.");
    return result("OI_REDUCTION", "NEUTRAL", "OI declining but price direction is mixed or inside the noise band.");
  }
  if (rising && priceDown) {
    const control = x.priceStructure?.lowerLows === true &&
      p5 <= -r.price5mNoisePct && p15 <= -r.price15mNoisePct && p1 <= -r.price1hNoisePct &&
      o30 >= r.oi30mNoisePct && o1 >= 1 && x.buildQuality >= r.minBuildQuality &&
      x.volume15mRatio >= 1.1;
    return control
      ? result("SHORT_CONTROL", "BEARISH", "OI builds across windows while 5M/15M/1H price falls; successive lower lows and volume confirm downside control.")
      : result("SHORT_BUILD", "BEARISH", "OI rises while price falls; added exposure is not a long signal, even with negative funding or an OI spike.");
  }
  evidence.priceRefusal = (evidence.oiHigh || evidence.oiRebuilding) &&
    o15 >= 0 && o30 >= 0 && p5 >= r.price5mNoisePct && p15 >= 0 && p1 < 5 &&
    x.buildQuality >= r.minBuildQuality && x.isOiSpike !== true &&
    x.volume15mRatio >= r.minRefusalVolume &&
    (x.priceStructure?.supportHeld === true || x.priceStructure?.keyLevelReclaimed === true);
  evidence.squeezeEligible = evidence.priceRefusal &&
    Number.isFinite(x.fundingRate) && x.fundingRate <= -0.0005;
  if (evidence.priceRefusal) {
    return result("PRICE_REFUSAL", "BULLISH", x.priceStructure.keyLevelReclaimed
      ? "Retained/rebuilding OI plus two closes reclaiming the preceding 15M high, with build quality and volume confirmation."
      : "Retained/rebuilding OI plus a held support retest and price recovery, with build quality and volume confirmation.");
  }
  if (rising || (o15 >= 0 && (o30 >= 1 || o1 >= 2 || o2 >= 5))) {
    return result("POSITION_BUILD", "NEUTRAL", "OI exposure is building/retained; no confirmed bearish control or price-refusal setup. Direction is not inferred from OI alone.");
  }
  return result("WATCH", "NEUTRAL", "Price/OI windows are mixed or inside noise bands; no execution setup confirmed.");
}

function applyExecution(x, now = Date.now()) {
  x.legacySignal = classify(x);
  x.legacyTrigger = triggerState(x);
  x.legacyScore = finalScore({ ...x, signal: x.legacySignal, trigger: x.legacyTrigger });
  Object.assign(x, executionState(x, now));
  x.signal = x.executionState;
  x.trigger = "NONE";
  const extended = x.price1hPct >= 12 || (x.price1hPct >= 8 && x.price15mPct >= 3);
  x.executionRisk = extended ? "EXTENDED" : null;
  if (x.executionState === "PRICE_REFUSAL") {
    x.signal = x.executionEvidence.squeezeEligible ? "SQUEEZE_READY" : "PRICE_REFUSAL";
    if (x.price5mPct >= 0.3 && x.price15mPct > 0 && x.volume15mRatio >= 1.5) {
      x.signal = "TRIGGERING";
      x.trigger = "ACTIVE";
    } else {
      x.trigger = "EARLY";
    }
  } else if (
    x.executionState ===
    "CORRELATION_FLIP"
  ) {

    x.trigger =
      "FLIP_WATCH";


  } else if (
    x.executionState ===
    "REBUILD"
  ) {

    x.trigger =
      "REBUILD_WATCH";


  } else if (
    x.executionState ===
    "SHORT_CONTROL"
  ) {

    x.trigger =
      "DOWNSIDE_ACTIVE";


  } else if (
    x.executionState ===
    "SHORT_BUILD"
  ) {

    x.trigger =
      "DOWNSIDE_WATCH";


  } else if (
    x.executionState ===
    "POSITION_BUILD"
  ) {

    x.trigger =
      x.isOiSpike

        ? "SPIKE_WAIT"

        : "LOADING";
  }
  if (extended) x.trigger = "NONE";
  // score ranks radar attention, not long conviction; funding only rewards
  // confirmed price refusal. Preserve the old score for comparisons.
  x.score = finalScore({ ...x,
    fundingRate: x.executionState === "PRICE_REFUSAL" ? x.fundingRate : 0,
    signal: extended ? "EXTENDED" : x.isOiSpike ? "OI_SPIKE" : x.signal,
  });
  return x;
}

// ============================================================
// DISCOVERY SCORE
//
// 只负责第一层 OI 异常发现。
// Funding 不负责决定谁进入。
// ============================================================

function discoveryScore(x) {
  let score = 0;


  const oi15 =
    x.oi15mPct ?? 0;

  const oi30 =
    x.oi30mPct ?? 0;

  const oi1h =
    x.oi1hPct ?? 0;


  score +=
    Math.max(
      oi15,
      0
    ) * 5;


  score +=
    Math.max(
      oi30,
      0
    ) * 3;


  score +=
    Math.max(
      oi1h,
      0
    ) * 4;


  score +=
    (x.positiveSteps || 0) * 2;


  if (oi15 >= 1) {
    score += 5;
  }


  if (oi15 >= 2) {
    score += 8;
  }


  if (oi15 >= 4) {
    score += 12;
  }


  if (oi1h >= 3) {
    score += 8;
  }


  if (oi1h >= 5) {
    score += 12;
  }


  if (oi1h >= 8) {
    score += 18;
  }


  return round(
    score,
    2
  );
}


// ============================================================
// V3.1 STATE MACHINE
//
// ACCUMULATING
//      ↓
// SQUEEZE_READY
//      ↓
// TRIGGERING
//      ↓
// EXTENDED
//      ↓
// UNWINDING
//
// 特殊状态：
//
// OI_SPIKE
// COOLING
// OI_WATCH
// ============================================================

function classify(x) {

  const oi15 =
    x.oi15mPct ?? 0;

  const oi30 =
    x.oi30mPct ?? 0;

  const oi1h =
    x.oi1hPct ?? 0;

  const oi2h =
    x.oi2hPct ?? 0;


  const p5 =
    x.price5mPct ?? 0;

  const p15 =
    x.price15mPct ?? 0;

  const p1h =
    x.price1hPct ?? 0;


  const volume =
    x.volume15mRatio ?? 0;


  const funding =
    x.fundingRate ?? 0;


  const positiveSteps =
    x.positiveSteps ?? 0;


  const negativeSteps =
    x.negativeSteps ?? 0;


  const consecutiveNegative =
    x.consecutiveNegative ?? 0;


  const buildQuality =
    x.buildQuality ?? 0;


  // ==========================================================
  // 1. EXTENDED
  // ==========================================================

  if (
    p1h >= 12 ||
    (
      p1h >= 8 &&
      p15 >= 3
    )
  ) {
    return "EXTENDED";
  }


  // ==========================================================
  // 2. UNWINDING
  //
  // 必须是真正持续撤仓。
  // ==========================================================

  const hardUnwind =
    oi15 <= -1 &&
    oi30 <= -1;


  const persistentUnwind =
    consecutiveNegative >= 2 &&
    oi15 <= -0.5 &&
    oi30 < 0;


  const fullUnwind =
    oi15 < 0 &&
    oi30 < 0 &&
    oi1h < 0 &&
    negativeSteps >= 2;


  const longUnwind =
    oi30 < 0 &&
    oi1h < 0 &&
    oi2h < 0 &&
    negativeSteps >= 2;


  if (
    hardUnwind ||
    persistentUnwind ||
    fullUnwind ||
    longUnwind
  ) {
    return "UNWINDING";
  }


  // ==========================================================
  // 3. COOLING
  //
  // 中周期仍有明显 OI，
  // 最新15M轻微回吐。
  // ==========================================================

  if (
    oi15 < 0 &&
    oi15 > -1 &&
    (
      oi30 >= 2 ||
      oi1h >= 3 ||
      oi2h >= 5
    )
  ) {
    return "COOLING";
  }


  // ==========================================================
  // 4. OI SPIKE
  //
  // 最新一根突然出现巨大 OI，
  // 但此前没有连续建仓。
  //
  // 不直接视为干净的 ACCUMULATING。
  // ==========================================================

  if (
    x.isOiSpike === true &&
    p1h < 8
  ) {
    return "OI_SPIKE";
  }


  // ==========================================================
  // 5. TRIGGERING
  //
  // 必须：
  //
  // OI建立
  // + 有一定连续性
  // + 价格转强
  // + 成交量确认
  // ==========================================================

  const oiEstablished =
    oi15 >= 0.3 &&
    (
      oi30 >= 1 ||
      oi1h >= 2 ||
      positiveSteps >= 3
    );


  const qualityConfirmed =
    buildQuality >= 40;


  const priceTrigger =
    p5 >= 0.25 &&
    p15 > 0;


  const volumeTrigger =
    volume >= 1.2;


  if (
    oiEstablished &&
    qualityConfirmed &&
    priceTrigger &&
    volumeTrigger &&
    p1h < 8
  ) {
    return "TRIGGERING";
  }


  // ==========================================================
  // 6. SQUEEZE READY
  //
  // 负 Funding
  // + OI持续建立
  // + 价格尚未释放
  // ==========================================================

  const squeezeOI =
    (
      oi15 >= 0.5 ||
      oi30 >= 2 ||
      oi1h >= 3
    ) &&
    positiveSteps >= 2 &&
    buildQuality >= 40;


  const priceNotReleased =
    p1h > -5 &&
    p1h <= 5;


  if (
    squeezeOI &&
    funding <= -0.0005 &&
    priceNotReleased
  ) {
    return "SQUEEZE_READY";
  }


  // ==========================================================
  // 7. ACCUMULATING
  //
  // OI先动，
  // 价格尚未明显释放。
  // ==========================================================

  const sustainedBuild =
    positiveSteps >= 3 &&
    oi1h >= 0.5 &&
    buildQuality >= 50;


  const acceleratedBuild =
    oi15 >= 0.5 &&
    oi30 >= 1 &&
    buildQuality >= 40;


  const strongHourlyBuild =
    oi1h >= 3 &&
    oi15 >= 0 &&
    buildQuality >= 40;


  if (
    (
      sustainedBuild ||
      acceleratedBuild ||
      strongHourlyBuild
    ) &&
    p1h > -5 &&
    p1h <= 5
  ) {
    return "ACCUMULATING";
  }


  // ==========================================================
  // 8. OI WATCH
  // ==========================================================

  if (
    oi1h >= 2 ||
    oi30 >= 1 ||
    oi15 >= 0.5
  ) {
    return "OI_WATCH";
  }


  return null;
}


// ============================================================
// TRIGGER STATE
//
// signal = 中周期结构
// trigger = 当前5M是否点火
// ============================================================

function triggerState(x) {

  const p5 =
    x.price5mPct ?? 0;


  const p15 =
    x.price15mPct ?? 0;


  const oi15 =
    x.oi15mPct ?? 0;


  const oi30 =
    x.oi30mPct ?? 0;


  const volume =
    x.volume15mRatio ?? 0;


  const buildQuality =
    x.buildQuality ?? 0;


  // ==========================================================
  // SPIKE 不能因为价格刚好上涨
  // 就直接获得 ACTIVE。
  // ==========================================================

  if (
    x.isOiSpike === true
  ) {

    if (
      p5 >= 0.3 &&
      p15 > 0 &&
      volume >= 1.5
    ) {
      return "SPIKE_ACTIVE";
    }

    return "SPIKE_WAIT";
  }


  // ==========================================================
  // ACTIVE
  // ==========================================================

  if (
    oi15 > 0 &&
    buildQuality >= 40 &&
    p5 >= 0.3 &&
    p15 > 0 &&
    volume >= 1.5
  ) {
    return "ACTIVE";
  }


  // ==========================================================
  // EARLY
  // ==========================================================

  if (
    oi15 > 0 &&
    buildQuality >= 40 &&
    p5 > 0.15 &&
    p15 >= 0 &&
    volume >= 1.1
  ) {
    return "EARLY";
  }


  // ==========================================================
  // LOADING
  //
  // OI建立，
  // 价格尚未启动。
  // ==========================================================

  if (
    (
      oi15 >= 0.5 ||
      oi30 >= 1
    ) &&
    Math.abs(p5) <= 0.5 &&
    volume < 1.5
  ) {
    return "LOADING";
  }


  // ==========================================================
  // VOLUME ONLY
  // ==========================================================

  if (
    oi15 > 0 &&
    volume >= 1.5
  ) {
    return "VOLUME_ONLY";
  }


  return "NONE";
}


// ============================================================
// FINAL SCORE — V3.1
//
// 重点：
//
// 1. OI幅度
// 2. OI连续性
// 3. Funding
// 4. Volume
// 5. Price位置
//
// 单根 OI SPIKE 不再轻易霸榜。
// ============================================================

function finalScore(x) {

  let score = 0;


  const oi15 =
    x.oi15mPct ?? 0;


  const oi30 =
    x.oi30mPct ?? 0;


  const oi1h =
    x.oi1hPct ?? 0;


  const oi2h =
    x.oi2hPct ?? 0;


  const funding =
    x.fundingRate ?? 0;


  const volume =
    x.volume15mRatio ?? 0;


  const p5 =
    x.price5mPct ?? 0;


  const p15 =
    x.price15mPct ?? 0;


  const p1h =
    x.price1hPct ?? 0;


  const buildQuality =
    x.buildQuality ?? 0;


  // ==========================================================
  // OI MAGNITUDE
  //
  // 全部封顶。
  // ==========================================================

  score += Math.min(
    Math.max(oi15, 0) * 3,
    12
  );


  score += Math.min(
    Math.max(oi30, 0) * 1.8,
    14
  );


  score += Math.min(
    Math.max(oi1h, 0) * 2,
    20
  );


  // 2H 只给少量背景分
  score += Math.min(
    Math.max(oi2h, 0) * 0.5,
    8
  );


  // ==========================================================
  // BUILD QUALITY
  //
  // 阶梯建仓成为核心加分项。
  // ==========================================================

  score += Math.min(
    buildQuality * 0.18,
    18
  );


  if (
    x.consecutivePositive >= 3
  ) {
    score += 5;
  }


  if (
    x.consecutivePositive === 4
  ) {
    score += 4;
  }


  // ==========================================================
  // FUNDING
  // ==========================================================

  if (
    funding <= -0.0005
  ) {
    score += 5;
  }


  if (
    funding <= -0.001
  ) {
    score += 7;
  }


  if (
    funding <= -0.003
  ) {
    score += 5;
  }


  // ==========================================================
  // VOLUME
  // ==========================================================

  if (
    volume >= 1.1
  ) {
    score += 4;
  }


  if (
    volume >= 1.5
  ) {
    score += 6;
  }


  if (
    volume >= 2
  ) {
    score += 4;
  }


  // ==========================================================
  // TRIGGER
  // ==========================================================

  if (
    x.trigger === "EARLY"
  ) {
    score += 8;
  }


  if (
    x.trigger === "ACTIVE"
  ) {
    score += 15;
  }


  if (
    x.trigger === "LOADING"
  ) {
    score += 5;
  }


  if (
    x.trigger === "SPIKE_ACTIVE"
  ) {
    score += 3;
  }


  // ==========================================================
  // STATE
  // ==========================================================

  if (
    x.signal === "ACCUMULATING"
  ) {
    score += 14;
  }


  if (
    x.signal === "SQUEEZE_READY"
  ) {
    score += 20;
  }


  if (
    x.signal === "TRIGGERING"
  ) {
    score += 22;
  }


  if (
    x.signal === "OI_SPIKE"
  ) {
    score -= 15;
  }


  if (
    x.signal === "COOLING"
  ) {
    score -= 8;
  }


  if (
    x.signal === "EXTENDED"
  ) {
    score -= 30;
  }


  if (
    x.signal === "UNWINDING"
  ) {
    score -= 45;
  }


  // ==========================================================
  // EARLY PRICE POSITION
  //
  // 奖励：
  //
  // OI已经动
  // 价格还没明显动
  // ==========================================================

  if (
    p1h >= -1 &&
    p1h <= 3
  ) {
    score += 8;
  }


  if (
    p15 >= 0 &&
    p15 <= 1.5
  ) {
    score += 4;
  }


  if (
    p5 > 0 &&
    p5 <= 0.8
  ) {
    score += 3;
  }


  // ==========================================================
  // PRICE ALREADY MOVED
  // ==========================================================

  if (
    p1h > 5
  ) {
    score -= 8;
  }


  if (
    p1h > 8
  ) {
    score -= 15;
  }


  if (
    p1h > 12
  ) {
    score -= 30;
  }


  return round(
    score,
    1
  );
}


// ============================================================
// MAIN
// ============================================================

export default async function handler(
  req,
  res
) {

  const started =
    Date.now();


 let oiErrors = 0;

  let klineErrors = 0;

  let flowErrors = 0;

  let flow5mParsedCount = 0;

  const errorSamples = [];


  try {

    // ========================================================
    // 1. TICKERS
    // ========================================================

    const tickerResult =
      await bybit(
        "/v5/market/tickers",
        {
          category: "linear",
        }
      );


    const tickers =
      tickerResult.list || [];


    // ========================================================
    // 2. INSTRUMENTS
    // ========================================================

    let instruments = [];

    let cursor = "";


    do {

      const params = {

        category:
          "linear",

        limit:
          "1000",
      };


      if (cursor) {
        params.cursor =
          cursor;
      }


      const result =
        await bybit(
          "/v5/market/instruments-info",
          params
        );


      instruments.push(
        ...(result.list || [])
      );


      cursor =
        result.nextPageCursor ||
        "";


    } while (cursor);


    // ========================================================
    // 3. BYBIT USDT LINEAR PERPETUAL ONLY
    // ========================================================

    const allowed =
      new Set(

        instruments

          .filter(
            (item) =>
              item.status ===
                "Trading" &&

              item.contractType ===
                "LinearPerpetual" &&

              item.quoteCoin ===
                "USDT"
          )

          .map(
            (item) =>
              item.symbol
          )
      );


    const universe =
      tickers

        .filter(
          (item) =>
            allowed.has(
              item.symbol
            )
        )

        .map(
          (item) => ({

            symbol:
              item.symbol,


            price:
              num(
                item.lastPrice
              ),


            price24hPct:
              num(
                item.price24hPcnt
              ) !== null

                ? num(
                    item.price24hPcnt
                  ) * 100

                : null,


            turnover24h:
              num(
                item.turnover24h
              ),


            fundingRate:
              num(
                item.fundingRate
              ),


            tickerSingleOI:
              num(
                item.singleOpenInterest
              ),
          })
        )

        .filter(
          (item) =>
            item.price !== null &&
            item.turnover24h !== null &&
            item.turnover24h >=
              500000
        );


    // ========================================================
    // 4. FULL MARKET OI SCAN
    // ========================================================

    const oiRows = [];


    for (
      let i = 0;
      i < universe.length;
      i += 15
    ) {

      const batch =
        universe.slice(
          i,
          i + 15
        );


      const data =
        await Promise.all(

          batch.map(
            async (ticker) => {

              try {

                const result =
                  await bybit(
                    "/v5/market/open-interest",
                    {

                      category:
                        "linear",

                      symbol:
                        ticker.symbol,

                      intervalTime:
                        "15min",

                      // ======================================
                      // V3.1:
                      //
                      // 需要至少9根才能计算2H。
                      // 拉12根留余量。
                      // ======================================

                      limit:
                        "12",
                    }
                  );


                const oi =
                  parseOI(
                    result.list ||
                      []
                  );


                if (!oi) {
                  throw new Error("Incomplete or non-contiguous 15M OI history");
                }


                const row = {

                  ...ticker,


                  singleOpenInterest:
                    oi.current,

                  oiSampleAt: oi.oiSampleAt,
                  oiHighRetention: oi.oiHighRetention,
                  oiRebuildEvidence: oi.oiRebuildEvidence,


                  oi15mPct:
                    oi.oi15mPct,


                  oi30mPct:
                    oi.oi30mPct,


                  oi1hPct:
                    oi.oi1hPct,


                  oi2hPct:
                    oi.oi2hPct,


                  oi15mSteps:
                    oi.steps,


                  positiveSteps:
                    oi.positiveSteps,


                  negativeSteps:
                    oi.negativeSteps,


                  priorPositiveSteps:
                    oi.priorPositiveSteps,


                  consecutivePositive:
                    oi.consecutivePositive,


                  consecutiveNegative:
                    oi.consecutiveNegative,


                  latestOiStep:
                    oi.latestStep,


                  maxPositiveOiStep:
                    oi.maxPositiveStep,


                  buildQuality:
                    oi.buildQuality,


                  spikeRatio:
                    oi.spikeRatio,


                  isOiSpike:
                    oi.isOiSpike,
                };


                row.discoveryScore =
                  discoveryScore(
                    row
                  );


                return row;


              } catch (error) {

                oiErrors++;


                if (
                  errorSamples.length <
                  10
                ) {

                  errorSamples.push({

                    stage:
                      "OI",

                    symbol:
                      ticker.symbol,

                    error:
                      error.message,
                  });
                }


                return null;
              }
            }
          )
        );


      oiRows.push(
        ...data.filter(Boolean)
      );


      await sleep(80);
    }


    // ========================================================
    // 5. OI DISCOVERY
    // ========================================================

    const oiCandidates =
      oiRows

        .filter(
          (item) => {

            const oi15 =
              item.oi15mPct ??
              0;


            const oi30 =
              item.oi30mPct ??
              0;


            const oi1h =
              item.oi1hPct ??
              0;


            const funding =
              item.fundingRate ??
              0;


            if (
              oi1h >= 2
            ) {
              return true;
            }


            if (
              oi30 >= 1
            ) {
              return true;
            }


            if (
              oi15 >= 0.5
            ) {
              return true;
            }


            if (
              item.positiveSteps >=
                3 &&
              oi1h > 0.5
            ) {
              return true;
            }


            if (
              funding <=
                -0.001 &&
              oi15 > 0
            ) {
              return true;
            }


            return false;
          }
        )


        .sort(
          (a, b) =>
            (
              b.discoveryScore ||
              0
            ) -
            (
              a.discoveryScore ||
              0
            )
        );


    // ========================================================
    // 6. KLINE DEEP SCAN
    // ========================================================

    const discoveryList = oiCandidates.slice(0, 80);
    const discovered = new Set(discoveryList.map(row => row.symbol));
    // Preserve the discovery ranking/cap. A bounded separate lane makes
    // OI-down / price-up cases observable without changing discovery rules.
    const reductionList = oiRows
      .filter(row => !discovered.has(row.symbol) && oiIsFalling(row))
      .sort((a, b) => Math.abs(b.oi30mPct) - Math.abs(a.oi30mPct))
      .slice(0, 20);
    const deepList = [
      ...discoveryList.map(row => ({ ...row, scanLane: "DISCOVERY" })),
      ...reductionList.map(row => ({ ...row, scanLane: "OI_REDUCTION" })),
    ];


    const finalRows = [];


    for (
      let i = 0;
      i < deepList.length;
      i += 10
    ) {

      const batch =
        deepList.slice(
          i,
          i + 10
        );


      const data =
        await Promise.all(

          batch.map(
            async (row) => {

              try {

                const scanNow =
                  Date.now();


                // ==============================================
                // 5M PRICE
                // ==============================================

                const result =
                  await bybit(
                    "/v5/market/kline",
                    {

                      category:
                        "linear",

                      symbol:
                        row.symbol,

                      interval:
                        "5",

                      // V4.1 needs enough data for
                      // Price × OI history.
                      limit:
                        "30",
                    }
                  );


                const kline =
                  parseKline(
                    result.list ||
                      [],
                    scanNow
                  );


                if (!kline) {

                  throw new Error(
                    "Incomplete or non-contiguous closed 5M kline history"
                  );
                }


                // ==============================================
                // V4.1 — 5M OI
                //
                // Flow failure must NOT remove an otherwise
                // valid V4 candidate.
                // ==============================================

                let flow5m =
                  null;


                try {

                  const oi5mResult =
                    await bybit(
                      "/v5/market/open-interest",
                      {

                        category:
                          "linear",

                        symbol:
                          row.symbol,

                        intervalTime:
                          "5min",

                        limit:
                          "30",
                      }
                    );


                  flow5m =
                    parsePriceOiFlow5m(

                      result.list ||
                        [],

                      oi5mResult.list ||
                        [],

                      scanNow
                    );


                  if (flow5m) {

                    flow5mParsedCount++;

                  } else {

                    flowErrors++;


                    if (
                      errorSamples.length <
                      10
                    ) {

                      errorSamples.push({

                        stage:
                          "FLOW5M",

                        symbol:
                          row.symbol,

                        error:
                          "Unable to align enough continuous 5M Price/OI samples",
                      });
                    }
                  }


                } catch (flowError) {

                  flowErrors++;


                  if (
                    errorSamples.length <
                    10
                  ) {

                    errorSamples.push({

                      stage:
                        "FLOW5M",

                      symbol:
                        row.symbol,

                      error:
                        flowError.message,
                    });
                  }
                }





                const item = {

                  ...row,

                  flow5m,

                  priceSampleAt:
                    kline.priceSampleAt,
                  priceStructure: kline.priceStructure,


                  price5mPct:
                    kline.price5mPct,


                  price15mPct:
                    kline.price15mPct,


                  price1hPct:
                    kline.price1hPct,


                  price24hPct:
                    round(
                      row.price24hPct,
                      2
                    ),


                  volume15mRatio:
                    kline.volume15mRatio,


                  fundingPct:
                    row.fundingRate !==
                    null

                      ? round(
                          row.fundingRate *
                            100,
                          4
                        )

                      : null,
                };


                applyExecution(item);


                return item;


              } catch (error) {

                klineErrors++;


                if (
                  errorSamples.length <
                  10
                ) {

                  errorSamples.push({

                    stage:
                      "KLINE",

                    symbol:
                      row.symbol,

                    error:
                      error.message,
                  });
                }


                return null;
              }
            }
          )
        );


      finalRows.push(
        ...data.filter(Boolean)
      );


      await sleep(80);
    }


    // ========================================================
    // 7. ACTIONABLE
    // ========================================================

    const actionable =
      finalRows

        .filter(
          (item) =>
            [
  "POSITION_BUILD",
  "SHORT_BUILD",
  "SHORT_CONTROL",
  "CORRELATION_FLIP",
  "REBUILD",
  "PRICE_REFUSAL",
].includes(item.executionState) &&
            item.executionRisk !== "EXTENDED"
        )

        .sort(
          (a, b) =>
            (
              b.score ||
              0
            ) -
            (
              a.score ||
              0
            )
        );


    // ========================================================
    

    const candidateRows = actionable.slice(0, 20);

    // Output-only validation; failure cannot remove or reclassify Bybit candidates.
    const coinalyzeApiKey = typeof process !== "undefined"
      ? process.env?.COINALYZE_API_KEY
      : null;
    const crossExchangeDiagnostics = await addCrossExchangeValidation(
      candidateRows,
      coinalyzeApiKey
    );

    // 8. OI SPIKES
    // ========================================================

    const spikes =
      finalRows

        .filter(
          (item) =>
            item.isOiSpike === true
        )

        .sort(
          (a, b) =>
            (
              b.discoveryScore ||
              0
            ) -
            (
              a.discoveryScore ||
              0
            )
        );


    // ========================================================
    // 9. COOLING
    // ========================================================

    const cooling =
      finalRows

        .filter(
          (item) =>
            item.legacySignal === "COOLING"
        )

        .sort(
          (a, b) =>
            (
              b.score ||
              0
            ) -
            (
              a.score ||
              0
            )
        );


    // ========================================================
    // 10. UNWINDING
    // ========================================================

    const unwind =
      finalRows

        .filter(
          (item) =>
            ["DELEVERAGING", "SHORT_COVERING", "OI_REDUCTION"].includes(item.executionState)
        )

        .sort(
          (a, b) =>
            (
              b.discoveryScore ||
              0
            ) -
            (
              a.discoveryScore ||
              0
            )
        );


    // ========================================================
    // 11. EXTENDED
    // ========================================================

    const extended =
      finalRows

        .filter(
          (item) =>
            item.executionRisk === "EXTENDED"
        )

        .sort(
          (a, b) =>
            (
              b.discoveryScore ||
              0
            ) -
            (
              a.discoveryScore ||
              0
            )
        );


    // ========================================================
    // OUTPUT
    // ========================================================

    return res
      .status(200)
      .json({

        status:
          "ok",


        version:
          "OI-RADAR-V4.1",


        source:
          "Bybit Official API",


        market:
          "Bybit USDT Linear Perpetual",


        oiDefinition:
          "singleOpenInterest",


        scannedAt:
          new Date().toISOString(),


        durationMs:
          Date.now() -
          started,


diagnostics: {

  crossExchange: crossExchangeDiagnostics,

  reductionDeepScannedCount:
    reductionList.length,

  flow5mDeepScannedCount:
    flow5mParsedCount,

  flowErrors,
          executionStateCounts: finalRows.reduce((counts, row) => {
            counts[row.executionState] = (counts[row.executionState] || 0) + 1;
            return counts;
          }, {}),

          universeCount:
            universe.length,


          oiScannedCount:
            oiRows.length,


          oiCandidateCount:
            oiCandidates.length,


          klineDeepScannedCount:
            deepList.length,


          actionableCount:
            actionable.length,


          spikeCount:
            spikes.length,


          coolingCount:
            cooling.length,


          unwindCount:
            unwind.length,


          extendedCount:
            extended.length,


          oiErrors,


          klineErrors,


          errorSamples,
        },


        // ====================================================
        // 主要候选
        // ====================================================

        executionRules:
          EXECUTION_RULES,

        scoreMeaning:
          "Radar attention only; use executionState and directionalBias for direction.",

        priceWindowBasis:
          "Completed 5M candles; exact 1/3/12-bar returns and completed-bar volume.",

        flow5mBasis:
          "Bybit 5min Open Interest aligned with completed 5M contract candles; used for Price×OI state transitions, CORRELATION_FLIP and REBUILD.",


        // Full bounded deep-scan output prevents top-N buckets hiding states.
        executionStates: finalRows,
        shortCovering: finalRows.filter(row => row.executionState === "SHORT_COVERING"),
        deleveraging: finalRows.filter(row => row.executionState === "DELEVERAGING"),

        candidates:
          candidateRows.slice(
            0,
            20
          ),


        // ====================================================
        // 单根 OI 异常爆发
        // ====================================================

        oiSpikes:
          spikes.slice(
            0,
            10
          ),


        // ====================================================
        // 建仓后冷却
        // ====================================================

        cooling:
          cooling.slice(
            0,
            10
          ),


        // ====================================================
        // 持续撤仓
        // ====================================================

        oiUnwind:
          unwind.slice(
            0,
            10
          ),


        // ====================================================
        // 已经明显释放
        // ====================================================

        extended:
          extended.slice(
            0,
            10
          ),
      });


  } catch (error) {

    return res
      .status(500)
      .json({

        status:
          "error",


        version:
          "OI-RADAR-V4.1",


        message:
          error.message,


        durationMs:
          Date.now() -
          started,


        diagnostics: {

          oiErrors,

          klineErrors,

          errorSamples,
        },
      });
  }
}
