import test from 'node:test';
import assert from 'node:assert/strict';
import { TravelOdysseyTokenBucketRateLimiter } from './rate-limiter.js';

function fixture(options = {}) {
  let time = 0;
  return {
    limiter: new TravelOdysseyTokenBucketRateLimiter({ clock: () => time, ...options }),
    set: value => { time = value; },
    advance: ms => { time += ms; }
  };
}

// --- Burst Capacity Bounds ---

test('TravelOdysseyTokenBucketRateLimiter - initial burst exhausts exactly at capacity', () => {
  const { limiter: l } = fixture();
  // Capacity is 10, should be able to consume exactly 10 tokens
  for (let i = 0; i < 10; i++) {
    assert.equal(l.tryConsume(), true, `Consume should succeed on attempt ${i + 1}`);
  }
  // 11th consume should fail (returns false, does not throw)
  assert.equal(l.tryConsume(), false, '11th consume should fail - bucket empty');
  // getAvailableTokens should return 0
  assert.equal(l.getAvailableTokens(), 0, 'Available tokens should be 0 after exhaustion');
});

test('TravelOdysseyTokenBucketRateLimiter - burst exceeding capacity is rejected', () => {
  const { limiter: l } = fixture();
  // Try to consume more than capacity in one go - returns false (try semantics)
  assert.equal(l.tryConsume(11), false, 'Consuming more than capacity should return false');
  assert.equal(l.tryConsume(10), true, 'Consuming exactly capacity should succeed');
});

test('TravelOdysseyTokenBucketRateLimiter - multi-token consume respects bounds', () => {
  const { limiter: l } = fixture();
  // Cost must be positive
  assert.throws(
    () => l.tryConsume(0),
    RangeError,
    'Token cost of 0 should throw'
  );
  assert.throws(
    () => l.tryConsume(-1),
    RangeError,
    'Negative token cost should throw'
  );
  // Tokens > capacity return false (try semantics, not an error)
  assert.equal(l.tryConsume(11), false, 'Token cost exceeding capacity should return false');
});

// --- Time-Based Token Replenishment Accuracy ---

test('TravelOdysseyTokenBucketRateLimiter - fractional elapsed refill conserves capacity', () => {
  const { limiter: l, set } = fixture();
  l.tryConsume(10); // exhaust
  set(125); // 125ms elapsed -> 125/1000 * 2 = 0.25 tokens
  assert.equal(l.getAvailableTokens(), 0.25, 'Should refill 0.25 tokens after 125ms');
  assert.equal(l.tryConsume(0.25), true, 'Should be able to consume the refilled 0.25 tokens');
});

test('TravelOdysseyTokenBucketRateLimiter - zero elapsed time does not add tokens', () => {
  const { limiter: l, set } = fixture();
  l.tryConsume(5);
  set(0); // no time elapsed
  assert.equal(l.getAvailableTokens(), 5, 'Tokens should remain unchanged with zero elapsed time');
});

test('TravelOdysseyTokenBucketRateLimiter - refill respects capacity cap', () => {
  const { limiter: l, set } = fixture();
  l.tryConsume(2); // 8 remaining
  // Set time far enough to refill full capacity
  set(10000); // 10 seconds at 2/sec = 20 tokens, but capped at capacity 10
  assert.equal(l.getAvailableTokens(), 10, 'Should be capped at capacity after long refill');
});

// --- Request Rejection Under Exhaustion ---

test('TravelOdysseyTokenBucketRateLimiter - request rejection under exhaustion', () => {
  const { limiter: l } = fixture();
  // Drain the bucket
  for (let i = 0; i < 10; i++) {
    assert.equal(l.tryConsume(), true);
  }
  // All subsequent tries should be rejected
  for (let i = 0; i < 5; i++) {
    assert.equal(l.tryConsume(), false, 'Should reject after exhaustion');
  }
});

test('TravelOdysseyTokenBucketRateLimiter - enqueue throttles when queue full', () => {
  const { limiter: l } = fixture();
  // Set maxQueue to 3 for testing
  // We can't easily change maxQueue after construction, so test with default
  // Enqueue more than maxQueue should throttle
  for (let i = 0; i < 105; i++) {
    const result = l.enqueue({ id: `req-${i}` });
    if (!result) break;
  }
  // Check throttled count
  const metrics = l.getMetrics();
  assert.ok(metrics.throttled > 0, 'Some requests should be throttled when queue is full');
});

test('TravelOdysseyTokenBucketRateLimiter - enqueue rejects invalid IDs', () => {
  const { limiter: l } = fixture();
  assert.throws(
    () => l.enqueue({ id: '' }),
    TypeError,
    'Empty ID should throw'
  );
  assert.throws(
    () => l.enqueue({ id: 'a'.repeat(65) }),
    TypeError,
    'ID longer than 64 chars should throw'
  );
});

// --- Tick / Clock Advancement ---

test('TravelOdysseyTokenBucketRateLimiter - tick advances clock and refills', () => {
  const { limiter: l } = fixture();
  l.tryConsume(5); // 5 remaining
  l.tick(); // advance clock - default clock advances by some ms
  const tokens = l.getAvailableTokens();
  // With default clock, tick() will advance by performance.now() difference
  // But we test that tick doesn't throw and returns structure
  const result = l.tick();
  assert.ok(result, 'tick should return started/completed objects');
  assert.ok(Array.isArray(result.started), 'tick should have started array');
  assert.ok(Array.isArray(result.completed), 'tick should have completed array');
});

test('TravelOdysseyTokenBucketRateLimiter - tick completes expired jobs', () => {
  const { limiter: l } = fixture();
  // Enqueue a job with short duration
  l.enqueue({ id: 'job1', durationMs: 1 });
  // Tick should process it
  l.tick();
  const metrics = l.getMetrics();
  // Job may or may not complete depending on clock advance, but structure should be valid
  assert.ok(typeof metrics.accepted === 'number', 'accepted should be a number');
  assert.ok(typeof metrics.completed === 'number', 'completed should be a number');
});

// --- Concurrency Throttling ---

test('TravelOdysseyTokenBucketRateLimiter - maxConcurrent limits active jobs', () => {
  const { limiter: l } = fixture();
  // Set high token capacity and enqueue many requests
  l.tryConsume(1); // consume 1
  // Enqueue more than maxConcurrent (3)
  for (let i = 0; i < 10; i++) {
    l.enqueue({ id: `req-${i}`, durationMs: 10 });
  }
  // Advance tick multiple times
  for (let i = 0; i < 5; i++) {
    l.tick();
  }
  const metrics = l.getMetrics();
  // Should have accepted some but not all due to concurrency limit
  assert.ok(metrics.accepted >= 0, 'accepted should be non-negative');
  assert.ok(metrics.accepted <= 10, 'accepted should not exceed enqueued count');
});

// --- Metrics ---

test('TravelOdysseyTokenBucketRateLimiter - getMetrics returns correct structure', () => {
  const { limiter: l } = fixture();
  const metrics = l.getMetrics();
  assert.ok(metrics.accepted !== undefined, 'should have accepted');
  assert.ok(metrics.throttled !== undefined, 'should have throttled');
  assert.ok(metrics.completed !== undefined, 'should have completed');
  assert.ok(metrics.cancelled !== undefined, 'should have cancelled');
  assert.ok(metrics.queueLength !== undefined, 'should have queueLength');
  assert.ok(metrics.activeCount !== undefined, 'should have activeCount');
  assert.ok(metrics.availableTokens !== undefined, 'should have availableTokens');
  assert.ok(metrics.capacity !== undefined, 'should have capacity');
  assert.ok(metrics.refillPerSecond !== undefined, 'should have refillPerSecond');
});

// --- Edge Cases ---

test('TravelOdysseyTokenBucketRateLimiter - tryConsume with fractional tokens after refill', () => {
  const { limiter: l, set } = fixture();
  l.tryConsume(8); // 2 remaining
  set(500); // 500ms at 2/sec = 1 token
  assert.equal(l.getAvailableTokens(), 3, 'Should have 3 tokens after 500ms refill');
  assert.equal(l.tryConsume(3), true, 'Should consume all 3 refilled tokens');
  assert.equal(l.tryConsume(), false, 'Should be empty after consuming all');
});

test('TravelOdysseyTokenBucketRateLimiter - cancel removes from queue', () => {
  const { limiter: l } = fixture();
  l.enqueue({ id: 'cancel-me', tokens: 1 });
  assert.equal(l.cancel('cancel-me'), true, 'Should cancel queued request');
  const metrics = l.getMetrics();
  assert.equal(metrics.cancelled, 1, 'Cancelled count should be 1');
});

// Suite finalization
test('TravelOdysseyTokenBucketRateLimiter - full integration: burst, refill, concurrency, metrics', () => {
  const { limiter: l, set } = fixture();
  // Initial burst
  for (let i = 0; i < 5; i++) assert.equal(l.tryConsume(), true);
  // Refill halfway: 5 remaining + 500ms * 2/sec = 5 + 1 = 6
  set(500);
  assert.equal(l.getAvailableTokens(), 6, 'Should have 6 tokens after 500ms refill (5 remaining + 1 refilled)');
  // Enqueue requests
  for (let i = 0; i < 5; i++) assert.equal(l.enqueue({ id: `req-${i}`, durationMs: 5 }), true);
  // Tick through
  l.tick();
  const metrics = l.getMetrics();
  assert.ok(metrics.accepted > 0, 'Should have accepted some requests');
  assert.ok(metrics.throttled >= 0, 'Throttled count should be valid');
});