export class TravelOdysseyTokenBucketRateLimiter {
  constructor({ capacity = 10, refillPerSecond = 2, maxConcurrent = 3, maxQueue = 100, clock = () => performance.now() } = {}) {
    // Validate capacity and refill rate
    for (const [name, value, max] of [['capacity', capacity, 1000], ['refillPerSecond', refillPerSecond, 1000]]) {
      if (!Number.isFinite(value) || value <= 0 || value > max) throw new RangeError(`${name} must be greater than 0 and at most ${max}.`);
    }
    // Validate concurrency
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 20) throw new RangeError('Concurrency must be 1–20.');
    // Validate queue limit
    if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 100) throw new RangeError('Queue limit must be 1–100.');
    // Validate clock
    if (typeof clock !== 'function') throw new TypeError('Clock must be a function.');

    Object.assign(this, { capacity, refillPerSecond, maxConcurrent, maxQueue, clock });
    this.lastTime = clock();
    this.tokens = capacity;
    this.queue = [];
    this.active = [];
    this.sequence = 0;
    this.metrics = { accepted: 0, completed: 0, throttled: 0, cancelled: 0 };
  }

  /** Replenish tokens based on elapsed time (Token Bucket algorithm) */
  refill() {
    const time = this.clock();
    const now = Math.max(time, this.lastTime);
    const elapsedSeconds = (now - this.lastTime) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastTime = now;
    return this.tokens;
  }

  /** Try to consume tokens from the bucket. Returns true if successful, false if insufficient tokens. */
  tryConsume(tokens = 1) {
    if (!Number.isFinite(tokens) || tokens <= 0) throw new RangeError('Token cost must be positive.');
    if (tokens > this.capacity) return false; // can't consume more than capacity
    this.refill();
    if (this.tokens < tokens) return false;
    this.tokens -= tokens;
    return true;
  }

  /** Get the current number of available (unconsumed) tokens */
  getAvailableTokens() {
    return this.refill();
  }

  /** Enqueue a request with priority, token cost, and duration */
  enqueue({ id, tokens = 1, priority = 0, durationMs = 800 } = {}) {
    if (typeof id !== 'string' || !id.trim() || id.length > 64) throw new TypeError('Request ID must contain 1–64 characters.');
    if (this.queue.length >= this.maxQueue) { this.metrics.throttled++; return false; }
    this.queue.push({ id, tokens, priority, durationMs, order: this.sequence++ });
    return true;
  }

  /** Advance the internal clock, refill tokens, complete expired jobs, and start new queued jobs */
  tick() {
    this.refill();
    const now = this.lastTime;

    // Complete jobs that have ended
    const completed = this.active.filter(job => job.endsAt <= now);
    this.active = this.active.filter(job => job.endsAt > now);
    this.metrics.completed += completed.length;

    // Start new jobs from the queue (prioritized, up to maxConcurrent)
    const started = [];
    while (this.queue.length && this.active.length < this.maxConcurrent) {
      const next = this.queue[0];
      // Check if we have enough tokens for this job
      if (this.tokens < next.tokens) break;

      // Start the job
      this.tokens -= next.tokens;
      this.queue.shift();
      const job = { ...next, startedAt: now, endsAt: now + next.durationMs };
      this.active.push(job);
      started.push({ ...job });
      this.metrics.accepted++;
    }

    return { started, completed: completed.map(job => ({ ...job })) };
  }

  /** Cancel a queued or active request by ID. Returns true if cancelled. */
  cancel(id) {
    // Cancel from queue
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].id === id) {
        this.queue.splice(i, 1);
        this.metrics.cancelled++;
        return true;
      }
    }
    // Cancel from active (completed jobs cannot be cancelled)
    for (let i = 0; i < this.active.length; i++) {
      if (this.active[i].id === id) {
        // Mark as cancelled by removing from active
        this.active.splice(i, 1);
        this.metrics.cancelled++;
        return true;
      }
    }
    return false;
  }

  /** Get current metrics summary */
  getMetrics() {
    return {
      accepted: this.metrics.accepted,
      completed: this.metrics.completed,
      throttled: this.metrics.throttled,
      cancelled: this.metrics.cancelled,
      queueLength: this.queue.length,
      activeCount: this.active.length,
      availableTokens: this.getAvailableTokens(),
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
    };
  }
}