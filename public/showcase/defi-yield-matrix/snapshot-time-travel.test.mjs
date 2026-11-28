import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefiYieldMatrixTimeTravelStore } from './snapshot-time-travel.js';

test('DefiYieldMatrixTimeTravelStore - records immutable snapshots and deep-clones state', () => {
  const initialState = { balance: 1000, pools: ['USDC-ETH'] };
  const store = new DefiYieldMatrixTimeTravelStore(initialState);

  // Mutating original object should not affect recorded snapshot
  initialState.balance = 99999;
  initialState.pools.push('MUTATION');

  const curr = store.getCurrentState();
  assert.strictEqual(curr.balance, 1000);
  assert.strictEqual(curr.pools.length, 1);

  store.commitSnapshot('DEPOSIT', { balance: 1500, pools: ['USDC-ETH', 'WBTC'] });
  assert.strictEqual(store.getHistory().length, 2);
  assert.strictEqual(store.getCurrentState().balance, 1500);
});

test('DefiYieldMatrixTimeTravelStore - computes granular diffs between states accurately', () => {
  const stateA = { a: 1, b: 'old', c: true };
  const stateB = { a: 1, b: 'new', d: 42 };

  const diff = DefiYieldMatrixTimeTravelStore.computeDiff(stateA, stateB);

  // modified: b
  assert.strictEqual(diff.modified.length, 1);
  assert.strictEqual(diff.modified[0].key, 'b');
  assert.strictEqual(diff.modified[0].oldValue, 'old');
  assert.strictEqual(diff.modified[0].newValue, 'new');

  // added: d
  assert.strictEqual(diff.added.length, 1);
  assert.strictEqual(diff.added[0].key, 'd');
  assert.strictEqual(diff.added[0].value, 42);

  // deleted: c
  assert.strictEqual(diff.deleted.length, 1);
  assert.strictEqual(diff.deleted[0].key, 'c');
  assert.strictEqual(diff.deleted[0].oldValue, true);
});

test('DefiYieldMatrixTimeTravelStore - jumps across steps with stepTo and clamps index bounds', () => {
  const store = new DefiYieldMatrixTimeTravelStore({ step: 0 });
  store.commitSnapshot('STEP_1', { step: 1 });
  store.commitSnapshot('STEP_2', { step: 2 });

  // Jump backward to step 1
  const res1 = store.stepTo(1);
  assert.strictEqual(res1.snapshot.state.step, 1);
  assert.strictEqual(store.getCurrentState().step, 1);

  // Jump to step 0
  const res0 = store.stepTo(0);
  assert.strictEqual(res0.snapshot.state.step, 0);

  // Clamps out of bound indices
  const clamped = store.stepTo(999);
  assert.strictEqual(clamped.snapshot.state.step, 2);

  // Clamps negative indices
  const clampedNeg = store.stepTo(-999);
  assert.strictEqual(clampedNeg.snapshot.state.step, 0);
});

test('DefiYieldMatrixTimeTravelStore - undo and redo navigation', () => {
  const store = new DefiYieldMatrixTimeTravelStore({ val: 0 });
  store.commitSnapshot('STEP_1', { val: 1 });
  store.commitSnapshot('STEP_2', { val: 2 });
  store.commitSnapshot('STEP_3', { val: 3 });

  // Undo twice
  const undo1 = store.undo();
  assert.strictEqual(undo1.snapshot.state.val, 2);
  const undo2 = store.undo();
  assert.strictEqual(undo2.snapshot.state.val, 1);

  // Redo twice
  const redo1 = store.redo();
  assert.strictEqual(redo1.snapshot.state.val, 2);
  const redo2 = store.redo();
  assert.strictEqual(redo2.snapshot.state.val, 3);
});

test('DefiYieldMatrixTimeTravelStore - new commit after undo truncates forward history', () => {
  const store = new DefiYieldMatrixTimeTravelStore({ val: 0 });
  store.commitSnapshot('STEP_1', { val: 1 });
  store.commitSnapshot('STEP_2', { val: 2 });
  store.commitSnapshot('STEP_3', { val: 3 });

  // Undo to step 1
  store.undo(); // step 2
  store.undo(); // step 1

  // Commit new step - should truncate forward history
  store.commitSnapshot('STEP_NEW', { val: 99 });

  assert.strictEqual(store.getHistory().length, 3);
  assert.strictEqual(store.getCurrentState().val, 99);
  assert.strictEqual(store.getHistory()[2].action, 'STEP_NEW');
});

test('DefiYieldMatrixTimeTravelStore - exports and imports replay JSON preserving history', () => {
  const store = new DefiYieldMatrixTimeTravelStore({ token: 'ETH' });
  store.commitSnapshot('STAKE', { token: 'ETH', staked: 10 });

  const jsonStr = store.exportHistory();
  assert.ok(typeof jsonStr === 'string');

  const newStore = new DefiYieldMatrixTimeTravelStore();
  const success = newStore.importHistory(jsonStr);
  assert.strictEqual(success, true);
  assert.strictEqual(newStore.getHistory().length, 2);
  assert.strictEqual(newStore.getCurrentState().staked, 10);
  assert.strictEqual(newStore.currentIndex, 1);
});

test('DefiYieldMatrixTimeTravelStore - getHistory returns deep-cloned copies', () => {
  const store = new DefiYieldMatrixTimeTravelStore({ x: 1 });
  store.commitSnapshot('ADD', { x: 2 });

  const hist = store.getHistory();
  const originalState = store.getHistory()[0].state;

  // Mutating returned history should not affect store
  originalState.x = 999;

  assert.strictEqual(store.getCurrentState().x, 2);
});