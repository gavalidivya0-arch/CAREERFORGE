import { test, describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SmartIotNexusTimeTravelStore } from './snapshot-time-travel.js';

describe('SmartIotNexusTimeTravelStore', () => {
  let store;

  beforeEach(() => {
    store = new SmartIotNexusTimeTravelStore();
  });

  describe('initial state', () => {
    it('starts with empty snapshots and index -1', () => {
      assert.strictEqual(store.getSnapshotCount(), 0);
      assert.strictEqual(store.getCurrentIndex(), -1);
      assert.strictEqual(store.getCurrentSnapshot(), null);
    });
  });

  describe('commitSnapshot', () => {
    it('captures and freezes snapshot state immutably', () => {
      const rawState = { temperature: 23, humidity: 45, status: 'online' };
      const snap = store.commitSnapshot(rawState, 'Initial Setup');

      assert.ok(Object.isFrozen(snap));
      assert.ok(Object.isFrozen(snap.state));
      assert.strictEqual(snap.label, 'Initial Setup');
      assert.strictEqual(snap.state.temperature, 23);
      assert.strictEqual(snap.state.humidity, 45);
      assert.strictEqual(snap.state.status, 'online');

      rawState.temperature = 99;
      assert.strictEqual(snap.state.temperature, 23);
    });

    it('advances index and increments snapshot count', () => {
      const snap1 = store.commitSnapshot({ status: 'boot' }, 'Boot');
      assert.strictEqual(store.getSnapshotCount(), 1);
      assert.strictEqual(store.getCurrentIndex(), 0);

      const snap2 = store.commitSnapshot({ status: 'ready' }, 'Ready');
      assert.strictEqual(store.getSnapshotCount(), 2);
      assert.strictEqual(store.getCurrentIndex(), 1);
    });

    it('removes redo range when new snapshot is committed', () => {
      console.log('[TEST] Before commit - count:', store.getSnapshotCount(), 'index:', store.getCurrentIndex());
      store.commitSnapshot({ a: 1 }, 'A');
      console.log('[TEST] After A - count:', store.getSnapshotCount(), 'index:', store.getCurrentIndex(), 'snap[0].label:', store._snapshots[0]?.label);
      store.commitSnapshot({ a: 2 }, 'B');
      console.log('[TEST] After B - count:', store.getSnapshotCount(), 'index:', store.getCurrentIndex(), 'snap[1].label:', store._snapshots[1]?.label);
      store.stepTo(1);
      console.log('[TEST] After stepTo(1) - count:', store.getSnapshotCount(), 'index:', store.getCurrentIndex());
      store.commitSnapshot({ a: 3 }, 'C');
      console.log('[TEST] After C - count:', store.getSnapshotCount(), 'index:', store.getCurrentIndex(), 'snapshots:', store._snapshots.map(s => s.label + ':' + s.id));
      assert.strictEqual(store.getSnapshotCount(), 3);
      assert.strictEqual(store.getCurrentIndex(), 2);
      const undoResult = store.undo();
      console.log('[TEST] Undo result - label:', undoResult.label, 'index:', store.getCurrentIndex());
      assert.strictEqual(undoResult.label, 'B');
      assert.strictEqual(store.getCurrentIndex(), 1);
    });
  });

  describe('stepTo', () => {
    it('jumps to valid index and stops playback', () => {
      store.commitSnapshot({ x: 1 }, 'S1');
      store.commitSnapshot({ x: 2 }, 'S2');
      store.commitSnapshot({ x: 3 }, 'S3');

      assert.strictEqual(store.stepTo(2), true);
      assert.strictEqual(store.getCurrentIndex(), 2);
      assert.strictEqual(store.getCurrentSnapshot().label, 'S3');

      assert.strictEqual(store.stepTo(5), false);
      assert.strictEqual(store.stepTo(-1), false);
    });

    it('maintains immutability of target snapshot state', () => {
      store.commitSnapshot({ config: { port: 8080 } }, 'Config');
      const success = store.stepTo(0);
      assert.strictEqual(success, true);

      const snap = store.getCurrentSnapshot();
      assert.ok(Object.isFrozen(snap));
      assert.ok(Object.isFrozen(snap.state));
    });
  });

  describe('undo', () => {
    it('goes to previous snapshot and maintains index', () => {
      store.commitSnapshot({ level: 1 }, 'L1');
      store.commitSnapshot({ level: 2 }, 'L2');
      store.commitSnapshot({ level: 3 }, 'L3');

      const result = store.undo();
      assert.strictEqual(result.label, 'L2');
      assert.strictEqual(store.getCurrentIndex(), 1);

      const result2 = store.undo();
      assert.strictEqual(result2.label, 'L1');
      assert.strictEqual(store.getCurrentIndex(), 0);
    });

    it('returns null when at first snapshot', () => {
      store.commitSnapshot({ val: 1 }, 'First');
      const result = store.undo();
      assert.strictEqual(result, null);
      assert.strictEqual(store.getCurrentIndex(), 0);
    });
  });

  describe('redo', () => {
    it('goes to next snapshot after undo', () => {
      store.commitSnapshot({ v: 1 }, 'V1');
      store.commitSnapshot({ v: 2 }, 'V2');
      store.commitSnapshot({ v: 3 }, 'V3');

      store.undo();
      assert.strictEqual(store.getCurrentIndex(), 1);

      const result = store.redo();
      assert.strictEqual(result.label, 'V3');
      assert.strictEqual(store.getCurrentIndex(), 2);
    });

    it('returns null when at last snapshot', () => {
      store.commitSnapshot({ val: 1 }, 'Only');
      const result = store.redo();
      assert.strictEqual(result, null);
    });
  });

  describe('exportHistory', () => {
    it('produces valid JSON serializable history', () => {
      store.commitSnapshot({ temp: 20 }, 'Cold');
      store.commitSnapshot({ temp: 25 }, 'Warm');

      const history = store.exportHistory();
      assert.ok(Array.isArray(history));
      assert.strictEqual(history.length, 2);

      const jsonString = JSON.stringify(history);
      const parsed = JSON.parse(jsonString);
      assert.strictEqual(parsed.length, 2);

      assert.strictEqual(parsed[0].label, 'Cold');
      assert.strictEqual(parsed[0].state.temp, 20);
      assert.strictEqual(parsed[1].label, 'Warm');
      assert.strictEqual(parsed[1].state.temp, 25);
    });

    it('exported snapshots are plain objects, not frozen', () => {
      store.commitSnapshot({ x: 1 }, 'S1');
      const history = store.exportHistory();

      assert.ok(typeof history[0].state.x === 'number');
      assert.strictEqual(history[0].state.x, 1);
    });
  });

  describe('immutability', () => {
    it('stored snapshot states cannot be mutated after commit', () => {
      const raw = { reading: 42 };
      store.commitSnapshot(raw, 'Reading');

      const snap = store.getCurrentSnapshot();
      assert.throws(() => {
        snap.state.reading = 99;
      }, TypeError);
    });

    it('exported history contains mutable copies', () => {
      store.commitSnapshot({ y: 10 }, 'Y');
      const history = store.exportHistory();

      assert.doesNotThrow(() => {
        history[0].state.y = 200;
      });
    });
  });
});