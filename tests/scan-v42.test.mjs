import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../api/scan-v42.js', import.meta.url), 'utf8');
function load() {
  const context = vm.createContext({
    fetch: async () => { throw new Error('unexpected network'); },
    URLSearchParams,
    process: { env: {} },
    console,
  });
  const transformed = source
    .replace('export default async function handler', 'async function handler')
    .replace(/export \{ marketClassification, crossExchangeSummary, classifyRunner, evaluateCandidate, buildCandidateLists \};/, '') +
    '\nglobalThis.api = { marketClassification, crossExchangeSummary, classifyRunner, evaluateCandidate, buildCandidateLists };';
  vm.runInContext(transformed, context);
  return context.api;
}
const api = load();

const executable = new Set(['EARLY_ENTRY', 'BREAKOUT_ENTRY', 'RETEST_ENTRY']);

const base = {
  symbol: 'TESTUSDT', price: 1,
  executionState: 'POSITION_BUILD', executionRisk: null,
  price5mPct: 0.2, price15mPct: 0.5, price1hPct: 1.5, price24hPct: 3,
  oi15mPct: 0.8, oi30mPct: 1.8, oi1hPct: 4, oi2hPct: 5,
  latestOiStep: 0.8, maxPositiveOiStep: 1.2, consecutivePositive: 3,
  buildQuality: 85, oiHighRetention: 0.99, fundingPct: 0.005,
  priceStructure: { support: 0.95, recentLow: 0.98, keyLevel: 1.01, supportHeld: false, keyLevelReclaimed: true, lowerLows: false },
  flow5m: {
    recentPrice30mPct: 1.2, recentOi30mPct: 1.8,
    recentSteps: [
      { state: 'LONG_BUILD' }, { state: 'LONG_BUILD' }, { state: 'POSITION_BUILD' },
      { state: 'LONG_BUILD' }, { state: 'MIXED' }, { state: 'LONG_BUILD' },
    ],
  },
};

test('sustained long structure ranks as actionable', () => {
  const out = api.evaluateCandidate(base, 'LONG');
  assert.notEqual(out.candidateState, 'WATCH');
  assert.ok(out.candidateQuality >= 52);
});

test('FIL-like slow long with decayed latest 15m and no price structure is downgraded', () => {
  const row = {
    ...base,
    oi15mPct: 0.05,
    latestOiStep: 0.05,
    consecutivePositive: 1,
    price5mPct: -0.1,
    price15mPct: -0.2,
    price1hPct: 0.3,
    priceStructure: { supportHeld: false, keyLevelReclaimed: false, lowerLows: false },
    flow5m: { recentPrice30mPct: -0.2, recentOi30mPct: 0.1, recentSteps: [{state:'MIXED'}] },
  };
  assert.equal(api.evaluateCandidate(row, 'LONG').candidateState, 'WATCH');
});

test('sustained slow short ranks as actionable', () => {
  const row = {
    ...base,
    executionState: 'SHORT_BUILD',
    price5mPct: -0.3, price15mPct: -0.8, price1hPct: -2,
    oi15mPct: 0.9, oi30mPct: 2.2, oi1hPct: 5,
    latestOiStep: 0.9,
    priceStructure: { lowerLows: true },
    flow5m: {
      recentPrice30mPct: -2.5, recentOi30mPct: 2.3,
      recentSteps: [{state:'SHORT_BUILD'},{state:'SHORT_BUILD'},{state:'MIXED'},{state:'SHORT_BUILD'},{state:'MIXED'},{state:'SHORT_BUILD'}],
    },
  };
  const out = api.evaluateCandidate(row, 'SHORT');
  assert.notEqual(out.candidateState, 'WATCH');
});

test('KMNO-like historical short build without latest 15m continuation is downgraded', () => {
  const row = {
    ...base,
    executionState: 'SHORT_BUILD',
    price5mPct: 0.2, price15mPct: -0.2, price1hPct: -1,
    oi15mPct: -0.4, oi30mPct: 1.5, oi1hPct: 4,
    oiHighRetention: 0.93,
    priceStructure: { lowerLows: true },
    flow5m: {
      recentPrice30mPct: -1.5, recentOi30mPct: -1.2,
      recentSteps: [{state:'SHORT_BUILD'},{state:'SHORT_BUILD'},{state:'SHORT_BUILD'},{state:'MIXED'},{state:'MIXED'},{state:'DELEVERAGING'}],
    },
  };
  assert.equal(api.evaluateCandidate(row, 'SHORT').candidateState, 'WATCH');
});

test('mixed cross-exchange data lowers quality but does not hard filter', () => {
  const confirmed = api.evaluateCandidate({
    ...base,
    crossExchange: { status:'ok', oi1hPct:2, oi15mPct:1, oi5mPct:0.2, bybitOiSharePct:30, aggregatedFundingPct:0 },
  }, 'LONG');
  const mixed = api.evaluateCandidate({
    ...base,
    crossExchange: { status:'ok', oi1hPct:2, oi15mPct:-0.2, oi5mPct:-0.1, bybitOiSharePct:30, aggregatedFundingPct:0 },
  }, 'LONG');
  assert.ok(confirmed.candidateQuality > mixed.candidateQuality);
  assert.notEqual(mixed.candidateState, undefined);
});

test('TradFi perp is explicitly tagged and penalized', () => {
  const crypto = api.evaluateCandidate(base, 'LONG');
  const tradfi = api.evaluateCandidate({ ...base, symbol:'SOFIUSDT' }, 'LONG');
  assert.equal(tradfi.marketType, 'TRADFI_PERP');
  assert.equal(tradfi.riskTag, 'TRADFI_EVENT_SENSITIVE');
  assert.ok(tradfi.candidateQuality < crypto.candidateQuality);
});

test('candidate lists cap at 3+3 and do not include WATCH', () => {
  const longs = Array.from({length:5}, (_, i) => ({ ...base, symbol:`L${i}USDT` }));
  const shorts = Array.from({length:5}, (_, i) => ({
    ...base, symbol:`S${i}USDT`, executionState:'SHORT_BUILD',
    price5mPct:-0.3, price15mPct:-0.8, price1hPct:-2,
    oi15mPct:0.9, oi30mPct:2, oi1hPct:4,
    priceStructure:{lowerLows:true},
    flow5m:{recentPrice30mPct:-2,recentOi30mPct:2,recentSteps:[{state:'SHORT_BUILD'},{state:'SHORT_BUILD'},{state:'SHORT_BUILD'}]},
  }));
  const out = api.buildCandidateLists({ executionStates:[...longs,...shorts], candidates:[] });
  assert.equal(out.longCandidates.length, 3);
  assert.equal(out.shortCandidates.length, 3);
  assert.ok([...out.longCandidates,...out.shortCandidates].every(x => x.candidateState !== 'WATCH'));
});

test('extended KSM/CROSS longs and crowded AVA shorts cannot trigger entries', () => {
  for (const [direction, patch] of [
    ['LONG', { price1hPct: 12.18, price15mPct: 4.7 }],
    ['LONG', { price24hPct: 38.98, price1hPct: 3.5 }],
    ['SHORT', { price5mPct: -0.3, price15mPct: -1, price1hPct: -2, fundingPct: -0.7169 }],
    ['SHORT', { price1hPct: -8 }],
    ['LONG', { executionRisk: 'EXTENDED' }],
    ['LONG', { fundingPct: 0.3 }],
  ]) {
    const out = api.evaluateCandidate({ ...base, ...patch }, direction);
    assert.equal(out.entrySignal, 'NO_CHASE');
    assert.ok(out.timingRiskFlags.length > 0);
    assert.ok(out.timingScore >= 0 && out.timingScore <= 100);
  }
});

test('breakout, retest and early entries are reachable without history', () => {
  const breakout = api.evaluateCandidate({ ...base, price: 1.01 }, 'LONG');
  const retest = api.evaluateCandidate({ ...base, price5mPct: -0.2 }, 'LONG');
  const early = api.evaluateCandidate({ ...base, oiHighRetention: 0.96 }, 'LONG');
  assert.equal(breakout.entrySignal, 'BREAKOUT_ENTRY');
  assert.equal(retest.entrySignal, 'RETEST_ENTRY');
  assert.equal(early.entrySignal, 'EARLY_ENTRY');
});

test('missing or invalid timing prices and funding cannot create entries', () => {
  for (const field of ['price', 'price5mPct', 'price15mPct', 'price1hPct', 'price24hPct', 'fundingPct']) {
    for (const value of [null, undefined, '', 'invalid']) {
      const out = api.evaluateCandidate({ ...base, [field]: value }, 'LONG');
      assert.equal(executable.has(out.entrySignal), false, field);
      assert.ok(out.timingRiskFlags.includes('TIMING_DATA_MISSING'));
    }
  }
});

test('entry pools exclude NO_CHASE and retain separate crypto and TradFi groups', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ ...base, price: 1.01, symbol: 'ENTRY' + i })),
    { ...base, symbol: 'EXTENDED', price1hPct: 10 },
    { ...base, symbol: 'SOFIUSDT', price: 1.01 },
  ];
  const out = api.buildCandidateLists({ executionStates: rows });
  assert.equal(out.longEntryCandidates.length, 3);
  assert.ok(out.longEntryCandidates.every(c => executable.has(c.entrySignal)));
  assert.ok(out.longEntryCandidates.every(c => c.marketType === 'CRYPTO_PERP'));
  assert.equal(out.tradFiLongEntryCandidates[0].symbol, 'SOFIUSDT');
  assert.ok(out.longCandidatePool.some(c => c.entrySignal === 'NO_CHASE'));
});

const runnerCandidate = {
  direction: 'LONG', finalCandidateScore: 84, entrySignal: 'RETEST_ENTRY',
  timingRiskFlags: [], crossExchangeSummary: { confirmation: 'CONFIRMED' },
  keyMetrics: { oi30mPct: 2.5, oi1hPct: 4, price1hPct: 2, price24hPct: 8 },
};

test('clean confirmed retest with a high final score is a high-potential runner', () => {
  const out = api.classifyRunner(runnerCandidate);
  assert.equal(out.tradeStyle, 'RUNNER');
  assert.equal(out.runnerPotential, 'HIGH');
  assert.ok(out.runnerScore >= 70);
  assert.ok(out.runnerReasons.includes('CROSS_CONFIRMED'));
  assert.ok(out.runnerReasons.includes('RETEST_ENTRY'));
});

test('setup weak, local-only and extended risks downgrade runner classification', () => {
  const out = api.classifyRunner({
    ...runnerCandidate,
    entrySignal: 'NO_CHASE',
    timingRiskFlags: ['SETUP_WEAK', '24H_EXTENDED'],
    crossExchangeSummary: { confirmation: 'LOCAL_ONLY' },
    keyMetrics: { ...runnerCandidate.keyMetrics, price1hPct: 6, price24hPct: 26 },
  });
  assert.equal(out.tradeStyle, 'WATCH');
  assert.equal(out.runnerPotential, 'LOW');
  for (const reason of ['SETUP_WEAK', 'LOCAL_ONLY', 'PRICE_24H_EXTENDED', 'PRICE_24H_OVER_25']) {
    assert.ok(out.runnerReasons.includes(reason), reason);
  }
});

test('short direction receives the same healthy directional price credit', () => {
  const long = api.classifyRunner(runnerCandidate);
  const short = api.classifyRunner({
    ...runnerCandidate,
    direction: 'SHORT',
    keyMetrics: { ...runnerCandidate.keyMetrics, price1hPct: -2, price24hPct: -8 },
  });
  assert.equal(short.runnerScore, long.runnerScore);
  assert.equal(short.runnerPotential, 'HIGH');
  assert.ok(short.runnerReasons.includes('PRICE_1H_DIRECTIONAL_HEALTHY'));
});

test('runner labels do not change V4.4 entry membership or signals', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ ...base, price: 1.01, symbol: `RUNNER${i}` })),
    { ...base, symbol: 'NOCHASE', price1hPct: 10 },
  ];
  const out = api.buildCandidateLists({ executionStates: rows });
  assert.equal(out.longEntryCandidates.length, 3);
  assert.ok(out.longEntryCandidates.every(candidate => executable.has(candidate.entrySignal)));
  assert.ok(out.longCandidatePool.some(candidate =>
    candidate.symbol === 'NOCHASE' && candidate.entrySignal === 'NO_CHASE'
  ));
  assert.ok(out.longCandidatePool.every(candidate =>
    typeof candidate.runnerScore === 'number' && Array.isArray(candidate.runnerReasons)
  ));
});
