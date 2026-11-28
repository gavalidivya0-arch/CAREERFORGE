import test from 'node:test';
import assert from 'node:assert/strict';
import { LegalSmartContractsTimeTravelStore } from './snapshot-time-travel.js';

test('LegalSmartContractsTimeTravelStore - guarantees immutability of stored contract snapshots', () => {
  const store = new LegalSmartContractsTimeTravelStore();
  const sourceState = {
    contractId: 'sc-101',
    balanceEth: 10.5,
    status: 'ACTIVE',
    signers: ['0x111', '0x222']
  };

  store.commitSnapshot(sourceState, 'Block 1');

  // Mutate source state object after commit
  sourceState.balanceEth = 999.0;
  sourceState.status = 'COMPROMISED';
  sourceState.signers.push('0xattacker');

  const snap1 = store.getCurrentSnapshot();
  assert.equal(snap1.state.balanceEth, 10.5);
  assert.equal(snap1.state.status, 'ACTIVE');
  assert.deepEqual(snap1.state.signers, ['0x111', '0x222']);

  // Mutating returned snapshot from getCurrentSnapshot must not alter stored history
  snap1.state.balanceEth = 500.0;
  const snap1ReRead = store.getCurrentSnapshot();
  assert.equal(snap1ReRead.state.balanceEth, 10.5);
});

test('LegalSmartContractsTimeTravelStore - correct index jumping with stepTo, undo, and redo', () => {
  const store = new LegalSmartContractsTimeTravelStore();

  store.commitSnapshot({ stage: 'Draft' }, 'Block 1');
  store.commitSnapshot({ stage: 'Funded' }, 'Block 2');
  store.commitSnapshot({ stage: 'Settled' }, 'Block 3');

  assert.equal(store.history.length, 3);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.stage, 'Settled');

  // Undo moves back to Block 2 (index 1)
  const undoResult = store.undo();
  assert.equal(store.currentIndex, 1);
  assert.equal(undoResult.state.stage, 'Funded');

  // Undo moves back to Block 1 (index 0)
  store.undo();
  assert.equal(store.currentIndex, 0);
  assert.equal(store.getCurrentSnapshot().state.stage, 'Draft');

  // Boundary clamp on extra undo
  store.undo();
  assert.equal(store.currentIndex, 0);

  // Redo moves forward to Block 2 (index 1)
  const redoResult = store.redo();
  assert.equal(store.currentIndex, 1);
  assert.equal(redoResult.state.stage, 'Funded');

  // stepTo direct jump to index 2
  store.stepTo(2);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.stage, 'Settled');

  // Clamping on out-of-bounds stepTo
  store.stepTo(100);
  assert.equal(store.currentIndex, 2);
  store.stepTo(-5);
  assert.equal(store.currentIndex, 0);
});

test('LegalSmartContractsTimeTravelStore - JSON export and import parity', () => {
  const store1 = new LegalSmartContractsTimeTravelStore();
  store1.commitSnapshot({ escrow: 10, status: 'INIT' }, 'Init');
  store1.commitSnapshot({ escrow: 50, status: 'LOCKED' }, 'Locked');
  store1.commitSnapshot({ escrow: 0, status: 'RELEASED' }, 'Released');
  store1.stepTo(1); // Positioned at frame 1

  const jsonExport = store1.exportHistory();
  assert.ok(typeof jsonExport === 'string');

  const store2 = new LegalSmartContractsTimeTravelStore();
  const importSuccess = store2.importHistory(jsonExport);
  assert.equal(importSuccess, true);
  assert.equal(store2.history.length, 3);
  assert.equal(store2.currentIndex, 1); // Exact index preserved

  const snapFrame1 = store2.getCurrentSnapshot();
  assert.equal(snapFrame1.label, 'Locked');
  assert.equal(snapFrame1.state.escrow, 50);
  assert.equal(snapFrame1.state.status, 'LOCKED');
});

test('LegalSmartContractsTimeTravelStore - computes accurate contract state diffs', () => {
  const store = new LegalSmartContractsTimeTravelStore();
  const oldState = { status: 'ACTIVE', balance: 50, arbitrator: '0xabc' };
  const newState = { status: 'SETTLED', balance: 0, payoutTx: '0x123' };

  const diffs = store.computeDiff(oldState, newState);
  assert.equal(diffs.length, 4);

  const modifiedStatus = diffs.find((d) => d.key === 'status');
  assert.equal(modifiedStatus.type, 'modified');
  assert.equal(modifiedStatus.oldVal, 'ACTIVE');
  assert.equal(modifiedStatus.newVal, 'SETTLED');

  const modifiedBalance = diffs.find((d) => d.key === 'balance');
  assert.equal(modifiedBalance.type, 'modified');
  assert.equal(modifiedBalance.oldVal, 50);
  assert.equal(modifiedBalance.newVal, 0);

  const removed = diffs.find((d) => d.key === 'arbitrator');
  assert.equal(removed.type, 'removed');
  assert.equal(removed.oldVal, '0xabc');

  const added = diffs.find((d) => d.key === 'payoutTx');
  assert.equal(added.type, 'added');
  assert.equal(added.newVal, '0x123');
});
