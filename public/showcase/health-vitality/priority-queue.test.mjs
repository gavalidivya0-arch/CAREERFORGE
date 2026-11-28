import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthVitalityPriorityQueue, PRIORITY_MAP } from './priority-queue.js';

function verifyMaxHeapInvariant(heap) {
  for (let i = 0; i < heap.length; i++) {
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    if (left < heap.length) {
      const valid =
        heap[i].priority > heap[left].priority ||
        (heap[i].priority === heap[left].priority && heap[i].insertOrder < heap[left].insertOrder);
      assert.equal(valid, true, `Heap invariant violated at parent ${i} -> left ${left}`);
    }
    if (right < heap.length) {
      const valid =
        heap[i].priority > heap[right].priority ||
        (heap[i].priority === heap[right].priority && heap[i].insertOrder < heap[right].insertOrder);
      assert.equal(valid, true, `Heap invariant violated at parent ${i} -> right ${right}`);
    }
  }
}

test('HealthVitalityPriorityQueue - preserves binary max-heap property across mixed priority insertions', () => {
  const queue = new HealthVitalityPriorityQueue();

  queue.enqueue('Wearable Sleep Log', PRIORITY_MAP.low);
  queue.enqueue('SpO2 Desaturation Warning', PRIORITY_MAP.high);
  queue.enqueue('Glucose Panel Poll', PRIORITY_MAP.normal);
  queue.enqueue('Cardiac Telemetry Code Blue', PRIORITY_MAP.urgent);
  queue.enqueue('Infusion Pump Occlusion', 4);
  queue.enqueue('Hydration Reminder', 1);
  queue.enqueue('Blood Pressure Spike', 3);

  verifyMaxHeapInvariant(queue.getHeapSnapshot());
  assert.equal(queue.size(), 7);
  assert.equal(queue.peek(), 'Cardiac Telemetry Code Blue');

  const drained = [];
  while (!queue.isEmpty()) {
    drained.push(queue.dequeue());
    verifyMaxHeapInvariant(queue.getHeapSnapshot());
  }

  assert.deepEqual(drained, [
    'Cardiac Telemetry Code Blue',
    'Infusion Pump Occlusion',
    'SpO2 Desaturation Warning',
    'Blood Pressure Spike',
    'Glucose Panel Poll',
    'Wearable Sleep Log',
    'Hydration Reminder',
  ]);
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.peek(), null);
});

test('HealthVitalityPriorityQueue - supports min-heap mode when configured', () => {
  const queue = new HealthVitalityPriorityQueue({ mode: 'min' });
  queue.enqueue('P3', 3);
  queue.enqueue('P1', 1);
  queue.enqueue('P4', 4);
  queue.enqueue('P2', 2);

  assert.equal(queue.peek(), 'P1');
  assert.deepEqual(
    [queue.dequeue(), queue.dequeue(), queue.dequeue(), queue.dequeue()],
    ['P1', 'P2', 'P3', 'P4']
  );
});

test('HealthVitalityPriorityQueue - preserves strict FIFO ordering on identical priorities', () => {
  const queue = new HealthVitalityPriorityQueue();

  queue.enqueue('High-1', 'high');
  queue.enqueue('Urgent-1', 'urgent');
  queue.enqueue('High-2', 3);
  queue.enqueue('High-3', 'HIGH');
  queue.enqueue('Normal-1', 'normal');
  queue.enqueue('High-4', 3);

  assert.equal(queue.dequeue(), 'Urgent-1');
  assert.equal(queue.dequeue(), 'High-1');
  assert.equal(queue.dequeue(), 'High-2');
  assert.equal(queue.dequeue(), 'High-3');
  assert.equal(queue.dequeue(), 'High-4');
  assert.equal(queue.dequeue(), 'Normal-1');
  assert.equal(queue.isEmpty(), true);
});

test('HealthVitalityPriorityQueue - tracks backpressure metrics and optional capacity shedding', () => {
  let now = 1000;
  const queue = new HealthVitalityPriorityQueue({
    maxCapacity: 4,
    enforceCapacity: true,
    highWatermarkRatio: 0.75,
    clock: () => now,
  });

  queue.enqueue('Event 1', 1);
  queue.enqueue('Event 2', 2);
  let metrics = queue.getMetrics();
  assert.equal(metrics.depth, 2);
  assert.equal(metrics.isBackpressured, false);

  queue.enqueue('Event 3', 3);
  metrics = queue.getMetrics();
  assert.equal(metrics.depth, 3);
  assert.equal(metrics.isBackpressured, true);

  queue.enqueue('Event 4', 4);
  const dropped = queue.enqueue('Event 5 Overflow', 2);
  assert.equal(dropped, null);

  metrics = queue.getMetrics();
  assert.equal(metrics.enqueuedCount, 4);
  assert.equal(metrics.droppedCount, 1);
  assert.equal(metrics.maxDepthObserved, 4);

  now = 1125;
  assert.equal(queue.dequeue(), 'Event 4');
  metrics = queue.getMetrics();
  assert.equal(metrics.dispatchedCount, 1);
  assert.equal(metrics.lastWaitTimeMs, 125);
  assert.equal(metrics.avgWaitTimeMs, 125);

  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(queue.peek(), null);
});

test('HealthVitalityPriorityQueue - rate-limited dequeue timing via startDispatcher', async () => {
  const queue = new HealthVitalityPriorityQueue();
  queue.enqueue('Normal Telemetry', 2);
  queue.enqueue('Urgent Arrhythmia', 4);
  queue.enqueue('High SpO2 Alert', 3);

  const dispatched = [];
  const timestamps = [];
  const rateLimitMs = 45;
  const startedAt = Date.now();

  const controller = queue.startDispatcher(rateLimitMs, (item, meta) => {
    dispatched.push(item);
    timestamps.push(Date.now() - startedAt);
    assert.ok(meta.priority >= 2 && meta.priority <= 4);
  });

  assert.equal(controller.isRunning(), true);

  // After 30ms (< rateLimitMs), no items should have been dispatched yet
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(dispatched.length, 0);

  // Wait enough intervals for all 3 items to drain (~3 * 45ms = 135ms + timer margin)
  await new Promise((resolve) => setTimeout(resolve, 175));
  controller.stop();
  assert.equal(controller.isRunning(), false);

  assert.deepEqual(dispatched, [
    'Urgent Arrhythmia',
    'High SpO2 Alert',
    'Normal Telemetry',
  ]);
  assert.equal(queue.isEmpty(), true);
  assert.ok(timestamps[2] >= 100, `Expected paced completion >= 100ms, got ${timestamps[2]}ms`);
});
