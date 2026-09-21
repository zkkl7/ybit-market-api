import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchClosedKlines } from "./update-entry-backtest.mjs";

const EXECUTABLE = new Set(["EARLY_ENTRY", "BREAKOUT_ENTRY", "RETEST_ENTRY"]);
const POOLS = ["longCandidatePool", "shortCandidatePool", "tradFiLongCandidatePool", "tradFiShortCandidatePool"];
const COOLDOWN_MS = 45 * 60 * 1000;
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
  entryPrice: number(candidate.keyMetrics?.price ?? candidate.price),
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

const emptyWindow = () => ({ mfePct: null, maePct: null, hit05: false, hit10: false, hit20: false });

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
        entryPrice: features.entryPrice,
        "15m": emptyWindow(), "30m": emptyWindow(),
        "60m": { ...emptyWindow(), timeTo05: null, timeTo10: null },
        legacy: { eventualHit05: false, stopHit35: false },
        classification: null,
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
  let changed = false;
  for (const minutes of WINDOWS) {
    const rows = candles.filter(c => c.openTime >= start && c.openTime < start + minutes * 60_000);
    if (!rows.length) continue;
    const favorable = rows.map(c => sign > 0 ? c.high : c.low);
    const adverse = rows.map(c => sign > 0 ? c.low : c.high);
    const mfe = sign * ((sign > 0 ? Math.max(...favorable) : Math.min(...favorable)) / event.entryPrice - 1) * 100;
    const mae = sign * ((sign > 0 ? Math.min(...adverse) : Math.max(...adverse)) / event.entryPrice - 1) * 100;
    const target = event[`${minutes}m`];
    Object.assign(target, {
      mfePct: round(Math.max(0, mfe)), maePct: round(Math.min(0, mae)),
      hit05: mfe >= 0.5, hit10: mfe >= 1, hit20: mfe >= 2,
    });
    if (minutes === 60) {
      for (const [threshold, field] of [[0.5, "timeTo05"], [1, "timeTo10"]]) {
        const hit = rows.find(c => sign * (((sign > 0 ? c.high : c.low) / event.entryPrice) - 1) * 100 >= threshold);
        target[field] = hit ? Math.max(0, Math.round((hit.openTime - start) / 60_000)) : null;
      }
      event.legacy.eventualHit05 = target.hit05;
      event.legacy.stopHit35 = target.maePct <= -3.5;
      event.classification = target.hit20 ? "RUNNER" : target.hit05
        ? (!event.firstConfirmedAt ? "FALSE_NEGATIVE" : event.confirmationType === "CLEAN" ? "CLEAN_WIN" : "MIXED_WIN")
        : event.firstProbeAt && !event.firstConfirmedAt ? "GOOD_BLOCK"
        : event.confirmationLostAt && Date.parse(event.confirmationLostAt) - Date.parse(event.firstConfirmedAt) < 15 * 60_000
          ? "FLASH_CONFIRMED" : null;
    }
    changed = true;
  }
  return changed;
}

export function summarize(events) {
  const summary = { total: events.length, active: 0, clean: 0, mixed: 0, hit05_60m: 0, hit10_60m: 0, hit20_60m: 0, byClassification: {} };
  for (const event of events) {
    if (event.lifecycleStatus === "ACTIVE") summary.active++;
    if (event.confirmationType === "CLEAN") summary.clean++;
    if (event.confirmationType === "MIXED") summary.mixed++;
    if (event["60m"]?.hit05) summary.hit05_60m++;
    if (event["60m"]?.hit10) summary.hit10_60m++;
    if (event["60m"]?.hit20) summary.hit20_60m++;
    if (event.classification) summary.byClassification[event.classification] = (summary.byClassification[event.classification] ?? 0) + 1;
  }
  return summary;
}

export async function updateV46Ledger({ ledger, latest, nowMs = Date.now(), fetchImpl = fetch }) {
  updateLifecycle(ledger, latest);
  const relevant = ledger.events.filter(event => nowMs - Date.parse(event.firstSeenAt) <= 2 * 60 * 60_000);
  for (const symbol of new Set(relevant.map(event => event.symbol))) {
    const events = relevant.filter(event => event.symbol === symbol);
    const start = Math.min(...events.map(event => Date.parse(event.firstSeenAt)));
    try {
      const candles = await fetchClosedKlines(symbol, start, nowMs, fetchImpl);
      for (const event of events) applyCandles(event, candles);
    } catch (error) {
      console.warn(`warning: ${symbol} V4.6 window update skipped: ${error.message}`);
    }
  }
  ledger.version = "V46-EVENT-LEDGER-1";
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
  console.log(`V4.6 ledger updated. total=${ledger.summary.total} active=${ledger.summary.active} 60m+0.5=${ledger.summary.hit05_60m}`);
  return ledger;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) run().catch(error => { console.error(error); process.exitCode = 1; });
