import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefiYieldMatrixPriorityQueue } from './priority-queue.js';

test('DefiYieldMatrixPriorityQueue - preserves min-heap property on enqueue', () => {
  const queue = new DefiYieldMatrixPriorityQueue();
  queue.enqueue('low', 8);
  queue.enqueue('high', 2);
  queue.enqueue('medium', 4);
  queue.enqueue('urgent', 1);
  queue.enqueue('lowest', 9);

  assert.strictEqual(queue.dequeue(), 'urgent');
  assert.strictEqual(queue.dequeue(), 'high');
  assert.strictEqual(queue.dequeue(), 'medium');
  assert.strictEqual(queue.dequeue(), 'low');
  assert.strictEqual(queue.dequeue(), 'lowest');
});

test('DefiYieldMatrixPriorityQueue - FIFO ordering on identical priorities', () => {
  const queue = new DefiYieldMatrixPriorityQueue();
  queue.enqueue('first', 3);
  queue.enqueue('second', 3);
  queue.enqueue('third', 3);

  assert.strictEqual(queue.dequeue(), 'first');
  assert.strictEqual(queue.dequeue(), 'second');
  assert.strictEqual(queue.dequeue(), 'third');
});

test('DefiYieldMatrixPriorityQueue - peek returns highest priority without removal', () => {
  const queue = new DefiYieldMatrixPriorityQueue();
  queue.enqueue('first', 5);
  queue.enqueue('second', 1);
  queue.enqueue('third', 3);

  assert.strictEqual(queue.peek(), 'second');
  assert.strictEqual(queue.dequeue(), 'second');
  assert.strictEqual(queue.dequeue(), 'third');
  assert.strictEqual(queue.dequeue(), 'first');
});

test('DefiYieldMatrixPriorityQueue - empty queue returns null from dequeue and peek', () => {
  const queue = new DefiYieldMatrixPriorityQueue();

  assert.strictEqual(queue.dequeue(), null);
  assert.strictEqual(queue.peek(), null);
});

test('DefiYieldMatrixPriorityQueue - depth tracks current size', () => {
  const queue = new DefiYieldMatrixPriorityQueue();

  assert.strictEqual(queue.depth, 0);

  queue.enqueue('a', 1);
  assert.strictEqual(queue.depth, 1);

  queue.enqueue('b', 2);
  assert.strictEqual(queue.depth, 2);

  queue.dequeue();
  assert.strictEqual(queue.depth, 1);
});

test('DefiYieldMatrixPriorityQueue - dispatcher respects rateLimitMs', async () => {
  const queue = new DefiYieldMatrixPriorityQueue();
  const events = [];
  const handler = (item) => events.push(item);
  const dispatcher = queue.startDispatcher(10, handler);

  dispatcher.enqueue('event1', 1);
  dispatcher.enqueue('event2', 2);

  await new Promise(resolve => setTimeout(resolve, 50));

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0], 'event1');
  assert.strictEqual(events[1], 'event2');

  dispatcher.stop();
});

test('DefiYieldMatrixPriorityQueue - dispatcher backpressure queues items', async () => {
  const queue = new DefiYieldMatrixPriorityQueue();
  const events = [];
  const handler = (item) => events.push(item);
  const dispatcher = queue.startDispatcher(20, handler);

  dispatcher.enqueue('urgent', 0);
  dispatcher.enqueue('high', 2);
  dispatcher.enqueue('low', 5);

  await new Promise(resolve => setTimeout(resolve, 100));

  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0], 'urgent');
  assert.strictEqual(events[1], 'high');
  assert.strictEqual(events[2], 'low');

  dispatcher.stop();
});