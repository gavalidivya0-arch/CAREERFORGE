import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartIotNexusPriorityQueue } from './priority-queue.js';

test('SmartIotNexusPriorityQueue - preserves min-heap property on enqueue', () => {
  const pq = new SmartIotNexusPriorityQueue();

  pq.enqueue('item-A', 3);
  pq.enqueue('item-B', 1);
  pq.enqueue('item-C', 4);
  pq.enqueue('item-D', 1);
  pq.enqueue('item-E', 2);

  assert.strictEqual(pq.getQueueDepth(), 5);

  const top = pq.peek();
  assert.strictEqual(top, 'item-B');

  pq.dequeue();
  const newTop = pq.peek();
  assert.strictEqual(newTop, 'item-D');

  pq.dequeue();
  const third = pq.peek();
  assert.strictEqual(third, 'item-E');
});

test('SmartIotNexusPriorityQueue - FIFO ordering on identical priorities', () => {
  const pq = new SmartIotNexusPriorityQueue();

  pq.enqueue('first', 2);
  pq.enqueue('second', 2);
  pq.enqueue('third', 2);

  const firstOut = pq.dequeue();
  assert.strictEqual(firstOut, 'first');

  const secondOut = pq.dequeue();
  assert.strictEqual(secondOut, 'second');

  const thirdOut = pq.dequeue();
  assert.strictEqual(thirdOut, 'third');
});

test('SmartIotNexusPriorityQueue - dequeue returns null on empty queue', () => {
  const pq = new SmartIotNexusPriorityQueue();
  assert.strictEqual(pq.dequeue(), null);
  assert.strictEqual(pq.peek(), null);
});

test('SmartIotNexusPriorityQueue - startDispatcher respects rate limit', async () => {
  const pq = new SmartIotNexusPriorityQueue();
  const calls = [];

  pq.enqueue('fast', 1);
  pq.enqueue('slow', 2);

  const dispatch = pq.startDispatcher(20, (item) => {
    calls.push(item);
    return Promise.resolve(item);
  });

  await dispatch();
  await dispatch();

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0], 'fast');
  assert.strictEqual(calls[1], 'slow');
});

test('SmartIotNexusPriorityQueue - startDispatcher rate-limits excess calls', async () => {
  const pq = new SmartIotNexusPriorityQueue();

  pq.enqueue('item', 1);

  const dispatch = pq.startDispatcher(50, (item) => {
    return Promise.resolve(item);
  });

  await dispatch();
  await dispatch();

  const remaining = pq.dequeue();
  assert.strictEqual(remaining, null);
});

test('SmartIotNexusPriorityQueue - startDispatcher passes items to handler', async () => {
  const pq = new SmartIotNexusPriorityQueue();
  const handled = [];

  pq.enqueue('test-payload', 1);

  const dispatch = pq.startDispatcher(10, (item) => {
    handled.push(item);
    return Promise.resolve();
  });

  await dispatch();
  assert.strictEqual(handled.length, 1);
  assert.strictEqual(handled[0], 'test-payload');
});

test('SmartIotNexusPriorityQueue - backpressure metrics', () => {
  const pq = new SmartIotNexusPriorityQueue();

  assert.strictEqual(pq.getQueueDepth(), 0);
  assert.strictEqual(pq.getMetrics().queueDepth, 0);

  pq.enqueue('a', 1);
  pq.enqueue('b', 2);

  assert.strictEqual(pq.getQueueDepth(), 2);
  assert.strictEqual(pq.getMetrics().queueDepth, 2);
});