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

const rules = () => ({
  lifecycleKey: "symbol+direction until invalidated and 45m cooldown",
  setupAnchor: "firstSeenAt+firstSeenPrice",
  confirmedAnchor: "firstConfirmedAt+confirmedEntryPrice",
  entryPriceAlias: "firstSeenPrice",
  focus: "15m/30m/60m underlying move",
  thresholdsPct: [0.5, 1, 2],
  windowMetricsBasis: "closed 5m candle high/low",
  maturity: "elapsed time and contiguous closed-candle coverage through window end",
  tiePolicy: "stop_wins",
  anchorPricesLocked: true,
  featureSnapshotsLocked: true,
  featureAttributionSource: "firstSeenFeatures / confirmedFeatures",
  releaseStatus: "V4.6.1 frozen for forward-sample collection",
  legacyResultsSource: "data/entry-backtest.json",
});

const emptyWindow = () => ({
  checkedThrough: null, dataComplete: false, matured: false,
  mfePct: null, maePct: null,
  hit05: false, hit10: false, hit20: false,
  failedBefore05: false, failedBefore10: false,
  firstHit05At: null, firstHit10At: null, firstHit20At: null, firstStop35At: null,
});

const emptyMetrics = () => ({
  "15m": emptyWindow(), "30m": emptyWindow(),
  "60m": { ...emptyWindow(), timeTo05: null, timeTo10: null },
});

export function createV46Ledger() {
  return { version: "V46-EVENT-LEDGER-2", updatedAt: null, rules: rules(), summary: {}, events: [] };
}

const allCandidates = latest => {
  const radar = latest?.radar ?? latest ?? {};
  const seen = new Map();
  for (const pool of POOLS) for (const candidate of radar[pool] ?? []) {
    if (candidate?.symbol && candidate?.direction) seen.set(`${candidate.symbol}:${candidate.direction}`, candidate);
  }
  return [...seen.values()];
};

const snapshotTime = latest => new Date(
  latest?.radar?.scannedAt ?? latest?.snapshot?.fetchedAt ?? latest?.scannedAt ?? Date.now()
).toISOString();

const candidatePrice = candidate => number(candidate.keyMetrics?.price ?? candidate.price);
const frozenFeatures = candidate => ({
  entrySignal: candidate.entrySignal ?? null,
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
  spreadBps: number(candidate.spreadBps),
  obiScore: number(candidate.obiScore),
  relativeStrengthAligned: candidate.relativeStrengthAligned ?? null,
  relativeStrengthOpposes: candidate.relativeStrengthOpposes ?? null,
});

const candidateFeatures = candidate => ({
  lastEntrySignal: candidate.entrySignal ?? null,
  lastSeenPrice: candidatePrice(candidate),
  lastExecutionTier: candidate.executionTier ?? null,
  marketType: candidate.marketType ?? "UNKNOWN",
  lastFinalCandidateScore: number(candidate.finalCandidateScore ?? candidate.candidateQuality),
  lastExecutionScore: number(candidate.executionScore ?? candidate.directionConfidence),
  lastMicroPersistence: candidate.microPersistence ?? null,
  lastStrictReclaim: candidate.strictPriceReclaim ?? null,
  lastNearReclaim: candidate.nearReclaim ?? null,
  lastRiskFlags: [...new Set(candidate.v46RiskFlags ?? candidate.v45RiskFlags ?? [])],
  lastCvdBias: candidate.cvdBias ?? null,
  lastOrderFlowBias: candidate.orderFlowBias ?? null,
  lastMicropriceBias: candidate.micropriceBias ?? null,
  lastCrossConfirmation: candidate.crossExchangeSummary?.confirmation ?? candidate.crossConfirmation ?? null,
});

const sameInstant = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);

export function migrateEvent(event, candidate = null) {
  event.firstSeenPrice ??= number(event.entryPrice);
  event.entryPrice = event.firstSeenPrice; // compatibility alias only
  event.lastSeenPrice ??= event.firstSeenPrice;
  event.marketType ??= candidate?.marketType ?? "UNKNOWN";
  event.lastExecutionTier ??= candidate?.executionTier ?? event.confirmationType ?? null;
  if (!("firstSeenFeatures" in event)) event.firstSeenFeatures = null;
  if (!("confirmedFeatures" in event)) event.confirmedFeatures = null;
  if (!("confirmedEntryPrice" in event)) {
    event.confirmedEntryPrice = event.firstConfirmedAt && sameInstant(event.firstConfirmedAt, event.firstSeenAt)
      ? event.firstSeenPrice : null;
  }
  event.confirmationDelayMin = event.firstConfirmedAt
    ? round((Date.parse(event.firstConfirmedAt) - Date.parse(event.firstSeenAt)) / 60_000, 2) : null;
  if (!event.setupMetrics) {
    event.setupMetrics = {};
    for (const minutes of WINDOWS) event.setupMetrics[`${minutes}m`] = event[`${minutes}m`] ?? emptyWindow();
  }
  event.confirmedMetrics ??= emptyMetrics();
  for (const minutes of WINDOWS) delete event[`${minutes}m`];
  event.legacy = { eventualHit05: null, stopHit35: null, source: "entry-backtest-ledger" };
  event.tags ??= [];
  return event;
}

export function updateLifecycle(ledger, latest) {
  if (!Array.isArray(ledger.events)) ledger.events = [];
  const at = snapshotTime(latest);
  const atMs = Date.parse(at);
  const candidates = allCandidates(latest);
  const current = new Map(candidates.map(candidate => [`${candidate.symbol}:${candidate.direction}`, candidate]));
  for (const event of ledger.events) migrateEvent(event, current.get(`${event.symbol}:${event.direction}`));

  for (const event of ledger.events.filter(row => row.lifecycleStatus === "ACTIVE")) {
    const candidate = current.get(`${event.symbol}:${event.direction}`);
    if (!candidate || !EXECUTABLE.has(candidate.entrySignal)) {
      if (event.firstConfirmedAt && !event.confirmationLostAt) event.confirmationLostAt = at;
      event.lifecycleStatus = "COOLDOWN";
      event.cooldownUntil = new Date(atMs + COOLDOWN_MS).toISOString();
    }
  }

  const changed = [];
  for (const candidate of candidates) {
    if (!EXECUTABLE.has(candidate.entrySignal)) continue;
    const key = `${candidate.symbol}:${candidate.direction}`;
    let event = [...ledger.events].reverse().find(row => `${row.symbol}:${row.direction}` === key &&
      (row.lifecycleStatus === "ACTIVE" || (row.lifecycleStatus === "COOLDOWN" && Date.parse(row.cooldownUntil) > atMs)));
    const features = candidateFeatures(candidate);
    if (!event) {
      event = {
        setupId: `${candidate.symbol}-${candidate.direction}-${at.replace(/[-:.TZ]/g, "")}`,
        symbol: candidate.symbol, direction: candidate.direction,
        firstSeenAt: at, firstSeenPrice: features.lastSeenPrice, entryPrice: features.lastSeenPrice,
        firstProbeAt: null, firstConfirmedAt: null, confirmedEntryPrice: null,
        confirmationType: null, confirmationDelayMin: null, confirmationLostAt: null,
        lifecycleStatus: "ACTIVE", cooldownUntil: null,
        ...features,
        firstSeenFeatures: frozenFeatures(candidate), confirmedFeatures: null,
        setupMetrics: emptyMetrics(), confirmedMetrics: emptyMetrics(),
        legacy: { eventualHit05: null, stopHit35: null, source: "entry-backtest-ledger" },
        classification: null, tags: [], lastSeenAt: at,
      };
      ledger.events.push(event);
    } else {
      Object.assign(event, features, { lifecycleStatus: "ACTIVE", cooldownUntil: null, lastSeenAt: at });
      event.entryPrice = event.firstSeenPrice;
    }
    if (candidate.entryStage === "CONFIRMED") {
      if (!event.firstConfirmedAt) {
        event.firstConfirmedAt = at;
        event.confirmedEntryPrice = features.lastSeenPrice;
        event.confirmationType = candidate.executionTier ?? "MIXED";
        event.confirmedFeatures = frozenFeatures(candidate);
        event.confirmationDelayMin = round((atMs - Date.parse(event.firstSeenAt)) / 60_000, 2);
      }
    } else {
      event.firstProbeAt ??= at;
      if (event.firstConfirmedAt && !event.confirmationLostAt) event.confirmationLostAt = at;
    }
    changed.push(event);
  }
  return changed;
}

const normalizeCandles = candles => candles.map(candle => ({
  openTime: Number(candle.openTime ?? candle[0]),
  high: Number(candle.high ?? candle[2]), low: Number(candle.low ?? candle[3]),
})).filter(candle => Number.isFinite(candle.openTime) && candle.high > 0 && candle.low > 0)
  .sort((a, b) => a.openTime - b.openTime);

function calculateMetrics(event, anchorAt, anchorPrice, candles, nowMs) {
  const metrics = emptyMetrics();
  if (!anchorAt || !Number.isFinite(anchorPrice)) return metrics;
  const start = Date.parse(anchorAt);
  const sign = event.direction === "SHORT" ? -1 : 1;
  const move = price => sign * (price / anchorPrice - 1) * 100;
  for (const minutes of WINDOWS) {
    const end = start + minutes * 60_000;
    const requiredStart = Math.floor(start / CANDLE_MS) * CANDLE_MS;
    const requiredLastOpen = Math.ceil(end / CANDLE_MS) * CANDLE_MS - CANDLE_MS;
    const byOpen = new Map(candles.map(candle => [candle.openTime, candle]));
    let contiguousThrough = requiredStart;
    for (let open = requiredStart; open <= requiredLastOpen; open += CANDLE_MS) {
      if (!byOpen.has(open)) break;
      contiguousThrough = open + CANDLE_MS;
    }
    const target = emptyWindow();
    if (minutes === 60) Object.assign(target, { timeTo05: null, timeTo10: null });
    target.checkedThrough = contiguousThrough > requiredStart ? new Date(contiguousThrough).toISOString() : null;
    target.dataComplete = contiguousThrough >= end;
    target.matured = nowMs >= end && target.dataComplete;
    const rows = candles.filter(candle => candle.openTime + CANDLE_MS > start && candle.openTime < end);
    let mfe = 0, mae = 0, stopped = false;
    for (const candle of rows) {
      const partialAnchorCandle = candle.openTime < start;
      const favorablePct = partialAnchorCandle ? 0 : Math.max(0, move(sign > 0 ? candle.high : candle.low));
      const adversePct = Math.min(0, move(sign > 0 ? candle.low : candle.high));
      mfe = Math.max(mfe, favorablePct); mae = Math.min(mae, adversePct);
      const hitAt = new Date(candle.openTime + CANDLE_MS).toISOString();
      if (!stopped && adversePct <= -3.5) {
        stopped = true; target.firstStop35At ??= hitAt;
      } else if (!stopped) {
        if (favorablePct >= 0.5) target.firstHit05At ??= hitAt;
        if (favorablePct >= 1) target.firstHit10At ??= hitAt;
        if (favorablePct >= 2) target.firstHit20At ??= hitAt;
      }
    }
    if (rows.length) { target.mfePct = round(mfe); target.maePct = round(mae); }
    target.hit05 = target.firstHit05At !== null;
    target.hit10 = target.firstHit10At !== null;
    target.hit20 = target.firstHit20At !== null;
    target.failedBefore05 = target.firstStop35At !== null && !target.hit05;
    target.failedBefore10 = target.firstStop35At !== null && !target.hit10;
    if (minutes === 60) {
      target.timeTo05 = target.firstHit05At ? Math.max(0, Math.round((Date.parse(target.firstHit05At) - start) / 60_000)) : null;
      target.timeTo10 = target.firstHit10At ? Math.max(0, Math.round((Date.parse(target.firstHit10At) - start) / 60_000)) : null;
    }
    metrics[`${minutes}m`] = target;
  }
  return metrics;
}

export function applyCandles(event, candles, nowMs = Date.now()) {
  migrateEvent(event);
  const normalized = normalizeCandles(candles);
  event.setupMetrics = calculateMetrics(event, event.firstSeenAt, event.firstSeenPrice, normalized, nowMs);
  event.confirmedMetrics = calculateMetrics(event, event.firstConfirmedAt, event.confirmedEntryPrice, normalized, nowMs);
  const setup60 = event.setupMetrics["60m"];
  const confirmed60 = event.confirmedMetrics["60m"];
  if (!event.firstConfirmedAt) {
    event.classification = setup60.hit05 ? "FALSE_NEGATIVE" : setup60.failedBefore05 ? "GOOD_BLOCK" : null;
  } else if (Number.isFinite(event.confirmedEntryPrice)) {
    event.classification = confirmed60.hit05 ? (event.confirmationType === "CLEAN" ? "CLEAN_WIN" : "MIXED_WIN") : null;
  }
  const tags = new Set(event.tags ?? []);
  if ((event.firstConfirmedAt ? confirmed60 : setup60).hit20) { tags.add("RUNNER"); tags.add("HIT_2PCT"); }
  if (event.confirmationLostAt && event.firstConfirmedAt &&
    Date.parse(event.confirmationLostAt) - Date.parse(event.firstConfirmedAt) < 15 * 60_000) tags.add("FLASH_CONFIRMED");
  event.tags = [...tags];
  event.legacy = { eventualHit05: null, stopHit35: null, source: "entry-backtest-ledger" };
  return normalized.length > 0;
}

const confirmedAggregate = events => {
  const aggregate = { total: events.length };
  for (const minutes of WINDOWS) {
    aggregate[`matured${minutes}m`] = 0;
    for (const threshold of minutes === 15 ? ["05", "10"] : ["05", "10", "20"]) {
      aggregate[`hit${threshold}_${minutes}m`] = 0;
      aggregate[`hit${threshold}Rate${minutes}m`] = null;
    }
  }
  for (const event of events) for (const minutes of WINDOWS) {
    const metric = event.confirmedMetrics?.[`${minutes}m`];
    if (!metric?.matured) continue;
    aggregate[`matured${minutes}m`]++;
    for (const threshold of minutes === 15 ? ["05", "10"] : ["05", "10", "20"]) {
      if (metric[`hit${threshold}`]) aggregate[`hit${threshold}_${minutes}m`]++;
    }
  }
  for (const minutes of WINDOWS) for (const threshold of minutes === 15 ? ["05", "10"] : ["05", "10", "20"]) {
    const denominator = aggregate[`matured${minutes}m`];
    aggregate[`hit${threshold}Rate${minutes}m`] = denominator
      ? round(aggregate[`hit${threshold}_${minutes}m`] / denominator * 100, 2) : null;
  }
  return aggregate;
};

const probeAggregate = events => ({
  total: events.length,
  matured60m: events.filter(event => event.setupMetrics?.["60m"]?.matured).length,
  goodBlock: events.filter(event => event.classification === "GOOD_BLOCK").length,
  falseNegative05: events.filter(event => event.setupMetrics?.["60m"]?.matured && event.setupMetrics["60m"].hit05).length,
  falseNegative10: events.filter(event => event.setupMetrics?.["60m"]?.matured && event.setupMetrics["60m"].hit10).length,
  falseNegative20: events.filter(event => event.setupMetrics?.["60m"]?.matured && event.setupMetrics["60m"].hit20).length,
});

export function summarize(events) {
  const market = type => {
    const scoped = events.filter(event => event.marketType === type);
    const confirmed = scoped.filter(event => event.firstConfirmedAt);
    const cleanEvents = confirmed.filter(event => event.confirmationType === "CLEAN");
    const mixedEvents = confirmed.filter(event => event.confirmationType === "MIXED");
    const result = confirmedAggregate(confirmed);
    result.clean = confirmedAggregate(cleanEvents);
    result.mixed = confirmedAggregate(mixedEvents);
    return { confirmed: result, probe: probeAggregate(scoped.filter(event => !event.firstConfirmedAt)) };
  };
  return {
    totalEvents: events.length,
    unknownMarketEvents: events.filter(event => event.marketType === "UNKNOWN").length,
    crypto: market("CRYPTO_PERP"),
    tradfi: market("TRADFI_PERP"),
  };
}

export async function updateV46Ledger({ ledger, latest, nowMs = Date.now(), fetchImpl = fetch }) {
  updateLifecycle(ledger, latest);
  const relevant = ledger.events.filter(event => nowMs - Date.parse(event.firstSeenAt) <= 2 * 60 * 60_000);
  for (const symbol of new Set(relevant.map(event => event.symbol))) {
    const events = relevant.filter(event => event.symbol === symbol);
    const anchors = events.flatMap(event => [event.firstSeenAt, event.firstConfirmedAt]).filter(Boolean).map(Date.parse);
    const start = Math.floor(Math.min(...anchors) / CANDLE_MS) * CANDLE_MS;
    try {
      const candles = await fetchClosedKlines(symbol, start, nowMs, fetchImpl);
      for (const event of events) applyCandles(event, candles, nowMs);
    } catch (error) {
      console.warn(`warning: ${symbol} V4.6 window update skipped: ${error.message}`);
    }
  }
  ledger.version = "V46-EVENT-LEDGER-2";
  ledger.rules = rules();
  ledger.summary = summarize(ledger.events);
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
  console.log(`V4.6 ledger updated. total=${ledger.summary.totalEvents} cryptoConfirmed=${ledger.summary.crypto.confirmed.total}`);
  return ledger;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) run().catch(error => { console.error(error); process.exitCode = 1; });
