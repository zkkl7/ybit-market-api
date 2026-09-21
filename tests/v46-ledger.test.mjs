import test from "node:test";
import assert from "node:assert/strict";
import { applyCandles, createV46Ledger, updateLifecycle } from "../scripts/update-v46-ledger.mjs";

const latest = (at, stage = "PROBE", tier = "MIXED") => ({
  snapshot: { fetchedAt: at },
  radar: { longCandidatePool: [{
    symbol: "TESTUSDT", direction: "LONG", entrySignal: "BREAKOUT_ENTRY",
    entryStage: stage, executionTier: tier, executionScore: 72,
    strictPriceReclaim: stage === "CONFIRMED", nearReclaim: true,
    microPersistence: "PERSISTENT", v46RiskFlags: [], keyMetrics: { price: 100 },
  }] },
});

test("same setup updates one event and records PROBE to CLEAN confirmation", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z"));
  updateLifecycle(ledger, latest("2026-09-21T00:15:00Z", "CONFIRMED", "CLEAN"));
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].firstProbeAt, "2026-09-21T00:00:00.000Z");
  assert.equal(ledger.events[0].firstConfirmedAt, "2026-09-21T00:15:00.000Z");
  assert.equal(ledger.events[0].confirmationType, "CLEAN");
});

test("missing setup enters cooldown and only creates a new event after cooldown", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "CONFIRMED", "CLEAN"));
  updateLifecycle(ledger, { snapshot: { fetchedAt: "2026-09-21T00:15:00Z" }, radar: {} });
  assert.equal(ledger.events.length, 1);
  updateLifecycle(ledger, latest("2026-09-21T01:15:00Z"));
  assert.equal(ledger.events.length, 2);
});

test("60m metrics include MFE MAE hits and time to profit", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "CONFIRMED", "CLEAN"));
  const event = ledger.events[0];
  applyCandles(event, [
    { openTime: Date.parse("2026-09-21T00:00:00Z"), high: 100.6, low: 99.7 },
    { openTime: Date.parse("2026-09-21T00:10:00Z"), high: 101.2, low: 99.9 },
    { openTime: Date.parse("2026-09-21T00:25:00Z"), high: 102.1, low: 100 },
  ]);
  assert.equal(event["60m"].hit05, true);
  assert.equal(event["60m"].hit10, true);
  assert.equal(event["60m"].hit20, true);
  assert.equal(event["60m"].timeTo05, 0);
  assert.equal(event.classification, "RUNNER");
});
