import test from 'node:test';
import assert from 'node:assert/strict';
import { AgritechPrecisionFarmingTimeTravelStore } from './snapshot-time-travel.js';

test('AgritechPrecisionFarmingTimeTravelStore - guarantees immutability of stored snapshots', () => {
  const store = new AgritechPrecisionFarmingTimeTravelStore();
  const sourceState = {
    soilMoisture: 45,
    valve: 'CLOSED',
    tags: ['sector-1', 'drip']
  };

  store.commitSnapshot(sourceState, 'Frame 1');

  // Mutate source object after commit
  sourceState.soilMoisture = 999;
  sourceState.valve = 'TAMPERED';
  sourceState.tags.push('unauthorized');

  const snap1 = store.getCurrentSnapshot();
  assert.equal(snap1.state.soilMoisture, 45);
  assert.equal(snap1.state.valve, 'CLOSED');
  assert.deepEqual(snap1.state.tags, ['sector-1', 'drip']);

  // Mutating returned snapshot from getCurrentSnapshot must not alter store history
  snap1.state.soilMoisture = 123;
  const snap1ReRead = store.getCurrentSnapshot();
  assert.equal(snap1ReRead.state.soilMoisture, 45);
});

test('AgritechPrecisionFarmingTimeTravelStore - correct index jumping with stepTo, undo, and redo', () => {
  const store = new AgritechPrecisionFarmingTimeTravelStore();

  store.commitSnapshot({ count: 1 }, 'Snap 1');
  store.commitSnapshot({ count: 2 }, 'Snap 2');
  store.commitSnapshot({ count: 3 }, 'Snap 3');

  assert.equal(store.history.length, 3);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.count, 3);

  // Undo moves back to Snap 2 (index 1)
  const undoResult = store.undo();
  assert.equal(store.currentIndex, 1);
  assert.equal(undoResult.state.count, 2);

  // Undo moves back to Snap 1 (index 0)
  store.undo();
  assert.equal(store.currentIndex, 0);
  assert.equal(store.getCurrentSnapshot().state.count, 1);

  // Clamping at index 0 on extra undo
  store.undo();
  assert.equal(store.currentIndex, 0);

  // Redo moves forward to Snap 2 (index 1)
  const redoResult = store.redo();
  assert.equal(store.currentIndex, 1);
  assert.equal(redoResult.state.count, 2);

  // stepTo direct jump to index 2
  store.stepTo(2);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.count, 3);

  // Clamping on out-of-bounds stepTo
  store.stepTo(999);
  assert.equal(store.currentIndex, 2);
  store.stepTo(-10);
  assert.equal(store.currentIndex, 0);
});

test('AgritechPrecisionFarmingTimeTravelStore - JSON export and import parity', () => {
  const store1 = new AgritechPrecisionFarmingTimeTravelStore();
  store1.commitSnapshot({ valve: 'CLOSED', temp: 21 }, 'Initial');
  store1.commitSnapshot({ valve: 'OPEN', temp: 24 }, 'Active');
  store1.commitSnapshot({ valve: 'CLOSED', temp: 22 }, 'Final');
  store1.stepTo(1); // Positioned at frame 1

  const jsonExport = store1.exportHistory();
  assert.ok(typeof jsonExport === 'string');

  const store2 = new AgritechPrecisionFarmingTimeTravelStore();
  const importSuccess = store2.importHistory(jsonExport);
  assert.equal(importSuccess, true);
  assert.equal(store2.history.length, 3);
  assert.equal(store2.currentIndex, 1); // Exact index restored

  const snapFrame1 = store2.getCurrentSnapshot();
  assert.equal(snapFrame1.label, 'Active');
  assert.equal(snapFrame1.state.valve, 'OPEN');
  assert.equal(snapFrame1.state.temp, 24);
});

test('AgritechPrecisionFarmingTimeTravelStore - computes accurate property diffs', () => {
  const store = new AgritechPrecisionFarmingTimeTravelStore();
  const oldState = { a: 1, b: 'unchanged', c: [1, 2] };
  const newState = { a: 2, b: 'unchanged', d: 'newProperty' };

  const diffs = store.computeDiff(oldState, newState);
  assert.equal(diffs.length, 3);

  const modified = diffs.find((d) => d.key === 'a');
  assert.equal(modified.type, 'modified');
  assert.equal(modified.oldVal, 1);
  assert.equal(modified.newVal, 2);

  const removed = diffs.find((d) => d.key === 'c');
  assert.equal(removed.type, 'removed');
  assert.deepEqual(removed.oldVal, [1, 2]);

  const added = diffs.find((d) => d.key === 'd');
  assert.equal(added.type, 'added');
  assert.equal(added.newVal, 'newProperty');
});
