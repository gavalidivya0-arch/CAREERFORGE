import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CryptoExchangeProTimeTravelStore } from './snapshot-time-travel.js';

describe('CryptoExchangeProTimeTravelStore', () => {
  it('guarantees immutability of stored snapshots against external and read mutations', () => {
    const store = new CryptoExchangeProTimeTravelStore();
    const sourceState = {
      pair: 'BTC-USDT',
      bestBid: 98420,
      nested: { orders: [101, 102], leverage: 5 }
    };

    const committed = store.commitSnapshot(sourceState, 'Initial Order Book');

    // Mutate source object after commit
    sourceState.bestBid = 1;
    sourceState.nested.orders.push(999);
    sourceState.nested.leverage = 100;

    // Mutate snapshot object returned by commitSnapshot
    committed.state.bestBid = 2;
    committed.state.nested.orders.push(888);

    const active = store.getCurrentSnapshot();
    assert.equal(active.state.bestBid, 98420);
    assert.deepEqual(active.state.nested.orders, [101, 102]);
    assert.equal(active.state.nested.leverage, 5);

    // Mutate snapshot returned by getCurrentSnapshot and getHistory
    active.state.nested.orders.push(777);
    const history = store.getHistory();
    history[0].state.bestBid = 3;

    const reread = store.getCurrentSnapshot();
    assert.equal(reread.state.bestBid, 98420);
    assert.deepEqual(reread.state.nested.orders, [101, 102]);
  });

  it('supports accurate index jumping with stepTo, undo, redo, clamping, and branch truncation', () => {
    const store = new CryptoExchangeProTimeTravelStore();
    assert.equal(store.stepTo(0), null);

    store.commitSnapshot({ price: 100 }, 'Tick 0');
    store.commitSnapshot({ price: 105 }, 'Tick 1');
    store.commitSnapshot({ price: 110 }, 'Tick 2');

    assert.equal(store.history.length, 3);
    assert.equal(store.currentIndex, 2);

    // Undo backward
    const frame1 = store.undo();
    assert.equal(store.currentIndex, 1);
    assert.equal(frame1.state.price, 105);

    const frame0 = store.undo();
    assert.equal(store.currentIndex, 0);
    assert.equal(frame0.state.price, 100);

    // Clamp at index 0
    store.undo();
    assert.equal(store.currentIndex, 0);

    // Redo forward
    const redone = store.redo();
    assert.equal(store.currentIndex, 1);
    assert.equal(redone.state.price, 105);

    // Direct stepTo & clamping
    store.stepTo(999);
    assert.equal(store.currentIndex, 2);
    assert.equal(store.getCurrentSnapshot().state.price, 110);

    store.stepTo(-42);
    assert.equal(store.currentIndex, 0);
    assert.equal(store.getCurrentSnapshot().state.price, 100);

    // Branch truncation when committing from the past
    store.stepTo(1);
    store.commitSnapshot({ price: 200 }, 'Branched Tick');
    assert.equal(store.history.length, 3);
    assert.equal(store.currentIndex, 2);
    assert.equal(store.getCurrentSnapshot().state.price, 200);
  });

  it('maintains JSON export and import parity including active cursor and breakpoints', () => {
    const store1 = new CryptoExchangeProTimeTravelStore();
    store1.commitSnapshot({ pair: 'ETH-USDT', bid: 3200, status: 'OPEN' }, 'Frame 0');
    store1.commitSnapshot({ pair: 'ETH-USDT', bid: 3250, status: 'FILLED' }, 'Frame 1');
    store1.commitSnapshot({ pair: 'ETH-USDT', bid: 3240, status: 'CLOSED' }, 'Frame 2');
    store1.toggleBreakpoint(1);
    store1.toggleWatchKey('status');
    store1.stepTo(1);

    const exported = store1.exportHistory();
    assert.equal(typeof exported, 'string');

    const store2 = new CryptoExchangeProTimeTravelStore();
    const ok = store2.importHistory(exported);

    assert.equal(ok, true);
    assert.equal(store2.history.length, 3);
    assert.equal(store2.currentIndex, 1);
    assert.equal(store2.breakpoints.has(1), true);
    assert.equal(store2.watchKeys.has('status'), true);

    const restored = store2.getCurrentSnapshot();
    assert.equal(restored.label, 'Frame 1');
    assert.deepEqual(restored.state, { pair: 'ETH-USDT', bid: 3250, status: 'FILLED' });

    // Invalid payloads fail safely
    assert.equal(store2.importHistory('not-valid-json'), false);
    assert.equal(store2.importHistory('{"history":"invalid"}'), false);
  });

  it('computes accurate property diffs and pauses bidirectional replay on breakpoints', async () => {
    const store = new CryptoExchangeProTimeTravelStore();
    store.commitSnapshot({ bid: 100, legacyFlag: true, side: 'LONG' }, 'Frame 0');
    store.commitSnapshot({ bid: 102, side: 'LONG' }, 'Frame 1');
    store.commitSnapshot({ bid: 105, side: 'SHORT', alert: 'MARGIN' }, 'Frame 2');

    // Diff between Frame 1 and Frame 2
    const diffs = store.getDiffAgainstPrevious();
    assert.equal(diffs.length, 3);
    assert.deepEqual(diffs.find((d) => d.key === 'bid'), {
      key: 'bid',
      type: 'modified',
      oldVal: 102,
      newVal: 105
    });
    assert.deepEqual(diffs.find((d) => d.key === 'alert'), {
      key: 'alert',
      type: 'added',
      oldVal: undefined,
      newVal: 'MARGIN'
    });

    const removedDiff = store.computeDiff({ bid: 100, legacyFlag: true }, { bid: 100 });
    assert.deepEqual(removedDiff, [
      { key: 'legacyFlag', type: 'removed', oldVal: true, newVal: undefined }
    ]);

    // Test backward replay pausing at breakpoint on Frame 1
    store.toggleBreakpoint(1);
    let hitEvent = null;
    await new Promise((resolve) => {
      store.startReplay(10, {
        direction: 'backward',
        onBreakpoint: (bp) => {
          hitEvent = bp;
          resolve();
        }
      });
    });

    assert.equal(store.isPlaying, false);
    assert.equal(store.currentIndex, 1);
    assert.equal(hitEvent.index, 1);
  });
});
