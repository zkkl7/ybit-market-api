import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INTERVAL_MS = 5 * 60 * 1000;
const API_LIMIT = 1000;
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
  stopThresholdPct: -3.5,
  deepDrawdownThresholdPct: -2,
  timeLimitMinutes: null,
  klineInterval: "5m",
  uniqueness: "first symbol+direction executable entry only",
  sameCandleOrder: "ADVERSE_FIRST_CONSERVATIVE",
  terminalStatusLocked: true,
  maeMfeContinueAfterTerminalStatus: true,
  entryCandlePolicy: "first fully closed 5m candle opening at or after entryTime",
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
      deepDrawdownSuccess: 0,
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
    deepDrawdownSuccess: 0,
    mfeBuckets: emptyBuckets(),
  };

  for (const entry of entries) {
    if (entry.status === "SUCCESS") summary.success++;
    else if (entry.status === "FAIL") summary.fail++;
    else summary.open++;
    if (entry.deepDrawdownSuccess === true) summary.deepDrawdownSuccess++;
    if (entry.mfeBucket) summary.mfeBuckets[entry.mfeBucket]++;
  }
  return summary;
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
        stopHitAt: null,
        status: "OPEN",
        deepDrawdownSuccess: false,
        mfeBucket: null,
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
  return (entry.entryPrice / price - 1) * 100;
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
  const firstOpenMs = Math.ceil(Date.parse(entry.entryTime) / INTERVAL_MS) * INTERVAL_MS;

  for (const candle of sorted) {
    const closeMs = candle.openTime + INTERVAL_MS;
    if (candle.openTime < firstOpenMs || closeMs <= checkedMs) continue;

    const favorablePrice = entry.direction === "LONG" ? candle.high : candle.low;
    const adversePrice = entry.direction === "LONG" ? candle.low : candle.high;
    const favorablePct = Math.max(0, moveForPrice(entry, favorablePrice));
    const adversePct = Math.min(0, moveForPrice(entry, adversePrice));
    const hitAt = new Date(closeMs).toISOString();

    if (favorablePct > entry.mfePct) {
      entry.mfePct = round(favorablePct);
      entry.mfePrice = favorablePrice;
    }
    if (adversePct < entry.maePct) {
      entry.maePct = round(adversePct);
      entry.maePrice = adversePrice;
    }

    const profitHit = favorablePct >= RULES.profitThresholdPct;
    const stopHit = adversePct <= RULES.stopThresholdPct;
    if (profitHit && !entry.firstProfitHitAt) entry.firstProfitHitAt = hitAt;
    if (stopHit && !entry.stopHitAt) entry.stopHitAt = hitAt;

    if (entry.status === "OPEN") {
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

    entry.mfeBucket = mfeBucket(entry.mfePct);
    entry.checkedThrough = hitAt;
    entry.updatedAt = hitAt;
    changed = true;
  }
  return changed;
}

function nextOpenTime(entry) {
  const checked = Date.parse(entry.checkedThrough ?? entry.entryTime);
  const entryTime = Date.parse(entry.entryTime);
  return Math.ceil(Math.max(checked, entryTime) / INTERVAL_MS) * INTERVAL_MS;
}

export async function fetchClosedKlines(symbol, startMs, nowMs, fetchImpl = fetch) {
  const lastClosedOpen = Math.floor(nowMs / INTERVAL_MS) * INTERVAL_MS - INTERVAL_MS;
  if (startMs > lastClosedOpen) return [];

  const candles = [];
  for (let cursor = startMs; cursor <= lastClosedOpen;) {
    const chunkLastOpen = Math.min(
      cursor + (API_LIMIT - 1) * INTERVAL_MS,
      lastClosedOpen
    );
    const params = new URLSearchParams({
      category: "linear",
      symbol,
      interval: "5",
      start: String(cursor),
      end: String(chunkLastOpen + INTERVAL_MS - 1),
      limit: String(API_LIMIT),
    });
    const response = await fetchImpl(
      `https://api.bybit.com/v5/market/kline?${params}`,
      { headers: { Accept: "application/json", "User-Agent": "Bybit-Entry-Backtest/1" } }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
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
  nowMs = Date.now(),
  fetchImpl = fetch,
  warn = message => console.warn(message),
}) {
  ledger.version = "ENTRY-BACKTEST-V1";
  ledger.rules = { ...RULES };
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  const added = addSnapshotEntries(ledger, latest);
  let changed = added.length > 0;

  const bySymbol = new Map();
  for (const entry of ledger.entries) {
    const rows = bySymbol.get(entry.symbol) ?? [];
    rows.push(entry);
    bySymbol.set(entry.symbol, rows);
  }

  for (const [symbol, entries] of bySymbol) {
    const startMs = Math.min(...entries.map(nextOpenTime));
    try {
      const candles = await fetchClosedKlines(symbol, startMs, nowMs, fetchImpl);
      for (const entry of entries) {
        if (applyCandles(entry, candles)) changed = true;
      }
    } catch (error) {
      warn(`warning: ${symbol} kline update skipped: ${error.message}`);
    }
  }

  ledger.summary = summarize(ledger.entries);
  if (changed) ledger.updatedAt = new Date(nowMs).toISOString();
  return { ledger, added, changed };
}

export async function run({ root = process.cwd(), fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const latestPath = path.join(root, "data", "latest.json");
  const ledgerPath = path.join(root, "data", "entry-backtest.json");
  const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  let ledger = createLedger();
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const before = JSON.stringify(ledger);
  const result = await updateLedger({ ledger, latest, nowMs, fetchImpl });
  const after = JSON.stringify(result.ledger);
  if (after !== before) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(result.ledger, null, 2) + "\n");
  }
  console.log(
    `Entry ledger updated. added=${result.added.length} total=${ledger.summary.total} ` +
    `open=${ledger.summary.open} success=${ledger.summary.success} fail=${ledger.summary.fail}`
  );
  if (result.added.length) {
    console.log("New entries:", result.added.map(e => `${e.symbol}:${e.direction}`));
  }
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
