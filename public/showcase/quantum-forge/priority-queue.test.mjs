import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuantumForgePriorityQueue } from './priority-queue.js';

describe('QuantumForgePriorityQueue', () => {
  it('preserves max-heap priority ordering across arbitrary insertions', () => {
    const pq = new QuantumForgePriorityQueue({ mode: 'max' });

    pq.enqueue('low-task', 'low');
    pq.enqueue('urgent-task', 'urgent');
    pq.enqueue('normal-task', 'normal');
    pq.enqueue('high-task', 'high');
    pq.enqueue('custom-10', 10);

    assert.equal(pq.size, 5);
    assert.equal(pq.peek().item, 'custom-10');

    const order = [];
    while (!pq.isEmpty()) {
      order.push(pq.dequeue().item);
    }

    assert.deepEqual(order, [
      'custom-10',
      'urgent-task',
      'high-task',
      'normal-task',
      'low-task'
    ]);
    assert.equal(pq.peek(), null);
    assert.equal(pq.dequeue(), null);
  });

  it('supports min-heap ordering when configured with mode="min"', () => {
    const pq = new QuantumForgePriorityQueue({ mode: 'min' });

    pq.enqueue('p5', 5);
    pq.enqueue('p1', 1);
    pq.enqueue('p3', 3);
    pq.enqueue('p2', 2);

    const drained = [];
    while (!pq.isEmpty()) {
      drained.push(pq.dequeue().item);
    }

    assert.deepEqual(drained, ['p1', 'p2', 'p3', 'p5']);
  });

  it('maintains strict FIFO ordering on identical priorities', () => {
    const pq = new QuantumForgePriorityQueue({ mode: 'max' });

    const expected = [];
    for (let i = 1; i <= 12; i++) {
      const name = `normal-${i}`;
      pq.enqueue(name, 'normal');
      expected.push(name);
    }

    // Interleave higher and lower priorities to force heap sift-up/sink-down swaps
    pq.enqueue('urgent-first', 'urgent');
    pq.enqueue('urgent-second', 'urgent');
    pq.enqueue('low-first', 'low');
    pq.enqueue('low-second', 'low');

    const dequeued = [];
    while (!pq.isEmpty()) {
      dequeued.push(pq.dequeue().item);
    }

    assert.deepEqual(dequeued, [
      'urgent-first',
      'urgent-second',
      ...expected,
      'low-first',
      'low-second'
    ]);
  });

  it('enforces backpressure capacity and tracks saturation metrics', () => {
    const pq = new QuantumForgePriorityQueue({ maxCapacity: 3, highWaterRatio: 0.6 });

    assert.ok(pq.enqueue('e1', 'normal'));
    assert.ok(pq.enqueue('e2', 'high'));
    assert.equal(pq.getMetrics().backpressureLevel, 'elevated');

    assert.ok(pq.enqueue('e3', 'urgent'));
    assert.equal(pq.getMetrics().backpressureLevel, 'saturated');

    const rejected = pq.enqueue('e4-overflow', 'urgent');
    assert.equal(rejected, null);

    const metrics = pq.getMetrics();
    assert.equal(metrics.size, 3);
    assert.equal(metrics.droppedCount, 1);
    assert.equal(metrics.enqueuedCount, 3);
  });

  it('enforces rate-limited dequeue timing via token-bucket dispatcher', async () => {
    const pq = new QuantumForgePriorityQueue({ mode: 'max', bucketCapacity: 1 });
    pq.enqueue('low-1', 'low');
    pq.enqueue('urgent-1', 'urgent');
    pq.enqueue('high-1', 'high');
    pq.enqueue('high-2', 'high');

    const rateLimitMs = 45;
    const processed = [];
    const timestamps = [];

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pq.stopDispatcher();
        reject(new Error('Dispatcher timed out before draining queue'));
      }, 2000);

      pq.startDispatcher(rateLimitMs, async (entry) => {
        processed.push(entry.item);
        timestamps.push(Date.now());
        if (processed.length === 4) {
          clearTimeout(timeout);
          pq.stopDispatcher();
          resolve();
        }
      });
    });

    assert.deepEqual(processed, ['urgent-1', 'high-1', 'high-2', 'low-1']);
    assert.equal(pq.size, 0);

    const totalElapsedMs = timestamps[timestamps.length - 1] - timestamps[0];
    // 4 items with bucketCapacity=1 requires 3 rateLimitMs refill intervals (allowing slight timer jitter)
    assert.ok(
      totalElapsedMs >= rateLimitMs * 2.5,
      `Expected elapsed >= ${rateLimitMs * 2.5}ms, got ${totalElapsedMs}ms`
    );
  });

  it('halts dispatching cleanly on stopDispatcher() and preserves non-mutating snapshots', async () => {
    const pq = new QuantumForgePriorityQueue({ mode: 'max', bucketCapacity: 1 });
    pq.enqueue('first', 'urgent');
    pq.enqueue('second', 'high');
    pq.enqueue('third', 'normal');

    const snapshot = pq.getSortedSnapshot();
    assert.deepEqual(
      snapshot.map(e => e.item),
      ['first', 'second', 'third']
    );
    assert.equal(pq.size, 3);

    const handled = [];
    pq.startDispatcher(80, (entry) => {
      handled.push(entry.item);
      pq.stopDispatcher();
    });

    await new Promise(resolve => setTimeout(resolve, 140));
    assert.deepEqual(handled, ['first']);
    assert.equal(pq.size, 2);
    assert.equal(pq.peek().item, 'second');
    assert.equal(pq.getMetrics().running, false);
  });

  it('validates constructor, priority, and dispatcher arguments', () => {
    assert.throws(() => new QuantumForgePriorityQueue({ mode: 'invalid' }), RangeError);
    assert.throws(() => new QuantumForgePriorityQueue({ maxCapacity: 0 }), RangeError);

    const pq = new QuantumForgePriorityQueue();
    assert.throws(() => pq.enqueue('bad', 'critical-unknown'), TypeError);
    assert.throws(() => pq.enqueue('bad-nan', Number.NaN), TypeError);
    assert.throws(() => pq.startDispatcher(-10, () => {}), RangeError);
    assert.throws(() => pq.startDispatcher(50, 'not-a-fn'), TypeError);
  });
});
