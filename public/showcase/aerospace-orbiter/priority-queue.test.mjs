import test from 'node:test';
import assert from 'node:assert/strict';
import { AerospaceOrbiterPriorityQueue } from './priority-queue.js';

test('preserves binary max-heap ordering across randomized numeric and string priorities', () => {
  const queue = new AerospaceOrbiterPriorityQueue();

  queue.enqueue('Low telemetry sweep', 'low');
  queue.enqueue('High attitude trim', 3);
  queue.enqueue('Normal heartbeat', 'normal');
  queue.enqueue('Urgent thruster abort', 'urgent');
  queue.enqueue('High solar gimbal', 'high');

  assert.equal(queue.size(), 5);
  assert.equal(queue.peek(), 'Urgent thruster abort');

  assert.equal(queue.dequeue(), 'Urgent thruster abort');
  assert.equal(queue.dequeue(), 'High attitude trim');
  assert.equal(queue.dequeue(), 'High solar gimbal');
  assert.equal(queue.dequeue(), 'Normal heartbeat');
  assert.equal(queue.dequeue(), 'Low telemetry sweep');
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.isEmpty(), true);
});

test('supports binary min-heap mode ordering', () => {
  const queue = new AerospaceOrbiterPriorityQueue({ mode: 'min' });

  queue.enqueue('Rank 4 event', 4);
  queue.enqueue('Rank 1 event', 1);
  queue.enqueue('Rank 3 event', 3);
  queue.enqueue('Rank 2 event', 2);

  assert.equal(queue.peek(), 'Rank 1 event');
  assert.equal(queue.dequeue(), 'Rank 1 event');
  assert.equal(queue.dequeue(), 'Rank 2 event');
  assert.equal(queue.dequeue(), 'Rank 3 event');
  assert.equal(queue.dequeue(), 'Rank 4 event');

  queue.enqueue('A', 1);
  queue.enqueue('B', 4);
  queue.setMode('max');
  assert.equal(queue.peek(), 'B');
  assert.equal(queue.dequeue(), 'B');
  assert.equal(queue.dequeue(), 'A');
});

test('preserves strict FIFO ordering for identical priorities', () => {
  const queue = new AerospaceOrbiterPriorityQueue();

  queue.enqueue('Normal-1', 2);
  queue.enqueue('High-1', 3);
  queue.enqueue('High-2', 3);
  queue.enqueue('High-3', 3);
  queue.enqueue('Normal-2', 2);
  queue.enqueue('High-4', 3);

  assert.equal(queue.dequeue(), 'High-1');
  assert.equal(queue.dequeue(), 'High-2');
  assert.equal(queue.dequeue(), 'High-3');
  assert.equal(queue.dequeue(), 'High-4');
  assert.equal(queue.dequeue(), 'Normal-1');
  assert.equal(queue.dequeue(), 'Normal-2');
  assert.equal(queue.isEmpty(), true);
});

test('tracks backpressure metrics and enforces optional maxCapacity', () => {
  const queue = new AerospaceOrbiterPriorityQueue({
    highWaterMark: 3,
    maxCapacity: 4
  });

  queue.enqueue('Evt 1', 1);
  queue.enqueue('Evt 2', 2);
  let metrics = queue.getMetrics();
  assert.equal(metrics.depth, 2);
  assert.equal(metrics.backpressureActive, false);
  assert.equal(metrics.backpressureLevel, 'elevated');

  queue.enqueue('Evt 3', 3);
  metrics = queue.getMetrics();
  assert.equal(metrics.depth, 3);
  assert.equal(metrics.backpressureActive, true);
  assert.equal(metrics.backpressureLevel, 'critical');

  assert.ok(queue.enqueue('Evt 4', 4));
  const dropped = queue.enqueue('Evt 5 overflow', 4);
  assert.equal(dropped, null);

  metrics = queue.getMetrics();
  assert.equal(metrics.depth, 4);
  assert.equal(metrics.maxDepth, 4);
  assert.equal(metrics.droppedCount, 1);

  queue.clear();
  assert.equal(queue.isEmpty(), true);
  assert.equal(queue.peek(), null);
});

test('startDispatcher paces dequeues according to rateLimitMs and respects stop()', async () => {
  const queue = new AerospaceOrbiterPriorityQueue();

  queue.enqueue('Normal command', 2);
  queue.enqueue('Urgent command', 4);
  queue.enqueue('High command', 3);
  queue.enqueue('Low command', 1);

  const dispatched = [];
  const startedAt = Date.now();
  const rateLimitMs = 35;

  const controller = queue.startDispatcher(rateLimitMs, (item, meta) => {
    dispatched.push({ item, priority: meta.priority, elapsed: Date.now() - startedAt });
  });

  assert.equal(controller.isRunning(), true);

  // Before the first interval fires, queue should not have drained
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(dispatched.length, 0);

  // Wait enough time for 4 paced ticks (~185ms)
  await new Promise((resolve) => setTimeout(resolve, 185));

  controller.stop();
  assert.equal(controller.isRunning(), false);
  assert.equal(queue.isEmpty(), true);

  assert.deepEqual(
    dispatched.map((d) => d.item),
    ['Urgent command', 'High command', 'Normal command', 'Low command']
  );

  // Confirm spacing is rate-controlled rather than instantaneous
  assert.ok(dispatched[dispatched.length - 1].elapsed >= rateLimitMs * 3);
});
