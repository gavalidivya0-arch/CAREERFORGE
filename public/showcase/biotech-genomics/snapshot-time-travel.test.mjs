import test from 'node:test';
import assert from 'node:assert/strict';
import { BiotechGenomicsTimeTravelStore } from './snapshot-time-travel.js';

test('BiotechGenomicsTimeTravelStore - guarantees immutability of stored genome snapshots', () => {
  const store = new BiotechGenomicsTimeTravelStore();
  const sourceState = {
    sampleId: 'GEN-101',
    variantCount: 1284,
    sequencingStatus: 'ALIGNED',
    variants: ['rs123', 'rs456']
  };

  store.commitSnapshot(sourceState, 'Frame 1');

  // Mutate source state object after commit
  sourceState.variantCount = 9999;
  sourceState.sequencingStatus = 'CONTAMINATED';
  sourceState.variants.push('rs-attacker');

  const snap1 = store.getCurrentSnapshot();
  assert.equal(snap1.state.variantCount, 1284);
  assert.equal(snap1.state.sequencingStatus, 'ALIGNED');
  assert.deepEqual(snap1.state.variants, ['rs123', 'rs456']);

  // Mutating returned snapshot from getCurrentSnapshot must not alter stored history
  snap1.state.variantCount = 500;
  const snap1ReRead = store.getCurrentSnapshot();
  assert.equal(snap1ReRead.state.variantCount, 1284);
});

test('BiotechGenomicsTimeTravelStore - correct index jumping with stepTo, undo, and redo', () => {
  const store = new BiotechGenomicsTimeTravelStore();

  store.commitSnapshot({ stage: 'Raw Reads' }, 'Frame 1');
  store.commitSnapshot({ stage: 'Aligned' }, 'Frame 2');
  store.commitSnapshot({ stage: 'Validated' }, 'Frame 3');

  assert.equal(store.history.length, 3);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.stage, 'Validated');

  // Undo moves back to Frame 2 (index 1)
  const undoResult = store.undo();
  assert.equal(store.currentIndex, 1);
  assert.equal(undoResult.state.stage, 'Aligned');

  // Undo moves back to Frame 1 (index 0)
  store.undo();
  assert.equal(store.currentIndex, 0);
  assert.equal(store.getCurrentSnapshot().state.stage, 'Raw Reads');

  // Boundary clamp on extra undo
  store.undo();
  assert.equal(store.currentIndex, 0);

  // Redo moves forward to Frame 2 (index 1)
  const redoResult = store.redo();
  assert.equal(store.currentIndex, 1);
  assert.equal(redoResult.state.stage, 'Aligned');

  // stepTo direct jump to index 2
  store.stepTo(2);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.stage, 'Validated');

  // Clamping on out-of-bounds stepTo
  store.stepTo(100);
  assert.equal(store.currentIndex, 2);
  store.stepTo(-5);
  assert.equal(store.currentIndex, 0);
});

test('BiotechGenomicsTimeTravelStore - JSON export and import parity', () => {
  const store1 = new BiotechGenomicsTimeTravelStore();
  store1.commitSnapshot({ coverage: 10, status: 'INIT' }, 'Init');
  store1.commitSnapshot({ coverage: 50, status: 'LOCKED' }, 'Locked');
  store1.commitSnapshot({ coverage: 30, status: 'VALIDATED' }, 'Validated');
  store1.stepTo(1); // Positioned at frame 1

  const jsonExport = store1.exportHistory();
  assert.ok(typeof jsonExport === 'string');

  const store2 = new BiotechGenomicsTimeTravelStore();
  const importSuccess = store2.importHistory(jsonExport);
  assert.equal(importSuccess, true);
  assert.equal(store2.history.length, 3);
  assert.equal(store2.currentIndex, 1); // Exact index preserved

  const snapFrame1 = store2.getCurrentSnapshot();
  assert.equal(snapFrame1.label, 'Locked');
  assert.equal(snapFrame1.state.coverage, 50);
  assert.equal(snapFrame1.state.status, 'LOCKED');
});

test('BiotechGenomicsTimeTravelStore - computes accurate genome state diffs', () => {
  const store = new BiotechGenomicsTimeTravelStore();
  const oldState = { sequencingStatus: 'ALIGNED', variantCount: 50, organism: 'Homo sapiens' };
  const newState = { sequencingStatus: 'VALIDATED', variantCount: 0, crisprTargets: 3 };

  const diffs = store.computeDiff(oldState, newState);
  assert.equal(diffs.length, 4);

  const modifiedStatus = diffs.find((d) => d.key === 'sequencingStatus');
  assert.equal(modifiedStatus.type, 'modified');
  assert.equal(modifiedStatus.oldVal, 'ALIGNED');
  assert.equal(modifiedStatus.newVal, 'VALIDATED');

  const modifiedVariants = diffs.find((d) => d.key === 'variantCount');
  assert.equal(modifiedVariants.type, 'modified');
  assert.equal(modifiedVariants.oldVal, 50);
  assert.equal(modifiedVariants.newVal, 0);

  const removed = diffs.find((d) => d.key === 'organism');
  assert.equal(removed.type, 'removed');
  assert.equal(removed.oldVal, 'Homo sapiens');

  const added = diffs.find((d) => d.key === 'crisprTargets');
  assert.equal(added.type, 'added');
  assert.equal(added.newVal, 3);
});

test('BiotechGenomicsTimeTravelStore - stepTo normalizes fractional and invalid indexes', () => {
  const store = new BiotechGenomicsTimeTravelStore();
  store.commitSnapshot({ stage: 'ONE' }, 'One');
  store.commitSnapshot({ stage: 'TWO' }, 'Two');
  store.commitSnapshot({ stage: 'THREE' }, 'Three');

  store.stepTo(1.9);
  assert.equal(store.currentIndex, 1);
  assert.equal(store.getCurrentSnapshot().state.stage, 'TWO');

  store.stepTo(Number.NaN);
  assert.equal(store.currentIndex, 0);
  assert.equal(store.getCurrentSnapshot().state.stage, 'ONE');
});

test('BiotechGenomicsTimeTravelStore - rejects malformed or empty import journals', () => {
  const store = new BiotechGenomicsTimeTravelStore();
  store.commitSnapshot({ stage: 'KEEP' }, 'Keep');

  assert.equal(store.importHistory('{not-json'), false);
  assert.equal(store.importHistory(JSON.stringify({ history: [] })), false);
  assert.equal(store.importHistory(JSON.stringify({ currentIndex: 0 })), false);
  assert.equal(store.history.length, 1);
  assert.equal(store.getCurrentSnapshot().state.stage, 'KEEP');
});
