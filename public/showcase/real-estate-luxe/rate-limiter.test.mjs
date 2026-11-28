import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RealEstateLuxeTokenBucketRateLimiter,
  RATE_LIMITER_LIMITS
} from './rate-limiter.js';

function fixture(options = {}) {
  let time = 0;
  const limiter = new RealEstateLuxeTokenBucketRateLimiter({
    clock: () => time,
    ...options
  });
  return {
    limiter,
    now: () => time,
    set: (value) => {
      time = value;
    },
    advance: (ms) => {
      time += ms;
    }
  };
}

const closeTo = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} should equal ${expected}`);
};

// ---------------------------------------------------------------------------
// Construction and validation
// ---------------------------------------------------------------------------

test('constructor - starts full with empty queue, lanes, and counters', () => {
  const { limiter } = fixture();
  assert.equal(limiter.capacity, 10);
  assert.equal(limiter.refillPerSecond, 2);
  assert.equal(limiter.maxConcurrent, 3);
  assert.equal(limiter.maxQueue, 100);
  assert.equal(limiter.getAvailableTokens(), 10);
  assert.deepEqual(limiter.queue, []);
  assert.deepEqual(limiter.active, []);
  assert.deepEqual(limiter.metrics, {
    offered: 0,
    accepted: 0,
    throttled: 0,
    completed: 0,
    cancelled: 0,
    tokensConsumed: 0,
    peakQueue: 0
  });
});

test('constructor - rejects invalid configuration', () => {
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter(null), TypeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ clock: 5 }), TypeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ capacity: 0 }), RangeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ capacity: 1001 }), RangeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ refillPerSecond: 0 }), RangeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ refillPerSecond: Number.NaN }), RangeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ maxConcurrent: 0 }), RangeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ maxConcurrent: 2.5 }), RangeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ maxQueue: 0 }), RangeError);
  assert.throws(() => new RealEstateLuxeTokenBucketRateLimiter({ maxQueue: 101 }), RangeError);
});

test('constructor - works with the default monotonic clock', () => {
  const limiter = new RealEstateLuxeTokenBucketRateLimiter();
  const tokens = limiter.getAvailableTokens();
  assert.ok(Number.isFinite(tokens));
  assert.ok(tokens > 0 && tokens <= limiter.capacity);
});

// ---------------------------------------------------------------------------
// Burst capacity and refill accuracy
// ---------------------------------------------------------------------------

test('tryConsume - initial burst exhausts exactly and never goes negative', () => {
  const { limiter } = fixture();
  for (let index = 0; index < 10; index += 1) {
    assert.equal(limiter.tryConsume(), true);
  }
  assert.equal(limiter.tryConsume(), false);
  assert.equal(limiter.getAvailableTokens(), 0);
  assert.ok(limiter.tokens >= 0);
});

test('tryConsume - rejects zero, negative, non-finite, and over-capacity costs', () => {
  const { limiter } = fixture();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 11]) {
    assert.throws(() => limiter.tryConsume(bad), RangeError);
  }
});

test('refill - replenishes at the configured rate with fractional accuracy', () => {
  const { limiter, set } = fixture({ capacity: 10, refillPerSecond: 2 });
  limiter.tryConsume(10);
  closeTo(limiter.getAvailableTokens(), 0);

  set(125);
  closeTo(limiter.getAvailableTokens(), 0.25);

  set(1000);
  closeTo(limiter.getAvailableTokens(), 2);

  set(2000);
  closeTo(limiter.getAvailableTokens(), 4);
});

test('refill - clamps at capacity no matter how long the interval is', () => {
  const { limiter, set } = fixture({ capacity: 10, refillPerSecond: 2 });
  limiter.tryConsume(10);
  set(60_000);
  assert.equal(limiter.getAvailableTokens(), 10);
  set(120_000);
  assert.equal(limiter.getAvailableTokens(), 10);
});

test('refill - repeated reads at the same instant do not double-count', () => {
  const { limiter, set } = fixture({ capacity: 10, refillPerSecond: 2 });
  limiter.tryConsume(10);
  set(500);
  closeTo(limiter.getAvailableTokens(), 1);
  closeTo(limiter.getAvailableTokens(), 1);
  closeTo(limiter.getAvailableTokens(), 1);
});

test('refill - a backwards clock never removes or invents tokens', () => {
  const { limiter, set } = fixture({ capacity: 10, refillPerSecond: 2 });
  limiter.tryConsume(10);
  set(500);
  closeTo(limiter.getAvailableTokens(), 1);

  set(100);
  closeTo(limiter.getAvailableTokens(), 1);

  set(600);
  closeTo(limiter.getAvailableTokens(), 1.2);
});

test('tryConsume - fractional refill can be spent immediately', () => {
  const { limiter, set } = fixture({ capacity: 10, refillPerSecond: 2 });
  limiter.tryConsume(10);
  set(125);
  assert.equal(limiter.tryConsume(0.25), true);
  closeTo(limiter.getAvailableTokens(), 0);
});

test('nextTokenInMs - reports time to the next whole token', () => {
  const { limiter, advance } = fixture({ capacity: 10, refillPerSecond: 2 });
  assert.equal(limiter.nextTokenInMs, 0);

  limiter.tryConsume(10);
  assert.equal(limiter.nextTokenInMs, 500);

  advance(125);
  limiter.refill();
  assert.equal(limiter.nextTokenInMs, 375);

  advance(375);
  limiter.refill();
  assert.equal(limiter.nextTokenInMs, 0);
  assert.equal(limiter.tryConsume(1), true);

  // After consuming the token, we need another 500ms for the next one
  assert.equal(limiter.nextTokenInMs, 500);
});

test('tryConsume - updates offered, accepted, throttled, and consumed metrics', () => {
  const { limiter } = fixture({ capacity: 2, refillPerSecond: 1 });
  assert.equal(limiter.tryConsume(1), true);
  assert.equal(limiter.tryConsume(1), true);
  assert.equal(limiter.tryConsume(1), false);

  assert.equal(limiter.metrics.offered, 3);
  assert.equal(limiter.metrics.accepted, 2);
  assert.equal(limiter.metrics.throttled, 1);
  assert.equal(limiter.metrics.tokensConsumed, 2);
});

// ---------------------------------------------------------------------------
// Priority queue
// ---------------------------------------------------------------------------

test('enqueue - orders the queue by priority and keeps FIFO within a tier', () => {
  const { limiter } = fixture();
  limiter.enqueue({ id: 'low', priority: 0 });
  limiter.enqueue({ id: 'high', priority: 9 });
  limiter.enqueue({ id: 'medium', priority: 4 });
  limiter.enqueue({ id: 'high-2', priority: 9 });

  assert.deepEqual(limiter.queue.map((job) => job.id), ['high', 'high-2', 'medium', 'low']);
});

test('enqueue - does not spend tokens until the request is admitted', () => {
  const { limiter } = fixture({ capacity: 10 });
  limiter.enqueue({ id: 'queued', tokens: 4 });
  assert.equal(limiter.tokens, 10);
  assert.equal(limiter.queue.length, 1);

  limiter.tick();
  assert.equal(limiter.tokens, 6);
  assert.equal(limiter.queue.length, 0);
  assert.equal(limiter.active.length, 1);
});

test('enqueue - rejects when the queue is full and tracks the peak', () => {
  const { limiter } = fixture({ maxQueue: 2 });
  assert.equal(limiter.enqueue({ id: 'a' }), true);
  assert.equal(limiter.enqueue({ id: 'b' }), true);
  assert.equal(limiter.enqueue({ id: 'c' }), false);

  assert.equal(limiter.metrics.throttled, 1);
  assert.equal(limiter.metrics.peakQueue, 2);
  assert.deepEqual(limiter.queue.map((job) => job.id), ['a', 'b']);
});

test('enqueue - rejects duplicate ids already queued or active', () => {
  const { limiter } = fixture();
  limiter.enqueue({ id: 'dup' });
  assert.throws(() => limiter.enqueue({ id: 'dup' }), RangeError);

  limiter.tick();
  assert.throws(() => limiter.enqueue({ id: 'dup' }), RangeError);

  assert.equal(limiter.enqueue({ id: '  spaced  ' }), true);
  assert.equal(limiter.queue[0].id, 'spaced');
});

test('enqueue - validates id, cost, priority, and duration', () => {
  const { limiter } = fixture();
  assert.throws(() => limiter.enqueue({ id: '' }), TypeError);
  assert.throws(() => limiter.enqueue({ id: 'x'.repeat(65) }), TypeError);
  assert.throws(() => limiter.enqueue({ id: 5 }), TypeError);
  assert.throws(() => limiter.enqueue({ id: 'a', tokens: 0 }), RangeError);
  assert.throws(() => limiter.enqueue({ id: 'a', tokens: 11 }), RangeError);
  assert.throws(() => limiter.enqueue({ id: 'a', priority: 11 }), RangeError);
  assert.throws(() => limiter.enqueue({ id: 'a', priority: 1.5 }), RangeError);
  assert.throws(() => limiter.enqueue({ id: 'a', durationMs: 0 }), RangeError);
  assert.throws(() => limiter.enqueue({ id: 'a', durationMs: 600_001 }), RangeError);
});

// ---------------------------------------------------------------------------
// Tick / concurrency throttler
// ---------------------------------------------------------------------------

test('tick - admits up to maxConcurrent and respects the token balance', () => {
  const { limiter } = fixture({ capacity: 10, maxConcurrent: 2 });
  for (const id of ['a', 'b', 'c', 'd']) limiter.enqueue({ id, durationMs: 100 });

  const first = limiter.tick();
  assert.deepEqual(first.started.map((job) => job.id), ['a', 'b']);
  assert.equal(limiter.active.length, 2);
  assert.equal(limiter.queue.length, 2);
  assert.equal(limiter.tokens, 8);

  const second = limiter.tick();
  assert.deepEqual(second.started, []);
  assert.equal(limiter.active.length, 2);
});

test('tick - retires finished lanes and starts the next requests', () => {
  const { limiter, advance } = fixture({ capacity: 10, maxConcurrent: 2 });
  for (const id of ['a', 'b', 'c', 'd']) limiter.enqueue({ id, durationMs: 100 });
  limiter.tick();

  advance(100);
  const result = limiter.tick();
  assert.deepEqual(result.completed.map((job) => job.id), ['a', 'b']);
  assert.deepEqual(result.started.map((job) => job.id), ['c', 'd']);
  assert.equal(limiter.metrics.completed, 2);
  assert.equal(limiter.active.length, 2);
});

test('tick - skips an unaffordable high-priority request for an affordable one', () => {
  const { limiter } = fixture({ capacity: 5, maxConcurrent: 3 });
  limiter.tryConsume(3);

  limiter.enqueue({ id: 'expensive', tokens: 4, priority: 9 });
  limiter.enqueue({ id: 'cheap', tokens: 1, priority: 1 });

  const result = limiter.tick();
  assert.deepEqual(result.started.map((job) => job.id), ['cheap']);
  assert.deepEqual(limiter.queue.map((job) => job.id), ['expensive']);
  assert.equal(limiter.tokens, 1);
});

test('tick - starts the highest priority request first', () => {
  const { limiter } = fixture({ capacity: 10, maxConcurrent: 1 });
  limiter.enqueue({ id: 'standard', priority: 0 });
  limiter.enqueue({ id: 'vip', priority: 9 });

  const result = limiter.tick();
  assert.deepEqual(result.started.map((job) => job.id), ['vip']);
  assert.deepEqual(limiter.queue.map((job) => job.id), ['standard']);
});

test('tick - records queue wait time on admission', () => {
  const { limiter, set } = fixture({ capacity: 10, maxConcurrent: 1 });
  limiter.enqueue({ id: 'waiting', durationMs: 500 });
  set(500);

  const result = limiter.tick();
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].waitMs, 500);
});

test('tick - with an empty queue is a safe no-op', () => {
  const { limiter, set } = fixture();
  set(5000);
  const result = limiter.tick();
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.completed, []);
  assert.equal(result.tokens, limiter.capacity);
});

test('tick - does not exceed the token balance across many lanes', () => {
  const { limiter } = fixture({ capacity: 4, maxConcurrent: 10 });
  for (const id of ['a', 'b', 'c', 'd', 'e']) limiter.enqueue({ id, tokens: 1 });

  const result = limiter.tick();
  assert.deepEqual(result.started.map((job) => job.id), ['a', 'b', 'c', 'd']);
  assert.equal(limiter.tokens, 0);
  assert.deepEqual(limiter.queue.map((job) => job.id), ['e']);
});

// ---------------------------------------------------------------------------
// Cancel, configure, reset, snapshot
// ---------------------------------------------------------------------------

test('cancel - removes a queued request and counts it', () => {
  const { limiter } = fixture();
  limiter.enqueue({ id: 'a' });
  limiter.enqueue({ id: 'b' });

  assert.equal(limiter.cancel('a'), true);
  assert.deepEqual(limiter.queue.map((job) => job.id), ['b']);
  assert.equal(limiter.metrics.cancelled, 1);
  assert.equal(limiter.cancel('missing'), false);
});

test('cancel - refuses active requests', () => {
  const { limiter } = fixture();
  limiter.enqueue({ id: 'active', durationMs: 1000 });
  limiter.tick();
  assert.equal(limiter.cancel('active'), false);
  assert.equal(limiter.active.length, 1);
});

test('configure - updates capacity, refill, concurrency, and queue limit', () => {
  const { limiter, set } = fixture({ capacity: 10, refillPerSecond: 2 });
  const snapshot = limiter.configure({
    capacity: 5,
    refillPerSecond: 4,
    maxConcurrent: 2,
    maxQueue: 4
  });

  assert.equal(limiter.capacity, 5);
  assert.equal(limiter.refillPerSecond, 4);
  assert.equal(limiter.maxConcurrent, 2);
  assert.equal(limiter.maxQueue, 4);
  assert.equal(limiter.tokens, 5, 'balance clamps to the new capacity');
  assert.equal(snapshot.capacity, 5);

  set(1000);
  closeTo(limiter.getAvailableTokens(), 5);
});

test('configure - raising capacity leaves the balance alone until refill', () => {
  const { limiter } = fixture({ capacity: 5, refillPerSecond: 1 });
  limiter.tryConsume(5);
  limiter.configure({ capacity: 20 });
  assert.equal(limiter.tokens, 0);
  assert.equal(limiter.capacity, 20);
});

test('configure - rejects invalid values without mutating state', () => {
  const { limiter } = fixture({ capacity: 10 });
  for (const bad of [
    { capacity: 0 },
    { capacity: 1001 },
    { refillPerSecond: 0 },
    { maxConcurrent: 0 },
    { maxConcurrent: 21 },
    { maxQueue: 0 },
    { maxQueue: 101 }
  ]) {
    assert.throws(() => limiter.configure(bad), RangeError);
  }
  assert.equal(limiter.capacity, 10);
  assert.equal(limiter.maxConcurrent, 3);
  assert.equal(limiter.maxQueue, 100);
  assert.throws(() => limiter.configure(null), TypeError);
});

test('reset - clears queue, lanes, counters, and refills the reservoir', () => {
  const { limiter } = fixture({ capacity: 10, maxConcurrent: 1 });
  limiter.tryConsume(10);
  limiter.enqueue({ id: 'queued' });
  limiter.tick();
  limiter.enqueue({ id: 'still-queued' });

  limiter.reset();

  assert.equal(limiter.tokens, 10);
  assert.deepEqual(limiter.queue, []);
  assert.deepEqual(limiter.active, []);
  assert.equal(limiter.metrics.offered, 0);
  assert.equal(limiter.metrics.accepted, 0);
  assert.equal(limiter.metrics.completed, 0);
  assert.equal(limiter.enqueue({ id: 'fresh' }), true);
});

test('snapshot - exposes a detached, render-ready view', () => {
  const { limiter, set } = fixture({ capacity: 10, maxConcurrent: 1 });
  limiter.enqueue({ id: 'a', priority: 3, durationMs: 400 });
  limiter.enqueue({ id: 'b', priority: 1, durationMs: 400 });
  limiter.tick();
  set(150);

  const snapshot = limiter.snapshot();
  assert.equal(snapshot.capacity, 10);
  closeTo(snapshot.tokens, 9.3);
  closeTo(snapshot.fillRatio, 0.93);
  assert.equal(snapshot.activeCount, 1);
  assert.equal(snapshot.queueDepth, 1);
  assert.equal(snapshot.active[0].remainingMs, 250);
  assert.equal(snapshot.queue[0].waitedMs, 150);
  assert.equal(typeof snapshot.nextTokenInMs, 'number');
  assert.equal(snapshot.metrics.peakQueue, 2);

  snapshot.queue.push({ id: 'fake' });
  snapshot.active[0].id = 'mutated';
  assert.equal(limiter.queue.length, 1);
  assert.equal(limiter.active[0].id, 'a');
});

test('metrics - track the full request lifecycle', () => {
  const { limiter, advance } = fixture({ capacity: 3, refillPerSecond: 1, maxConcurrent: 1 });
  limiter.tryConsume(3);
  limiter.enqueue({ id: 'queued', durationMs: 100 });
  limiter.enqueue({ id: 'cancelled' });
  limiter.cancel('cancelled');

  advance(1000);
  limiter.tick();
  advance(100);
  limiter.tick();

  assert.equal(limiter.metrics.offered, 3);
  assert.equal(limiter.metrics.accepted, 2);
  assert.equal(limiter.metrics.throttled, 0);
  assert.equal(limiter.metrics.completed, 1);
  assert.equal(limiter.metrics.cancelled, 1);
  assert.equal(limiter.metrics.tokensConsumed, 4);
});

test('limits - exported constants match the guardrails', () => {
  assert.equal(RATE_LIMITER_LIMITS.capacity, 1000);
  assert.equal(RATE_LIMITER_LIMITS.maxConcurrent, 20);
  assert.equal(RATE_LIMITER_LIMITS.maxQueue, 100);
  assert.equal(RATE_LIMITER_LIMITS.priority, 10);
});
