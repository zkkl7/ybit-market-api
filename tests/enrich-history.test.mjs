import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('history persists timing fields without changing entry ranking or requiring history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-history-test-'));
  try {
    fs.mkdirSync(path.join(root, 'data'));
    const candidate = {
      symbol: 'TESTUSDT', direction: 'LONG', candidateState: 'PRE_ENTRY',
      candidateQuality: 74, entrySignal: 'EARLY_ENTRY', timingScore: 83,
      entryStage: 'PROBE', v45EntryStage: 'PROBE', v45EntrySignal: 'EARLY_PROBE',
      priceConfirmScore: 45, cvdBias: 'BEARISH', orderFlowBias: 'BEARISH',
      obiScore: -0.1, directionConfidence: 30,
      invalidationReason: 'KEY_LEVEL_NOT_RECLAIMED', v45RunnerPotential: 'MEDIUM',
      v45DataFreshness: { orderFlowStatus: 'ok', orderBookStatus: 'ok' },
      timingRiskFlags: ['PRICE_WARM'], keyMetrics: { price: 1, oi15mPct: 1, oi30mPct: 2 },
    };
    const radar = { longCandidatePool: [candidate], longEntryCandidates: [candidate] };
    fs.writeFileSync(path.join(root, 'data/latest.json'), JSON.stringify({ radar }));
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/enrich-history.mjs', import.meta.url))], { cwd: root });
    const latest = JSON.parse(fs.readFileSync(path.join(root, 'data/latest.json')));
    const history = JSON.parse(fs.readFileSync(path.join(root, 'data/history.json')));
    assert.equal(latest.radar.longEntryCandidates.length, 1);
    assert.equal(latest.radar.longEntryCandidates[0].symbol, candidate.symbol);
    assert.equal(latest.radar.longEntryCandidates[0].entrySignal, candidate.entrySignal);
    assert.equal(typeof latest.radar.longEntryCandidates[0].runnerScore, 'number');
    assert.equal(latest.radar.longEntryCandidates[0].finalCandidateScore,
      latest.radar.longCandidatePool[0].finalCandidateScore);
    assert.equal(latest.radar.longCandidatePool[0].seenInLast3, 1);
    const saved = history.snapshots[0].candidates[0];
    assert.equal(saved.entrySignal, 'EARLY_ENTRY');
    assert.equal(saved.timingScore, 83);
    assert.deepEqual(saved.timingRiskFlags, ['PRICE_WARM']);
    assert.equal(saved.entryStage, 'PROBE');
    assert.equal(saved.v45EntrySignal, 'EARLY_PROBE');
    assert.equal(saved.cvdBias, 'BEARISH');
    assert.equal(saved.v45RunnerPotential,
      latest.radar.longCandidatePool[0].v45RunnerPotential);
    assert.equal(latest.radar.longEntryCandidates[0].v45EntrySignal, 'EARLY_PROBE');
    assert.equal(latest.radar.longEntryCandidates[0].v45RunnerPotential,
      latest.radar.longCandidatePool[0].v45RunnerPotential);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
