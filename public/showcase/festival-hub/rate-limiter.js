/**
 * FestivalHub Token Bucket Rate Limiter
 * Implements the Token Bucket algorithm with refill rate intervals,
 * burst capacity limits, queue prioritization, and concurrency throttling.
 *
 * Design notes:
 * - Tokens are added to the bucket at a constant refill rate (per second).
 * - The bucket has a maximum capacity; excess tokens are discarded.
 * - tryConsume(tokens) attempts to deduct tokens; returns false if insufficient.
 * - refill() advances the internal clock and replenishes tokens.
 * - getAvailableTokens() returns the current token count (after refill).
 * - enqueue() queues requests when at capacity, with priority ordering.
 * - tick() advances one time step, completes expired jobs, and starts new ones.
 * - All timestamps use a monotonic clock (performance.now() by default).
 */
export class FestivalHubTokenBucketRateLimiter {
  /**
   * @param {Object} options
   * @param {number} [options.capacity=10] - Maximum tokens the bucket can hold. Must be <= 1000.
   * @param {number} [options.refillPerSecond=2] - Tokens added per second. Must be <= 1000.
   * @param {number} [options.maxConcurrent=3] - Maximum simultaneous accepted requests. 1-20.
   * @param {number} [options.maxQueue=100] - Maximum queued requests. 1-100.
   * @param {function} [options.clock=performance.now] - Monotonic clock function.
   */
  constructor({
    capacity = 10,
    refillPerSecond = 2,
    maxConcurrent = 3,
    maxQueue = 100,
    clock = () => performance.now(),
  } = {}) {
    // Validate capacity and refill rate
    for (const [name, value, max] of [
      ['capacity', capacity, 1000],
      ['refillPerSecond', refillPerSecond, 1000],
    ]) {
      if (
        !Number.isFinite(value) ||
        value <= 0 ||
        value > max
      ) {
        throw new RangeError(
          `${name} must be greater than 0 and at most ${max}.`,
        );
      }
    }

    // Validate concurrency and queue limits
    if (
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > 20
    ) {
      throw new RangeError('Concurrency must be an integer from 1 to 20.');
    }
    if (
      !Number.isInteger(maxQueue) ||
      maxQueue < 1 ||
      maxQueue > 100
    ) {
      throw new RangeError('Queue limit must be an integer from 1 to 100.');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('Clock must be a function.');
    }

    // Initialize state
    Object.assign(this, {
      capacity,
      refillPerSecond,
      maxConcurrent,
      maxQueue,
      clock,
    });

    this.lastTime = this.clock();
    this.tokens = capacity; // start bucket full
    this.queue = [];
    this.active = [];
    this.sequence = 0;
    this.metrics = {
      accepted: 0,
      completed: 0,
      throttled: 0,
      cancelled: 0,
    };

    // Public API flags
    this.isRunning = false;
    this.intervalId = null;
  }

  /** Replenish tokens based on elapsed time. */
  refill() {
    const now = this.clock();
    const elapsed = now - this.lastTime;
    if (elapsed <= 0) {
      return this.tokens;
    }
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed * this.refillPerSecond) / 1000,
    );
    this.lastTime = now;
    return this.tokens;
  }

  /**
   * Attempt to consume tokens from the bucket.
   * @param {number} tokens - Number of tokens to consume. Must be > 0 and <= capacity.
   * @returns {boolean} true if tokens were consumed, false if insufficient.
   * @throws {RangeError} if tokens is invalid.
   */
  tryConsume(tokens = 1) {
    if (
      !Number.isFinite(tokens) ||
      tokens <= 0 ||
      tokens > this.capacity
    ) {
      throw new RangeError(
        'Token cost must be positive and no larger than capacity.',
      );
    }
    this.refill();
    if (this.tokens < tokens) {
      return false;
    }
    this.tokens -= tokens;
    return true;
  }

  /** Return the current available tokens after refilling. */
  getAvailableTokens() {
    return this.refill();
  }

  /**
   * Enqueue a request for later processing.
   * @param {Object} options
   * @param {string} options.id - Request identifier (1-64 chars).
   * @param {number} [options.tokens=1] - Token cost for this request.
   * @param {number} [options.priority=0] - Higher priority requests are processed first. Higher number = higher priority.
   * @param {number} [options.durationMs=800] - Estimated processing duration in ms.
   * @returns {boolean} true if enqueued, false if queue is full (throttled).
   * @throws {TypeError} if request ID is invalid.
   */
  enqueue({ id, tokens = 1, priority = 0, durationMs = 800 } = {}) {
    if (
      typeof id !== 'string' ||
      !id.trim() ||
      id.length > 64
    ) {
      throw new TypeError('Request ID must contain 1–64 characters.');
    }
    if (this.queue.length >= this.maxQueue) {
      this.metrics.throttled++;
      return false;
    }
    this.queue.push({
      id,
      tokens,
      priority,
      durationMs,
      order: this.sequence++,
    });
    return true;
  }

  /**
   * Advance one time step: refill tokens, complete expired active jobs,
   * and start new queued jobs up to the concurrency limit.
   * @returns {{ started: Array, completed: Array }} started and completed jobs.
   */
  tick() {
    this.refill();

    const now = this.lastTime;

    // Complete jobs that have ended
    const completed = this.active.filter((job) => job.endsAt <= now);
    this.active = this.active.filter((job) => job.endsAt > now);
    this.metrics.completed += completed.length;

    // Start new jobs from the queue, prioritized by priority then order
    const started = [];
    while (this.queue.length && this.active.length < this.maxConcurrent) {
      const next = this.queue[0];

      // Check if we have enough tokens
      if (this.tokens < next.tokens) {
        break; // Not enough tokens; remaining queue items also won't fit (FIFO)
      }

      // Dequeue and start the job
      this.tokens -= next.tokens;
      this.queue.shift();

      const job = {
        ...next,
        startedAt: now,
        endsAt: now + next.durationMs,
      };
      this.active.push(job);
      started.push({ ...job });
      this.metrics.accepted++;
    }

    return { started, completed: completed.map((job) => ({ ...job })) };
  }

  /** Start the auto-tick loop (for simulator use). */
  startTick(intervalMs = 50) {
    if (this.isRunning) return;
    this.isRunning = true;
    const step = () => {
      if (!this.isRunning) return;
      this.tick();
      this._updateMetricsDisplay();
      this.isRunning = true; // allow re-entry
    };
    this.intervalId = setInterval(step, intervalMs);
    step(); // run immediately
    return this;
  }

  /** Stop the auto-tick loop. */
  stopTick() {
    this.isRunning = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    return this;
  }

  /** Rebuild the metrics display DOM elements. */
  _updateMetricsDisplay() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('metric-tokens');
    if (el) el.textContent = Math.round(this.tokens);
    const el2 = document.getElementById('metric-accepted');
    if (el2) el2.textContent = this.metrics.accepted;
    const el3 = document.getElementById('metric-throttled');
    if (el3) el3.textContent = this.metrics.throttled;
    const el4 = document.getElementById('metric-completed');
    if (el4) el4.textContent = this.metrics.completed;
  }

  /** Dispose of the limiter and clean up. */
  dispose() {
    this.stopTick();
    this.queue = [];
    this.active = [];
    this.metrics = { accepted: 0, completed: 0, throttled: 0, cancelled: 0 };
  }
}