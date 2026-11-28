import test from 'node:test';
import assert from 'node:assert/strict';
import { LuxuryRealmsPriorityQueue, PRIORITY_RANKS } from './priority-queue.js';

test('max-heap preserves heap property across arbitrary insertions and interleaved dequeues', () => {
  const pq = new LuxuryRealmsPriorityQueue({ mode: 'max' });

  const inputs = [
    ['low-1', 1],
    ['urgent-1', 4],
    ['normal-1', 2],
    ['high-1', 3],
    ['critical-10', 10],
    ['normal-2', 2],
    ['high-2', 3]
  ];

  for (const [item, priority] of inputs) {
    assert.equal(pq.enqueue(item, priority), true);
    assert.equal(pq.verifyHeapInvariant(), true);
  }

  assert.equal(pq.size, 7);
  assert.equal(pq.peek(), 'critical-10');
  assert.equal(pq.dequeue(), 'critical-10');
  assert.equal(pq.verifyHeapInvariant(), true);

  assert.equal(pq.dequeue(), 'urgent-1');
  assert.equal(pq.verifyHeapInvariant(), true);

  // Interleave another higher-priority insertion mid-drain
  pq.enqueue('urgent-override', 99);
  assert.equal(pq.verifyHeapInvariant(), true);
  assert.equal(pq.peek(), 'urgent-override');

  const drained = [];
  while (!pq.isEmpty()) {
    drained.push(pq.dequeue());
    assert.equal(pq.verifyHeapInvariant(), true);
  }

  assert.deepEqual(drained, [
    'urgent-override',
    'high-1',
    'high-2',
    'normal-1',
    'normal-2',
    'low-1'
  ]);
  assert.equal(pq.peek(), null);
  assert.equal(pq.dequeue(), null);
});

test('min-heap mode orders smallest numeric priority first while preserving heap invariant', () => {
  const pq = new LuxuryRealmsPriorityQueue({ mode: 'min' });

  [40, 5, 25, 1, 15, 30, 10].forEach((p, idx) => {
    pq.enqueue(`task-${p}-${idx}`, p);
    assert.equal(pq.verifyHeapInvariant(), true);
  });

  const out = [];
  while (!pq.isEmpty()) {
    out.push(pq.dequeue());
    assert.equal(pq.verifyHeapInvariant(), true);
  }

  assert.deepEqual(out, [
    'task-1-3',
    'task-5-1',
    'task-10-6',
    'task-15-4',
    'task-25-2',
    'task-30-5',
    'task-40-0'
  ]);
});

test('maintains strict FIFO ordering for identical priorities across mixed ranks', () => {
  const pq = new LuxuryRealmsPriorityQueue();

  for (let i = 1; i <= 15; i++) {
    pq.enqueue(`normal-${i}`, PRIORITY_RANKS.NORMAL);
  }
  for (let i = 1; i <= 5; i++) {
    pq.enqueue(`urgent-${i}`, PRIORITY_RANKS.URGENT);
  }
  for (let i = 1; i <= 6; i++) {
    pq.enqueue(`low-${i}`, PRIORITY_RANKS.LOW);
  }

  const results = [];
  while (!pq.isEmpty()) {
    results.push(pq.dequeue());
  }

  assert.deepEqual(results, [
    'urgent-1', 'urgent-2', 'urgent-3', 'urgent-4', 'urgent-5',
    'normal-1', 'normal-2', 'normal-3', 'normal-4', 'normal-5',
    'normal-6', 'normal-7', 'normal-8', 'normal-9', 'normal-10',
    'normal-11', 'normal-12', 'normal-13', 'normal-14', 'normal-15',
    'low-1', 'low-2', 'low-3', 'low-4', 'low-5', 'low-6'
  ]);
});

test('supports semantic rank labels and validates invalid priorities or options', () => {
  const pq = new LuxuryRealmsPriorityQueue();
  pq.enqueue('routine', 'Low');
  pq.enqueue('standard', 'Normal');
  pq.enqueue('vip', 'High');
  pq.enqueue('mayday', 'Urgent');

  assert.equal(pq.dequeue(), 'mayday');
  assert.equal(pq.dequeue(), 'vip');
  assert.equal(pq.dequeue(), 'standard');
  assert.equal(pq.dequeue(), 'routine');

  assert.throws(() => pq.enqueue('bad', 'UnknownRank'), TypeError);
  assert.throws(() => pq.enqueue('nan', Number.NaN), TypeError);
  assert.throws(() => new LuxuryRealmsPriorityQueue({ mode: 'invalid' }), RangeError);
  assert.throws(() => new LuxuryRealmsPriorityQueue({ maxCapacity: 0 }), RangeError);
});

test('enforces backpressure capacity limits, watermarks, and drop metrics', () => {
  const bpEvents = [];
  const pq = new LuxuryRealmsPriorityQueue({
    maxCapacity: 4,
    highWatermark: 0.75
  });
  pq.on('backpressure', (evt) => bpEvents.push(evt.reason));

  assert.equal(pq.enqueue('a', 1), true);
  assert.equal(pq.getMetrics().backpressureLevel, 'NOMINAL');

  assert.equal(pq.enqueue('b', 2), true);
  assert.equal(pq.getMetrics().backpressureLevel, 'ELEVATED');

  assert.equal(pq.enqueue('c', 3), true);
  assert.equal(pq.getMetrics().backpressureLevel, 'CRITICAL');
  assert.equal(pq.getMetrics().isBackpressured, true);

  assert.equal(pq.enqueue('d', 4), true);
  assert.equal(pq.getMetrics().backpressureLevel, 'SATURATED');

  // 5th item rejected due to capacity saturation
  assert.equal(pq.enqueue('overflow', 4), false);

  const metrics = pq.getMetrics();
  assert.equal(metrics.size, 4);
  assert.equal(metrics.totalEnqueued, 4);
  assert.equal(metrics.totalDropped, 1);
  assert.ok(bpEvents.includes('CRITICAL'));
  assert.ok(bpEvents.includes('SATURATED'));
  assert.ok(bpEvents.includes('CAPACITY_EXCEEDED'));

  // Freeing a slot allows new enqueues again
  assert.equal(pq.dequeue(), 'd');
  assert.equal(pq.enqueue('recovered', 4), true);
  assert.equal(pq.peek(), 'recovered');
});

test('startDispatcher enforces rate-limited dequeue timing and priority order', async () => {
  const pq = new LuxuryRealmsPriorityQueue({ bucketCapacity: 1 });
  const dispatched = [];
  const timestamps = [];

  pq.enqueue('low-task', 'Low');
  pq.enqueue('urgent-1', 'Urgent');
  pq.enqueue('normal-task', 'Normal');
  pq.enqueue('urgent-2', 'Urgent');

  const rateLimitMs = 45;
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const stop = pq.startDispatcher(rateLimitMs, (item, meta) => {
    timestamps.push(Date.now());
    dispatched.push({ item, label: meta.label });
    if (dispatched.length === 4) {
      resolveDone();
    }
  });

  await donePromise;
  stop();

  assert.deepEqual(dispatched, [
    { item: 'urgent-1', label: 'Urgent' },
    { item: 'urgent-2', label: 'Urgent' },
    { item: 'normal-task', label: 'Normal' },
    { item: 'low-task', label: 'Low' }
  ]);

  // Verify consecutive dispatch intervals respect rateLimitMs
  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    assert.ok(
      gap >= rateLimitMs - 2,
      `Expected dispatch gap >= ${rateLimitMs}ms, observed ${gap}ms at index ${i}`
    );
  }

  const metrics = pq.getMetrics();
  assert.equal(metrics.totalDispatched, 4);
  assert.equal(metrics.size, 0);
  assert.equal(metrics.isRunning, false);
});

test('dispatcher handles dynamic rate updates, pause/resume, and handler errors safely', async () => {
  const pq = new LuxuryRealmsPriorityQueue({ bucketCapacity: 1 });
  const errors = [];
  const processed = [];

  pq.on('error', (evt) => errors.push(evt.error.message));

  pq.enqueue('will-fail', 'Urgent');
  pq.enqueue('will-succeed', 'High');

  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });

  pq.startDispatcher(30, async (item) => {
    if (item === 'will-fail') {
      throw new Error('Transient concierge API timeout');
    }
    processed.push(item);
    finished();
  });

  await done;
  pq.pauseDispatcher();
  assert.equal(pq.getMetrics().isPaused, true);
  assert.equal(pq.getMetrics().isRunning, false);

  pq.enqueue('while-paused', 'Normal');
  await new Promise((r) => setTimeout(r, 45));
  assert.deepEqual(processed, ['will-succeed']);

  pq.setRateLimit(20);
  const resumedDone = new Promise((resolve) => {
    pq.on('dispatch', ({ item }) => {
      if (item === 'while-paused') resolve();
    });
  });

  pq.resumeDispatcher();
  await resumedDone;
  pq.stopDispatcher();

  assert.deepEqual(errors, ['Transient concierge API timeout']);
  assert.deepEqual(processed, ['will-succeed', 'while-paused']);
  assert.equal(pq.getMetrics().failedDispatches, 1);
  assert.equal(pq.getMetrics().totalDispatched, 3);
});
