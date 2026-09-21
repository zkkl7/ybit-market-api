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
    setTimeout,
    clearTimeout,
  });
  const transformed = source
    .replace('export default async function handler', 'async function handler')
    .replace(/export \{[\s\S]*?\};\s*$/, '') +
    '\nglobalThis.api = { VERSION, marketClassification, crossExchangeSummary, classifyRunner, classifyV45Runner, parseRecentTrades, parseOrderBook, parseBenchmarkKlines, fetchBenchmarks, relativeStrength, v45Confirmation, evaluateCandidate, buildCandidateLists, fetchMicrostructure, enrichMicrostructure, v45AbSummary };';
  vm.runInContext(transformed, context);
  return context.api;
}
const api = load();

const executable = new Set(['EARLY_ENTRY', 'BREAKOUT_ENTRY', 'RETEST_ENTRY']);

test('reports the V4.6.1 version', () => {
  assert.equal(api.VERSION, 'OI-RADAR-V4.6.1');
});

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

const bearishMicrostructure = {
  collectedAt: 1_000_000,
  flow: {
    status: 'ok', takerBuyVolume: 30, takerSellVolume: 70,
    buySellImbalance: -0.4, cvd1m: -20, cvd3m: -35, cvd5m: -40,
    cvdBias: 'BEARISH', orderFlowBias: 'BEARISH', sourceAt: 999_900, sampleCount: 100,
  },
  orderBook: {
    status: 'ok', obiScore: -0.15, obiTop10: -0.12, obiTop20: -0.15,
    orderBookBias: 'BEARISH', sourceAt: 999_950, ageMs: 50, depthLevels: 20,
  },
};

const bullishMicrostructure = {
  collectedAt: 1_000_000,
  flow: {
    status: 'ok', takerBuyVolume: 70, takerSellVolume: 30,
    buySellImbalance: 0.4, cvd1m: 20, cvd3m: 35, cvd5m: 40,
    cvdBias: 'BULLISH', orderFlowBias: 'BULLISH', sourceAt: 999_900, sampleCount: 100,
  },
  orderBook: {
    status: 'ok', obiScore: 0.15, obiTop10: 0.12, obiTop20: 0.15,
    orderBookBias: 'BULLISH', sourceAt: 999_950, ageMs: 50, depthLevels: 20,
  },
};

test('V4.5 tightens breakout reclaim without changing the V4.4 entry signal', () => {
  const row = {
    ...base,
    price: 0.997,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false },
  };
  const out = api.evaluateCandidate(row, 'LONG');
  assert.equal(out.entrySignal, 'BREAKOUT_ENTRY');
  assert.equal(out.strictPriceReclaim, false);
  assert.equal(out.v45EntrySignal, 'BREAKOUT_PROBE');
  assert.equal(out.entryStage, 'PROBE');
});

test('retest that holds support but has not reclaimed key level stays PROBE', () => {
  const out = api.evaluateCandidate({
    ...base,
    price: 0.997,
    price5mPct: -0.2,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false },
  }, 'LONG');
  assert.equal(out.entrySignal, 'RETEST_ENTRY');
  assert.equal(out.v45EntrySignal, 'RETEST_PROBE');
  assert.ok(out.v45RiskFlags.includes('KEY_LEVEL_NOT_RECLAIMED'));
});

test('rising OI with falling CVD and price strongly downgrades LONG', () => {
  const out = api.evaluateCandidate({
    ...base,
    price: 0.997,
    price5mPct: -0.2,
    price15mPct: -0.4,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false },
    v45Microstructure: bearishMicrostructure,
  }, 'LONG');
  assert.equal(out.entrySignal, 'RETEST_ENTRY');
  assert.equal(out.entryStage, 'PROBE');
  assert.equal(out.adverseOiFlowPrice, true);
  assert.equal(out.v45RunnerPotential, 'LOW');
  assert.ok(out.invalidationReason.includes('OI_UP_CVD_AND_PRICE_AGAINST_DIRECTION'));
});

test('rising OI with rising CVD and price strongly downgrades SHORT symmetrically', () => {
  const out = api.evaluateCandidate({
    ...base,
    executionState: 'SHORT_BUILD',
    directionalBias: 'NEUTRAL',
    price: 1.003,
    price5mPct: 0.2,
    price15mPct: 0.4,
    price1hPct: -1,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false, lowerLows: true },
    flow5m: { recentPrice30mPct: -1, recentOi30mPct: 2, recentSteps: [
      {state:'SHORT_BUILD'}, {state:'SHORT_BUILD'}, {state:'SHORT_BUILD'},
    ] },
    v45Microstructure: bullishMicrostructure,
  }, 'SHORT');
  assert.equal(out.entryStage, 'PROBE');
  assert.equal(out.adverseOiFlowPrice, true);
  assert.equal(out.v45RunnerPotential, 'LOW');
});

test('POSITION_BUILD plus NEUTRAL cannot keep V4.5 runner HIGH without direction confirmation', () => {
  const out = api.evaluateCandidate({
    ...base,
    directionalBias: 'NEUTRAL',
    price: 0.997,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false },
    crossExchange: { status:'ok', oi1hPct:3, oi15mPct:2, oi5mPct:1, bybitOiSharePct:30 },
  }, 'LONG');
  assert.equal(out.runnerPotential, 'HIGH');
  assert.equal(out.entryStage, 'PROBE');
  assert.equal(out.v45RunnerPotential, 'MEDIUM');
});

test('strong active flow can confirm immediately without waiting two 5m candles', () => {
  const out = api.evaluateCandidate({
    ...base,
    price: 0.997,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false },
    v45Microstructure: bullishMicrostructure,
  }, 'LONG');
  assert.equal(out.strictPriceReclaim, false);
  assert.equal(out.entryStage, 'CONFIRMED');
  assert.equal(out.v45EntrySignal, 'BREAKOUT_CONFIRMED');
});

test('DOT-like LONG with bearish CVD and order flow becomes PROBE and runner LOW', () => {
  const out = api.evaluateCandidate({
    ...base,
    symbol: 'DOTUSDT',
    directionalBias: 'BULLISH',
    price: 1.01,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: true },
    crossExchange: { status:'ok', oi1hPct:3, oi15mPct:2, oi5mPct:1, bybitOiSharePct:30 },
    v45Microstructure: bearishMicrostructure,
  }, 'LONG');
  assert.equal(out.entrySignal, 'BREAKOUT_ENTRY');
  assert.equal(out.strictPriceReclaim, true);
  assert.equal(out.entryStage, 'PROBE');
  assert.equal(out.v45EntrySignal, 'BREAKOUT_PROBE');
  assert.equal(out.v45RunnerPotential, 'LOW');
  assert.equal(out.v45RiskFlags.filter(flag =>
    flag === 'ORDER_FLOW_OPPOSES_DIRECTION').length, 1);
});

test('EGLD-like LONG exposes opposing flow without treating score as probability', () => {
  const cvdOnlyOpposition = {
    ...bearishMicrostructure,
    flow: {
      ...bearishMicrostructure.flow,
      buySellImbalance: 0,
      orderFlowBias: 'NEUTRAL',
    },
  };
  const out = api.evaluateCandidate({
    ...base,
    symbol: 'EGLDUSDT',
    directionalBias: 'BULLISH',
    price: 1.001,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false },
    crossExchange: { status:'ok', oi1hPct:3, oi15mPct:2, oi5mPct:1, bybitOiSharePct:30 },
    v45Microstructure: cvdOnlyOpposition,
  }, 'LONG');
  assert.equal(out.entrySignal, 'BREAKOUT_ENTRY');
  assert.equal(out.strictPriceReclaim, true);
  assert.equal(out.orderFlowBias, 'NEUTRAL');
  assert.equal(out.cvdBias, 'BEARISH');
  assert.equal(out.directionConfidence, out.executionScore);
  assert.equal(out.executionTier, 'MIXED');
  assert.notEqual(out.v45RunnerPotential, 'HIGH');
  assert.equal(out.v45RiskFlags.filter(flag =>
    flag === 'ORDER_FLOW_OPPOSES_DIRECTION').length, 1);
});

test('AVAX-like aligned price, CVD and order flow remains CONFIRMED', () => {
  const out = api.evaluateCandidate({
    ...base,
    symbol: 'AVAXUSDT',
    directionalBias: 'BULLISH',
    price: 1.01,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: true },
    v45Microstructure: bullishMicrostructure,
  }, 'LONG');
  assert.equal(out.entrySignal, 'BREAKOUT_ENTRY');
  assert.equal(out.entryStage, 'CONFIRMED');
  assert.equal(out.v45EntrySignal, 'BREAKOUT_CONFIRMED');
  assert.ok(out.directionConfidence >= 60);
  assert.equal(out.v45RiskFlags.includes('ORDER_FLOW_OPPOSES_DIRECTION'), false);
});

test('SHORT confirmation gate mirrors opposing bullish CVD and order flow', () => {
  const out = api.evaluateCandidate({
    ...base,
    executionState: 'SHORT_BUILD',
    directionalBias: 'BEARISH',
    price: 0.99,
    price5mPct: -0.2,
    price15mPct: -0.4,
    price1hPct: -1,
    priceStructure: { ...base.priceStructure, keyLevel: 1, lowerLows: true },
    flow5m: { recentPrice30mPct: -1, recentOi30mPct: 2, recentSteps: [
      {state:'SHORT_BUILD'}, {state:'SHORT_BUILD'}, {state:'SHORT_BUILD'},
    ] },
    crossExchange: { status:'ok', oi1hPct:3, oi15mPct:2, oi5mPct:1, bybitOiSharePct:30 },
    v45Microstructure: bullishMicrostructure,
  }, 'SHORT');
  assert.equal(out.entrySignal, 'BREAKOUT_ENTRY');
  assert.equal(out.strictPriceReclaim, true);
  assert.equal(out.entryStage, 'PROBE');
  assert.equal(out.v45RunnerPotential, 'LOW');
  assert.ok(out.v45RiskFlags.includes('ORDER_FLOW_OPPOSES_DIRECTION'));
});

test('BZ commodity is classified as TradFi and excluded from crypto pools', () => {
  const bz = {
    ...base,
    symbol: 'BZUSDT',
    crossExchange: { status:'ok', oi1hPct:3, oi15mPct:2, oi5mPct:1, bybitOiSharePct:30 },
  };
  const classification = api.marketClassification('BZUSDT');
  assert.equal(classification.marketType, 'TRADFI_PERP');
  const out = api.buildCandidateLists({
    executionStates: [bz, { ...base, symbol: 'CRYPTOUSDT' }],
    candidates: [],
  });
  assert.equal(out.longCandidatePool.some(candidate => candidate.symbol === 'BZUSDT'), false);
  assert.equal(out.tradFiLongCandidatePool.some(candidate => candidate.symbol === 'BZUSDT'), true);
});

test('STX and T regression fixtures keep old high-quality LONG but V4.5 marks them PROBE', () => {
  const fixtures = [
    { symbol: 'STXUSDT', price: 0.2838, keyLevel: 0.285, support: 0.278, price5mPct: 0.2 },
    { symbol: 'TUSDT', price: 0.0051, keyLevel: 0.00513, support: 0.00502, price5mPct: -0.2 },
  ];
  for (const fixture of fixtures) {
    const out = api.evaluateCandidate({
      ...base,
      symbol: fixture.symbol,
      price: fixture.price,
      price5mPct: fixture.price5mPct,
      priceStructure: {
        ...base.priceStructure,
        keyLevel: fixture.keyLevel,
        support: fixture.support,
        supportHeld: true,
        keyLevelReclaimed: false,
      },
    }, 'LONG');
    assert.ok(out.candidateQuality >= 70, fixture.symbol);
    assert.ok(executable.has(out.entrySignal), fixture.symbol);
    assert.equal(out.entryStage, 'PROBE', fixture.symbol);
    assert.notEqual(out.v45RunnerPotential, 'HIGH', fixture.symbol);
  }
});

test('trade and top-10/top-20 order book parsers expose stable confirmation fields', () => {
  const now = 1_000_000;
  const trades = api.parseRecentTrades([
    { T: now - 30_000, S: 'Buy', v: '7' },
    { T: now - 30_000, S: 'Sell', v: '3' },
    { T: now - 120_000, S: 'Buy', v: '2' },
    { T: now - 240_000, S: 'Sell', v: '1' },
  ], now);
  assert.equal(trades.takerBuyVolume, 9);
  assert.equal(trades.takerSellVolume, 4);
  assert.equal(trades.cvd1m, 4);
  assert.equal(trades.cvd3m, 6);
  assert.equal(trades.cvd5m, 5);
  assert.equal(trades.cvdSlope1m, 4);
  assert.equal(trades.cvdSlope3m, 2);
  assert.equal(trades.cvdSlope5m, 1);
  assert.equal(trades.cvdAcceleration, 3);
  assert.equal(trades.cvdAccelerationBias, 'BULLISH');
  assert.equal(trades.orderFlowBias, 'BULLISH');

  const book = api.parseOrderBook({
    ts: now - 50,
    b: Array.from({ length: 20 }, (_, i) => [String(1 - i / 1000), '2']),
    a: Array.from({ length: 20 }, (_, i) => [String(1 + i / 1000), '1']),
  }, now);
  assert.ok(book.obiTop10 > 0 && book.obiTop20 > 0);
  assert.equal(book.orderBookBias, 'BULLISH');
  assert.equal(book.depthLevels, 20);
  assert.equal(book.ageMs, 50);
});

test('microPersistence does not count CVD-derived slope direction as another vote', () => {
  const make = slopes => api.evaluateCandidate({
    ...base,
    price: 1.01,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: true },
    v45Microstructure: {
      ...bullishMicrostructure,
      flow: {
        ...bullishMicrostructure.flow,
        cvdSlope1m: slopes[0], cvdSlope3m: slopes[1], cvdSlope5m: slopes[2],
        cvdAcceleration: 0, cvdAccelerationBias: 'NEUTRAL',
      },
    },
  }, 'LONG');
  const alignedSlopes = make([20, 10, 8]);
  const opposingSlopes = make([-20, -10, -8]);
  assert.equal(alignedSlopes.microPersistenceScore, opposingSlopes.microPersistenceScore);
  assert.equal(alignedSlopes.microPersistence, opposingSlopes.microPersistence);
  assert.equal(alignedSlopes.executionTier, 'CLEAN');
});

test('microPersistence uses a simple three-vote majority and ignores flowBias as a vote', () => {
  const evaluateFlow = flow => api.evaluateCandidate({
    ...base,
    price: 1.01,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: true },
    v45Microstructure: {
      collectedAt: 1_000_000,
      flow: { status: 'ok', takerBuyVolume: 50, takerSellVolume: 50, ...flow },
      orderBook: { status: 'unavailable' },
    },
  }, 'LONG');

  const twoAligned = evaluateFlow({
    cvd1m: 10, cvd3m: 20, cvd5m: 30, cvdBias: 'BULLISH',
    cvdAccelerationBias: 'NEUTRAL', buySellImbalance: 0.1, orderFlowBias: 'BULLISH',
  });
  assert.equal(twoAligned.microPersistence, 'PERSISTENT');

  const flowBiasMustNotRescue = evaluateFlow({
    cvd1m: 10, cvd3m: 20, cvd5m: 30, cvdBias: 'BULLISH',
    cvdAccelerationBias: 'BEARISH', buySellImbalance: -0.1, orderFlowBias: 'BULLISH',
  });
  assert.equal(flowBiasMustNotRescue.microPersistence, 'OPPOSING');

  const twoOpposing = evaluateFlow({
    cvd1m: -10, cvd3m: -20, cvd5m: -30, cvdBias: 'BEARISH',
    cvdAccelerationBias: 'NEUTRAL', buySellImbalance: -0.1, orderFlowBias: 'BEARISH',
  });
  assert.equal(twoOpposing.microPersistence, 'OPPOSING');

  const unavailable = evaluateFlow({ status: 'unavailable' });
  assert.equal(unavailable.microPersistence, 'UNAVAILABLE');
});

test('order book parser exposes microprice, spread and top-10/top-20 depth', () => {
  const book = api.parseOrderBook({
    ts: 1_000_000,
    b: Array.from({ length: 20 }, (_, i) => [String(1 - i / 10_000), '2']),
    a: Array.from({ length: 20 }, (_, i) => [String(1.001 + i / 10_000), '1']),
  }, 1_000_000);
  assert.equal(book.bestBid, 1);
  assert.equal(book.bestAsk, 1.001);
  assert.equal(book.midPrice, 1.0005);
  assert.ok(book.microprice > book.midPrice);
  assert.ok(book.micropriceEdgeBps > 0);
  assert.ok(book.spreadBps > 9 && book.spreadBps < 11);
  assert.equal(book.bidDepthTop10, 20);
  assert.equal(book.askDepthTop10, 10);
  assert.equal(book.bidDepthTop20, 40);
  assert.equal(book.askDepthTop20, 20);
  assert.equal(book.totalDepthTop20, 60);
});

test('benchmark klines produce candidate relative-strength fields', () => {
  const start = 1_000_000;
  const rows = Array.from({ length: 13 }, (_, i) => [
    String(start + i * 300_000), '0', '0', '0', String(100 + i), '0', '0',
  ]).reverse();
  const btc = api.parseBenchmarkKlines(rows);
  const relative = api.relativeStrength(
    { price5mPct: 2, price15mPct: 4, price1hPct: 15 },
    { BTCUSDT: btc, ETHUSDT: { status: 'ok', price15mPct: 1.5 } },
  );
  assert.equal(btc.status, 'ok');
  assert.ok(relative.relBtc5m > 1);
  assert.ok(relative.relBtc15m > 1);
  assert.ok(relative.relBtc1h > 2);
  assert.equal(relative.relEth15m, 2.5);
});

test('aligned microprice raises confidence while opposing microprice lowers it', () => {
  const make = edge => api.evaluateCandidate({
    ...base,
    price: 1.01,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: true },
    v45Microstructure: {
      collectedAt: 1_000_000,
      flow: { status: 'unavailable' },
      orderBook: {
        status: 'ok', obiScore: 0, obiTop10: 0, obiTop20: 0,
        orderBookBias: 'NEUTRAL', micropriceEdgeBps: edge, spreadBps: 2,
      },
    },
  }, 'LONG');
  const aligned = make(1);
  const opposing = make(-1);
  assert.equal(aligned.micropriceBias, 'BULLISH');
  assert.equal(opposing.micropriceBias, 'BEARISH');
  assert.ok(aligned.directionConfidence > opposing.directionConfidence);
  assert.equal(aligned.entrySignal, opposing.entrySignal);
});

test('very wide spread can invalidate an otherwise reclaimed confirmation', () => {
  const out = api.evaluateCandidate({
    ...base,
    price: 1.01,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: true },
    v45Microstructure: {
      ...bullishMicrostructure,
      orderBook: { ...bullishMicrostructure.orderBook, spreadBps: 30, micropriceEdgeBps: 1 },
    },
  }, 'LONG');
  assert.equal(out.strictPriceReclaim, true);
  assert.equal(out.veryWideSpread, true);
  assert.equal(out.entryStage, 'PROBE');
  assert.ok(out.v45RiskFlags.includes('VERY_WIDE_SPREAD'));
});

test('relative strength and absorption only adjust confirmation confidence', () => {
  const common = {
    ...base,
    price: 0.997,
    price5mPct: -0.2,
    price15mPct: -0.4,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: false },
    v45Microstructure: bullishMicrostructure,
  };
  const aligned = api.evaluateCandidate({
    ...common, relBtc15m: 0.5, relBtc1h: 0.8, relEth15m: 0.4,
  }, 'LONG');
  const opposing = api.evaluateCandidate({
    ...common, relBtc15m: -0.5, relBtc1h: -0.8, relEth15m: -0.4,
  }, 'LONG');
  assert.equal(aligned.entrySignal, opposing.entrySignal);
  assert.equal(aligned.aggressiveFlowAbsorption, true);
  assert.ok(aligned.v45RiskFlags.includes('AGGRESSIVE_FLOW_ABSORBED'));
  assert.equal(aligned.relativeStrengthAligned, true);
  assert.equal(opposing.relativeStrengthOpposes, true);
  assert.ok(aligned.directionConfidence > opposing.directionConfidence);

  const absorbedOpposition = api.evaluateCandidate({
    ...base,
    price: 1.01,
    priceStructure: { ...base.priceStructure, keyLevel: 1, keyLevelReclaimed: true },
    v45Microstructure: bearishMicrostructure,
  }, 'LONG');
  assert.equal(absorbedOpposition.opposingFlowAbsorption, true);
  assert.equal(absorbedOpposition.entryStage, 'PROBE');
});

test('microstructure request failure is marked unavailable and preserves V4.4 entries', async () => {
  const legacy = api.buildCandidateLists({ executionStates: [base], candidates: [] });
  const enrichedBase = await api.enrichMicrostructure(
    { executionStates: [base], candidates: [] },
    async () => { throw new Error('rate limited'); },
    1_000_000,
  );
  const enriched = api.buildCandidateLists(enrichedBase);
  assert.deepEqual(
    enriched.longEntryCandidates.map(candidate => candidate.entrySignal),
    legacy.longEntryCandidates.map(candidate => candidate.entrySignal),
  );
  assert.equal(enriched.longCandidatePool[0].v45DataFreshness.orderFlowStatus, 'unavailable');
  assert.equal(enriched.longCandidatePool[0].v45DataFreshness.orderBookStatus, 'unavailable');
});

test('manual chase and TradFi classification remain independent of V4.5 confirmation', () => {
  const chase = api.evaluateCandidate({
    ...base, executionRisk: 'EXTENDED', price1hPct: 10,
    oi15mPct: 4, oi30mPct: 6, oi1hPct: 8,
  }, 'LONG');
  assert.equal(chase.entrySignal, 'NO_CHASE');
  assert.equal(chase.manualChaseAlert.enabled, true);
  const tradfi = api.evaluateCandidate({ ...base, symbol: 'SOFIUSDT' }, 'LONG');
  assert.equal(tradfi.marketType, 'TRADFI_PERP');
  assert.equal(tradfi.riskTag, 'TRADFI_EVENT_SENSITIVE');
  assert.equal(tradfi.runnerPotential, undefined);
});
