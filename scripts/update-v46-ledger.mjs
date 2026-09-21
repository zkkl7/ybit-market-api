import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchClosedKlines } from "./update-entry-backtest.mjs";

const EXECUTABLE = new Set(["EARLY_ENTRY", "BREAKOUT_ENTRY", "RETEST_ENTRY"]);
const POOLS = ["longCandidatePool", "shortCandidatePool", "tradFiLongCandidatePool", "tradFiShortCandidatePool"];
const COOLDOWN_MS = 45 * 60 * 1000;
const CANDLE_MS = 5 * 60 * 1000;
const WINDOWS = [15, 30, 60];
const round = (n, d = 4) => Number.isFinite(n) ? Number(n.toFixed(d)) : null;
const number = value => value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function createV46Ledger() {
  return {
    version: "V46-EVENT-LEDGER-1",
    updatedAt: null,
    rules: {
      lifecycleKey: "symbol+direction until invalidated and 45m cooldown",
      focus: "15m/30m/60m underlying move",
      thresholdsPct: [0.5, 1, 2],
      legacyPreserved: true,
      windowMetricsBasis: "5m candle high/low",
      tiePolicy: "stop_wins",
      entryPriceLocked: true,
    },
    summary: {},
    events: [],
  };
}

const allCandidates = latest => {
  const radar = latest?.radar ?? latest ?? {};
  const seen = new Map();
  for (const pool of POOLS) for (const candidate of radar[pool] ?? []) {
    if (!candidate?.symbol || !candidate?.direction) continue;
    seen.set(`${candidate.symbol}:${candidate.direction}`, candidate);
  }
  return [...seen.values()];
};

const snapshotTime = latest => new Date(
  latest?.radar?.scannedAt ?? latest?.snapshot?.fetchedAt ?? latest?.scannedAt ?? Date.now()
).toISOString();

const compactFeatures = candidate => ({
  entrySignal: candidate.entrySignal ?? null,
  lastSeenPrice: number(candidate.keyMetrics?.price ?? candidate.price),
  finalCandidateScore: number(candidate.finalCandidateScore ?? candidate.candidateQuality),
  executionScore: number(candidate.executionScore ?? candidate.directionConfidence),
  microPersistence: candidate.microPersistence ?? null,
  strictReclaim: candidate.strictPriceReclaim ?? null,
  nearReclaim: candidate.nearReclaim ?? null,
  riskFlags: [...new Set(candidate.v46RiskFlags ?? candidate.v45RiskFlags ?? [])],
  cvdBias: candidate.cvdBias ?? null,
  orderFlowBias: candidate.orderFlowBias ?? null,
  micropriceBias: candidate.micropriceBias ?? null,
  crossConfirmation: candidate.crossExchangeSummary?.confirmation ?? candidate.crossConfirmation ?? null,
});

const emptyWindow = () => ({
  matured: false, mfePct: null, maePct: null,
  hit05: false, hit10: false, hit20: false,
  failedBefore05: false, failedBefore10: false,
  firstHit05At: null, firstHit10At: null, firstHit20At: null, firstStop35At: null,
});

export function updateLifecycle(ledger, latest) {
  if (!Array.isArray(ledger.events)) ledger.events = [];
  const at = snapshotTime(latest);
  const atMs = Date.parse(at);
  const current = new Map(allCandidates(latest).map(candidate => [`${candidate.symbol}:${candidate.direction}`, candidate]));
  const changed = [];

  for (const event of ledger.events.filter(row => row.lifecycleStatus === "ACTIVE")) {
    const key = `${event.symbol}:${event.direction}`;
    const candidate = current.get(key);
    if (!candidate || !EXECUTABLE.has(candidate.entrySignal)) {
      if (event.firstConfirmedAt && !event.confirmationLostAt) event.confirmationLostAt = at;
      event.lifecycleStatus = "COOLDOWN";
      event.cooldownUntil = new Date(atMs + COOLDOWN_MS).toISOString();
      changed.push(event);
    }
  }

  for (const candidate of current.values()) {
    if (!EXECUTABLE.has(candidate.entrySignal)) continue;
    const key = `${candidate.symbol}:${candidate.direction}`;
    let event = [...ledger.events].reverse().find(row => `${row.symbol}:${row.direction}` === key &&
      (row.lifecycleStatus === "ACTIVE" || (row.lifecycleStatus === "COOLDOWN" && Date.parse(row.cooldownUntil) > atMs)));
    const features = compactFeatures(candidate);
    if (!event) {
      event = {
        setupId: `${candidate.symbol}-${candidate.direction}-${at.replace(/[-:.TZ]/g, "")}`,
        symbol: candidate.symbol,
        direction: candidate.direction,
        firstSeenAt: at,
        firstProbeAt: null,
        firstConfirmedAt: null,
        confirmationType: null,
        confirmationLostAt: null,
        lifecycleStatus: "ACTIVE",
        cooldownUntil: null,
        ...features,
        entryPrice: features.lastSeenPrice,
        "15m": emptyWindow(), "30m": emptyWindow(),
        "60m": { ...emptyWindow(), timeTo05: null, timeTo10: null },
        legacy: { eventualHit05: false, stopHit35: false },
        classification: null,
        tags: [],
        firstHit05At: null,
        firstHit10At: null,
        firstHit20At: null,
        firstStop35At: null,
        lastSeenAt: at,
      };
      ledger.events.push(event);
    } else {
      Object.assign(event, features, { lifecycleStatus: "ACTIVE", cooldownUntil: null, lastSeenAt: at });
    }
    if (candidate.entryStage === "CONFIRMED") {
      event.firstConfirmedAt ??= at;
      event.confirmationType ??= candidate.executionTier ?? "MIXED";
    } else {
      event.firstProbeAt ??= at;
      if (event.firstConfirmedAt && !event.confirmationLostAt) event.confirmationLostAt = at;
    }
    changed.push(event);
  }
  return changed;
}

export function applyCandles(event, candles) {
  if (!Number.isFinite(event.entryPrice) || !event.firstSeenAt) return false;
  const start = Date.parse(event.firstSeenAt);
  const sign = event.direction === "SHORT" ? -1 : 1;
  const sorted = candles.map(candle => ({
    openTime: Number(candle.openTime ?? candle[0]),
    high: Number(candle.high ?? candle[2]),
    low: Number(candle.low ?? candle[3]),
  })).filter(candle => Number.isFinite(candle.openTime) && candle.high > 0 && candle.low > 0)
    .sort((a, b) => a.openTime - b.openTime);
  const move = price => sign * (price / event.entryPrice - 1) * 100;
  let changed = false;
  for (const minutes of WINDOWS) {
    const rows = sorted.filter(c => c.openTime + CANDLE_MS > start && c.openTime < start + minutes * 60_000);
    if (!rows.length) continue;
    const target = emptyWindow();
    if (minutes === 60) Object.assign(target, { timeTo05: null, timeTo10: null });
    let mfe = 0;
    let mae = 0;
    let stopped = false;
    for (const candle of rows) {
      const partialEntryCandle = candle.openTime < start;
      const favorablePct = partialEntryCandle ? 0 : Math.max(0, move(sign > 0 ? candle.high : candle.low));
      const adversePct = Math.min(0, move(sign > 0 ? candle.low : candle.high));
      mfe = Math.max(mfe, favorablePct);
      mae = Math.min(mae, adversePct);
      const hitAt = new Date(candle.openTime + CANDLE_MS).toISOString();
      const stopHit = adversePct <= -3.5;
      // OHLC cannot prove intrabar order, so the stop wins a same-candle tie.
      if (!stopped && stopHit) {
        stopped = true;
        target.firstStop35At ??= hitAt;
      } else if (!stopped) {
        if (favorablePct >= 0.5) target.firstHit05At ??= hitAt;
        if (favorablePct >= 1) target.firstHit10At ??= hitAt;
        if (favorablePct >= 2) target.firstHit20At ??= hitAt;
      }
    }
    Object.assign(target, {
      mfePct: round(mfe), maePct: round(mae),
      hit05: target.firstHit05At !== null,
      hit10: target.firstHit10At !== null,
      hit20: target.firstHit20At !== null,
      failedBefore05: target.firstStop35At !== null && target.firstHit05At === null,
      failedBefore10: target.firstStop35At !== null && target.firstHit10At === null,
    });
    if (minutes === 60) {
      target.timeTo05 = target.firstHit05At ? Math.max(0, Math.round((Date.parse(target.firstHit05At) - start) / 60_000)) : null;
      target.timeTo10 = target.firstHit10At ? Math.max(0, Math.round((Date.parse(target.firstHit10At) - start) / 60_000)) : null;
      event.firstHit05At = target.firstHit05At;
      event.firstHit10At = target.firstHit10At;
      event.firstHit20At = target.firstHit20At;
      event.firstStop35At = target.firstStop35At;
      event.legacy.eventualHit05 = target.hit05;
      event.legacy.stopHit35 = target.firstStop35At !== null;
      event.classification = target.hit05
        ? (!event.firstConfirmedAt ? "FALSE_NEGATIVE" : event.confirmationType === "CLEAN" ? "CLEAN_WIN" : "MIXED_WIN")
        : event.firstProbeAt && !event.firstConfirmedAt && target.failedBefore05 ? "GOOD_BLOCK" : null;
      const tags = new Set(event.tags ?? []);
      if (target.hit20) tags.add("RUNNER");
      if (target.hit20) tags.add("HIT_2PCT");
      if (event.confirmationLostAt && event.firstConfirmedAt &&
        Date.parse(event.confirmationLostAt) - Date.parse(event.firstConfirmedAt) < 15 * 60_000) tags.add("FLASH_CONFIRMED");
      event.tags = [...tags];
    }
    event[`${minutes}m`] = target;
    changed = true;
  }
  return changed;
}

export function summarize(events, nowMs = Date.now()) {
  const summary = {
    total: events.length, active: 0, clean: 0, mixed: 0,
    matured15m: 0, matured30m: 0, matured60m: 0,
    hit05_15m: 0, hit10_15m: 0,
    hit05_30m: 0, hit10_30m: 0, hit20_30m: 0,
    hit05_60m: 0, hit10_60m: 0, hit20_60m: 0,
    hit05Rate15m: null, hit10Rate15m: null,
    hit05Rate30m: null, hit10Rate30m: null, hit20Rate30m: null,
    hit05Rate60m: null, hit10Rate60m: null, hit20Rate60m: null,
    byClassification: {},
  };
  for (const event of events) {
    if (event.lifecycleStatus === "ACTIVE") summary.active++;
    if (event.confirmationType === "CLEAN") summary.clean++;
    if (event.confirmationType === "MIXED") summary.mixed++;
    for (const minutes of WINDOWS) {
      const matured = nowMs >= Date.parse(event.firstSeenAt) + minutes * 60_000;
      if (event[`${minutes}m`]) event[`${minutes}m`].matured = matured;
      if (!matured) continue;
      summary[`matured${minutes}m`]++;
      for (const threshold of minutes === 15 ? ["05", "10"] : ["05", "10", "20"]) {
        if (event[`${minutes}m`]?.[`hit${threshold}`]) summary[`hit${threshold}_${minutes}m`]++;
      }
    }
    if (event.classification) summary.byClassification[event.classification] = (summary.byClassification[event.classification] ?? 0) + 1;
  }
  for (const minutes of WINDOWS) {
    const denominator = summary[`matured${minutes}m`];
    for (const threshold of minutes === 15 ? ["05", "10"] : ["05", "10", "20"]) {
      summary[`hit${threshold}Rate${minutes}m`] = denominator
        ? round(summary[`hit${threshold}_${minutes}m`] / denominator * 100, 2) : null;
    }
  }
  return summary;
}

export async function updateV46Ledger({ ledger, latest, nowMs = Date.now(), fetchImpl = fetch }) {
  updateLifecycle(ledger, latest);
  const relevant = ledger.events.filter(event => nowMs - Date.parse(event.firstSeenAt) <= 2 * 60 * 60_000);
  for (const symbol of new Set(relevant.map(event => event.symbol))) {
    const events = relevant.filter(event => event.symbol === symbol);
    const start = Math.min(...events.map(event => Math.floor(Date.parse(event.firstSeenAt) / CANDLE_MS) * CANDLE_MS));
    try {
      const candles = await fetchClosedKlines(symbol, start, nowMs, fetchImpl);
      for (const event of events) applyCandles(event, candles);
    } catch (error) {
      console.warn(`warning: ${symbol} V4.6 window update skipped: ${error.message}`);
    }
  }
  ledger.version = "V46-EVENT-LEDGER-1";
  ledger.rules = { ...createV46Ledger().rules };
  ledger.summary = summarize(ledger.events, nowMs);
  ledger.updatedAt = new Date(nowMs).toISOString();
  return ledger;
}

export async function run({ root = process.cwd(), nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const latest = JSON.parse(fs.readFileSync(path.join(root, "data", "latest.json"), "utf8"));
  const ledgerPath = path.join(root, "data", "v46-ledger.json");
  let ledger = createV46Ledger();
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await updateV46Ledger({ ledger, latest, nowMs, fetchImpl });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`V4.6 ledger updated. total=${ledger.summary.total} active=${ledger.summary.active} 60m+0.5=${ledger.summary.hit05_60m}`);
  return ledger;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) run().catch(error => { console.error(error); process.exitCode = 1; });
