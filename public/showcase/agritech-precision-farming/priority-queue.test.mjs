import test from 'node:test';
import assert from 'node:assert/strict';
import { AgritechPrecisionFarmingPriorityQueue } from './priority-queue.js';

test('AgritechPrecisionFarmingPriorityQueue - heap property preservation (higher priorities dequeued first)', () => {
  const queue = new AgritechPrecisionFarmingPriorityQueue();

  // Enqueue in randomized priority order
  queue.enqueue('Low priority telemetry', 1);
  queue.enqueue('High priority heater', 3);
  queue.enqueue('Normal priority irrigation', 2);
  queue.enqueue('Urgent emergency shutoff', 4);

  assert.equal(queue.size(), 4);
  assert.equal(queue.peek(), 'Urgent emergency shutoff');

  // Dequeue sequence must strictly follow priority 4 -> 3 -> 2 -> 1
  assert.equal(queue.dequeue(), 'Urgent emergency shutoff'); // Priority 4
  assert.equal(queue.dequeue(), 'High priority heater');       // Priority 3
  assert.equal(queue.dequeue(), 'Normal priority irrigation'); // Priority 2
  assert.equal(queue.dequeue(), 'Low priority telemetry');     // Priority 1
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.isEmpty(), true);
});

test('AgritechPrecisionFarmingPriorityQueue - preserves FIFO ordering on identical priorities', () => {
  const queue = new AgritechPrecisionFarmingPriorityQueue();

  // Enqueue 3 items all with identical priority rank (3 / High)
  queue.enqueue('High Task A', 3);
  queue.enqueue('High Task B', 3);
  queue.enqueue('High Task C', 3);

  // Must dequeue in exact FIFO order: A, then B, then C
  assert.equal(queue.dequeue(), 'High Task A');
  assert.equal(queue.dequeue(), 'High Task B');
  assert.equal(queue.dequeue(), 'High Task C');
  assert.equal(queue.isEmpty(), true);
});

test('AgritechPrecisionFarmingPriorityQueue - peek, size, and clear mechanics', () => {
  const queue = new AgritechPrecisionFarmingPriorityQueue();
  assert.equal(queue.peek(), null);
  assert.equal(queue.size(), 0);
  assert.equal(queue.isEmpty(), true);

  queue.enqueue('Sensor Ping', 'normal');
  assert.equal(queue.size(), 1);
  assert.equal(queue.peek(), 'Sensor Ping');
  assert.equal(queue.isEmpty(), false);

  queue.enqueue('Critical Alert', 'urgent');
  assert.equal(queue.size(), 2);
  assert.equal(queue.peek(), 'Critical Alert'); // Higher priority peeked

  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(queue.isEmpty(), true);
  assert.equal(queue.peek(), null);
});

test('AgritechPrecisionFarmingPriorityQueue - rate-limited dispatcher timing', async () => {
  const queue = new AgritechPrecisionFarmingPriorityQueue();
  queue.enqueue('Task 1', 2);
  queue.enqueue('Task 2', 4);
  queue.enqueue('Task 3', 3);

  const processed = [];
  const rateLimitMs = 40;

  const dispatcher = queue.startDispatcher(rateLimitMs, (item) => {
    processed.push(item);
  });

  assert.equal(dispatcher.isRunning(), true);

  // Wait for 3 dispatch intervals (~150ms)
  await new Promise((resolve) => setTimeout(resolve, 160));

  dispatcher.stop();
  assert.equal(dispatcher.isRunning(), false);

  // Priority 4 (Task 2), Priority 3 (Task 3), Priority 2 (Task 1)
  assert.deepEqual(processed, ['Task 2', 'Task 3', 'Task 1']);
  assert.equal(queue.isEmpty(), true);
});
