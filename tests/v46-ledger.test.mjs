import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCandles, createV46Ledger, migrateEvent, summarize, updateLifecycle,
} from "../scripts/update-v46-ledger.mjs";

const T0 = Date.parse("2026-09-21T00:00:00Z");
const latest = (minutes, stage = "PROBE", tier = "MIXED", price = 100, marketType = "CRYPTO_PERP") => ({
  snapshot: { fetchedAt: new Date(T0 + minutes * 60_000).toISOString() },
  radar: { longCandidatePool: [{
    symbol: "TESTUSDT", direction: "LONG", marketType,
    entrySignal: "BREAKOUT_ENTRY", entryStage: stage, executionTier: tier,
    executionScore: 72, strictPriceReclaim: stage === "CONFIRMED", nearReclaim: true,
    microPersistence: "PERSISTENT", v46RiskFlags: [], keyMetrics: { price },
  }] },
});

const candle = (minute, high, low) => ({ openTime: T0 + minute * 60_000, high, low });
const flatCandles = (fromMinute, throughMinute, high = 100.2, low = 99.8) => {
  const rows = [];
  for (let minute = fromMinute; minute < throughMinute; minute += 5) rows.push(candle(minute, high, low));
  return rows;
};

test("PROBE and first CONFIRMED prices are independently locked", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest(0, "PROBE", "MIXED", 100));
  updateLifecycle(ledger, latest(10, "CONFIRMED", "CLEAN", 101));
  updateLifecycle(ledger, latest(15, "CONFIRMED", "MIXED", 103));
  const event = ledger.events[0];
  assert.equal(event.firstSeenFeatures.executionScore, 72);
  assert.deepEqual(event.firstSeenFeatures.riskFlags, []);
  assert.equal(event.firstSeenPrice, 100);
  assert.equal(event.entryPrice, 100);
  assert.equal(event.confirmedEntryPrice, 101);
  assert.equal(event.lastSeenPrice, 103);
  assert.equal(event.confirmationType, "CLEAN");
  assert.equal(event.confirmedFeatures.executionScore, 72);
  assert.equal(event.confirmedFeatures.microPersistence, "PERSISTENT");
  assert.equal(event.lastExecutionTier, "MIXED");
  assert.equal(event.confirmationDelayMin, 10);
  assert.equal(ledger.events.length, 1);
});

test("frozen features do not change while explicit last fields update", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest(0, "PROBE", "MIXED", 100));
  const changed = latest(5, "PROBE", "MIXED", 103);
  changed.radar.longCandidatePool[0].executionScore = 40;
  changed.radar.longCandidatePool[0].v46RiskFlags = ["LATER_RISK"];
  updateLifecycle(ledger, changed);
  const event = ledger.events[0];
  assert.equal(event.firstSeenFeatures.executionScore, 72);
  assert.deepEqual(event.firstSeenFeatures.riskFlags, []);
  assert.equal(event.lastExecutionScore, 40);
  assert.deepEqual(event.lastRiskFlags, ["LATER_RISK"]);
  assert.equal(event.lastSeenPrice, 103);
});

test("first-frame CONFIRMED freezes both feature snapshots", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest(0, "CONFIRMED", "CLEAN", 100));
  const event = ledger.events[0];
  assert.deepEqual(event.firstSeenFeatures, event.confirmedFeatures);
  assert.equal(event.confirmationType, "CLEAN");
});

test("setup gains before confirmation do not leak into confirmed metrics", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest(0, "PROBE", "MIXED", 100));
  updateLifecycle(ledger, latest(10, "CONFIRMED", "CLEAN", 101));
  const event = ledger.events[0];
  applyCandles(event, [
    candle(0, 100.4, 99.8), candle(5, 101.1, 100),
    candle(10, 101.2, 100.8), candle(15, 101.2, 100.9), candle(20, 101.2, 100.9),
  ], T0 + 30 * 60_000);
  assert.equal(event.setupMetrics["15m"].hit10, true);
  assert.equal(event.confirmedMetrics["15m"].hit05, false);
});

test("elapsed time without complete candle coverage is not matured", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest(0, "CONFIRMED", "CLEAN", 100));
  const event = ledger.events[0];
  const incomplete = flatCandles(0, 60).filter(row => row.openTime !== T0 + 25 * 60_000);
  applyCandles(event, incomplete, T0 + 70 * 60_000);
  assert.equal(event.confirmedMetrics["60m"].dataComplete, false);
  assert.equal(event.confirmedMetrics["60m"].matured, false);
  applyCandles(event, flatCandles(0, 60), T0 + 70 * 60_000);
  assert.equal(event.confirmedMetrics["60m"].dataComplete, true);
  assert.equal(event.confirmedMetrics["60m"].matured, true);
  assert.equal(event.confirmedMetrics["60m"].checkedThrough, "2026-09-21T01:00:00.000Z");
});

test("summary separates PROBE, market type, CLEAN and MIXED denominators", () => {
  const make = ({ symbol, marketType, confirmed, tier, hit }) => {
    const event = {
      setupId: symbol, symbol, direction: "LONG", marketType,
      firstSeenAt: new Date(T0).toISOString(), firstSeenPrice: 100, entryPrice: 100,
      firstProbeAt: confirmed ? null : new Date(T0).toISOString(),
      firstConfirmedAt: confirmed ? new Date(T0).toISOString() : null,
      confirmedEntryPrice: confirmed ? 100 : null, confirmationType: confirmed ? tier : null,
      setupMetrics: { "60m": { ...{}, matured: true, hit05: hit, hit10: hit, hit20: false } },
      confirmedMetrics: { "60m": { ...{}, matured: confirmed, hit05: hit, hit10: false, hit20: false } },
      classification: confirmed ? `${tier}_WIN` : hit ? "FALSE_NEGATIVE" : "GOOD_BLOCK",
    };
    for (const minutes of [15, 30]) {
      event.setupMetrics[`${minutes}m`] = { matured: false };
      event.confirmedMetrics[`${minutes}m`] = { matured: false };
    }
    return event;
  };
  const events = [
    make({ symbol: "CLEAN", marketType: "CRYPTO_PERP", confirmed: true, tier: "CLEAN", hit: true }),
    make({ symbol: "MIXED", marketType: "CRYPTO_PERP", confirmed: true, tier: "MIXED", hit: false }),
    make({ symbol: "PROBE", marketType: "CRYPTO_PERP", confirmed: false, tier: null, hit: true }),
    make({ symbol: "STOCK", marketType: "TRADFI_PERP", confirmed: true, tier: "CLEAN", hit: true }),
  ];
  const summary = summarize(events);
  assert.equal(summary.crypto.confirmed.total, 2);
  assert.equal(summary.crypto.confirmed.matured60m, 2);
  assert.equal(summary.crypto.confirmed.hit05_60m, 1);
  assert.equal(summary.crypto.confirmed.clean.matured60m, 1);
  assert.equal(summary.crypto.confirmed.clean.hit05_60m, 1);
  assert.equal(summary.crypto.confirmed.mixed.matured60m, 1);
  assert.equal(summary.crypto.confirmed.mixed.hit05_60m, 0);
  assert.equal(summary.crypto.probe.total, 1);
  assert.equal(summary.crypto.probe.falseNegative05, 1);
  assert.equal(summary.tradfi.confirmed.total, 1);
});

test("old events never borrow firstSeenPrice for an unknown confirmation price", () => {
  const old = {
    symbol: "OLDUSDT", direction: "LONG", firstSeenAt: "2026-09-21T00:00:00Z",
    firstConfirmedAt: "2026-09-21T00:10:00Z", entryPrice: 100, confirmationType: "CLEAN",
    "15m": {}, "30m": {}, "60m": {},
  };
  migrateEvent(old);
  assert.equal(old.firstSeenPrice, 100);
  assert.equal(old.confirmedEntryPrice, null);
  assert.equal(old.firstSeenFeatures, null);
  assert.equal(old.confirmedFeatures, null);
  assert.equal(old.marketType, "UNKNOWN");
  old.confirmedMetrics["60m"].matured = true;
  const summary = summarize([old]);
  assert.equal(summary.crypto.confirmed.total, 0);
  assert.equal(summary.unknownMarketEvents, 1);

  old.marketType = "CRYPTO_PERP";
  old.confirmedMetrics["60m"].matured = false;
  const cryptoSummary = summarize([old]);
  assert.equal(cryptoSummary.crypto.confirmed.total, 1);
  assert.equal(cryptoSummary.crypto.confirmed.matured60m, 0);
});

test("legacy eventual results stay null even when short-term targets hit", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest(0, "CONFIRMED", "CLEAN", 100));
  const event = ledger.events[0];
  applyCandles(event, [candle(0, 101, 99.8), ...flatCandles(5, 60)], T0 + 70 * 60_000);
  assert.equal(event.confirmedMetrics["60m"].hit05, true);
  assert.equal(event.legacy.eventualHit05, null);
  assert.equal(event.legacy.stopHit35, null);
});

test("cooldown still gates creation of a new setup", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest(0));
  updateLifecycle(ledger, { snapshot: { fetchedAt: new Date(T0 + 15 * 60_000).toISOString() }, radar: {} });
  updateLifecycle(ledger, latest(30));
  assert.equal(ledger.events.length, 1);
  updateLifecycle(ledger, { snapshot: { fetchedAt: new Date(T0 + 45 * 60_000).toISOString() }, radar: {} });
  updateLifecycle(ledger, latest(100));
  assert.equal(ledger.events.length, 2);
});
