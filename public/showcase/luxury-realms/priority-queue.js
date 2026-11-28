/**
 * Luxury Realms — Binary Heap Priority Event Queue & Backpressure Dispatcher
 *
 * Implements:
 *  - Binary max-heap / min-heap with strict FIFO tie-breaking on identical priorities
 *  - Token-bucket dispatch pacing for asynchronous rate-controlled event delivery
 *  - Backpressure capacity guardrails, watermark status, and live telemetry metrics
 *  - Interactive browser dashboard controller (mounted only in DOM environments)
 */

export const PRIORITY_RANKS = Object.freeze({
  URGENT: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1
});

const LABEL_TO_RANK_MAX = Object.freeze({
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1
});

const LABEL_TO_RANK_MIN = Object.freeze({
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4
});

/**
 * Resolve a numeric priority or semantic rank label into a numeric priority and display badge label.
 * @param {number|string} priority
 * @param {'max'|'min'} mode
 * @returns {{ value: number, label: string }}
 */
export function resolvePriority(priority, mode = 'max') {
  if (typeof priority === 'string') {
    const normalized = priority.trim().toLowerCase();
    const map = mode === 'min' ? LABEL_TO_RANK_MIN : LABEL_TO_RANK_MAX;
    if (Object.prototype.hasOwnProperty.call(map, normalized)) {
      const titleLabel = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      return { value: map[normalized], label: titleLabel };
    }
    throw new TypeError(`Unknown priority rank label: "${priority}". Expected Urgent, High, Normal, Low, or a finite number.`);
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

export class LuxuryRealmsPriorityQueue {
  /**
   * @param {Object} [options]
   * @param {'max'|'min'} [options.mode='max'] Heap ordering mode ('max' = higher number first, 'min' = lower number first)
   * @param {number} [options.maxCapacity=Infinity] Maximum queued items before backpressure rejection
   * @param {number} [options.highWatermark=0.8] Utilization ratio (0..1] that marks elevated backpressure
   * @param {number} [options.bucketCapacity=1] Token-bucket burst capacity (defaults to 1 for strict rate pacing)
   * @param {number} [options.initialTokens] Initial tokens available in the bucket
   * @param {() => number} [options.now] Clock function returning milliseconds
   */
  constructor(options = {}) {
    const {
      mode = 'max',
      maxCapacity = Infinity,
      highWatermark = 0.8,
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
    if (typeof highWatermark !== 'number' || !Number.isFinite(highWatermark) || highWatermark <= 0 || highWatermark > 1) {
      throw new RangeError('highWatermark must be a number in (0, 1].');
    }
    if (typeof bucketCapacity !== 'number' || !Number.isFinite(bucketCapacity) || bucketCapacity < 1) {
      throw new RangeError('bucketCapacity must be a finite number >= 1.');
    }
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function returning a timestamp in milliseconds.');
    }

    this.mode = mode;
    this.maxCapacity = maxCapacity;
    this.highWatermark = highWatermark;
    this.bucketCapacity = bucketCapacity;
    this._now = now;

    this._heap = [];
    this._seq = 0;

    // Token-bucket & dispatcher state
    const startTokens = initialTokens === undefined ? Math.min(1, bucketCapacity) : initialTokens;
    if (typeof startTokens !== 'number' || !Number.isFinite(startTokens) || startTokens < 0 || startTokens > bucketCapacity) {
      throw new RangeError('initialTokens must be between 0 and bucketCapacity.');
    }
    this._tokens = startTokens;
    this._rateLimitMs = 250;
    this._lastRefillAt = this._now();
    this._lastDispatchAt = null;
    this._handler = null;
    this._running = false;
    this._paused = false;
    this._dispatching = false;
    this._timer = null;

    // Telemetry & backpressure metrics
    this.metrics = {
      totalEnqueued: 0,
      totalDispatched: 0,
      totalDequeued: 0,
      totalDropped: 0,
      failedDispatches: 0,
      backpressureEvents: 0,
      peakDepth: 0,
      totalWaitTimeMs: 0,
      lastWaitTimeMs: 0
    };

    this._listeners = new Map();
  }

  /** @returns {number} Current number of queued items */
  get size() {
    return this._heap.length;
  }

  /** @returns {boolean} */
  isEmpty() {
    return this._heap.length === 0;
  }

  /**
   * Subscribe to queue lifecycle events:
   * 'enqueue', 'dequeue', 'dispatch', 'backpressure', 'rateChange', 'error', 'clear'
   * @param {string} event
   * @param {(payload: any) => void} listener
   * @returns {() => void} Unsubscribe function
   */
  on(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Event listener must be a function.');
    }
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  off(event, listener) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(listener);
    }
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(payload);
      } catch {
        // Keep queue/dispatcher resilient against listener errors
      }
    }
  }

  /**
   * Compare two heap entries. Returns < 0 if `a` should be dequeued before `b`.
   * Preserves strict FIFO order via monotonic `seq` when priorities match.
   */
  _compare(a, b) {
    if (a.priority !== b.priority) {
      return this.mode === 'min' ? a.priority - b.priority : b.priority - a.priority;
    }
    return a.seq - b.seq;
  }

  _siftUp(index) {
    let idx = index;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      if (this._compare(this._heap[idx], this._heap[parentIdx]) < 0) {
        const tmp = this._heap[idx];
        this._heap[idx] = this._heap[parentIdx];
        this._heap[parentIdx] = tmp;
        idx = parentIdx;
      } else {
        break;
      }
    }
  }

  _siftDown(index) {
    let idx = index;
    const len = this._heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = idx * 2 + 2;
      let best = idx;

      if (left < len && this._compare(this._heap[left], this._heap[best]) < 0) {
        best = left;
      }
      if (right < len && this._compare(this._heap[right], this._heap[best]) < 0) {
        best = right;
      }
      if (best === idx) break;

      const tmp = this._heap[idx];
      this._heap[idx] = this._heap[best];
      this._heap[best] = tmp;
      idx = best;
    }
  }

  /**
   * Insert an item into the priority queue with the given priority.
   * Rejects and emits a backpressure event if maxCapacity is reached.
   * @param {any} item
   * @param {number|string} [priority=PRIORITY_RANKS.NORMAL]
   * @returns {boolean} True if accepted, false if rejected due to backpressure
   */
  enqueue(item, priority = PRIORITY_RANKS.NORMAL) {
    const resolved = resolvePriority(priority, this.mode);

    if (this._heap.length >= this.maxCapacity) {
      this.metrics.totalDropped++;
      this.metrics.backpressureEvents++;
      this._emit('backpressure', {
        reason: 'CAPACITY_EXCEEDED',
        item,
        priority: resolved.value,
        label: resolved.label,
        metrics: this.getMetrics()
      });
      return false;
    }

    const entry = {
      item,
      priority: resolved.value,
      label: resolved.label,
      seq: this._seq++,
      enqueuedAt: this._now()
    };

    this._heap.push(entry);
    this._siftUp(this._heap.length - 1);

    this.metrics.totalEnqueued++;
    if (this._heap.length > this.metrics.peakDepth) {
      this.metrics.peakDepth = this._heap.length;
    }

    const snapshot = this.getMetrics();
    this._emit('enqueue', { entry: { ...entry }, metrics: snapshot });

    if (snapshot.isBackpressured) {
      this.metrics.backpressureEvents++;
      this._emit('backpressure', {
        reason: snapshot.backpressureLevel,
        entry: { ...entry },
        metrics: this.getMetrics()
      });
    }

    if (this._running && !this._paused && !this._dispatching && !this._timer) {
      this._scheduleNextTick();
    }

    return true;
  }

  /**
   * Internal dequeue returning the full metadata node.
   */
  _dequeueEntry() {
    if (this._heap.length === 0) return null;

    const top = this._heap[0];
    const tail = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = tail;
      this._siftDown(0);
    }

    this.metrics.totalDequeued++;
    this._emit('dequeue', { entry: { ...top }, metrics: this.getMetrics() });
    return top;
  }

  /**
   * Remove and return the highest-priority item (FIFO on ties), or null if empty.
   * @returns {any|null}
   */
  dequeue() {
    const entry = this._dequeueEntry();
    return entry ? entry.item : null;
  }

  /**
   * Inspect the highest-priority item without removing it, or null if empty.
   * @returns {any|null}
   */
  peek() {
    return this._heap.length > 0 ? this._heap[0].item : null;
  }

  /**
   * Non-mutating snapshot of queued entries in dispatch order (for UI inspection & diagnostics).
   * @returns {Array<{ item: any, priority: number, label: string, seq: number, enqueuedAt: number }>}
   */
  getSnapshot() {
    return [...this._heap]
      .sort((a, b) => this._compare(a, b))
      .map((entry) => ({ ...entry }));
  }

  /**
   * Verify the binary heap property holds across the internal array.
   * @returns {boolean}
   */
  verifyHeapInvariant() {
    const len = this._heap.length;
    for (let i = 0; i < len; i++) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < len && this._compare(this._heap[i], this._heap[left]) > 0) {
        return false;
      }
      if (right < len && this._compare(this._heap[i], this._heap[right]) > 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Clear all queued items without altering cumulative telemetry totals.
   */
  clear() {
    this._heap = [];
    this._emit('clear', { metrics: this.getMetrics() });
  }

  /**
   * Refill token bucket based on elapsed time and current rateLimitMs.
   * @returns {number} Available tokens
   */
  _refillTokens() {
    const now = this._now();
    const elapsed = Math.max(0, now - this._lastRefillAt);
    if (elapsed > 0 && this._rateLimitMs > 0) {
      this._tokens = Math.min(this.bucketCapacity, this._tokens + elapsed / this._rateLimitMs);
      this._lastRefillAt = now;
    }
    return this._tokens;
  }

  /**
   * Start the rate-controlled asynchronous dispatcher loop.
   * @param {number} rateLimitMs Minimum interval (ms) per token refill / dispatch
   * @param {(item: any, meta: Object) => any|Promise<any>} handler Callback invoked for each dequeued item
   * @returns {() => void} Stop function
   */
  startDispatcher(rateLimitMs, handler) {
    if (typeof rateLimitMs !== 'number' || !Number.isFinite(rateLimitMs) || rateLimitMs <= 0) {
      throw new RangeError('rateLimitMs must be a positive finite number.');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function.');
    }

    this.stopDispatcher();

    this._rateLimitMs = rateLimitMs;
    this._handler = handler;
    this._running = true;
    this._paused = false;
    this._lastRefillAt = this._now();

    if (this._heap.length > 0) {
      this._scheduleNextTick();
    }

    return () => this.stopDispatcher();
  }

  /**
   * Update dispatch pacing interval while running or idle.
   * @param {number} rateLimitMs
   */
  setRateLimit(rateLimitMs) {
    if (typeof rateLimitMs !== 'number' || !Number.isFinite(rateLimitMs) || rateLimitMs <= 0) {
      throw new RangeError('rateLimitMs must be a positive finite number.');
    }
    this._refillTokens();
    this._rateLimitMs = rateLimitMs;
    this._emit('rateChange', { rateLimitMs, metrics: this.getMetrics() });

    if (this._running && !this._paused && !this._dispatching) {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      if (this._heap.length > 0) {
        this._scheduleNextTick();
      }
    }
  }

  pauseDispatcher() {
    this._paused = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  resumeDispatcher() {
    if (!this._running || !this._paused) return;
    this._paused = false;
    this._lastRefillAt = this._now();
    if (this._heap.length > 0 && !this._dispatching && !this._timer) {
      this._scheduleNextTick();
    }
  }

  stopDispatcher() {
    this._running = false;
    this._paused = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _scheduleNextTick() {
    if (!this._running || this._paused || this._dispatching || this._heap.length === 0) {
      return;
    }

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    this._refillTokens();

    let delayMs = 0;
    if (this._tokens < 1) {
      const missingTokens = 1 - this._tokens;
      // Add 1ms cushion to prevent OS timer jitter from firing slightly early
      delayMs = Math.ceil(missingTokens * this._rateLimitMs) + 1;
    } else if (this.bucketCapacity === 1 && this._lastDispatchAt !== null) {
      const sinceLast = this._now() - this._lastDispatchAt;
      if (sinceLast < this._rateLimitMs) {
        delayMs = Math.ceil(this._rateLimitMs - sinceLast) + 1;
      }
    }

    this._timer = setTimeout(() => {
      this._timer = null;
      void this._dispatchTick();
    }, delayMs);
  }

  async _dispatchTick() {
    if (!this._running || this._paused || this._dispatching || this._heap.length === 0) {
      return;
    }

    this._refillTokens();

    if (this._tokens < 1) {
      this._scheduleNextTick();
      return;
    }

    if (this.bucketCapacity === 1 && this._lastDispatchAt !== null) {
      const sinceLast = this._now() - this._lastDispatchAt;
      if (sinceLast < this._rateLimitMs) {
        this._scheduleNextTick();
        return;
      }
    }

    const entry = this._dequeueEntry();
    if (!entry) return;

    this._tokens = Math.max(0, this._tokens - 1);
    const dispatchedAt = this._now();
    this._lastDispatchAt = dispatchedAt;
    const waitTimeMs = Math.max(0, dispatchedAt - entry.enqueuedAt);

    this.metrics.totalDispatched++;
    this.metrics.lastWaitTimeMs = waitTimeMs;
    this.metrics.totalWaitTimeMs += waitTimeMs;

    const meta = {
      priority: entry.priority,
      label: entry.label,
      seq: entry.seq,
      enqueuedAt: entry.enqueuedAt,
      dispatchedAt,
      waitTimeMs,
      remainingTokens: this._tokens,
      queueDepth: this._heap.length
    };

    this._dispatching = true;
    try {
      await Promise.resolve(this._handler(entry.item, meta));
      this._emit('dispatch', { item: entry.item, meta, metrics: this.getMetrics() });
    } catch (error) {
      this.metrics.failedDispatches++;
      this._emit('error', { error, item: entry.item, meta, metrics: this.getMetrics() });
    } finally {
      this._dispatching = false;
      if (this._running && !this._paused && this._heap.length > 0) {
        this._scheduleNextTick();
      }
    }
  }

  /**
   * Compute live queue depth, backpressure state, and token-bucket metrics.
   */
  getMetrics() {
    this._refillTokens();
    const size = this._heap.length;
    const finiteCapacity = Number.isFinite(this.maxCapacity);
    const utilization = finiteCapacity ? Math.min(1, size / this.maxCapacity) : 0;

    let backpressureLevel = 'NOMINAL';
    if (finiteCapacity) {
      if (size >= this.maxCapacity) {
        backpressureLevel = 'SATURATED';
      } else if (utilization >= this.highWatermark) {
        backpressureLevel = 'CRITICAL';
      } else if (utilization >= this.highWatermark * 0.65) {
        backpressureLevel = 'ELEVATED';
      }
    }

    const avgWaitTimeMs = this.metrics.totalDispatched > 0
      ? Math.round(this.metrics.totalWaitTimeMs / this.metrics.totalDispatched)
      : 0;

    return {
      size,
      maxCapacity: this.maxCapacity,
      utilization,
      isBackpressured: backpressureLevel === 'CRITICAL' || backpressureLevel === 'SATURATED',
      backpressureLevel,
      totalEnqueued: this.metrics.totalEnqueued,
      totalDispatched: this.metrics.totalDispatched,
      totalDequeued: this.metrics.totalDequeued,
      totalDropped: this.metrics.totalDropped,
      failedDispatches: this.metrics.failedDispatches,
      backpressureEvents: this.metrics.backpressureEvents,
      peakDepth: this.metrics.peakDepth,
      avgWaitTimeMs,
      lastWaitTimeMs: this.metrics.lastWaitTimeMs,
      tokens: Number(this._tokens.toFixed(2)),
      bucketCapacity: this.bucketCapacity,
      rateLimitMs: this._rateLimitMs,
      isRunning: this._running && !this._paused,
      isPaused: this._paused,
      mode: this.mode
    };
  }
}

/* ==========================================================================
   Browser Dashboard Controller (Isolated to priority-queue.html)
   ========================================================================== */

const PRESET_EVENTS = [
  { payload: 'Private Jet Diversion — Geneva Slot Clearance', priority: 'Urgent' },
  { payload: 'Azure Atoll Helipad VIP Arrival Briefing', priority: 'High' },
  { payload: 'Superyacht Tender Provisioning Manifest', priority: 'Normal' },
  { payload: 'Seasonal Wine Cellar Humidity Telemetry Sync', priority: 'Low' },
  { payload: 'UHNW Escrow Wire Authorization (#8842)', priority: 'Urgent' },
  { payload: 'St. Barts Villa Sommelier Table Allocation', priority: 'High' }
];

export function initLuxuryPriorityQueueDashboard() {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector('[data-luxury-priority-queue]');
  if (!root) return null;

  const MAX_CAPACITY = 20;
  let queue = new LuxuryRealmsPriorityQueue({
    mode: 'max',
    maxCapacity: MAX_CAPACITY,
    highWatermark: 0.75,
    bucketCapacity: 1
  });

  // DOM References
  const enqueueForm = root.querySelector('#enqueueForm');
  const payloadInput = root.querySelector('#eventPayloadInput');
  const prioritySelect = root.querySelector('#priorityRankSelect');
  const rateSlider = root.querySelector('#dispatchRateSlider');
  const rateValueLabel = root.querySelector('#dispatchRateValue');
  const rateThroughputLabel = root.querySelector('#dispatchThroughputValue');
  const heapModeSelect = root.querySelector('#heapModeSelect');

  const btnToggleDispatcher = root.querySelector('#btnToggleDispatcher');
  const btnBurstStress = root.querySelector('#btnBurstStress');
  const btnClearQueue = root.querySelector('#btnClearQueue');
  const btnClearFeed = root.querySelector('#btnClearFeed');

  const depthGaugeBar = root.querySelector('#depthGaugeBar');
  const depthGaugeText = root.querySelector('#depthGaugeText');
  const backpressureBadge = root.querySelector('#backpressureBadge');
  const tokenGaugeBar = root.querySelector('#tokenGaugeBar');
  const tokenGaugeText = root.querySelector('#tokenGaugeText');

  const metricQueued = root.querySelector('#metricQueued');
  const metricDispatched = root.querySelector('#metricDispatched');
  const metricDropped = root.querySelector('#metricDropped');
  const metricAvgWait = root.querySelector('#metricAvgWait');

  const heapPreviewList = root.querySelector('#heapPreviewList');
  const processedFeed = root.querySelector('#processedFeed');
  const backpressureToast = root.querySelector('#backpressureToast');

  let currentRateMs = Number(rateSlider?.value || 650);
  let dispatcherEnabled = true;

  function formatPriorityClass(label) {
    const clean = String(label || 'normal').toLowerCase();
    return ['urgent', 'high', 'normal', 'low'].includes(clean) ? clean : 'normal';
  }

  function updateRateReadout(ms) {
    if (rateValueLabel) {
      rateValueLabel.textContent = `${ms} ms`;
    }
    if (rateThroughputLabel) {
      const eps = (1000 / ms).toFixed(2);
      rateThroughputLabel.textContent = `${eps} events/sec`;
    }
  }

  function renderHeapPreview() {
    if (!heapPreviewList) return;
    heapPreviewList.replaceChildren();
    const snapshot = queue.getSnapshot();

    if (snapshot.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Heap is idle — enqueue an estate concierge event to observe priority ordering.';
      heapPreviewList.appendChild(empty);
      return;
    }

    snapshot.slice(0, 12).forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'heap-item';

      const rankBadge = document.createElement('span');
      const pClass = formatPriorityClass(entry.label);
      rankBadge.className = `priority-badge badge-${pClass}`;
      rankBadge.textContent = `${entry.label} (${entry.priority})`;

      const textWrap = document.createElement('div');
      textWrap.className = 'heap-item-text';

      const title = document.createElement('span');
      title.className = 'heap-item-payload';
      title.textContent = typeof entry.item === 'string' ? entry.item : JSON.stringify(entry.item);

      const seqTag = document.createElement('span');
      seqTag.className = 'heap-item-seq';
      seqTag.textContent = idx === 0 ? `NEXT • seq #${entry.seq}` : `seq #${entry.seq}`;

      textWrap.append(title, seqTag);
      row.append(rankBadge, textWrap);
      heapPreviewList.appendChild(row);
    });

    if (snapshot.length > 12) {
      const overflow = document.createElement('div');
      overflow.className = 'heap-overflow-note';
      overflow.textContent = `+ ${snapshot.length - 12} additional queued event(s) in binary heap`;
      heapPreviewList.appendChild(overflow);
    }
  }

  function appendProcessedCard(item, meta) {
    if (!processedFeed) return;

    const emptyNotice = processedFeed.querySelector('.empty-state');
    if (emptyNotice) emptyNotice.remove();

    const card = document.createElement('article');
    const pClass = formatPriorityClass(meta.label);
    card.className = `feed-card feed-card-${pClass}`;

    const topRow = document.createElement('div');
    topRow.className = 'feed-card-header';

    const badge = document.createElement('span');
    badge.className = `priority-badge badge-${pClass}`;
    badge.textContent = meta.label;

    const timestamp = document.createElement('span');
    timestamp.className = 'feed-card-time';
    timestamp.textContent = new Date(meta.dispatchedAt).toLocaleTimeString();

    topRow.append(badge, timestamp);

    const body = document.createElement('p');
    body.className = 'feed-card-payload';
    body.textContent = typeof item === 'string' ? item : JSON.stringify(item);

    const footer = document.createElement('div');
    footer.className = 'feed-card-meta';
    footer.textContent = `Priority ${meta.priority} • Seq #${meta.seq} • Wait ${meta.waitTimeMs}ms • Depth left ${meta.queueDepth}`;

    card.append(topRow, body, footer);
    processedFeed.prepend(card);

    while (processedFeed.children.length > 30) {
      processedFeed.removeChild(processedFeed.lastChild);
    }
  }

  function renderMetrics() {
    const m = queue.getMetrics();
    const pct = Math.min(100, Math.round(m.utilization * 100));

    if (depthGaugeBar) {
      depthGaugeBar.style.width = `${pct}%`;
      depthGaugeBar.className = `progress-fill level-${m.backpressureLevel.toLowerCase()}`;
    }
    if (depthGaugeText) {
      depthGaugeText.textContent = `${m.size} / ${m.maxCapacity} (${pct}%)`;
    }
    if (backpressureBadge) {
      backpressureBadge.textContent = m.backpressureLevel;
      backpressureBadge.className = `bp-badge bp-${m.backpressureLevel.toLowerCase()}`;
    }

    const tokenPct = Math.min(100, Math.round((m.tokens / m.bucketCapacity) * 100));
    if (tokenGaugeBar) {
      tokenGaugeBar.style.width = `${tokenPct}%`;
    }
    if (tokenGaugeText) {
      tokenGaugeText.textContent = `${m.tokens.toFixed(2)} / ${m.bucketCapacity} token`;
    }

    if (metricQueued) metricQueued.textContent = String(m.size);
    if (metricDispatched) metricDispatched.textContent = String(m.totalDispatched);
    if (metricDropped) metricDropped.textContent = String(m.totalDropped);
    if (metricAvgWait) metricAvgWait.textContent = `${m.avgWaitTimeMs} ms`;

    if (btnToggleDispatcher) {
      btnToggleDispatcher.textContent = m.isRunning ? '⏸ Pause Dispatcher' : '▶ Resume Dispatcher';
      btnToggleDispatcher.classList.toggle('is-paused', !m.isRunning);
    }

    renderHeapPreview();
  }

  let toastTimeout = null;
  function showBackpressureAlert(message) {
    if (!backpressureToast) return;
    backpressureToast.textContent = message;
    backpressureToast.classList.add('visible');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      backpressureToast.classList.remove('visible');
    }, 3500);
  }

  function bindQueueEvents(instance) {
    instance.on('enqueue', () => renderMetrics());
    instance.on('dequeue', () => renderMetrics());
    instance.on('dispatch', ({ item, meta }) => {
      appendProcessedCard(item, meta);
      renderMetrics();
    });
    instance.on('clear', () => renderMetrics());
    instance.on('backpressure', ({ reason, metrics }) => {
      if (reason === 'CAPACITY_EXCEEDED') {
        showBackpressureAlert(`Backpressure Shedding Active: Queue saturated (${metrics.size}/${metrics.maxCapacity}). Event rejected.`);
      } else {
        showBackpressureAlert(`Backpressure ${reason}: Queue at ${Math.round(metrics.utilization * 100)}% capacity.`);
      }
      renderMetrics();
    });
  }

  function startQueueDispatcher(instance) {
    instance.startDispatcher(currentRateMs, (item, meta) => {
      return { handled: true, seq: meta.seq, payload: item };
    });
    if (!dispatcherEnabled) {
      instance.pauseDispatcher();
    }
  }

  bindQueueEvents(queue);
  startQueueDispatcher(queue);
  updateRateReadout(currentRateMs);
  renderMetrics();

  if (enqueueForm) {
    enqueueForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const rawPayload = payloadInput?.value?.trim();
      const payload = rawPayload || `Concierge Dispatch #${Date.now().toString(36).toUpperCase()}`;
      const priority = prioritySelect?.value || 'Normal';
      queue.enqueue(payload, priority);
      if (payloadInput) payloadInput.value = '';
    });
  }

  if (rateSlider) {
    rateSlider.addEventListener('input', () => {
      currentRateMs = Number(rateSlider.value);
      updateRateReadout(currentRateMs);
      queue.setRateLimit(currentRateMs);
      renderMetrics();
    });
  }

  if (btnToggleDispatcher) {
    btnToggleDispatcher.addEventListener('click', () => {
      const m = queue.getMetrics();
      if (m.isRunning) {
        dispatcherEnabled = false;
        queue.pauseDispatcher();
      } else {
        dispatcherEnabled = true;
        if (m.isPaused) {
          queue.resumeDispatcher();
        } else {
          startQueueDispatcher(queue);
        }
      }
      renderMetrics();
    });
  }

  if (btnBurstStress) {
    btnBurstStress.addEventListener('click', () => {
      for (let i = 0; i < 8; i++) {
        const preset = PRESET_EVENTS[i % PRESET_EVENTS.length];
        queue.enqueue(`${preset.payload} [${i + 1}]`, preset.priority);
      }
    });
  }

  if (btnClearQueue) {
    btnClearQueue.addEventListener('click', () => {
      queue.clear();
    });
  }

  if (btnClearFeed) {
    btnClearFeed.addEventListener('click', () => {
      if (!processedFeed) return;
      processedFeed.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Processed event feed cleared. Dispatched concierge events will appear here.';
      processedFeed.appendChild(empty);
    });
  }

  if (heapModeSelect) {
    heapModeSelect.addEventListener('change', () => {
      const nextMode = heapModeSelect.value === 'min' ? 'min' : 'max';
      const existing = queue.getSnapshot();
      queue.stopDispatcher();
      queue = new LuxuryRealmsPriorityQueue({
        mode: nextMode,
        maxCapacity: MAX_CAPACITY,
        highWatermark: 0.75,
        bucketCapacity: 1
      });
      bindQueueEvents(queue);
      for (const entry of existing) {
        queue.enqueue(entry.item, entry.label);
      }
      startQueueDispatcher(queue);
      renderMetrics();
    });
  }

  // Periodic UI token refill refresh so token bar animates smoothly
  const uiPulse = setInterval(() => {
    renderMetrics();
  }, 150);

  return {
    getQueue: () => queue,
    destroy: () => {
      clearInterval(uiPulse);
      queue.stopDispatcher();
    }
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.LuxuryRealmsPriorityQueue = LuxuryRealmsPriorityQueue;
  window.PRIORITY_RANKS = PRIORITY_RANKS;
  document.addEventListener('DOMContentLoaded', () => {
    initLuxuryPriorityQueueDashboard();
  });
}
