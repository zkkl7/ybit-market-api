import test from "node:test";
import assert from "node:assert/strict";
import { applyCandles, createV46Ledger, summarize, updateLifecycle } from "../scripts/update-v46-ledger.mjs";

const latest = (at, stage = "PROBE", tier = "MIXED", price = 100) => ({
  snapshot: { fetchedAt: at },
  radar: { longCandidatePool: [{
    symbol: "TESTUSDT", direction: "LONG", entrySignal: "BREAKOUT_ENTRY",
    entryStage: stage, executionTier: tier, executionScore: 72,
    strictPriceReclaim: stage === "CONFIRMED", nearReclaim: true,
    microPersistence: "PERSISTENT", v46RiskFlags: [], keyMetrics: { price },
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

test("entryPrice is locked while lastSeenPrice follows later snapshots", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "PROBE", "MIXED", 100));
  updateLifecycle(ledger, latest("2026-09-21T00:05:00Z", "PROBE", "MIXED", 105));
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].entryPrice, 100);
  assert.equal(ledger.events[0].lastSeenPrice, 105);
});

test("missing setup enters cooldown and only creates a new event after cooldown", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "CONFIRMED", "CLEAN"));
  updateLifecycle(ledger, { snapshot: { fetchedAt: "2026-09-21T00:15:00Z" }, radar: {} });
  assert.equal(ledger.events.length, 1);
  updateLifecycle(ledger, latest("2026-09-21T01:15:00Z"));
  assert.equal(ledger.events.length, 2);
});

test("profit before stop succeeds and runner is a tag without replacing CLEAN_WIN", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "CONFIRMED", "CLEAN"));
  const event = ledger.events[0];
  applyCandles(event, [
    { openTime: Date.parse("2026-09-21T00:00:00Z"), high: 100.6, low: 99.7 },
    { openTime: Date.parse("2026-09-21T00:10:00Z"), high: 101.2, low: 99.9 },
    { openTime: Date.parse("2026-09-21T00:25:00Z"), high: 102.1, low: 100 },
    { openTime: Date.parse("2026-09-21T00:30:00Z"), high: 101, low: 96 },
  ]);
  assert.equal(event["60m"].hit05, true);
  assert.equal(event["60m"].hit10, true);
  assert.equal(event["60m"].hit20, true);
  assert.equal(event["60m"].timeTo05, 5);
  assert.equal(event.classification, "CLEAN_WIN");
  assert.ok(event.tags.includes("RUNNER"));
});

test("stop before later profit fails all unresolved target layers", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "CONFIRMED", "MIXED"));
  const event = ledger.events[0];
  applyCandles(event, [
    { openTime: Date.parse("2026-09-21T00:00:00Z"), high: 100.2, low: 96.4 },
    { openTime: Date.parse("2026-09-21T00:05:00Z"), high: 102.5, low: 99 },
  ]);
  assert.equal(event["60m"].hit05, false);
  assert.equal(event["60m"].hit10, false);
  assert.equal(event["60m"].failedBefore05, true);
  assert.ok(event.firstStop35At);
});

test("same candle target and stop uses conservative stop-wins tie", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "CONFIRMED", "CLEAN"));
  const event = ledger.events[0];
  applyCandles(event, [{ openTime: Date.parse("2026-09-21T00:00:00Z"), high: 101.2, low: 96.4 }]);
  assert.equal(event["60m"].hit05, false);
  assert.equal(event["60m"].failedBefore05, true);
});

test("GOOD_BLOCK requires an unconfirmed PROBE stopped before +0.5", () => {
  const stopped = createV46Ledger();
  updateLifecycle(stopped, latest("2026-09-21T00:00:00Z"));
  applyCandles(stopped.events[0], [{ openTime: Date.parse("2026-09-21T00:00:00Z"), high: 100.1, low: 96.4 }]);
  assert.equal(stopped.events[0].classification, "GOOD_BLOCK");

  const flat = createV46Ledger();
  updateLifecycle(flat, latest("2026-09-21T00:00:00Z"));
  applyCandles(flat.events[0], [{ openTime: Date.parse("2026-09-21T00:00:00Z"), high: 100.1, low: 99.5 }]);
  assert.equal(flat.events[0].classification, null);
});

test("summary uses only matured events for each window denominator", () => {
  const ledger = createV46Ledger();
  updateLifecycle(ledger, latest("2026-09-21T00:00:00Z", "CONFIRMED", "CLEAN"));
  updateLifecycle(ledger, { snapshot: { fetchedAt: "2026-09-21T00:05:00Z" }, radar: {} });
  updateLifecycle(ledger, latest("2026-09-21T01:00:00Z", "CONFIRMED", "MIXED"));
  ledger.events[0]["15m"].hit05 = true;
  ledger.events[0]["30m"].hit05 = true;
  ledger.events[0]["60m"].hit05 = true;
  const summary = summarize(ledger.events, Date.parse("2026-09-21T01:20:00Z"));
  assert.equal(summary.matured15m, 2);
  assert.equal(summary.matured30m, 1);
  assert.equal(summary.matured60m, 1);
  assert.equal(summary.hit05_60m, 1);
  assert.equal(summary.hit05Rate60m, 100);
});
