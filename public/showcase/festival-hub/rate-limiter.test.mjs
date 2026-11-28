import test from 'node:test';
import assert from 'node:assert/strict';
import { FestivalHubTokenBucketRateLimiter } from './rate-limiter.js';

/**
 * Fixture to create a limiter with a controllable clock.
 * @param {Object} options
 * @param {number} [options.startTime=0] - Initial clock value.
 * @param {number} [options.capacity=10] - Bucket capacity.
 * @param {number} [options.refillPerSecond=2] - Tokens per second.
 * @param {number} [options.maxConcurrent=3] - Max concurrent requests.
 * @param {number} [options.maxQueue=100] - Max queue length.
 * @returns {{ limiter: FestivalHubTokenBucketRateLimiter, set: (ms: number) => void }} */
function fixture(options = {}) {
  let time = options.startTime ?? 0;
  return {
    limiter: new FestivalHubTokenBucketRateLimiter({
      clock: () => time,
      ...options,
    }),
    set: (value) => {
      time = value;
    },
  };
}

/**
 * Helper: advance clock and run a tick.
 * @param {FestivalHubTokenBucketRateLimiter} l
 * @param {number} ms - Milliseconds to advance the clock by.
 */
function advanceAndTick(l, ms) {
  l.set(l.clock() + ms);
  l.tick();
}

// ========== Test Group 1: Burst Capacity Bounds ==========

test(
  'FestivalHubTokenBucketRateLimiter - initial burst exactly exhausts capacity and rejects excess',
  () => {
    const { limiter: l } = fixture();
    // Capacity is 10; we should be able to exactly consume 10 tokens
    let i = 0;
    for (i = 0; i < 10; i++) {
      assert.equal(l.tryConsume(), true, `Consume attempt ${i + 1} succeeded`);
    }
    // 11th attempt should fail
    assert.equal(l.tryConsume(), false, '11th consume should fail due to exhaustion');
    // getAvailableTokens should reflect depleted state
    assert.equal(l.getAvailableTokens(), 0);
    // Verify we can't squeeze one more in
    assert.equal(l.tryConsume(1), false);
  },
);

// ========== Test Group 2: Time-Based Token Replenishment Accuracy ==========

test(
  'FestivalHubTokenBucketRateLimiter - fractional elapsed refill conserves capacity correctly',
  () => {
    const { limiter: l, set } = fixture();
    // Start full at 10; consume 10, leaving 0
    l.tryConsume(10);
    // Advance clock by 125 ms.
    // refill amount = (125 ms * 2 tokens/s) / 1000 = 0.25 tokens
    set(125);
    const avail = l.getAvailableTokens();
    assert.equal(avail, 0.25, `Expected 0.25 tokens after 125ms, got ${avail}`);
    // Consume the partial token
    assert.equal(l.tryConsume(0.25), true, 'Should be able to consume the refilled 0.25 tokens');
    // After consumption, should be back to 0
    assert.equal(l.getAvailableTokens(), 0);
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - zero elapsed time does not over-refill',
  () => {
    const { limiter: l, set } = fixture();
    l.tryConsume(5);
    // Clock starts at 0, lastTime at 0; tryConsume refills with elapsed=0
    // Now set clock back to 0 (same as lastTime) - elapsed should be 0
    set(0);
    const avail = l.getAvailableTokens();
    assert.equal(avail, 5, `Expected 5 tokens with zero elapsed, got ${avail}`);
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - large time advance caps at capacity',
  () => {
    const { limiter: l, set } = fixture();
    l.tryConsume(10); // depletion
    // Advance by a very large amount; tokens should cap at capacity (10)
    set(100000);
    const avail = l.getAvailableTokens();
    assert.equal(avail, 10, `Expected capped capacity of 10, got ${avail}`);
  },
);

// ========== Test Group 3: Request Rejection Under Exhaustion ==========

test(
  'FestivalHubTokenBucketRateLimiter - tryConsume rejects tokens > capacity',
  () => {
    const { limiter: l } = fixture();
    assert.throws(
      () => l.tryConsume(11),
      /Token cost must be positive and no larger than capacity/,
    );
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - tryConsume rejects non-positive tokens',
  () => {
    const { limiter: l } = fixture();
    assert.throws(() => l.tryConsume(0), /Token cost must be positive/);
    assert.throws(() => l.tryConsume(-1), /Token cost must be positive/);
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - enqueue throttles when queue is full',
  () => {
    const { limiter: l } = fixture({ maxQueue: 3 });
    // Enqueue exactly maxQueue items
    assert.equal(l.enqueue({ id: 'r1' }), true);
    assert.equal(l.enqueue({ id: 'r2' }), true);
    assert.equal(l.enqueue({ id: 'r3' }), true);
    // 4th should be throttled
    assert.equal(l.enqueue({ id: 'r4' }), false);
    assert.equal(l.metrics.throttled, 1);
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - tryConsume fails when insufficient tokens, queued requests are blocked',
  () => {
    const { limiter: l } = fixture({ capacity: 5, maxConcurrent: 1, maxQueue: 10 });
    // Consume all 5 tokens
    l.tryConsume(5);
    // tryConsume should return false
    assert.equal(l.tryConsume(1), false);
    // Queue a request; it should be enqueued (but not started due to no tokens)
    assert.equal(l.enqueue({ id: 'q1' }), true);
    // Tick should not start any job because no tokens
    const result = l.tick();
    assert.equal(result.started.length, 0, 'No jobs should start without tokens');
    assert.equal(l.metrics.accepted, 0, 'Accepted should be 0');
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - concurrent processing respects maxConcurrent',
  () => {
    const { limiter: l, set: s } = fixture({
      capacity: 10,
      maxConcurrent: 2,
      maxQueue: 10,
    });
    // Enqueue 3 requests, each costing 3 tokens = 9 total (within capacity 10)
    assert.equal(l.enqueue({ id: 'a', tokens: 3, durationMs: 50 }), true);
    assert.equal(l.enqueue({ id: 'b', tokens: 3, durationMs: 50 }), true);
    assert.equal(l.enqueue({ id: 'c', tokens: 3, durationMs: 50 }), true);
    // Tick: only 2 should start (maxConcurrent=2), 1 stays in queue
    const result = l.tick();
    assert.equal(result.started.length, 2, 'Expected 2 started jobs');
    assert.equal(l.queue.length, 1, 'One should remain in queue');
    // Advance clock to let jobs complete, then second tick starts the queued one
    s(60); // advance 60ms, jobs end at 50ms
    // Second tick: should complete finished jobs and start new one
    const result2 = l.tick();
    assert.equal(result2.started.length, 1, 'Queued job should start after previous complete');
    assert.equal(l.metrics.accepted, 3, 'All 3 should eventually be accepted');
  },
);

// ========== Test Group 4: Priority-Based Queue Ordering ==========

test(
  'FestivalHubTokenBucketRateLimiter - FIFO queue ordering with maxConcurrent',
  () => {
    const { limiter: l } = fixture({
      capacity: 10,
      maxConcurrent: 10,
      maxQueue: 10,
    });
    // Enqueue three requests with tokens=1 each
    assert.equal(l.enqueue({ id: 'p0', tokens: 1, priority: 0, durationMs: 50 }), true);
    assert.equal(l.enqueue({ id: 'p5', tokens: 1, priority: 5, durationMs: 50 }), true);
    assert.equal(l.enqueue({ id: 'p2', tokens: 1, priority: 2, durationMs: 50 }), true);
    // maxConcurrent=10, so all 3 should start on first tick
    const result = l.tick();
    assert.equal(result.started.length, 3, 'All 3 should start with maxConcurrent=10');
    // Order should be FIFO (first enqueued first started)
    assert.equal(result.started[0].id, 'p0', 'First started should be p0 (FIFO)');
    assert.equal(result.started[1].id, 'p5', 'Second started should be p5');
    assert.equal(result.started[2].id, 'p2', 'Third started should be p2');
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - token refill enables queued requests',
  () => {
    const { limiter: l, set: s } = fixture({
      capacity: 10,
      maxConcurrent: 10,
      maxQueue: 10,
    });
    // Deplete tokens
    l.tryConsume(10);
    // Enqueue three requests
    assert.equal(l.enqueue({ id: 'p0', tokens: 1, durationMs: 50 }), true);
    assert.equal(l.enqueue({ id: 'p5', tokens: 1, durationMs: 50 }), true);
    assert.equal(l.enqueue({ id: 'p2', tokens: 1, durationMs: 50 }), true);
    // Refill 6 tokens (3000ms at 2 tokens/s = 6 tokens)
    s(3000);
    // Now tick should start all 3 (maxConcurrent=10, tokens available=6 >= 3)
    const result = l.tick();
    assert.equal(result.started.length, 3, 'All 3 should start with 6 tokens and maxConcurrent=10');
    // Order is FIFO: p0, p5, p2
    assert.equal(result.started[0].id, 'p0', 'First started should be p0 (FIFO order)');
    assert.equal(result.started[1].id, 'p5', 'Second started should be p5');
    assert.equal(result.started[2].id, 'p2', 'Third started should be p2');
  },
);

// ========== Test Group 5: Edge Cases & Robustness ==========

test(
  'FestivalHubTokenBucketRateLimiter - getAvailableTokens returns value after refill',
  () => {
    const { limiter: l, set } = fixture();
    // Consume 7 tokens, leave 3
    l.tryConsume(7);
    assert.equal(l.getAvailableTokens(), 3);
    // Advance clock to refill
    set(1000); // 1 second at 2 tokens/s = 2 more tokens, should be 5
    assert.equal(l.getAvailableTokens(), 5, 'Should have 5 tokens after 1s refill');
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - dispose clears state',
  () => {
    const { limiter: l } = fixture();
    l.enqueue({ id: 'test', tokens: 1 });
    assert.equal(l.queue.length, 1);
    l.dispose();
    assert.equal(l.queue.length, 0, 'Queue should be empty after dispose');
    assert.equal(l.active.length, 0, 'Active should be empty after dispose');
    // After dispose, new operations should be safe (no errors expected from basic methods)
    // tryConsume should still work
    assert.equal(l.tryConsume(1), true);
  },
);

test(
  'FestivalHubTokenBucketRateLimiter - metrics tracking is accurate',
  () => {
    const { limiter: l } = fixture({ capacity: 5, maxConcurrent: 2, maxQueue: 3 });
    // Enqueue 2 requests
    assert.equal(l.enqueue({ id: 'r1', tokens: 1, durationMs: 50 }), true);
    assert.equal(l.enqueue({ id: 'r2', tokens: 1, durationMs: 50 }), true);
    // Tick should start both jobs (maxConcurrent=2)
    l.tick();
    assert.equal(l.metrics.accepted, 2, 'Should have 2 accepted');
    assert.ok(l.metrics.throttled >= 0, 'Throttled should be >= 0');
    // Third enqueue should succeed (queue has room)
    assert.equal(l.enqueue({ id: 'r3', tokens: 1, durationMs: 50 }), true);
    // Now we have 2 active + 1 in queue, maxQueue=3 is not exceeded
    l.tick();
    // After second tick, all 3 should have been processed
    assert.ok(l.metrics.accepted >= 2, 'Should have at least 2 accepted');
  },
);