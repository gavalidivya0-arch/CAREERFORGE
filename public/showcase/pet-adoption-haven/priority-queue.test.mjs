import test from 'node:test';
import assert from 'node:assert/strict';
import { PetAdoptionHavenPriorityQueue } from './priority-queue.js';

test('PetAdoptionHavenPriorityQueue - heap property preservation (higher priorities dequeued first)', () => {
  const queue = new PetAdoptionHavenPriorityQueue();

  // Enqueue in randomized priority order
  queue.enqueue('Low priority photo update', 1);
  queue.enqueue('High priority foster match', 3);
  queue.enqueue('Normal priority rabies vaccine', 2);
  queue.enqueue('Urgent emergency medical triage', 4);

  assert.equal(queue.size(), 4);
  assert.equal(queue.peek(), 'Urgent emergency medical triage');

  // Dequeue sequence must strictly follow priority 4 -> 3 -> 2 -> 1
  assert.equal(queue.dequeue(), 'Urgent emergency medical triage'); // Priority 4
  assert.equal(queue.dequeue(), 'High priority foster match');       // Priority 3
  assert.equal(queue.dequeue(), 'Normal priority rabies vaccine');   // Priority 2
  assert.equal(queue.dequeue(), 'Low priority photo update');        // Priority 1
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.isEmpty(), true);
});

test('PetAdoptionHavenPriorityQueue - preserves FIFO ordering on identical priorities', () => {
  const queue = new PetAdoptionHavenPriorityQueue();

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

test('PetAdoptionHavenPriorityQueue - peek, size, and clear mechanics', () => {
  const queue = new PetAdoptionHavenPriorityQueue();
  assert.equal(queue.peek(), null);
  assert.equal(queue.size(), 0);
  assert.equal(queue.isEmpty(), true);

  queue.enqueue('Daily Feeding', 'normal');
  assert.equal(queue.size(), 1);
  assert.equal(queue.peek(), 'Daily Feeding');
  assert.equal(queue.isEmpty(), false);

  queue.enqueue('Critical Intake', 'urgent');
  assert.equal(queue.size(), 2);
  assert.equal(queue.peek(), 'Critical Intake'); // Higher priority peeked

  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(queue.isEmpty(), true);
  assert.equal(queue.peek(), null);
});

test('PetAdoptionHavenPriorityQueue - rate-limited dispatcher timing', async () => {
  const queue = new PetAdoptionHavenPriorityQueue();
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
