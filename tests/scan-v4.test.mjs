import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../api/scan.js', import.meta.url), 'utf8');
const now = Math.floor(Date.now() / 900000) * 900000;
function load(fetchImpl = () => { throw new Error('unexpected network'); }) {
  const context = vm.createContext({ URLSearchParams, fetch: fetchImpl,
    setTimeout: fn => fn() });
  vm.runInContext(source.replace('export default async function handler', 'async function handler') +
    '\nglobalThis.api = { handler, parseOI, parseKline, executionState, applyExecution, discoveryScore, num };', context);
  return context.api;
}
const api = load();
const base = {
  oi15mPct: 1, oi30mPct: 2, oi1hPct: 5, oi2hPct: 8,
  price5mPct: 0, price15mPct: 0, price1hPct: 0,
  positiveSteps: 4, negativeSteps: 0, consecutivePositive: 4, consecutiveNegative: 0,
  buildQuality: 100, volume15mRatio: 1.3, fundingRate: -0.001,
  oiSampleAt: now, priceSampleAt: now, oiHighRetention: 1,
  isOiSpike: false, oiRebuildEvidence: false,
  priceStructure: { lowerLows: false, supportHeld: false, keyLevelReclaimed: false },
};
const classify = patch => api.applyExecution({ ...base, ...patch }, now);
const cases = [
  ['flat OI build is neutral', {}, 'POSITION_BUILD', 'NEUTRAL'],
  ['BE-type sudden OI jump with falling price', { oi15mPct: 19, oi30mPct: 18, oi1hPct: 17,
    price5mPct: -0.4, price15mPct: -1.2, price1hPct: -3,
    isOiSpike: true, buildQuality: 15 }, 'SHORT_BUILD', 'BEARISH'],
  ['sustained OI build and confirmed lower lows', { price5mPct: -0.4,
    price15mPct: -1.2, price1hPct: -3, priceStructure: { lowerLows: true } }, 'SHORT_CONTROL', 'BEARISH'],
  ['negative funding never rescues a falling price', { fundingRate: -0.02,
    price5mPct: -0.4, price15mPct: -1, price1hPct: -3 }, 'SHORT_BUILD', 'BEARISH'],
  ['IOST-type reduction and rising price', { oi15mPct: -1, oi30mPct: -2,
    oi1hPct: -3, oi2hPct: -5, price5mPct: 0.4, price15mPct: 1, price1hPct: 3 }, 'SHORT_COVERING', 'BULLISH'],
  ['reduction and declining price', { oi15mPct: -1, oi30mPct: -2,
    price5mPct: -0.4, price15mPct: -1, price1hPct: -3 }, 'DELEVERAGING', 'BEARISH'],
  ['reduction with flat price', { oi15mPct: -1, oi30mPct: -2 }, 'OI_REDUCTION', 'NEUTRAL'],
  ['retained OI and support refusal', { price5mPct: 0.2, price15mPct: 0.1,
    priceStructure: { supportHeld: true } }, 'PRICE_REFUSAL', 'BULLISH'],
  ['rebuild evidence permits refusal without high OI', { oi1hPct: -1, oi2hPct: -3,
    oiHighRetention: 0.9, oiRebuildEvidence: true, price5mPct: 0.2, price15mPct: 0.1,
    priceStructure: { keyLevelReclaimed: true } }, 'PRICE_REFUSAL', 'BULLISH'],
  ['rising price and OI without retest/reclaim remains neutral', { price5mPct: 0.4,
    price15mPct: 1, price1hPct: 3 }, 'POSITION_BUILD', 'NEUTRAL'],
  ['low OI cannot promote a rebound', { oi1hPct: 1, oi2hPct: 1, oiHighRetention: 0.9,
    price5mPct: 0.2, price15mPct: 0.1, priceStructure: { supportHeld: true } }, 'POSITION_BUILD', 'NEUTRAL'],
  ['isolated spike cannot promote squeeze', { isOiSpike: true, price5mPct: 0.2,
    price15mPct: 0.1, priceStructure: { supportHeld: true } }, 'POSITION_BUILD', 'NEUTRAL'],
  ['low volume cannot confirm refusal', { volume15mRatio: 0.5, price5mPct: 0.2,
    price15mPct: 0.1, priceStructure: { supportHeld: true } }, 'POSITION_BUILD', 'NEUTRAL'],
  ['poor build quality cannot confirm refusal', { buildQuality: 25, price5mPct: 0.2,
    price15mPct: 0.1, priceStructure: { supportHeld: true } }, 'POSITION_BUILD', 'NEUTRAL'],
  ['OI reduction wins over refusal evidence', { oi15mPct: -1, oi30mPct: -2,
    price5mPct: 0.4, price15mPct: 1, priceStructure: { supportHeld: true } }, 'SHORT_COVERING', 'BULLISH'],
  ['weak bounce within a decline is not refusal', { price5mPct: 0.05,
    price15mPct: -0.1, price1hPct: -2, priceStructure: { supportHeld: true } }, 'SHORT_BUILD', 'BEARISH'],
  ['stale OI blocks execution', { oiSampleAt: now - 3600000 }, 'INSUFFICIENT_DATA', 'NEUTRAL'],
  ['stale price blocks execution', { priceSampleAt: now - 1200000 }, 'INSUFFICIENT_DATA', 'NEUTRAL'],
  ['future samples block execution', { priceSampleAt: now + 1 }, 'INSUFFICIENT_DATA', 'NEUTRAL'],
  ['missing price is not flat price', { price15mPct: null }, 'INSUFFICIENT_DATA', 'NEUTRAL'],
];
for (const [name, patch, state, bias] of cases) test(name, () => {
  const row = classify(patch);
  assert.equal(row.executionState, state);
  assert.equal(row.directionalBias, bias);
  assert.ok(row.stateReason.length > 20);
  if (state !== 'PRICE_REFUSAL') {
    assert.ok(!['ACCUMULATING', 'SQUEEZE_READY', 'TRIGGERING'].includes(row.signal));
    assert.ok(!['ACTIVE', 'EARLY', 'SPIKE_ACTIVE'].includes(row.trigger));
  }
});

test('funding upgrades only a confirmed refusal, and legacy outputs remain inspectable', () => {
  const patch = { price5mPct: 0.2, price15mPct: 0.1, priceStructure: { supportHeld: true } };
  assert.equal(classify(patch).signal, 'SQUEEZE_READY');
  assert.equal(classify({ ...patch, fundingRate: null }).signal, 'PRICE_REFUSAL');
  assert.equal(classify({ ...patch, fundingRate: 0.001 }).signal, 'PRICE_REFUSAL');
  const active = classify({ ...patch, price5mPct: 0.4, volume15mRatio: 1.6 });
  assert.equal(active.signal, 'TRIGGERING');
  assert.equal(active.trigger, 'ACTIVE');
  const falling = { price5mPct: -0.3, price15mPct: -0.8, price1hPct: -2 };
  assert.equal(classify({ ...falling, fundingRate: -0.02 }).score,
    classify({ ...falling, fundingRate: 0 }).score);
  assert.equal(classify(falling).legacySignal, 'SQUEEZE_READY');
  assert.ok(Number.isFinite(classify(falling).legacyScore));
});

test('extended covering is still covering, with explicit risk and no active trigger', () => {
  const row = classify({ oi15mPct: -1, oi30mPct: -2, price5mPct: 1, price15mPct: 4, price1hPct: 15 });
  assert.equal(row.executionState, 'SHORT_COVERING');
  assert.equal(row.executionRisk, 'EXTENDED');
  assert.equal(row.trigger, 'NONE');
});

function oi(values) {
  return values.map((v, i) => ({ timestamp: String(now - i * 900000), singleOpenInterest: String(v) }));
}
function candles(direction = 0) {
  return Array.from({ length: 20 }, (_, i) => {
    const open = 100 + (19 - i) * direction;
    const close = open + direction;
    return [String(now - (i + 1) * 300000), String(open),
      String(Math.max(open, close) + 0.1), String(Math.min(open, close) - 0.1),
      String(close), '100', '10000'];
  });
}
test('OI parser preserves singleOpenInterest, exposes high retention and genuine rebuild evidence', () => {
  const row = api.parseOI(oi([102, 101, 99, 100, 102, 103, 104, 104, 104]));
  assert.equal(row.current, 102);
  assert.equal(row.oiRebuildEvidence, true);
  assert.equal(row.oiSampleAt, now);
  assert.equal(row.oiHighRetention, 0.9808);
  assert.equal(row.oi15mPct, 0.99);
  assert.equal(api.parseOI(oi([108, 107, 106, 105, 104, 103, 102, 101, 100])).oiRebuildEvidence, false);
  const missing = oi([100, 99, 98, 97, 96, 95, 94, 93, 92, 91]);
  missing.splice(3, 1);
  assert.equal(api.parseOI(missing), null);
  assert.equal(api.parseOI(oi([0, 99, 98, 97, 96, 95, 94, 93, 92])), null);
});
test('5M/15M/1H returns use exactly 1/3/12 completed candles and exclude current volume', () => {
  const list = candles(1);
  list.unshift([String(now), '120', '999', '1', '999', '9999999', '9999999']);
  const row = api.parseKline(list, now + 60000);
  assert.equal(row.price5mPct, 0.84); // 120 / 119
  assert.equal(row.price15mPct, 2.56); // 120 / 117
  assert.equal(row.price1hPct, 11.11); // 120 / 108
  assert.equal(row.volume15mRatio, 1);
  assert.equal(row.priceSampleAt, now);
  const gap = candles(); gap.splice(5, 1);
  assert.equal(api.parseKline(gap, now), null);
  assert.equal(api.num(null), null);
  assert.equal(api.num(''), null);
});
test('price evidence recognizes real retest, two-close reclaim and successive lower lows', () => {
  const support = candles();
  support[0] = [support[0][0], '100', '100.5', '99.9', '100.4', '150', '15000'];
  assert.equal(api.parseKline(support, now).priceStructure.supportHeld, true);
  const reclaim = candles();
  reclaim[1] = [reclaim[1][0], '100', '100.3', '99.9', '100.2', '150', '15000'];
  reclaim[0] = [reclaim[0][0], '100.2', '100.5', '100.1', '100.4', '150', '15000'];
  assert.equal(api.parseKline(reclaim, now).priceStructure.keyLevelReclaimed, true);
  assert.equal(api.parseKline(candles(-1), now).priceStructure.lowerLows, true);
  assert.equal(api.parseKline(candles(), now).priceStructure.supportHeld, false);
});

test('handler keeps market/discovery scope, adds bounded reduction lane and propagates states', async () => {
  const symbols = [
    ...Array.from({ length: 85 }, (_, i) => `BUILD${i}USDT`),
    ...Array.from({ length: 25 }, (_, i) => `COVER${i}USDT`),
    'BTCUSDC', 'FUTUREUSDT', 'HALTEDUSDT', 'DUSTUSDT',
  ];
  const requests = [];
  const mock = async url => {
    const u = new URL(url), symbol = u.searchParams.get('symbol');
    requests.push([u.pathname, symbol]);
    let result;
    if (u.pathname.endsWith('/tickers')) result = { list: symbols.map(symbol => ({ symbol,
      lastPrice: '100', price24hPcnt: '0', turnover24h: symbol === 'DUSTUSDT' ? '1000' : '1000000',
      fundingRate: '-0.001', singleOpenInterest: '100' })) };
    else if (u.pathname.endsWith('/instruments-info')) {
      const cursor = u.searchParams.get('cursor');
      const list = symbols.map(symbol => ({ symbol, status: symbol === 'HALTEDUSDT' ? 'Settling' : 'Trading',
        contractType: symbol === 'FUTUREUSDT' ? 'LinearFutures' : 'LinearPerpetual',
        quoteCoin: symbol === 'BTCUSDC' ? 'USDC' : 'USDT' }));
      result = { list: cursor ? list.slice(50) : list.slice(0, 50), nextPageCursor: cursor ? '' : 'page2' };
    } else if (u.pathname.endsWith('/open-interest')) result = { list: oi(
      Array.from({ length: 12 }, (_, i) => symbol.startsWith('COVER') ? 100 + i : 120 - i)) };
    else if (u.pathname.endsWith('/kline')) result = { list: candles(symbol.startsWith('COVER') ? 0.3 : -0.3) };
    else throw new Error('unexpected path');
    return { ok: true, text: async () => JSON.stringify({ retCode: 0, result }) };
  };
  const server = load(mock);
  let status, payload;
  await server.handler({}, { status(code) { status = code; return this; }, json(body) { payload = body; } });
  assert.equal(status, 200);
  assert.equal(payload.version, 'OI-RADAR-V4.1');
  assert.equal(payload.diagnostics.universeCount, 110);
  assert.equal(payload.diagnostics.oiCandidateCount, 85);
  assert.equal(payload.diagnostics.reductionDeepScannedCount, 20);
  assert.equal(payload.diagnostics.klineDeepScannedCount, 100);
  assert.equal(payload.shortCovering.length, 20);
  assert.equal(payload.executionStates.length, 100);
  assert.equal(new Set(payload.executionStates.map(x => x.symbol)).size, 100);
  assert.equal(payload.diagnostics.oiErrors, 0);
  assert.equal(payload.diagnostics.klineErrors, 0);
  assert.ok(payload.executionStates.every(x => x.stateReason && x.executionState && x.directionalBias));
  assert.ok(payload.candidates.every(x => x.executionState === 'SHORT_BUILD'));
  assert.ok(payload.shortCovering.every(x => x.scanLane === 'OI_REDUCTION' && x.trigger === 'NONE'));
  assert.ok(!requests.some(([, s]) => ['BTCUSDC', 'FUTUREUSDT', 'HALTEDUSDT', 'DUSTUSDT'].includes(s)));
  for (const field of ['candidates', 'oiSpikes', 'cooling', 'oiUnwind', 'extended']) assert.ok(Array.isArray(payload[field]));
  assert.ok(payload.executionStates.every(x => 'legacySignal' in x && 'legacyTrigger' in x && 'legacyScore' in x));
  assert.ok(payload.candidates.every(x => x.crossExchange.status === 'not_configured'));
  assert.equal(payload.diagnostics.crossExchange.status, 'not_configured');
});
test('handler errors identify V4', async () => {
  let code, payload;
  await load(async () => { throw new Error('upstream unavailable'); }).handler({}, {
    status(value) { code = value; return this; }, json(value) { payload = value; },
  });
  assert.equal(code, 500);
  assert.equal(payload.version, 'OI-RADAR-V4.1');
  assert.equal(payload.status, 'error');
});
