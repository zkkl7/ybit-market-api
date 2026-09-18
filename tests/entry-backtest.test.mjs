import test from "node:test";
import assert from "node:assert/strict";
import {
  addSnapshotEntries,
  applyCandles,
  assertKlineProgress,
  createLedger,
  fetchClosedKlines,
  mfeBucket,
  migrateEntries,
  summarize,
  updateLedger,
} from "../scripts/update-entry-backtest.mjs";

const T0 = Date.parse("2026-09-18T00:00:00.000Z");
const candle = (offset, high, low) => ({
  openTime: T0 + offset * 300000,
  high,
  low,
});
const entry = (direction = "LONG") => ({
  symbol: "TESTUSDT",
  direction,
  entrySignal: "EARLY_ENTRY",
  entryPrice: 100,
  entryTime: new Date(T0).toISOString(),
  maePct: 0,
  mfePct: 0,
  maePrice: 100,
  mfePrice: 100,
  maeBeforeSuccessPct: 0,
  firstProfitHitAt: null,
  hit05: false,
  hit05At: null,
  hit10: false,
  hit10At: null,
  tradeStatus: "OPEN",
  tradeTerminalAt: null,
  tradeCheckedThrough: new Date(T0).toISOString(),
  stopHitAt: null,
  status: "OPEN",
  deepDrawdownSuccess: false,
  mfeBucket: null,
  runner2: false,
  runner5: false,
  checkedThrough: new Date(T0).toISOString(),
  updatedAt: new Date(T0).toISOString(),
});

test("LONG reaches +0.5% and succeeds", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.6, 99.9)]);
  assert.equal(row.status, "SUCCESS");
  assert.ok(row.firstProfitHitAt);
  assert.ok(row.mfePct >= 0.5);
});

test("LONG hits -3.5% first and remains failed after a later rally", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.2, 96.5)]);
  assert.equal(row.status, "FAIL");
  assert.ok(row.stopHitAt);
  applyCandles(row, [candle(1, 106, 99)]);
  assert.equal(row.status, "FAIL");
  assert.ok(row.mfePct >= 5);
});

test("deep drawdown followed by profit is marked precisely before success", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.1, 97.5), candle(1, 100.8, 99)]);
  assert.equal(row.status, "SUCCESS");
  assert.ok(Math.abs(row.maePct - -2.5) < 0.001);
  assert.equal(row.maeBeforeSuccessPct, -2.5);
  assert.equal(row.deepDrawdownSuccess, true);
});

test("first symbol+direction executable entry is unique", () => {
  const ledger = createLedger();
  const snapshot = (signal, price, time) => ({
    radar: {
      scannedAt: time,
      longEntryCandidates: [{
        symbol: "TESTUSDT",
        direction: "LONG",
        entrySignal: signal,
        keyMetrics: { price },
      }],
    },
  });
  addSnapshotEntries(ledger, snapshot("EARLY_ENTRY", 100, "2026-09-18T00:00:00Z"));
  addSnapshotEntries(ledger, snapshot("BREAKOUT_ENTRY", 101, "2026-09-18T00:15:00Z"));
  addSnapshotEntries(ledger, snapshot("RETEST_ENTRY", 99, "2026-09-18T00:30:00Z"));
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].entrySignal, "EARLY_ENTRY");
  assert.equal(ledger.entries[0].entryPrice, 100);
});

test("LONG MAE and MFE use low and high", () => {
  const row = entry("LONG");
  applyCandles(row, [candle(0, 105, 98)]);
  assert.equal(row.mfePct, 5);
  assert.equal(row.mfePrice, 105);
  assert.equal(row.maePct, -2);
  assert.equal(row.maePrice, 98);
});

test("SHORT MAE and MFE are direction-aware", () => {
  const row = entry("SHORT");
  applyCandles(row, [candle(0, 102, 95)]);
  assert.equal(row.mfePct, 5);
  assert.equal(row.mfePrice, 95);
  assert.equal(row.maePct, -2);
  assert.equal(row.maePrice, 102);
});

test("same candle profit and stop is adverse-first conservative FAIL", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.6, 96.5)]);
  assert.equal(row.status, "FAIL");
  assert.ok(row.firstProfitHitAt);
  assert.ok(row.stopHitAt);
  assert.equal(row.hit10, false);
  assert.equal(row.tradeStatus, "FAIL");
});

test("+0.5% keeps legacy success while +1% remains a separate open outcome", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.6, 99.8)]);
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.hit05, true);
  assert.equal(row.tradeStatus, "OPEN");
  assert.equal(row.hit10, false);
  applyCandles(row, [candle(1, 101.1, 99.9)]);
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.tradeStatus, "SUCCESS");
  assert.equal(row.hit10, true);
});

test("runner flags follow continuing MFE after terminal status", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.2, 96.4), candle(1, 105, 99)]);
  assert.equal(row.status, "FAIL");
  assert.equal(row.tradeStatus, "FAIL");
  assert.equal(row.runner2, true);
  assert.equal(row.runner5, true);
});

test("SUCCESS stays locked while later MAE continues updating", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.6, 99.8)]);
  const terminalAt = row.terminalAt;
  applyCandles(row, [candle(1, 100, 95)]);
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.terminalAt, terminalAt);
  assert.equal(row.maePct, -5);
  assert.equal(row.maePrice, 95);
  assert.ok(row.stopHitAt);
});

test("FAIL stays locked while later MFE continues updating", () => {
  const row = entry();
  applyCandles(row, [candle(0, 100.1, 96)]);
  const terminalAt = row.terminalAt;
  applyCandles(row, [candle(1, 105, 99)]);
  assert.equal(row.status, "FAIL");
  assert.equal(row.terminalAt, terminalAt);
  assert.equal(row.mfePct, 5);
  assert.equal(row.mfePrice, 105);
  assert.ok(row.firstProfitHitAt);
});

test("partial entry candle counts only adverse movement and prevents reprocessing", () => {
  const row = entry();
  row.entryTime = new Date(T0 + 120000).toISOString();
  row.checkedThrough = row.entryTime;
  applyCandles(row, [candle(0, 110, 96), candle(1, 100.6, 99.8)]);
  assert.equal(row.status, "FAIL");
  assert.equal(row.mfePct, 0.6);
  assert.equal(row.maePct, -4);
  assert.equal(row.stopHitAt, new Date(T0 + 5 * 60000).toISOString());
  assert.equal(row.firstProfitHitAt, new Date(T0 + 10 * 60000).toISOString());
  assert.equal(row.entryCandleChecked, true);
  const checked = row.checkedThrough;
  assert.equal(applyCandles(row, [candle(1, 120, 80)]), false);
  assert.equal(row.checkedThrough, checked);
  assert.equal(row.maePct, -4);
});

test("partial entry candle cannot create a favorable hit", () => {
  const row = entry();
  row.entryTime = new Date(T0 + 120000).toISOString();
  row.checkedThrough = row.entryTime;
  applyCandles(row, [candle(0, 110, 99.5)]);
  assert.equal(row.status, "OPEN");
  assert.equal(row.mfePct, 0);
  assert.equal(row.firstProfitHitAt, null);
});

test("snapshot time falls back and non-executable signals are ignored", () => {
  const ledger = createLedger();
  const latest = {
    snapshot: { fetchedAt: "2026-09-18T01:00:00Z" },
    radar: {
      longEntryCandidates: [
        { symbol: "AUSDT", direction: "LONG", entrySignal: "WAIT", keyMetrics: { price: 1 } },
        { symbol: "BUSDT", direction: "LONG", entrySignal: "RETEST_ENTRY", keyMetrics: { price: 2 } },
      ],
    },
  };
  const added = addSnapshotEntries(ledger, latest);
  assert.equal(added.length, 1);
  assert.equal(added[0].symbol, "BUSDT");
  assert.equal(added[0].entryTime, "2026-09-18T01:00:00.000Z");
});

test("new entries freeze the lightweight candidate snapshot", () => {
  const ledger = createLedger();
  const latest = {
    radar: {
      scannedAt: "2026-09-18T01:00:00Z",
      longEntryCandidates: [{
        symbol: "AUSDT", direction: "LONG", entrySignal: "EARLY_ENTRY",
        candidateQuality: 77, finalCandidateScore: 81, timingScore: 72,
        timingRiskFlags: ["PRICE_WARM"],
        crossExchangeSummary: { confirmation: "CONFIRMED" },
        keyMetrics: { price: 10, oi15mPct: 1, oi30mPct: 2, oi1hPct: 3 },
      }],
    },
  };
  const [row] = addSnapshotEntries(ledger, latest);
  assert.deepEqual({
    oi15mPct: row.oi15mPct, oi30mPct: row.oi30mPct, oi1hPct: row.oi1hPct,
    finalCandidateScore: row.finalCandidateScore, candidateQuality: row.candidateQuality,
    timingScore: row.timingScore, crossConfirmation: row.crossConfirmation,
    timingRiskFlags: row.timingRiskFlags, entrySignal: row.entrySignal, direction: row.direction,
  }, {
    oi15mPct: 1, oi30mPct: 2, oi1hPct: 3, finalCandidateScore: 81,
    candidateQuality: 77, timingScore: 72, crossConfirmation: "CONFIRMED",
    timingRiskFlags: ["PRICE_WARM"], entrySignal: "EARLY_ENTRY", direction: "LONG",
  });
});

test("legacy migration backfills only an exact historical snapshot", () => {
  const exact = entry();
  delete exact.hit05; delete exact.hit10; delete exact.tradeStatus;
  delete exact.tradeCheckedThrough; delete exact.runner2; delete exact.runner5;
  const unmatched = { ...entry(), symbol: "OTHERUSDT" };
  for (const key of ["oi15mPct", "oi30mPct", "oi1hPct", "finalCandidateScore", "candidateQuality", "timingScore", "crossConfirmation", "timingRiskFlags"]) {
    delete exact[key]; delete unmatched[key];
  }
  const ledger = { entries: [exact, unmatched] };
  migrateEntries(ledger, {}, { snapshots: [{
    scannedAt: exact.entryTime,
    candidates: [{
      symbol: exact.symbol, direction: exact.direction, candidateQuality: 70,
      finalCandidateScore: 75, timingScore: 80, timingRiskFlags: [],
      crossConfirmation: "CONFIRMED", oi15mPct: 1, oi30mPct: 2, oi1hPct: 3,
    }],
  }] });
  assert.equal(exact.finalCandidateScore, 75);
  assert.equal(exact.oi1hPct, 3);
  assert.equal(exact.tradeCheckedThrough, exact.entryTime);
  assert.equal(unmatched.finalCandidateScore, null);
  assert.equal(unmatched.timingRiskFlags, null);
});

test("MFE buckets and summary use fixed boundaries", () => {
  assert.equal(mfeBucket(0.49), null);
  assert.equal(mfeBucket(0.5), "+0.5~1%");
  assert.equal(mfeBucket(1), "+1~2%");
  assert.equal(mfeBucket(2), "+2~5%");
  assert.equal(mfeBucket(5), "+2~5%");
  assert.equal(mfeBucket(5.01), ">+5%");
  const rows = [entry(), entry(), entry()];
  rows[0].status = "SUCCESS"; rows[0].deepDrawdownSuccess = true; rows[0].mfeBucket = "+0.5~1%";
  rows[1].status = "FAIL"; rows[1].mfeBucket = ">+5%";
  assert.deepEqual(summarize(rows), {
    total: 3, open: 1, success: 1, fail: 1, deepDrawdownSuccess: 1,
    hit05: 0, hit10: 0, tradeSuccess: 0, runner2: 0, runner5: 0,
    mfeBuckets: { "+0.5~1%": 1, "+1~2%": 0, "+2~5%": 0, ">+5%": 1 },
  });
});

test("kline fetch is incremental, paginated, and excludes the forming candle", async () => {
  const calls = [];
  const fetchImpl = async url => {
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    calls.push({ start, end });
    const list = [];
    for (let time = start; time <= end; time += 300000) {
      list.push([String(time), "100", "101", "99", "100", "1", "100"]);
    }
    return { ok: true, json: async () => ({ retCode: 0, result: { list: list.reverse() } }) };
  };
  const now = T0 + 1002 * 300000;
  const rows = await fetchClosedKlines("TESTUSDT", T0, now, fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 1002);
  assert.equal(Number(rows.at(-1)[0]), now - 300000);
});

test("proxy-wrapped kline responses are accepted", async () => {
  let requestedUrl;
  const fetchImpl = async url => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({
        proxyStatus: "ok",
        data: { retCode: 0, result: { list: [[String(T0), "100", "101", "99", "100"]] } },
      }),
    };
  };
  const rows = await fetchClosedKlines("TESTUSDT", T0, T0 + 300000, fetchImpl);
  assert.equal(rows.length, 1);
  assert.match(requestedUrl, /ybit-market-api\.vercel\.app\/api\/market/);
  assert.equal(new URL(requestedUrl).searchParams.get("endpoint"), "kline");
});

test("kline failures are counted while other symbols continue", async () => {
  const ledger = createLedger();
  ledger.entries = [entry(), { ...entry(), symbol: "OKUSDT" }];
  const warnings = [];
  const result = await updateLedger({
    ledger,
    latest: {},
    nowMs: T0 + 300000,
    warn: message => warnings.push(message),
    fetchImpl: async url => {
      const symbol = new URL(url).searchParams.get("symbol");
      if (symbol === "TESTUSDT") return { ok: false, status: 403 };
      return { ok: true, json: async () => ({ data: { retCode: 0, result: { list: [] } } }) };
    },
  });
  assert.deepEqual(result.kline, { attempted: 2, succeeded: 1, failed: 1 });
  assert.equal(warnings.length, 1);
});

test("all attempted kline failures make the CLI fail", () => {
  assert.throws(
    () => assertKlineProgress({ attempted: 2, succeeded: 0, failed: 2 }),
    /All kline updates failed/
  );
  assert.doesNotThrow(() =>
    assertKlineProgress({ attempted: 2, succeeded: 1, failed: 1 })
  );
});
