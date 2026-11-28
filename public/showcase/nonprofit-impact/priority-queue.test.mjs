import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NonprofitImpactPriorityQueue,
  PRIORITY_RANKS,
  mountPriorityQueue,
  resolvePriority
} from './priority-queue.js';

test('resolvePriority normalizes semantic rank labels and numeric values for max and min modes', () => {
  assert.deepEqual(resolvePriority('urgent', 'max'), { value: PRIORITY_RANKS.URGENT, label: 'Urgent' });
  assert.deepEqual(resolvePriority('HIGH', 'max'), { value: PRIORITY_RANKS.HIGH, label: 'High' });
  assert.deepEqual(resolvePriority('Normal', 'max'), { value: PRIORITY_RANKS.NORMAL, label: 'Normal' });
  assert.deepEqual(resolvePriority('low', 'max'), { value: PRIORITY_RANKS.LOW, label: 'Low' });

  assert.deepEqual(resolvePriority('Urgent', 'min'), { value: 1, label: 'Urgent' });
  assert.deepEqual(resolvePriority('Low', 'min'), { value: 4, label: 'Low' });

  assert.deepEqual(resolvePriority(10, 'max'), { value: 10, label: 'Urgent' });
  assert.deepEqual(resolvePriority(0, 'min'), { value: 0, label: 'Urgent' });

  assert.throws(() => resolvePriority('critical', 'max'), TypeError);
  assert.throws(() => resolvePriority(Number.NaN, 'max'), TypeError);
  assert.throws(() => resolvePriority(Infinity, 'max'), TypeError);
  assert.throws(() => resolvePriority('High', 'invalid'), RangeError);
});

test('max-heap preserves heap property across interleaved enqueues, peeks, and dequeues', () => {
  const queue = new NonprofitImpactPriorityQueue({ mode: 'max' });

  assert.equal(queue.peek(), null);
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.isEmpty(), true);

  queue.enqueue('donor-digest', 'Low');
  queue.enqueue('watershed-grant', 'High');
  queue.enqueue('wildfire-alert', 'Urgent');
  queue.enqueue('sapling-sync', 'Normal');

  assert.equal(queue.size(), 4);
  assert.equal(queue.peek(), 'wildfire-alert');
  assert.equal(queue.size(), 4);

  assert.equal(queue.dequeue(), 'wildfire-alert');
  assert.equal(queue.peek(), 'watershed-grant');

  queue.enqueue('flood-relief', 99);
  queue.enqueue('mangrove-audit', 2.5);

  const drained = [];
  while (!queue.isEmpty()) {
    drained.push(queue.dequeue());
  }

  assert.deepEqual(drained, [
    'flood-relief',
    'watershed-grant',
    'mangrove-audit',
    'sapling-sync',
    'donor-digest'
  ]);
});

test('min-heap preserves heap property and setMode re-heapifies existing entries', () => {
  const queue = new NonprofitImpactPriorityQueue({ mode: 'min' });

  queue.enqueue('low-task', 40);
  queue.enqueue('urgent-task', 1);
  queue.enqueue('high-task', 10);
  queue.enqueue('normal-task', 25);

  assert.equal(queue.peek(), 'urgent-task');
  assert.equal(queue.dequeue(), 'urgent-task');
  assert.equal(queue.dequeue(), 'high-task');
  assert.equal(queue.dequeue(), 'normal-task');
  assert.equal(queue.dequeue(), 'low-task');

  const semanticQueue = new NonprofitImpactPriorityQueue({ mode: 'max' });
  semanticQueue.enqueue('low-item', 'Low');
  semanticQueue.enqueue('urgent-item', 'Urgent');
  semanticQueue.enqueue('normal-item', 'Normal');

  semanticQueue.setMode('min');
  assert.equal(semanticQueue.peek(), 'urgent-item');
  assert.deepEqual(
    semanticQueue.toArray().map((entry) => entry.item),
    ['urgent-item', 'normal-item', 'low-item']
  );

  const numericQueue = new NonprofitImpactPriorityQueue({ mode: 'max' });
  numericQueue.enqueue('p10', 10);
  numericQueue.enqueue('p99', 99);
  assert.equal(numericQueue.peek(), 'p99');
  numericQueue.setMode('min');
  assert.equal(numericQueue.peek(), 'p10');
});

test('FIFO ordering is strictly preserved on identical priorities across heap sift operations', () => {
  const queue = new NonprofitImpactPriorityQueue({ mode: 'max' });

  // Interleave high/normal items so identical priorities occupy both left and right child slots
  for (let i = 1; i <= 12; i += 1) {
    queue.enqueue(`normal-${i}`, 'Normal');
  }
  queue.enqueue('urgent-1', 'Urgent');
  queue.enqueue('urgent-2', 'Urgent');
  queue.enqueue('urgent-3', 'Urgent');
  for (let i = 13; i <= 20; i += 1) {
    queue.enqueue(`normal-${i}`, 'Normal');
  }

  const urgentOrder = [queue.dequeue(), queue.dequeue(), queue.dequeue()];
  assert.deepEqual(urgentOrder, ['urgent-1', 'urgent-2', 'urgent-3']);

  const normalOrder = [];
  while (!queue.isEmpty()) {
    normalOrder.push(queue.dequeue());
  }

  const expectedNormals = Array.from({ length: 20 }, (_, idx) => `normal-${idx + 1}`);
  assert.deepEqual(normalOrder, expectedNormals);
});

test('backpressure enforces maxCapacity, watermark states, and telemetry metrics', () => {
  let fakeNow = 1000;
  const queue = new NonprofitImpactPriorityQueue({
    mode: 'max',
    maxCapacity: 4,
    highWatermark: 0.75,
    now: () => fakeNow
  });

  assert.equal(queue.getBackpressureState(), 'idle');

  assert.ok(queue.enqueue('evt-1', 'Low'));
  assert.equal(queue.getBackpressureState(), 'nominal');

  assert.ok(queue.enqueue('evt-2', 'Normal'));
  assert.ok(queue.enqueue('evt-3', 'High'));
  assert.equal(queue.getBackpressureState(), 'elevated');

  assert.ok(queue.enqueue('evt-4', 'Urgent'));
  assert.equal(queue.getBackpressureState(), 'saturated');

  const rejected = queue.enqueue('evt-5-overflow', 'Urgent');
  assert.equal(rejected, null);
  assert.equal(queue.size(), 4);

  fakeNow += 120;
  assert.equal(queue.dequeue(), 'evt-4');

  const metrics = queue.getMetrics();
  assert.equal(metrics.depth, 3);
  assert.equal(metrics.peakDepth, 4);
  assert.equal(metrics.totalEnqueued, 4);
  assert.equal(metrics.totalDequeued, 1);
  assert.equal(metrics.totalDropped, 1);
  assert.ok(metrics.backpressureEvents >= 2);
  assert.equal(metrics.lastWaitMs, 120);
  assert.equal(metrics.averageWaitMs, 120);
});

test('startDispatcher paces dequeues at the configured rate limit using token-bucket control', async () => {
  const queue = new NonprofitImpactPriorityQueue({
    mode: 'max',
    bucketCapacity: 1,
    initialTokens: 1
  });

  const dispatched = [];
  const rateLimitMs = 45;

  queue.enqueue('low-report', 'Low');
  queue.enqueue('urgent-fire', 'Urgent');
  queue.enqueue('high-grant', 'High');
  queue.enqueue('normal-seed', 'Normal');

  const controller = queue.startDispatcher(rateLimitMs, async (item, meta) => {
    dispatched.push({ item, label: meta.label, at: Date.now() });
  });

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Dispatcher timed out')), 1500);
      const check = setInterval(() => {
        if (dispatched.length === 4) {
          clearInterval(check);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });
  } finally {
    controller.stop();
  }

  assert.deepEqual(
    dispatched.map((entry) => entry.item),
    ['urgent-fire', 'high-grant', 'normal-seed', 'low-report']
  );

  // First event uses the initial token immediately; remaining 3 require >= ~3 * rateLimitMs total span
  const totalElapsedMs = dispatched[3].at - dispatched[0].at;
  assert.ok(
    totalElapsedMs >= rateLimitMs * 2.4,
    `Expected rate-limited dispatch span >= ${rateLimitMs * 2.4}ms, got ${totalElapsedMs}ms`
  );

  for (let i = 1; i < dispatched.length; i += 1) {
    const delta = dispatched[i].at - dispatched[i - 1].at;
    assert.ok(delta >= rateLimitMs * 0.7, `Expected step interval >= ${rateLimitMs * 0.7}ms, got ${delta}ms`);
  }

  const metrics = queue.getMetrics();
  assert.equal(metrics.totalDispatched, 4);
  assert.equal(metrics.depth, 0);
  assert.equal(metrics.running, false);
});

test('dispatcher supports pause, resume, dynamic setRateLimit, and failing handler isolation', async () => {
  const queue = new NonprofitImpactPriorityQueue({
    bucketCapacity: 1,
    initialTokens: 1
  });

  const delivered = [];
  queue.enqueue('first-fails', 'Urgent');
  queue.enqueue('second-succeeds', 'High');
  queue.enqueue('third-after-resume', 'Normal');

  const controller = queue.startDispatcher(30, async (item) => {
    if (item === 'first-fails') {
      throw new Error('Simulated downstream webhook timeout');
    }
    delivered.push(item);
    if (delivered.length === 1) {
      controller.pause();
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.deepEqual(delivered, ['second-succeeds']);
  assert.equal(queue.getMetrics().paused, true);
  assert.equal(queue.getMetrics().failedDispatches, 1);
  assert.equal(queue.size(), 1);

  controller.setRateLimit(20);
  controller.resume();

  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Resume timed out')), 1000);
    const poll = setInterval(() => {
      if (delivered.length === 2) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 10);
  });

  controller.stop();
  assert.deepEqual(delivered, ['second-succeeds', 'third-after-resume']);
});

test('constructor and methods validate arguments and mountPriorityQueue safely no-ops without DOM', () => {
  assert.throws(() => new NonprofitImpactPriorityQueue(null), TypeError);
  assert.throws(() => new NonprofitImpactPriorityQueue({ mode: 'invalid' }), RangeError);
  assert.throws(() => new NonprofitImpactPriorityQueue({ maxCapacity: 0 }), RangeError);
  assert.throws(() => new NonprofitImpactPriorityQueue({ highWatermark: 1.5 }), RangeError);
  assert.throws(() => new NonprofitImpactPriorityQueue({ bucketCapacity: 0 }), RangeError);

  const queue = new NonprofitImpactPriorityQueue();
  assert.throws(() => queue.enqueue(undefined, 'Normal'), TypeError);
  assert.throws(() => queue.startDispatcher(0, () => {}), RangeError);
  assert.throws(() => queue.startDispatcher(50, 'not-a-fn'), TypeError);

  assert.equal(mountPriorityQueue(null), null);
});
