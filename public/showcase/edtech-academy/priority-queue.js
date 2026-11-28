/**
 * Edtech Academy (Synapse Academy) — Binary Heap Priority Event Queue & Backpressure Dispatcher
 *
 * Implements:
 *  - Binary max-heap / min-heap with strict FIFO tie-breaking on identical priorities
 *  - Token-bucket dispatch pacing for asynchronous rate-controlled event delivery
 *  - Backpressure capacity guardrails, watermark status, and live queue metrics
 *  - Interactive browser controller (mounted only when DOM elements are present)
 */

export const PRIORITY_RANKS = Object.freeze({
  URGENT: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1
});

const MAX_MODE_LABELS = Object.freeze({
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1
});

const MIN_MODE_LABELS = Object.freeze({
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4
});

/**
 * Resolve a numeric or semantic priority rank into a finite numeric value and badge label.
 * @param {number|string} priority
 * @param {'max'|'min'} [mode='max']
 * @returns {{ value: number, label: 'Urgent'|'High'|'Normal'|'Low' }}
 */
export function resolvePriority(priority, mode = 'max') {
  if (mode !== 'max' && mode !== 'min') {
    throw new RangeError(`Invalid heap mode "${mode}". Expected "max" or "min".`);
  }

  if (typeof priority === 'string') {
    const normalized = priority.trim().toLowerCase();
    const lookup = mode === 'min' ? MIN_MODE_LABELS : MAX_MODE_LABELS;
    if (Object.prototype.hasOwnProperty.call(lookup, normalized)) {
      const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      return { value: lookup[normalized], label };
    }
    throw new TypeError(
      `Unknown priority rank "${priority}". Expected Urgent, High, Normal, Low, or a finite number.`
    );
  }

  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new TypeError('Priority must be a finite number or one of Urgent, High, Normal, Low.');
  }

  let label = 'Normal';
  if (mode === 'min') {
    if (priority <= 1) label = 'Urgent';
    else if (priority <= 2) label = 'High';
    else if (priority <= 3) label = 'Normal';
    else label = 'Low';
  } else {
    if (priority >= 4) label = 'Urgent';
    else if (priority >= 3) label = 'High';
    else if (priority >= 2) label = 'Normal';
    else label = 'Low';
  }

  return { value: priority, label };
}

export class EdtechAcademyPriorityQueue {
  /**
   * @param {Object} [options]
   * @param {'max'|'min'} [options.mode='max'] Heap ordering ('max' = higher number first, 'min' = lower number first)
   * @param {number} [options.maxCapacity=Infinity] Hard capacity bound before backpressure rejects new items
   * @param {number} [options.highWatermark=0.75] Utilization ratio in (0, 1] marking elevated backpressure
   * @param {number} [options.bucketCapacity=1] Token-bucket capacity (>= 1)
   * @param {number} [options.initialTokens] Initial tokens in bucket (defaults to Math.min(1, bucketCapacity))
   * @param {() => number} [options.now] Clock source returning milliseconds
   */
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('Queue options must be an object.');
    }

    const {
      mode = 'max',
      maxCapacity = Infinity,
      highWatermark = 0.75,
      bucketCapacity = 1,
      initialTokens,
      now = () => Date.now()
    } = options;

    if (mode !== 'max' && mode !== 'min') {
      throw new RangeError(`Invalid heap mode "${mode}". Expected "max" or "min".`);
    }
    if (maxCapacity !== Infinity && (!Number.isInteger(maxCapacity) || maxCapacity < 1)) {
      throw new RangeError('maxCapacity must be a positive integer or Infinity.');
    }
    if (
      typeof highWatermark !== 'number' ||
      !Number.isFinite(highWatermark) ||
      highWatermark <= 0 ||
      highWatermark > 1
    ) {
      throw new RangeError('highWatermark must be a finite number in (0, 1].');
    }
    if (typeof bucketCapacity !== 'number' || !Number.isFinite(bucketCapacity) || bucketCapacity < 1) {
      throw new RangeError('bucketCapacity must be a finite number >= 1.');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function returning milliseconds.');
    }

    const startTokens = initialTokens === undefined ? Math.min(1, bucketCapacity) : initialTokens;
    if (
      typeof startTokens !== 'number' ||
      !Number.isFinite(startTokens) ||
      startTokens < 0 ||
      startTokens > bucketCapacity
    ) {
      throw new RangeError('initialTokens must be a finite number between 0 and bucketCapacity.');
    }

    this.mode = mode;
    this.maxCapacity = maxCapacity;
    this.highWatermark = highWatermark;
    this.bucketCapacity = bucketCapacity;
    this._now = now;

    this._heap = [];
    this._seq = 0;

    this._tokens = startTokens;
    this._rateLimitMs = 250;
    this._lastRefillAt = this._now();
    this._lastDispatchAt = null;
    this._handler = null;
    this._running = false;
    this._paused = false;
    this._dispatchLoopActive = false;
    this._timer = null;

    this._listeners = new Set();
    this.metrics = {
      totalEnqueued: 0,
      totalDequeued: 0,
      totalDispatched: 0,
      totalDropped: 0,
      failedDispatches: 0,
      backpressureEvents: 0,
      peakDepth: 0,
      totalWaitTimeMs: 0,
      lastWaitTimeMs: 0
    };
  }

  get depth() {
    return this._heap.length;
  }

  size() {
    return this._heap.length;
  }

  isEmpty() {
    return this._heap.length === 0;
  }

  _hasHigherPrecedence(a, b) {
    if (a.priority !== b.priority) {
      return this.mode === 'max' ? a.priority > b.priority : a.priority < b.priority;
    }
    return a.sequence < b.sequence;
  }

  _siftUp(index) {
    let cursor = index;
    const target = this._heap[cursor];
    while (cursor > 0) {
      const parentIdx = (cursor - 1) >> 1;
      const parent = this._heap[parentIdx];
      if (!this._hasHigherPrecedence(target, parent)) break;
      this._heap[cursor] = parent;
      cursor = parentIdx;
    }
    this._heap[cursor] = target;
  }

  _siftDown(index) {
    let cursor = index;
    const length = this._heap.length;
    const target = this._heap[cursor];

    while (true) {
      const leftIdx = (cursor << 1) + 1;
      if (leftIdx >= length) break;

      const rightIdx = leftIdx + 1;
      let bestIdx = leftIdx;
      if (rightIdx < length && this._hasHigherPrecedence(this._heap[rightIdx], this._heap[leftIdx])) {
        bestIdx = rightIdx;
      }

      if (!this._hasHigherPrecedence(this._heap[bestIdx], target)) break;
      this._heap[cursor] = this._heap[bestIdx];
      cursor = bestIdx;
    }

    this._heap[cursor] = target;
  }

  _notify(eventType, detail) {
    for (const listener of this._listeners) {
      listener(eventType, detail);
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Subscriber must be a function.');
    }
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Enqueue a task/event payload with a priority rank.
   * Preserves FIFO order for identical priorities and enforces maxCapacity backpressure.
   * @param {*} item
   * @param {number|string} [priority='Normal']
   * @returns {object|null} The queued entry metadata, or null if rejected due to backpressure
   */
  enqueue(item, priority = 'Normal') {
    if (item === undefined) {
      throw new TypeError('Enqueued item cannot be undefined.');
    }

    const resolved = resolvePriority(priority, this.mode);

    if (this._heap.length >= this.maxCapacity) {
      this.metrics.totalDropped += 1;
      this.metrics.backpressureEvents += 1;
      this._notify('drop', {
        item,
        priority: resolved.value,
        label: resolved.label,
        metrics: this.getMetrics()
      });
      return null;
    }

    const entry = {
      id: `edu-evt-${++this._seq}`,
      item,
      priority: resolved.value,
      label: resolved.label,
      isSemantic: typeof priority === 'string',
      sequence: this._seq,
      enqueuedAt: this._now()
    };

    this._heap.push(entry);
    this._siftUp(this._heap.length - 1);

    this.metrics.totalEnqueued += 1;
    if (this._heap.length > this.metrics.peakDepth) {
      this.metrics.peakDepth = this._heap.length;
    }

    if (this.maxCapacity !== Infinity && this._heap.length / this.maxCapacity >= this.highWatermark) {
      this.metrics.backpressureEvents += 1;
    }

    this._notify('enqueue', { entry, metrics: this.getMetrics() });

    if (this._running && !this._paused && !this._dispatchLoopActive) {
      this._scheduleNextTick(0);
    }

    return entry;
  }

  _dequeueEntry() {
    if (this._heap.length === 0) return null;

    const top = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this._siftDown(0);
    }

    const waitMs = Math.max(0, this._now() - top.enqueuedAt);
    this.metrics.totalDequeued += 1;
    this.metrics.lastWaitTimeMs = waitMs;
    this.metrics.totalWaitTimeMs += waitMs;

    this._notify('dequeue', { entry: top, waitMs, metrics: this.getMetrics() });
    return top;
  }

  /**
   * Remove and return the highest-precedence item payload, or null when empty.
   * @returns {*}
   */
  dequeue() {
    const entry = this._dequeueEntry();
    return entry ? entry.item : null;
  }

  /**
   * Return the highest-precedence item payload without removing it, or null when empty.
   * @returns {*}
   */
  peek() {
    return this._heap.length > 0 ? this._heap[0].item : null;
  }

  /**
   * Return a copy of the top heap entry metadata without mutating the queue.
   * @returns {object|null}
   */
  peekEntry() {
    return this._heap.length > 0 ? { ...this._heap[0] } : null;
  }

  /**
   * Return a non-destructive snapshot of queued entries sorted in dispatch order.
   * @returns {Array<object>}
   */
  toArray() {
    return [...this._heap]
      .sort((a, b) => (this._hasHigherPrecedence(a, b) ? -1 : this._hasHigherPrecedence(b, a) ? 1 : 0))
      .map((entry) => ({ ...entry }));
  }

  clear() {
    this._heap = [];
    this._notify('clear', { metrics: this.getMetrics() });
  }

  setMaxCapacity(maxCapacity) {
    if (maxCapacity !== Infinity && (!Number.isInteger(maxCapacity) || maxCapacity < 1)) {
      throw new RangeError('maxCapacity must be a positive integer or Infinity.');
    }
    this.maxCapacity = maxCapacity;
    this._notify('config', { metrics: this.getMetrics() });
  }

  setMode(mode) {
    if (mode !== 'max' && mode !== 'min') {
      throw new RangeError(`Invalid heap mode "${mode}". Expected "max" or "min".`);
    }
    if (this.mode === mode) return;
    this.mode = mode;
    for (const entry of this._heap) {
      if (entry.isSemantic) {
        entry.priority = resolvePriority(entry.label, mode).value;
      } else {
        entry.label = resolvePriority(entry.priority, mode).label;
      }
    }
    for (let i = Math.floor(this._heap.length / 2) - 1; i >= 0; i -= 1) {
      this._siftDown(i);
    }
    this._notify('config', { metrics: this.getMetrics() });
  }

  _refillTokens() {
    const now = this._now();
    const elapsed = Math.max(0, now - this._lastRefillAt);
    this._lastRefillAt = now;
    if (elapsed > 0 && this._rateLimitMs > 0) {
      const accrued = elapsed / this._rateLimitMs;
      this._tokens = Math.min(this.bucketCapacity, this._tokens + accrued);
    }
    return this._tokens;
  }

  _clearTimer() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _scheduleNextTick(delayMs) {
    this._clearTimer();
    if (!this._running || this._paused) return;
    const safeDelay = Math.max(0, Math.ceil(delayMs));
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._drainTick();
    }, safeDelay);
  }

  async _drainTick() {
    if (!this._running || this._paused || this._dispatchLoopActive) return;
    this._dispatchLoopActive = true;

    try {
      while (this._running && !this._paused && this._heap.length > 0) {
        this._refillTokens();
        if (this._tokens < 1) {
          const waitForTokenMs = Math.ceil((1 - this._tokens) * this._rateLimitMs);
          this._scheduleNextTick(waitForTokenMs);
          return;
        }

        this._tokens -= 1;
        const entry = this._dequeueEntry();
        if (!entry) break;

        this._lastDispatchAt = this._now();
        const waitMs = Math.max(0, this._lastDispatchAt - entry.enqueuedAt);
        this.metrics.totalDispatched += 1;

        try {
          await this._handler(entry.item, {
            ...entry,
            dispatchedAt: this._lastDispatchAt,
            waitMs
          });
          this._notify('dispatch', {
            entry,
            dispatchedAt: this._lastDispatchAt,
            waitMs,
            metrics: this.getMetrics()
          });
        } catch (error) {
          this.metrics.failedDispatches += 1;
          this._notify('dispatch_error', {
            entry,
            error,
            metrics: this.getMetrics()
          });
        }
      }

      if (this._running && !this._paused && this._heap.length > 0) {
        this._scheduleNextTick(this._rateLimitMs);
      }
    } finally {
      this._dispatchLoopActive = false;
      if (this._running && !this._paused && this._heap.length > 0 && this._timer === null) {
        this._refillTokens();
        const delay = this._tokens >= 1 ? 0 : Math.ceil((1 - this._tokens) * this._rateLimitMs);
        this._scheduleNextTick(delay);
      }
    }
  }

  /**
   * Start asynchronous rate-controlled event dispatching using token-bucket pacing.
   * @param {number} rateLimitMs Minimum interval per token replenishment in milliseconds (> 0)
   * @param {(item: *, meta: object) => (void|Promise<void>)} handler Async or sync consumer callback
   * @returns {{ stop: () => void, pause: () => void, resume: () => void, setRateLimit: (ms: number) => void, isRunning: () => boolean, isPaused: () => boolean }}
   */
  startDispatcher(rateLimitMs, handler) {
    if (typeof rateLimitMs !== 'number' || !Number.isFinite(rateLimitMs) || rateLimitMs <= 0) {
      throw new RangeError('rateLimitMs must be a finite positive number.');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('Dispatcher handler must be a function.');
    }

    this.stopDispatcher();
    this._rateLimitMs = rateLimitMs;
    this._handler = handler;
    this._running = true;
    this._paused = false;
    this._lastRefillAt = this._now();

    this._notify('dispatcher_start', { rateLimitMs, metrics: this.getMetrics() });

    if (this._heap.length > 0) {
      this._scheduleNextTick(0);
    }

    return {
      stop: () => this.stopDispatcher(),
      pause: () => this.pauseDispatcher(),
      resume: () => this.resumeDispatcher(),
      setRateLimit: (nextMs) => this.setRateLimit(nextMs),
      isRunning: () => this._running,
      isPaused: () => this._paused
    };
  }

  setRateLimit(rateLimitMs) {
    if (typeof rateLimitMs !== 'number' || !Number.isFinite(rateLimitMs) || rateLimitMs <= 0) {
      throw new RangeError('rateLimitMs must be a finite positive number.');
    }
    this._refillTokens();
    this._rateLimitMs = rateLimitMs;
    this._notify('config', { metrics: this.getMetrics() });
    if (this._running && !this._paused && this._heap.length > 0 && !this._dispatchLoopActive) {
      const delay = this._tokens >= 1 ? 0 : Math.ceil((1 - this._tokens) * this._rateLimitMs);
      this._scheduleNextTick(delay);
    }
  }

  pauseDispatcher() {
    if (!this._running || this._paused) return;
    this._paused = true;
    this._clearTimer();
    this._notify('dispatcher_pause', { metrics: this.getMetrics() });
  }

  resumeDispatcher() {
    if (!this._running || !this._paused) return;
    this._paused = false;
    this._lastRefillAt = this._now();
    this._notify('dispatcher_resume', { metrics: this.getMetrics() });
    if (this._heap.length > 0) {
      const delay = this._tokens >= 1 ? 0 : Math.ceil((1 - this._tokens) * this._rateLimitMs);
      this._scheduleNextTick(delay);
    }
  }

  stopDispatcher() {
    const wasRunning = this._running;
    this._running = false;
    this._paused = false;
    this._clearTimer();
    if (wasRunning) {
      this._notify('dispatcher_stop', { metrics: this.getMetrics() });
    }
  }

  getBackpressureState() {
    if (this.maxCapacity === Infinity) {
      return this._heap.length > 0 ? 'nominal' : 'idle';
    }
    const utilization = this._heap.length / this.maxCapacity;
    if (utilization >= 1) return 'saturated';
    if (utilization >= this.highWatermark) return 'elevated';
    return this._heap.length > 0 ? 'nominal' : 'idle';
  }

  getMetrics() {
    this._refillTokens();
    const depth = this._heap.length;
    const utilization = this.maxCapacity === Infinity ? 0 : Math.min(1, depth / this.maxCapacity);
    const averageWaitMs = this.metrics.totalDequeued > 0
      ? this.metrics.totalWaitTimeMs / this.metrics.totalDequeued
      : 0;

    return {
      depth,
      maxCapacity: this.maxCapacity,
      utilization,
      highWatermark: this.highWatermark,
      backpressureState: this.getBackpressureState(),
      mode: this.mode,
      rateLimitMs: this._rateLimitMs,
      tokens: Number(this._tokens.toFixed(3)),
      bucketCapacity: this.bucketCapacity,
      running: this._running,
      paused: this._paused,
      totalEnqueued: this.metrics.totalEnqueued,
      totalDequeued: this.metrics.totalDequeued,
      totalDispatched: this.metrics.totalDispatched,
      totalDropped: this.metrics.totalDropped,
      failedDispatches: this.metrics.failedDispatches,
      backpressureEvents: this.metrics.backpressureEvents,
      peakDepth: this.metrics.peakDepth,
      lastWaitMs: this.metrics.lastWaitTimeMs,
      averageWaitMs: Number(averageWaitMs.toFixed(2))
    };
  }
}

const SAMPLE_EVENTS = [
  { payload: 'Proctored exam timer sync — Cohort #14', priority: 'Urgent' },
  { payload: 'CUDA kernel lab auto-grader — Lab #08', priority: 'High' },
  { payload: 'PagedAttention quiz submission — Student #412', priority: 'Normal' },
  { payload: 'Lecture transcript indexing — Module 04', priority: 'Low' }
];

const BURST_EVENTS = [
  { payload: 'Live classroom WebRTC failover — Room B', priority: 'Urgent' },
  { payload: 'GPU sandbox OOM recovery — Pod #09', priority: 'Urgent' },
  { payload: 'Capstone PR benchmark run — Team Delta', priority: 'High' },
  { payload: 'Peer code-review assignment — Cohort #14', priority: 'High' },
  { payload: 'Interactive notebook checkpoint — Lab #05', priority: 'Normal' },
  { payload: 'Streak milestone badge grant — Student #208', priority: 'Normal' },
  { payload: 'Weekly cohort digest email batch', priority: 'Low' },
  { payload: 'Archive idle lab workspace snapshots', priority: 'Low' }
];

function createBadge(label) {
  const badge = document.createElement('span');
  const slug = label.toLowerCase();
  badge.className = `priority-badge badge-${slug}`;
  badge.dataset.priority = slug;
  badge.textContent = label;
  return badge;
}

/**
 * Mount the interactive priority queue and backpressure dispatcher UI when DOM nodes are present.
 * Safely returns null in headless/Node test environments.
 */
export function mountPriorityQueue(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;

  const form = doc.getElementById('pq-form');
  const heapList = doc.getElementById('pq-heap-list');
  const feedList = doc.getElementById('pq-feed-list');
  if (!form || !heapList || !feedList) return null;

  const payloadInput = doc.getElementById('pq-payload');
  const prioritySelect = doc.getElementById('pq-priority');
  const modeSelect = doc.getElementById('pq-mode');
  const rateSlider = doc.getElementById('pq-rate-slider');
  const rateValue = doc.getElementById('pq-rate-value');
  const capacityInput = doc.getElementById('pq-capacity');
  const capacityValue = doc.getElementById('pq-capacity-value');
  const toggleDispatcherBtn = doc.getElementById('pq-toggle-dispatcher');
  const stepBtn = doc.getElementById('pq-step-btn');
  const burstButton = doc.getElementById('pq-burst-btn');
  const clearBtn = doc.getElementById('pq-clear-btn');
  const clearFeedBtn = doc.getElementById('pq-clear-feed');
  const statusBanner = doc.getElementById('pq-status');

  const depthBar = doc.getElementById('pq-depth-bar');
  const depthCount = doc.getElementById('pq-depth-count');
  const depthText = doc.getElementById('pq-depth-text');
  const bpBadge = doc.getElementById('pq-backpressure-badge');
  const tokenBar = doc.getElementById('pq-token-bar');
  const tokenText = doc.getElementById('pq-token-text');

  const metricDispatched = doc.getElementById('metric-dispatched');
  const metricDropped = doc.getElementById('metric-dropped');
  const metricPeak = doc.getElementById('metric-peak');
  const metricWait = doc.getElementById('metric-wait');
  const metricPeek = doc.getElementById('metric-peek');

  const initialRate = Number(rateSlider?.value || 450);
  const initialCapacity = Number(capacityInput?.value || 16);

  const queue = new EdtechAcademyPriorityQueue({
    mode: modeSelect?.value === 'min' ? 'min' : 'max',
    maxCapacity: initialCapacity,
    highWatermark: 0.75,
    bucketCapacity: 2,
    initialTokens: 1
  });

  const feedEntries = [];
  const MAX_FEED_ITEMS = 30;

  const setStatus = (message, tone = 'info') => {
    if (!statusBanner) return;
    statusBanner.textContent = message;
    statusBanner.dataset.tone = tone;
  };

  const renderQueue = () => {
    const ordered = queue.toArray();
    heapList.replaceChildren();

    if (ordered.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'Heap is empty. Enqueue a classroom event or trigger a burst to inspect ordering.';
      heapList.appendChild(empty);
      return;
    }

    ordered.forEach((entry, index) => {
      const li = doc.createElement('li');
      li.className = 'pq-item';
      li.dataset.priority = entry.label.toLowerCase();

      const metaLeft = doc.createElement('div');
      metaLeft.className = 'pq-item-main';

      const rankNum = doc.createElement('span');
      rankNum.className = 'seq-tag';
      rankNum.textContent = `#${index + 1} · seq ${entry.sequence}`;

      const title = doc.createElement('span');
      title.className = 'pq-item-payload';
      title.textContent = typeof entry.item === 'string' ? entry.item : JSON.stringify(entry.item);

      metaLeft.append(rankNum, title);

      const metaRight = doc.createElement('div');
      metaRight.className = 'pq-item-meta';

      const scoreChip = doc.createElement('span');
      scoreChip.className = 'score-chip';
      scoreChip.textContent = `P${entry.priority}`;

      metaRight.append(createBadge(entry.label), scoreChip);
      li.append(metaLeft, metaRight);
      heapList.appendChild(li);
    });
  };

  const renderFeed = () => {
    feedList.replaceChildren();

    if (feedEntries.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'Processed classroom events will stream here in rate-paced priority order.';
      feedList.appendChild(empty);
      return;
    }

    feedEntries.forEach((ev) => {
      const li = doc.createElement('li');
      li.className = ev.dropped ? 'feed-card feed-card-dropped' : 'feed-card';
      li.dataset.priority = ev.label.toLowerCase();

      const header = doc.createElement('div');
      header.className = 'feed-card-head';
      header.append(createBadge(ev.label));

      const meta = doc.createElement('span');
      meta.className = 'feed-card-meta';
      meta.textContent = ev.dropped
        ? `DROPPED · ${ev.timestamp}`
        : `seq ${ev.sequence} · wait ${ev.waitMs} ms · ${ev.timestamp}`;
      header.append(meta);

      const body = doc.createElement('p');
      body.className = 'feed-card-body';
      body.textContent = ev.payload;

      li.append(header, body);
      feedList.appendChild(li);
    });
  };

  const renderMetrics = () => {
    const m = queue.getMetrics();
    const pct = m.maxCapacity === Infinity ? 0 : Math.round(m.utilization * 100);

    if (depthBar) {
      depthBar.style.width = `${pct}%`;
      depthBar.setAttribute('aria-valuenow', String(m.depth));
      depthBar.setAttribute('aria-valuemax', String(m.maxCapacity));
      depthBar.dataset.state = m.backpressureState;
    }
    if (depthCount) depthCount.textContent = `${m.depth} / ${m.maxCapacity}`;
    if (depthText) depthText.textContent = `${pct}% capacity`;

    if (bpBadge) {
      bpBadge.textContent = m.backpressureState.toUpperCase();
      bpBadge.dataset.state = m.backpressureState;
    }

    const tokenPct = Math.min(100, Math.round((m.tokens / m.bucketCapacity) * 100));
    if (tokenBar) tokenBar.style.width = `${tokenPct}%`;
    if (tokenText) tokenText.textContent = `${m.tokens.toFixed(2)} / ${m.bucketCapacity} tokens`;

    if (metricDispatched) metricDispatched.textContent = String(m.totalDispatched);
    if (metricDropped) metricDropped.textContent = String(m.totalDropped);
    if (metricPeak) metricPeak.textContent = String(m.peakDepth);
    if (metricWait) metricWait.textContent = `${Math.round(m.averageWaitMs)} ms`;

    if (metricPeek) {
      const top = queue.peekEntry();
      metricPeek.textContent = top
        ? `[${top.label}] ${typeof top.item === 'string' ? top.item : JSON.stringify(top.item)}`
        : 'Empty';
    }

    if (toggleDispatcherBtn) {
      if (!m.running) {
        toggleDispatcherBtn.textContent = 'Start Dispatcher';
      } else if (m.paused) {
        toggleDispatcherBtn.textContent = 'Resume Dispatcher';
      } else {
        toggleDispatcherBtn.textContent = 'Pause Dispatcher';
      }
    }
  };

  const pushFeed = (entry) => {
    feedEntries.unshift(entry);
    if (feedEntries.length > MAX_FEED_ITEMS) {
      feedEntries.length = MAX_FEED_ITEMS;
    }
    renderFeed();
  };

  const handleDispatch = (item, meta) => {
    pushFeed({
      payload: typeof item === 'string' ? item : JSON.stringify(item),
      label: meta.label,
      sequence: meta.sequence,
      waitMs: meta.waitMs,
      dropped: false,
      timestamp: new Date(meta.dispatchedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    });
  };

  queue.subscribe((eventType, detail) => {
    if (eventType === 'drop') {
      pushFeed({
        payload: typeof detail.item === 'string' ? detail.item : JSON.stringify(detail.item),
        label: detail.label,
        sequence: '—',
        waitMs: 0,
        dropped: true,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      });
      setStatus(
        `Backpressure active: dropped "${detail.item}" at full capacity (${queue.maxCapacity}).`,
        'warning'
      );
    }
    renderQueue();
    renderMetrics();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = payloadInput?.value.trim() ?? '';
    if (!raw) {
      setStatus('Please enter a classroom event payload before enqueuing.', 'warning');
      payloadInput?.focus();
      return;
    }
    const rank = prioritySelect?.value || 'Normal';
    const entry = queue.enqueue(raw, rank);
    if (entry) {
      setStatus(`Enqueued "${raw}" as ${entry.label} (Seq #${entry.sequence}).`, 'success');
      if (payloadInput) payloadInput.value = '';
    }
  });

  burstButton?.addEventListener('click', () => {
    let accepted = 0;
    let dropped = 0;
    for (const sample of BURST_EVENTS) {
      const result = queue.enqueue(sample.payload, sample.priority);
      if (result) accepted += 1;
      else dropped += 1;
    }
    setStatus(
      dropped > 0
        ? `Burst ingested ${accepted} events; ${dropped} dropped by backpressure.`
        : `Burst ingested ${accepted} prioritized classroom events into the binary heap.`,
      dropped > 0 ? 'warning' : 'success'
    );
  });

  rateSlider?.addEventListener('input', () => {
    const ms = Number(rateSlider.value);
    if (rateValue) rateValue.textContent = `${ms} ms / event (${(1000 / ms).toFixed(1)}/s)`;
    queue.setRateLimit(ms);
  });

  capacityInput?.addEventListener('input', () => {
    const cap = Number(capacityInput.value);
    if (capacityValue) capacityValue.textContent = `${cap} events`;
    queue.setMaxCapacity(cap);
  });

  modeSelect?.addEventListener('change', () => {
    const mode = modeSelect.value === 'min' ? 'min' : 'max';
    queue.setMode(mode);
    setStatus(`Heap comparator switched to ${mode === 'max' ? 'Max-Heap' : 'Min-Heap'} mode.`, 'info');
  });

  toggleDispatcherBtn?.addEventListener('click', () => {
    const m = queue.getMetrics();
    if (!m.running) {
      const ms = Number(rateSlider?.value || initialRate);
      queue.startDispatcher(ms, handleDispatch);
      setStatus(`Dispatcher running at ${ms} ms token refill interval.`, 'success');
    } else if (m.paused) {
      queue.resumeDispatcher();
      setStatus('Dispatcher resumed.', 'success');
    } else {
      queue.pauseDispatcher();
      setStatus('Dispatcher paused. Queue continues accepting events.', 'info');
    }
    renderMetrics();
  });

  stepBtn?.addEventListener('click', () => {
    const entry = queue.peekEntry();
    if (!entry) {
      setStatus('Queue is empty; nothing to dispatch.', 'info');
      return;
    }
    const item = queue.dequeue();
    const now = Date.now();
    queue.metrics.totalDispatched += 1;
    handleDispatch(item, {
      ...entry,
      dispatchedAt: now,
      waitMs: Math.max(0, now - entry.enqueuedAt)
    });
    renderQueue();
    renderMetrics();
    setStatus(`Manually dispatched ${entry.label} event #${entry.sequence}.`, 'success');
  });

  clearBtn?.addEventListener('click', () => {
    queue.clear();
    setStatus('Cleared all pending events from the heap.', 'info');
  });

  clearFeedBtn?.addEventListener('click', () => {
    feedEntries.length = 0;
    renderFeed();
  });

  for (const sample of SAMPLE_EVENTS) {
    queue.enqueue(sample.payload, sample.priority);
  }

  if (rateValue) rateValue.textContent = `${initialRate} ms / event (${(1000 / initialRate).toFixed(1)}/s)`;
  if (capacityValue) capacityValue.textContent = `${initialCapacity} events`;

  queue.startDispatcher(initialRate, handleDispatch);

  const tokenRefreshTimer = typeof window !== 'undefined'
    ? window.setInterval(() => {
        if (doc.visibilityState !== 'hidden') {
          renderMetrics();
        }
      }, 150)
    : null;

  renderQueue();
  renderFeed();
  renderMetrics();
  setStatus(`Ready · ${queue.size()} classroom events queued with token-bucket pacing active.`, 'success');

  return {
    queue,
    destroy() {
      queue.stopDispatcher();
      if (tokenRefreshTimer !== null && typeof window !== 'undefined') {
        window.clearInterval(tokenRefreshTimer);
      }
    }
  };
}

if (typeof document !== 'undefined') {
  mountPriorityQueue(document);
}
