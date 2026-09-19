import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERVAL_MS = 5 * 60 * 1000;
const API_LIMIT = 1000;
const DEFAULT_KLINE_BASE_URL =
  "https://ybit-market-api.vercel.app/api/market";
const EXECUTABLE_SIGNALS = new Set([
  "EARLY_ENTRY",
  "BREAKOUT_ENTRY",
  "RETEST_ENTRY",
]);
const ENTRY_POOLS = [
  ["longEntryCandidates", "LONG"],
  ["shortEntryCandidates", "SHORT"],
  ["tradFiLongEntryCandidates", "LONG"],
  ["tradFiShortEntryCandidates", "SHORT"],
];

export const RULES = Object.freeze({
  leverageReference: "10x",
  pnlUnit: "underlying_pct",
  profitThresholdPct: 0.5,
  tradeSuccessThresholdPct: 1,
  stopThresholdPct: -3.5,
  deepDrawdownThresholdPct: -2,
  timeLimitMinutes: null,
  klineInterval: "5m",
  uniqueness: "first symbol+direction executable entry only",
  sameCandleOrder: "ADVERSE_FIRST_CONSERVATIVE",
  terminalStatusLocked: true,
  maeMfeContinueAfterTerminalStatus: true,
  entryCandlePolicy: "ADVERSE_ONLY_FULL_CANDLE_CONSERVATIVE",
  entryCandlePolicyDetail:
    "For a partial entry candle, use the full candle only for MAE and stop detection; ignore its favorable move, MFE, and profit hit because pre-entry intrabar order is unknown.",
});

const round = (value, decimals = 4) =>
  Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;

function emptyBuckets() {
  return { "+0.5~1%": 0, "+1~2%": 0, "+2~5%": 0, ">+5%": 0 };
}

export function createLedger() {
  return {
    version: "ENTRY-BACKTEST-V1",
    updatedAt: null,
    rules: { ...RULES },
    summary: {
      total: 0,
      open: 0,
      success: 0,
      fail: 0,
      hit05: 0,
      hit10: 0,
      tradeSuccess: 0,
      runner2: 0,
      runner5: 0,
      deepDrawdownSuccess: 0,
      cleanSuccess: 0,
      dirtySuccess: 0,
      fakeSuccess: 0,
      post05SevereGiveback: 0,
      returnedBelowEntry05: 0,
      mfeBuckets: emptyBuckets(),
    },
    entries: [],
  };
}

export function mfeBucket(mfePct) {
  if (!Number.isFinite(mfePct) || mfePct < 0.5) return null;
  if (mfePct < 1) return "+0.5~1%";
  if (mfePct < 2) return "+1~2%";
  if (mfePct <= 5) return "+2~5%";
  return ">+5%";
}

export function summarize(entries) {
  const summary = {
    total: entries.length,
    open: 0,
    success: 0,
    fail: 0,
    hit05: 0,
    hit10: 0,
    tradeSuccess: 0,
    runner2: 0,
    runner5: 0,
    deepDrawdownSuccess: 0,
    cleanSuccess: 0,
    dirtySuccess: 0,
    fakeSuccess: 0,
    post05SevereGiveback: 0,
    returnedBelowEntry05: 0,
    mfeBuckets: emptyBuckets(),
  };

  for (const entry of entries) {
    if (entry.status === "SUCCESS") summary.success++;
    else if (entry.status === "FAIL") summary.fail++;
    else summary.open++;
    if (entry.deepDrawdownSuccess === true) summary.deepDrawdownSuccess++;
    if (entry.hit05 === true) summary.hit05++;
    if (entry.hit10 === true) summary.hit10++;
    if (entry.tradeStatus === "SUCCESS") summary.tradeSuccess++;
    if (entry.runner2 === true) summary.runner2++;
    if (entry.runner5 === true) summary.runner5++;
    if (entry.profitQuality === "CLEAN_SUCCESS") summary.cleanSuccess++;
    if (entry.profitQuality === "DIRTY_SUCCESS") summary.dirtySuccess++;
    if (entry.profitQuality === "FAKE_SUCCESS") summary.fakeSuccess++;
    if (entry.severeGiveback05 === true) summary.post05SevereGiveback++;
    if (entry.returnedBelowEntry05 === true) summary.returnedBelowEntry05++;
    if (entry.mfeBucket) summary.mfeBuckets[entry.mfeBucket]++;
  }
  return summary;
}

export function profitQuality(entry) {
  const fakeSuccess =
    entry.hit05 === true &&
    entry.hit10 !== true &&
    entry.severeGiveback05 === true;

  // A +0.5% touch followed by a full-candle stop is more informative than
  // the generic FAIL label, so preserve it as FAKE_SUCCESS.
  if (fakeSuccess) return "FAKE_SUCCESS";
  if (entry.tradeStatus === "OPEN") return "OPEN";
  if (entry.status === "FAIL" || entry.tradeStatus === "FAIL") return "FAIL";
  if (entry.tradeStatus === "SUCCESS" && Number(entry.mfePct) >= 5) {
    return "RUNNER";
  }
  if (entry.tradeStatus === "SUCCESS" && entry.dirtySuccess05 === true) {
    return "DIRTY_SUCCESS";
  }
  if (entry.tradeStatus === "SUCCESS") return "CLEAN_SUCCESS";
  return "OPEN";
}

const nullableNumber = value => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function candidateFeatures(candidate) {
  return {
    oi15mPct: nullableNumber(candidate?.keyMetrics?.oi15mPct ?? candidate?.oi15mPct),
    oi30mPct: nullableNumber(candidate?.keyMetrics?.oi30mPct ?? candidate?.oi30mPct),
    oi1hPct: nullableNumber(candidate?.keyMetrics?.oi1hPct ?? candidate?.oi1hPct),
    finalCandidateScore: nullableNumber(
      candidate?.finalCandidateScore ?? candidate?.candidateQuality
    ),
    candidateQuality: nullableNumber(candidate?.candidateQuality),
    timingScore: nullableNumber(candidate?.timingScore),
    crossConfirmation:
      candidate?.crossExchangeSummary?.confirmation ??
      candidate?.crossConfirmation ??
      null,
    timingRiskFlags: Array.isArray(candidate?.timingRiskFlags)
      ? [...candidate.timingRiskFlags]
      : null,
    entrySignal: candidate?.entrySignal ?? null,
    direction: candidate?.direction ?? null,
  };
}

function allLatestCandidates(latest) {
  const radar = latest?.radar ?? {};
  const pools = [
    ...ENTRY_POOLS.map(([name]) => radar[name]),
    radar.longCandidatePool,
    radar.shortCandidatePool,
    radar.tradFiLongCandidatePool,
    radar.tradFiShortCandidatePool,
    radar.longCandidates,
    radar.shortCandidates,
    radar.tradFiLongCandidates,
    radar.tradFiShortCandidates,
  ];
  return pools.flatMap(pool => Array.isArray(pool) ? pool : []);
}

function snapshotCandidate(snapshot, entry) {
  return (snapshot?.candidates ?? []).find(candidate =>
    candidate?.symbol === entry.symbol &&
    String(candidate?.direction ?? "").toUpperCase() === entry.direction
  ) ?? null;
}

export function migrateEntries(ledger, latest, history) {
  const latestTime = validTime(latest?.radar?.scannedAt ?? latest?.snapshot?.fetchedAt);
  const latestCandidates = allLatestCandidates(latest);
  const snapshots = Array.isArray(history?.snapshots) ? history.snapshots : [];
  let changed = false;

  for (const entry of ledger.entries) {
    const defaults = {
      hit05: entry.status === "SUCCESS",
      hit05At: entry.status === "SUCCESS" ? entry.firstProfitHitAt ?? null : null,
      hit10: false,
      hit10At: null,
      tradeStatus: "OPEN",
      tradeTerminalAt: null,
      tradeCheckedThrough: entry.entryTime,
      runner2: Number(entry.mfePct) >= 2,
      runner5: Number(entry.mfePct) >= 5,
      post05MaePct: null,
      post10MaePct: null,
      returnedBelowEntry05: false,
      returnedBelowEntry10: false,
      dirtySuccess05: false,
      severeGiveback05: false,
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in entry)) {
        entry[key] = value;
        changed = true;
      }
    }

    const nextProfitQuality = profitQuality(entry);
    if (entry.profitQuality !== nextProfitQuality) {
      entry.profitQuality = nextProfitQuality;
      changed = true;
    }

    const featureKeys = [
      "oi15mPct", "oi30mPct", "oi1hPct", "finalCandidateScore",
      "candidateQuality", "timingScore", "crossConfirmation", "timingRiskFlags",
    ];
    if (featureKeys.some(key => !(key in entry))) {
      const entryTime = validTime(entry.entryTime);
      const historical = snapshots.find(snapshot =>
        validTime(snapshot?.scannedAt ?? snapshot?.fetchedAt) === entryTime
      );
      const source = snapshotCandidate(historical, entry) ??
        (latestTime === entryTime
          ? latestCandidates.find(candidate =>
              candidate?.symbol === entry.symbol &&
              String(candidate?.direction ?? "").toUpperCase() === entry.direction
            )
          : null);
      const features = source ? candidateFeatures(source) : {};
      for (const key of featureKeys) {
        if (!(key in entry)) {
          entry[key] = features[key] ?? null;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export function assertKlineProgress(kline) {
  if (kline.attempted > 0 && kline.succeeded === 0) {
    throw new Error(
      `All kline updates failed (attempted=${kline.attempted}, failed=${kline.failed})`
    );
  }
}

function validTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function addSnapshotEntries(ledger, latest) {
  const entryTime = validTime(
    latest?.radar?.scannedAt ?? latest?.snapshot?.fetchedAt
  );
  if (!entryTime) return [];

  const seen = new Set(
    ledger.entries.map(entry => `${entry.symbol}:${entry.direction}`)
  );
  const added = [];

  for (const [poolName, fallbackDirection] of ENTRY_POOLS) {
    for (const candidate of latest?.radar?.[poolName] ?? []) {
      const symbol = String(candidate?.symbol ?? "").toUpperCase();
      const direction = String(
        candidate?.direction ?? fallbackDirection
      ).toUpperCase();
      const entrySignal = candidate?.entrySignal;
      const entryPrice = Number(candidate?.keyMetrics?.price);
      const key = `${symbol}:${direction}`;

      if (!symbol || !["LONG", "SHORT"].includes(direction)) continue;
      if (!EXECUTABLE_SIGNALS.has(entrySignal)) continue;
      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || seen.has(key)) continue;

      const entry = {
        symbol,
        ...candidateFeatures(candidate),
        direction,
        entrySignal,
        entryPrice,
        entryTime,
        maePct: 0,
        mfePct: 0,
        maePrice: entryPrice,
        mfePrice: entryPrice,
        maeBeforeSuccessPct: 0,
        firstProfitHitAt: null,
        hit05: false,
        hit05At: null,
        hit10: false,
        hit10At: null,
        tradeStatus: "OPEN",
        tradeTerminalAt: null,
        tradeCheckedThrough: entryTime,
        stopHitAt: null,
        status: "OPEN",
        deepDrawdownSuccess: false,
        mfeBucket: null,
        runner2: false,
        runner5: false,
        post05MaePct: null,
        post10MaePct: null,
        returnedBelowEntry05: false,
        returnedBelowEntry10: false,
        dirtySuccess05: false,
        severeGiveback05: false,
        profitQuality: "OPEN",
        entryCandleChecked: false,
        checkedThrough: entryTime,
        updatedAt: entryTime,
      };
      ledger.entries.push(entry);
      added.push(entry);
      seen.add(key);
    }
  }
  return added;
}

function moveForPrice(entry, price) {
  if (entry.direction === "LONG") {
    return (price / entry.entryPrice - 1) * 100;
  }
  return ((entry.entryPrice - price) / entry.entryPrice) * 100;
}

export function applyCandles(entry, candles) {
  const sorted = [...candles]
    .map(candle => ({
      openTime: Number(candle.openTime ?? candle[0]),
      high: Number(candle.high ?? candle[2]),
      low: Number(candle.low ?? candle[3]),
    }))
    .filter(candle =>
      Number.isFinite(candle.openTime) && candle.high > 0 && candle.low > 0
    )
    .sort((a, b) => a.openTime - b.openTime);

  let changed = false;
  const checkedMs = Date.parse(entry.checkedThrough ?? entry.entryTime);
  const tradeCheckedMs = Date.parse(entry.tradeCheckedThrough ?? entry.entryTime);
  const entryMs = Date.parse(entry.entryTime);
  const entryOpenMs = Math.floor(entryMs / INTERVAL_MS) * INTERVAL_MS;

  for (const candle of sorted) {
    const closeMs = candle.openTime + INTERVAL_MS;
    if (candle.openTime < entryOpenMs) continue;
    const updateLegacy = closeMs > checkedMs;
    const updateTrade = closeMs > tradeCheckedMs;
    const hit05Ms = Date.parse(entry.hit05At);
    const hit10Ms = Date.parse(entry.hit10At);
    const updatePost05 = Number.isFinite(hit05Ms) && candle.openTime >= hit05Ms;
    const updatePost10 = Number.isFinite(hit10Ms) && candle.openTime >= hit10Ms;
    if (!updateLegacy && !updateTrade && !updatePost05 && !updatePost10) continue;

    const favorablePrice = entry.direction === "LONG" ? candle.high : candle.low;
    const adversePrice = entry.direction === "LONG" ? candle.low : candle.high;
    const partialEntryCandle = candle.openTime === entryOpenMs && entryMs > entryOpenMs;
    // Pre-entry intrabar movement is unknowable. Count the whole candle's
    // adverse side, but never grant favorable excursion or success from it.
    const favorablePct = partialEntryCandle
      ? 0
      : Math.max(0, moveForPrice(entry, favorablePrice));
    const adversePct = Math.min(0, moveForPrice(entry, adversePrice));
    const hitAt = new Date(closeMs).toISOString();

    if (updateLegacy && favorablePct > entry.mfePct) {
      entry.mfePct = round(favorablePct);
      entry.mfePrice = favorablePrice;
    }
    if (updateLegacy && adversePct < entry.maePct) {
      entry.maePct = round(adversePct);
      entry.maePrice = adversePrice;
    }

    const profitHit = favorablePct >= RULES.profitThresholdPct;
    const tradeProfitHit = favorablePct >= RULES.tradeSuccessThresholdPct;
    const stopHit = adversePct <= RULES.stopThresholdPct;

    if (updatePost05) {
      entry.post05MaePct = round(
        Math.min(entry.post05MaePct ?? 0, adversePct)
      );
      entry.returnedBelowEntry05 =
        entry.returnedBelowEntry05 === true || adversePct < 0;
      entry.dirtySuccess05 =
        entry.post05MaePct <= RULES.deepDrawdownThresholdPct;
      entry.severeGiveback05 =
        entry.post05MaePct <= RULES.stopThresholdPct;
    }
    if (updatePost10) {
      entry.post10MaePct = round(
        Math.min(entry.post10MaePct ?? 0, adversePct)
      );
      entry.returnedBelowEntry10 =
        entry.returnedBelowEntry10 === true || adversePct < 0;
    }
    if (updateLegacy && profitHit && !entry.firstProfitHitAt) entry.firstProfitHitAt = hitAt;
    if (updateLegacy && stopHit && !entry.stopHitAt) entry.stopHitAt = hitAt;

    if (updateLegacy && entry.status === "OPEN") {
      entry.maeBeforeSuccessPct = round(
        Math.min(entry.maeBeforeSuccessPct ?? 0, adversePct)
      );
      // OHLC cannot prove intrabar order. A stop touch wins ties.
      if (stopHit) {
        entry.status = "FAIL";
        entry.terminalAt = hitAt;
      } else if (profitHit) {
        entry.status = "SUCCESS";
        entry.terminalAt = hitAt;
        entry.deepDrawdownSuccess =
          entry.maeBeforeSuccessPct <= RULES.deepDrawdownThresholdPct &&
          entry.maeBeforeSuccessPct > RULES.stopThresholdPct;
      }
    }

    if (updateTrade) {
      if (entry.tradeStatus === "OPEN") {
        if (stopHit) {
          entry.tradeStatus = "FAIL";
          entry.tradeTerminalAt = hitAt;
        } else if (tradeProfitHit) {
          entry.hit10 = true;
          entry.hit10At = hitAt;
          entry.tradeStatus = "SUCCESS";
          entry.tradeTerminalAt = hitAt;
        }
      }
      entry.tradeCheckedThrough = hitAt;
    }

    if (updateLegacy) {
      if (entry.status === "SUCCESS" && entry.hit05 !== true) {
        entry.hit05 = true;
        entry.hit05At = entry.firstProfitHitAt;
      }
      entry.mfeBucket = mfeBucket(entry.mfePct);
      entry.runner2 = entry.mfePct >= 2;
      entry.runner5 = entry.mfePct >= 5;
      if (candle.openTime === entryOpenMs) entry.entryCandleChecked = true;
      entry.checkedThrough = hitAt;
      entry.updatedAt = hitAt;
    }
    entry.profitQuality = profitQuality(entry);
    changed = true;
  }
  return changed;
}

function nextOpenTime(entry) {
  const checked = Date.parse(entry.checkedThrough ?? entry.entryTime);
  const entryTime = Date.parse(entry.entryTime);
  if (checked <= entryTime) {
    return Math.floor(entryTime / INTERVAL_MS) * INTERVAL_MS;
  }
  return Math.ceil(checked / INTERVAL_MS) * INTERVAL_MS;
}

function nextRequiredOpenTime(entry) {
  const cursors = [
    nextOpenTime(entry),
    nextOpenTime({
      entryTime: entry.entryTime,
      checkedThrough: entry.tradeCheckedThrough ?? entry.entryTime,
    }),
  ];
  if (entry.hit05 === true && entry.post05MaePct == null) {
    const hit05Ms = Date.parse(entry.hit05At);
    if (Number.isFinite(hit05Ms)) cursors.push(hit05Ms);
  }
  if (entry.hit10 === true && entry.post10MaePct == null) {
    const hit10Ms = Date.parse(entry.hit10At);
    if (Number.isFinite(hit10Ms)) cursors.push(hit10Ms);
  }
  return Math.min(...cursors);
}

export async function fetchClosedKlines(
  symbol,
  startMs,
  nowMs,
  fetchImpl = fetch,
  baseUrl = process.env.ENTRY_KLINE_BASE_URL ?? DEFAULT_KLINE_BASE_URL
) {
  const lastClosedOpen = Math.floor(nowMs / INTERVAL_MS) * INTERVAL_MS - INTERVAL_MS;
  if (startMs > lastClosedOpen) return [];

  const candles = [];
  for (let cursor = startMs; cursor <= lastClosedOpen;) {
    const chunkLastOpen = Math.min(
      cursor + (API_LIMIT - 1) * INTERVAL_MS,
      lastClosedOpen
    );
    const params = new URLSearchParams({
      endpoint: "kline",
      category: "linear",
      symbol,
      interval: "5",
      start: String(cursor),
      end: String(chunkLastOpen + INTERVAL_MS - 1),
      limit: String(API_LIMIT),
    });
    const response = await fetchImpl(
      `${baseUrl}?${params}`,
      { headers: { Accept: "application/json", "User-Agent": "Bybit-Entry-Backtest/1" } }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const responseBody = await response.json();
    const body = responseBody?.data ?? responseBody;
    if (body.retCode !== 0) throw new Error(`${body.retCode}: ${body.retMsg}`);
    for (const row of body.result?.list ?? []) {
      const openTime = Number(row[0]);
      if (openTime >= cursor && openTime <= chunkLastOpen && openTime + INTERVAL_MS <= nowMs) {
        candles.push(row);
      }
    }
    cursor = chunkLastOpen + INTERVAL_MS;
  }
  return candles.sort((a, b) => Number(a[0]) - Number(b[0]));
}

export async function updateLedger({
  ledger,
  latest,
  history = null,
  nowMs = Date.now(),
  fetchImpl = fetch,
  warn = message => console.warn(message),
}) {
  ledger.version = "ENTRY-BACKTEST-V1";
  ledger.rules = { ...RULES };
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  let changed = migrateEntries(ledger, latest, history);
  const added = addSnapshotEntries(ledger, latest);
  changed = added.length > 0 || changed;
  const kline = { attempted: 0, succeeded: 0, failed: 0 };

  const bySymbol = new Map();
  for (const entry of ledger.entries) {
    const rows = bySymbol.get(entry.symbol) ?? [];
    rows.push(entry);
    bySymbol.set(entry.symbol, rows);
  }

  for (const [symbol, entries] of bySymbol) {
    const startMs = Math.min(...entries.map(nextRequiredOpenTime));
    kline.attempted++;
    try {
      const candles = await fetchClosedKlines(symbol, startMs, nowMs, fetchImpl);
      kline.succeeded++;
      for (const entry of entries) {
        if (applyCandles(entry, candles)) changed = true;
      }
    } catch (error) {
      kline.failed++;
      warn(`warning: ${symbol} kline update skipped: ${error.message}`);
    }
  }

  ledger.summary = summarize(ledger.entries);
  if (changed) ledger.updatedAt = new Date(nowMs).toISOString();
  return { ledger, added, changed, kline };
}

export async function run({ root = process.cwd(), fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const latestPath = path.join(root, "data", "latest.json");
  const historyPath = path.join(root, "data", "history.json");
  const ledgerPath = path.join(root, "data", "entry-backtest.json");
  const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  let history = null;
  try {
    history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let ledger = createLedger();
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const before = JSON.stringify(ledger);
  const result = await updateLedger({ ledger, latest, history, nowMs, fetchImpl });
  const after = JSON.stringify(result.ledger);
  if (after !== before) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(result.ledger, null, 2) + "\n");
  }
  console.log(
    `Entry ledger updated. added=${result.added.length} total=${ledger.summary.total} ` +
    `open=${ledger.summary.open} success=${ledger.summary.success} fail=${ledger.summary.fail}`
  );
  console.log(
    `Kline update. attempted=${result.kline.attempted} ` +
    `succeeded=${result.kline.succeeded} failed=${result.kline.failed}`
  );
  if (result.added.length) {
    console.log("New entries:", result.added.map(e => `${e.symbol}:${e.direction}`));
  }
  assertKlineProgress(result.kline);
  return result;
}

const isCli = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  run().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
