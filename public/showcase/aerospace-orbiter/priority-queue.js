/**
 * Aerospace Orbiter - Binary Heap Priority Event Queue & Backpressure Dispatcher
 * Implements an in-memory binary max-heap / min-heap with FIFO tie-breaking,
 * token-bucket dispatch pacing, and live backpressure telemetry metrics.
 */

export const PRIORITY_MAP = Object.freeze({
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1
});

export const PRIORITY_LABELS = Object.freeze({
  4: 'Urgent',
  3: 'High',
  2: 'Normal',
  1: 'Low'
});

/**
 * In-memory binary heap priority queue with token-bucket rate-controlled dispatcher
 * and backpressure monitoring for Aerospace Orbiter telemetry events.
 */
export class AerospaceOrbiterPriorityQueue {
  /**
   * @param {object} [options]
   * @param {'max'|'min'} [options.mode='max'] - Binary heap ordering mode
   * @param {number} [options.highWaterMark=20] - Queue depth threshold that activates backpressure
   * @param {number} [options.maxCapacity=Infinity] - Optional hard queue capacity limit
   * @param {number} [options.bucketCapacity=1] - Token bucket maximum capacity
   */
  constructor(options = {}) {
    this.mode = options.mode === 'min' ? 'min' : 'max';
    this.highWaterMark = Math.max(1, Number(options.highWaterMark) || 20);
    this.maxCapacity =
      options.maxCapacity !== undefined && Number.isFinite(Number(options.maxCapacity))
        ? Math.max(1, Number(options.maxCapacity))
        : Infinity;
    this.bucketCapacity = Math.max(1, Number(options.bucketCapacity) || 1);

    this.heap = [];
    this.sequenceCounter = 0;
    this.dispatcherTimer = null;
    this.isDispatching = false;
    this.rateLimitMs = 500;
    this.tokens = 0;

    this.dispatchedCount = 0;
    this.droppedCount = 0;
    this.maxDepth = 0;
    this.listeners = new Set();
  }

  /**
   * Normalizes a string or numeric priority value to a finite number.
   * @param {number|string} priority
   * @returns {number}
   */
  static normalizePriority(priority = 2) {
    if (typeof priority === 'string') {
      const mapped = PRIORITY_MAP[priority.trim().toLowerCase()];
      if (mapped !== undefined) {
        return mapped;
      }
    }

    const numeric = Number(priority);
    return Number.isFinite(numeric) ? numeric : PRIORITY_MAP.normal;
  }

  /**
   * Resolves a numeric priority rank to a human-readable badge label.
   * @param {number|string} priority
   * @returns {string}
   */
  static getPriorityLabel(priority) {
    const rank = AerospaceOrbiterPriorityQueue.normalizePriority(priority);
    return PRIORITY_LABELS[rank] || `P${rank}`;
  }

  /**
   * Enqueues an item into the binary heap.
   * Preserves FIFO ordering when priorities are identical.
   * @param {*} item - Event payload
   * @param {number|string} [priority=2] - Priority rank (4/urgent, 3/high, 2/normal, 1/low)
   * @returns {object|null} Enqueued node metadata, or null if dropped due to maxCapacity
   */
  enqueue(item, priority = PRIORITY_MAP.normal) {
    if (this.heap.length >= this.maxCapacity) {
      this.droppedCount += 1;
      this.#notify('backpressure_drop', {
        item,
        priority: AerospaceOrbiterPriorityQueue.normalizePriority(priority),
        metrics: this.getMetrics()
      });
      return null;
    }

    const numericPriority = AerospaceOrbiterPriorityQueue.normalizePriority(priority);
    const node = {
      id: `orb-evt-${++this.sequenceCounter}`,
      item,
      priority: numericPriority,
      insertOrder: this.sequenceCounter,
      timestamp: Date.now()
    };

    this.heap.push(node);
    this.#bubbleUp(this.heap.length - 1);

    if (this.heap.length > this.maxDepth) {
      this.maxDepth = this.heap.length;
    }

    this.#notify('enqueue', { node, metrics: this.getMetrics() });
    return node;
  }

  /**
   * Removes and returns the highest-priority item (or lowest in min-heap mode).
   * @returns {*} Item payload or null if empty
   */
  dequeue() {
    if (this.heap.length === 0) {
      return null;
    }

    const top = this.heap[0];
    const bottom = this.heap.pop();

    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.#sinkDown(0);
    }

    this.dispatchedCount += 1;
    this.#notify('dequeue', { node: top, metrics: this.getMetrics() });
    return top.item;
  }

  /**
   * Returns the top item without removing it from the heap.
   * @returns {*}
   */
  peek() {
    return this.heap.length > 0 ? this.heap[0].item : null;
  }

  /**
   * Returns the top heap node metadata without removing it.
   * @returns {object|null}
   */
  peekNode() {
    return this.heap.length > 0 ? { ...this.heap[0] } : null;
  }

  /**
   * Current number of queued items.
   * @returns {number}
   */
  size() {
    return this.heap.length;
  }

  /**
   * Checks whether the queue is empty.
   * @returns {boolean}
   */
  isEmpty() {
    return this.heap.length === 0;
  }

  /**
   * Removes all queued items from the heap.
   */
  clear() {
    this.heap = [];
    this.#notify('clear', { metrics: this.getMetrics() });
  }

  /**
   * Switches between binary max-heap and min-heap ordering in O(n) while preserving FIFO sequence IDs.
   * @param {'max'|'min'} mode
   */
  setMode(mode) {
    const nextMode = mode === 'min' ? 'min' : 'max';
    if (this.mode === nextMode) {
      return;
    }

    this.mode = nextMode;
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i -= 1) {
      this.#sinkDown(i);
    }

    this.#notify('mode_change', { mode: this.mode, metrics: this.getMetrics() });
  }

  /**
   * Returns a snapshot of the internal heap nodes.
   * @returns {Array<object>}
   */
  toArray() {
    return this.heap.map((node) => ({ ...node }));
  }

  /**
   * Computes current queue depth, token bucket, and backpressure metrics.
   * @returns {object}
   */
  getMetrics() {
    const depth = this.heap.length;
    const referenceCap = Number.isFinite(this.maxCapacity)
      ? this.maxCapacity
      : this.highWaterMark;
    const saturationRatio = Math.min(1, depth / referenceCap);
    const backpressureActive = depth >= this.highWaterMark;

    const elevatedThreshold = Math.max(1, Math.floor(this.highWaterMark * 0.7));
    let backpressureLevel = 'nominal';
    if (depth >= this.highWaterMark) {
      backpressureLevel = 'critical';
    } else if (depth >= elevatedThreshold) {
      backpressureLevel = 'elevated';
    }

    return {
      depth,
      maxDepth: this.maxDepth,
      highWaterMark: this.highWaterMark,
      maxCapacity: this.maxCapacity,
      dispatchedCount: this.dispatchedCount,
      droppedCount: this.droppedCount,
      saturationRatio,
      backpressureActive,
      backpressureLevel,
      tokens: this.tokens,
      bucketCapacity: this.bucketCapacity,
      isDispatching: this.isDispatching,
      rateLimitMs: this.rateLimitMs,
      mode: this.mode
    };
  }

  /**
   * Starts an asynchronous rate-controlled event dispatcher using token-bucket pacing.
   * @param {number} [rateLimitMs=500] - Interval in milliseconds between token refills / dispatches
   * @param {Function|null} [handler=null] - Callback invoked with (item, nodeMetadata)
   * @param {object} [options]
   * @param {number} [options.bucketCapacity] - Override token bucket capacity
   * @param {number} [options.initialTokens=0] - Starting token count
   * @param {boolean} [options.allowBurst=false] - Whether to drain multiple tokens per tick
   * @returns {{ stop: Function, isRunning: Function, getTokens: Function }}
   */
  startDispatcher(rateLimitMs = 500, handler = null, options = {}) {
    this.stopDispatcher();

    const intervalMs = Math.max(10, Math.round(Number(rateLimitMs) || 500));
    const bucketCap = Math.max(1, Number(options.bucketCapacity ?? this.bucketCapacity) || 1);
    const startTokens = Number.isFinite(Number(options.initialTokens))
      ? Math.min(bucketCap, Math.max(0, Number(options.initialTokens)))
      : 0;
    const allowBurst = Boolean(options.allowBurst);

    this.rateLimitMs = intervalMs;
    this.bucketCapacity = bucketCap;
    this.tokens = startTokens;
    this.isDispatching = true;

    const tick = () => {
      if (!this.isDispatching) {
        return;
      }

      if (this.tokens < this.bucketCapacity) {
        this.tokens = Math.min(this.bucketCapacity, this.tokens + 1);
      }

      const maxDrain = allowBurst ? Math.floor(this.tokens) : 1;
      let drained = 0;

      while (this.heap.length > 0 && this.tokens >= 1 && drained < maxDrain) {
        this.tokens -= 1;
        drained += 1;

        const nodeSnapshot = { ...this.heap[0] };
        const item = this.dequeue();

        if (typeof handler === 'function') {
          try {
            handler(item, nodeSnapshot);
          } catch (error) {
            this.#notify('handler_error', { error, node: nodeSnapshot });
          }
        }
      }

      if (drained === 0) {
        this.#notify('token_refill', { metrics: this.getMetrics() });
      }
    };

    this.dispatcherTimer = setInterval(tick, intervalMs);
    this.#notify('dispatcher_start', { metrics: this.getMetrics() });

    return {
      stop: () => this.stopDispatcher(),
      isRunning: () => this.isDispatching,
      getTokens: () => this.tokens
    };
  }

  /**
   * Stops the active dispatcher loop if running.
   */
  stopDispatcher() {
    if (this.dispatcherTimer !== null) {
      clearInterval(this.dispatcherTimer);
      this.dispatcherTimer = null;
    }

    if (this.isDispatching) {
      this.isDispatching = false;
      this.#notify('dispatcher_stop', { metrics: this.getMetrics() });
    }
  }

  /**
   * Subscribes a listener to queue and dispatcher lifecycle events.
   * @param {Function} listener
   * @returns {Function} Unsubscribe callback
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  #notify(event, detail) {
    for (const listener of this.listeners) {
      try {
        listener(event, detail);
      } catch {
        // Isolate observer errors from queue mechanics
      }
    }
  }

  /**
   * Compares two heap nodes according to heap mode with FIFO tie-breaking.
   * @param {object} a
   * @param {object} b
   * @returns {boolean} True if `a` should sit higher in the heap than `b`
   */
  #hasHigherPrecedence(a, b) {
    if (a.priority !== b.priority) {
      return this.mode === 'min' ? a.priority < b.priority : a.priority > b.priority;
    }
    return a.insertOrder < b.insertOrder;
  }

  #bubbleUp(startIndex) {
    let idx = startIndex;
    const node = this.heap[idx];

    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      const parent = this.heap[parentIdx];

      if (!this.#hasHigherPrecedence(node, parent)) {
        break;
      }

      this.heap[idx] = parent;
      this.heap[parentIdx] = node;
      idx = parentIdx;
    }
  }

  #sinkDown(startIndex) {
    let idx = startIndex;
    const length = this.heap.length;
    const node = this.heap[idx];

    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let swapIdx = null;

      if (leftIdx < length && this.#hasHigherPrecedence(this.heap[leftIdx], node)) {
        swapIdx = leftIdx;
      }

      if (rightIdx < length) {
        const candidate = swapIdx === null ? node : this.heap[swapIdx];
        if (this.#hasHigherPrecedence(this.heap[rightIdx], candidate)) {
          swapIdx = rightIdx;
        }
      }

      if (swapIdx === null) {
        break;
      }

      this.heap[idx] = this.heap[swapIdx];
      this.heap[swapIdx] = node;
      idx = swapIdx;
    }
  }
}
