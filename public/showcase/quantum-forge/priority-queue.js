/**
 * Quantum Forge - Binary Heap Priority Event Queue & Backpressure Dispatcher
 * Issue #4156 - NSoC '26 Level 3 Feature
 */

export class QuantumForgePriorityQueue {
  static PRIORITY_RANKS = Object.freeze({
    urgent: 4,
    high: 3,
    normal: 2,
    low: 1
  });

  static RANK_LABELS = Object.freeze({
    4: 'Urgent',
    3: 'High',
    2: 'Normal',
    1: 'Low'
  });

  #heap = [];
  #seq = 0;
  #listeners = new Set();
  #history = [];
  #timer = null;
  #running = false;
  #inFlight = false;
  #handler = null;
  #rateLimitMs = 250;
  #tokens = 1;
  #lastRefillAt = 0;
  #enqueuedCount = 0;
  #dispatchedCount = 0;
  #droppedCount = 0;
  #peakDepth = 0;
  #totalWaitMs = 0;

  /**
   * @param {Object} [options]
   * @param {'max'|'min'} [options.mode='max'] - Heap ordering mode ('max' prioritizes larger numeric priority).
   * @param {number} [options.maxCapacity=32] - Maximum queue depth before backpressure drops new events.
   * @param {number} [options.highWaterRatio=0.75] - Utilization ratio threshold for elevated backpressure.
   * @param {number} [options.bucketCapacity=1] - Token bucket burst capacity.
   * @param {number} [options.maxHistory=50] - Maximum processed event entries kept in history.
   * @param {() => number} [options.now] - Clock function returning milliseconds.
   */
  constructor(options = {}) {
    const mode = options.mode ?? 'max';
    if (mode !== 'max' && mode !== 'min') {
      throw new RangeError('Heap mode must be "max" or "min".');
    }

    const maxCapacity = options.maxCapacity ?? 32;
    if (maxCapacity !== Infinity && (!Number.isInteger(maxCapacity) || maxCapacity < 1)) {
      throw new RangeError('maxCapacity must be a positive integer or Infinity.');
    }

    const bucketCapacity = options.bucketCapacity ?? 1;
    if (!Number.isFinite(bucketCapacity) || bucketCapacity < 1) {
      throw new RangeError('bucketCapacity must be a finite number >= 1.');
    }

    const highWaterRatio = options.highWaterRatio ?? 0.75;
    if (!Number.isFinite(highWaterRatio) || highWaterRatio <= 0 || highWaterRatio > 1) {
      throw new RangeError('highWaterRatio must be in (0, 1].');
    }

    const now = options.now ?? (() => Date.now());
    if (typeof now !== 'function') {
      throw new TypeError('now option must be a function.');
    }

    this.mode = mode;
    this.maxCapacity = maxCapacity;
    this.highWaterRatio = highWaterRatio;
    this.bucketCapacity = bucketCapacity;
    this.maxHistory = Number.isInteger(options.maxHistory) && options.maxHistory > 0 ? options.maxHistory : 50;
    this._now = now;
    this.#tokens = bucketCapacity;
    this.#lastRefillAt = this._now();
  }

  get size() {
    return this.#heap.length;
  }

  isEmpty() {
    return this.#heap.length === 0;
  }

  /**
   * Resolves a numeric priority or rank name ('urgent' | 'high' | 'normal' | 'low').
   */
  static resolvePriority(priority = 'normal') {
    if (typeof priority === 'number') {
      if (!Number.isFinite(priority)) {
        throw new TypeError('Numeric priority must be finite.');
      }
      return {
        value: priority,
        label: QuantumForgePriorityQueue.RANK_LABELS[priority] || `P${priority}`
      };
    }

    if (typeof priority === 'string') {
      const key = priority.trim().toLowerCase();
      if (key in QuantumForgePriorityQueue.PRIORITY_RANKS) {
        const value = QuantumForgePriorityQueue.PRIORITY_RANKS[key];
        return {
          value,
          label: QuantumForgePriorityQueue.RANK_LABELS[value]
        };
      }
      const parsed = Number(key);
      if (key !== '' && Number.isFinite(parsed)) {
        return {
          value: parsed,
          label: QuantumForgePriorityQueue.RANK_LABELS[parsed] || `P${parsed}`
        };
      }
    }

    throw new TypeError(`Unsupported priority rank: ${String(priority)}`);
  }

  #compare(a, b) {
    if (a.priority !== b.priority) {
      if (this.mode === 'max') {
        return a.priority > b.priority ? -1 : 1;
      }
      return a.priority < b.priority ? -1 : 1;
    }
    if (a.seq === b.seq) return 0;
    return a.seq < b.seq ? -1 : 1;
  }

  #hasHigherPriority(a, b) {
    return this.#compare(a, b) < 0;
  }

  #swap(i, j) {
    const tmp = this.#heap[i];
    this.#heap[i] = this.#heap[j];
    this.#heap[j] = tmp;
  }

  #bubbleUp(index) {
    let idx = index;
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      if (this.#hasHigherPriority(this.#heap[idx], this.#heap[parentIdx])) {
        this.#swap(idx, parentIdx);
        idx = parentIdx;
      } else {
        break;
      }
    }
  }

  #sinkDown(index) {
    let idx = index;
    const len = this.#heap.length;

    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let bestIdx = idx;

      if (leftIdx < len && this.#hasHigherPriority(this.#heap[leftIdx], this.#heap[bestIdx])) {
        bestIdx = leftIdx;
      }
      if (rightIdx < len && this.#hasHigherPriority(this.#heap[rightIdx], this.#heap[bestIdx])) {
        bestIdx = rightIdx;
      }

      if (bestIdx === idx) {
        break;
      }

      this.#swap(idx, bestIdx);
      idx = bestIdx;
    }
  }

  /**
   * Enqueues an item with a given priority rank or number.
   * Rejects under backpressure when maxCapacity is reached.
   */
  enqueue(item, priority = 'normal') {
    const { value, label } = QuantumForgePriorityQueue.resolvePriority(priority);

    if (this.#heap.length >= this.maxCapacity) {
      this.#droppedCount += 1;
      this.#emit();
      return null;
    }

    const entry = {
      id: `qf-evt-${this.#seq + 1}`,
      item,
      priority: value,
      priorityLabel: label,
      seq: this.#seq++,
      enqueuedAt: this._now()
    };

    this.#heap.push(entry);
    this.#bubbleUp(this.#heap.length - 1);
    this.#enqueuedCount += 1;
    if (this.#heap.length > this.#peakDepth) {
      this.#peakDepth = this.#heap.length;
    }

    this.#emit();
    return { ...entry };
  }

  /**
   * Returns the highest-priority entry without removing it, or null if empty.
   */
  peek() {
    if (this.#heap.length === 0) {
      return null;
    }
    return { ...this.#heap[0] };
  }

  /**
   * Removes and returns the highest-priority entry (FIFO for equal priorities), or null if empty.
   */
  dequeue() {
    if (this.#heap.length === 0) {
      return null;
    }

    const root = this.#heap[0];
    const last = this.#heap.pop();
    if (this.#heap.length > 0 && last) {
      this.#heap[0] = last;
      this.#sinkDown(0);
    }

    const dispatchedAt = this._now();
    const waitMs = Math.max(0, dispatchedAt - root.enqueuedAt);
    this.#dispatchedCount += 1;
    this.#totalWaitMs += waitMs;

    const result = {
      ...root,
      dispatchedAt,
      waitMs
    };

    this.#emit();
    return result;
  }

  #refillTokens(nowMs) {
    if (this.#rateLimitMs <= 0) {
      this.#tokens = this.bucketCapacity;
      this.#lastRefillAt = nowMs;
      return;
    }
    const elapsed = Math.max(0, nowMs - this.#lastRefillAt);
    const added = elapsed / this.#rateLimitMs;
    if (added > 0) {
      this.#tokens = Math.min(this.bucketCapacity, this.#tokens + added);
      this.#lastRefillAt = nowMs;
    }
  }

  #msUntilNextToken(nowMs) {
    if (this.#rateLimitMs <= 0) {
      return 0;
    }
    this.#refillTokens(nowMs);
    if (this.#tokens >= 1) {
      return 0;
    }
    return Math.max(1, Math.ceil((1 - this.#tokens) * this.#rateLimitMs));
  }

  /**
   * Starts an asynchronous token-bucket rate-limited dispatcher loop.
   */
  startDispatcher(rateLimitMs = 250, handler) {
    if (!Number.isFinite(rateLimitMs) || rateLimitMs < 0) {
      throw new RangeError('rateLimitMs must be a finite number >= 0.');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function.');
    }

    this.stopDispatcher();
    this.#rateLimitMs = rateLimitMs;
    this.#handler = handler;
    this.#running = true;
    this.#tokens = Math.min(this.bucketCapacity, Math.max(1, this.#tokens));
    this.#lastRefillAt = this._now();

    this.#scheduleNextTick(0);
    this.#emit();
    return this;
  }

  setRateLimit(rateLimitMs) {
    if (!Number.isFinite(rateLimitMs) || rateLimitMs < 0) {
      throw new RangeError('rateLimitMs must be a finite number >= 0.');
    }
    this.#refillTokens(this._now());
    this.#rateLimitMs = rateLimitMs;
    if (this.#running && !this.#inFlight) {
      if (this.#timer !== null) {
        clearTimeout(this.#timer);
        this.#timer = null;
      }
      const waitMs = this.isEmpty() ? Math.max(25, Math.min(rateLimitMs, 100)) : this.#msUntilNextToken(this._now());
      this.#scheduleNextTick(waitMs);
    }
    this.#emit();
  }

  stopDispatcher() {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#emit();
  }

  #scheduleNextTick(delayMs) {
    if (!this.#running || this.#timer !== null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#drainStep();
    }, delayMs);
  }

  async #drainStep() {
    if (!this.#running || this.#inFlight) {
      return;
    }

    if (this.isEmpty()) {
      this.#refillTokens(this._now());
      const idlePollMs = this.#rateLimitMs === 0 ? 10 : Math.max(20, Math.min(this.#rateLimitMs, 100));
      this.#scheduleNextTick(idlePollMs);
      return;
    }

    const nowMs = this._now();
    const waitForToken = this.#msUntilNextToken(nowMs);
    if (waitForToken > 0) {
      this.#scheduleNextTick(waitForToken);
      return;
    }

    this.#tokens = Math.max(0, this.#tokens - 1);
    const entry = this.dequeue();
    if (!entry) {
      this.#scheduleNextTick(this.#rateLimitMs);
      return;
    }

    this.#inFlight = true;
    try {
      await this.#handler(entry);
      this.#recordHistory({ ...entry, status: 'dispatched' });
    } catch (error) {
      this.#recordHistory({
        ...entry,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.#inFlight = false;
      this.#emit();
      if (this.#running) {
        const nextDelay = this.isEmpty()
          ? (this.#rateLimitMs === 0 ? 10 : Math.max(20, Math.min(this.#rateLimitMs, 100)))
          : this.#msUntilNextToken(this._now());
        this.#scheduleNextTick(nextDelay);
      }
    }
  }

  #recordHistory(record) {
    this.#history.unshift(record);
    if (this.#history.length > this.maxHistory) {
      this.#history.length = this.maxHistory;
    }
  }

  getHistory() {
    return this.#history.map(item => ({ ...item }));
  }

  /**
   * Returns a priority-ordered copy of currently queued items without mutating the heap.
   */
  getSortedSnapshot() {
    return [...this.#heap]
      .sort((a, b) => this.#compare(a, b))
      .map(entry => ({ ...entry }));
  }

  getMetrics() {
    const size = this.#heap.length;
    const utilization = this.maxCapacity === Infinity ? 0 : size / this.maxCapacity;
    let backpressureLevel = 'nominal';
    if (utilization >= 1) {
      backpressureLevel = 'saturated';
    } else if (utilization >= this.highWaterRatio) {
      backpressureLevel = 'elevated';
    } else if (utilization >= 0.4) {
      backpressureLevel = 'moderate';
    }

    this.#refillTokens(this._now());

    return {
      mode: this.mode,
      size,
      maxCapacity: this.maxCapacity,
      utilization,
      utilizationPct: Math.round(utilization * 100),
      backpressureLevel,
      enqueuedCount: this.#enqueuedCount,
      dispatchedCount: this.#dispatchedCount,
      droppedCount: this.#droppedCount,
      peakDepth: this.#peakDepth,
      tokens: Number(this.#tokens.toFixed(2)),
      bucketCapacity: this.bucketCapacity,
      rateLimitMs: this.#rateLimitMs,
      running: this.#running,
      avgWaitMs: this.#dispatchedCount > 0 ? Math.round(this.#totalWaitMs / this.#dispatchedCount) : 0
    };
  }

  clear() {
    this.#heap = [];
    this.#emit();
  }

  subscribe(fn) {
    if (typeof fn !== 'function') {
      return () => {};
    }
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    const snapshot = {
      metrics: this.getMetrics(),
      queued: this.getSortedSnapshot(),
      history: this.getHistory()
    };
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('PriorityQueue listener error:', err);
      }
    }
  }
}

// Browser UI bindings
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.QuantumForgePriorityQueue = QuantumForgePriorityQueue;

  document.addEventListener('DOMContentLoaded', () => {
    const queue = new QuantumForgePriorityQueue({
      mode: 'max',
      maxCapacity: 24,
      highWaterRatio: 0.75,
      bucketCapacity: 2
    });

    const form = document.getElementById('enqueue-form');
    const payloadInput = document.getElementById('event-payload');
    const prioritySelect = document.getElementById('event-priority');
    const burstBtn = document.getElementById('burst-btn');
    const toggleBtn = document.getElementById('toggle-dispatcher-btn');
    const clearBtn = document.getElementById('clear-queue-btn');
    const rateSlider = document.getElementById('rate-slider');
    const rateValueEl = document.getElementById('rate-value');

    const depthBarEl = document.getElementById('queue-depth-bar');
    const depthLabelEl = document.getElementById('queue-depth-label');
    const bpBadgeEl = document.getElementById('backpressure-badge');
    const tokenBarEl = document.getElementById('token-bucket-bar');
    const tokenLabelEl = document.getElementById('token-label');

    const metricEnqueuedEl = document.getElementById('metric-enqueued');
    const metricDispatchedEl = document.getElementById('metric-dispatched');
    const metricDroppedEl = document.getElementById('metric-dropped');
    const metricWaitEl = document.getElementById('metric-wait');

    const heapListEl = document.getElementById('heap-preview-list');
    const feedListEl = document.getElementById('processed-feed-list');
    const statusToastEl = document.getElementById('backpressure-alert');

    let lastAlertTimer = null;

    const showAlert = (message) => {
      if (!statusToastEl) return;
      statusToastEl.textContent = message;
      statusToastEl.hidden = false;
      if (lastAlertTimer) clearTimeout(lastAlertTimer);
      lastAlertTimer = setTimeout(() => {
        statusToastEl.hidden = true;
      }, 2600);
    };

    const makeBadge = (label) => {
      const badge = document.createElement('span');
      const norm = String(label || 'normal').toLowerCase();
      badge.className = `priority-badge badge-${norm}`;
      badge.textContent = label;
      return badge;
    };

    const formatTime = (ms) => {
      const d = new Date(ms);
      return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    const render = ({ metrics, queued, history }) => {
      if (depthBarEl) {
        depthBarEl.style.width = `${metrics.utilizationPct}%`;
        depthBarEl.dataset.level = metrics.backpressureLevel;
      }
      if (depthLabelEl) {
        depthLabelEl.textContent = `${metrics.size} / ${metrics.maxCapacity} (${metrics.utilizationPct}%)`;
      }
      if (bpBadgeEl) {
        bpBadgeEl.textContent = metrics.backpressureLevel.toUpperCase();
        bpBadgeEl.className = `bp-status bp-${metrics.backpressureLevel}`;
      }
      if (tokenBarEl) {
        const tokenPct = Math.min(100, Math.round((metrics.tokens / metrics.bucketCapacity) * 100));
        tokenBarEl.style.width = `${tokenPct}%`;
      }
      if (tokenLabelEl) {
        tokenLabelEl.textContent = `${metrics.tokens} / ${metrics.bucketCapacity} tokens`;
      }

      if (metricEnqueuedEl) metricEnqueuedEl.textContent = String(metrics.enqueuedCount);
      if (metricDispatchedEl) metricDispatchedEl.textContent = String(metrics.dispatchedCount);
      if (metricDroppedEl) metricDroppedEl.textContent = String(metrics.droppedCount);
      if (metricWaitEl) metricWaitEl.textContent = `${metrics.avgWaitMs} ms`;

      if (toggleBtn) {
        toggleBtn.textContent = metrics.running ? 'Pause Dispatcher' : 'Start Dispatcher';
        toggleBtn.dataset.running = String(metrics.running);
      }

      if (heapListEl) {
        heapListEl.replaceChildren();
        if (queued.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'empty-state';
          empty.textContent = 'Heap is idle. Enqueue quantum events to inspect priority order.';
          heapListEl.appendChild(empty);
        } else {
          queued.forEach((entry, idx) => {
            const li = document.createElement('li');
            li.className = 'heap-item';

            const left = document.createElement('div');
            left.className = 'item-main';

            const rankIdx = document.createElement('span');
            rankIdx.className = 'seq-tag';
            rankIdx.textContent = `#${idx + 1} · seq ${entry.seq}`;

            const text = document.createElement('span');
            text.className = 'item-payload';
            text.textContent = typeof entry.item === 'string' ? entry.item : JSON.stringify(entry.item);

            left.append(rankIdx, makeBadge(entry.priorityLabel), text);

            const time = document.createElement('span');
            time.className = 'item-time';
            time.textContent = formatTime(entry.enqueuedAt);

            li.append(left, time);
            heapListEl.appendChild(li);
          });
        }
      }

      if (feedListEl) {
        feedListEl.replaceChildren();
        if (history.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'empty-state';
          empty.textContent = 'No events dispatched yet.';
          feedListEl.appendChild(empty);
        } else {
          history.slice(0, 20).forEach((entry) => {
            const card = document.createElement('li');
            card.className = `feed-card feed-${String(entry.priorityLabel).toLowerCase()}`;

            const top = document.createElement('div');
            top.className = 'feed-card-header';

            const meta = document.createElement('div');
            meta.className = 'item-main';
            const idTag = document.createElement('span');
            idTag.className = 'seq-tag';
            idTag.textContent = entry.id;
            meta.append(makeBadge(entry.priorityLabel), idTag);

            const stats = document.createElement('span');
            stats.className = 'item-time';
            stats.textContent = `${formatTime(entry.dispatchedAt)} · wait ${entry.waitMs}ms`;

            top.append(meta, stats);

            const body = document.createElement('p');
            body.className = 'feed-payload';
            body.textContent = typeof entry.item === 'string' ? entry.item : JSON.stringify(entry.item);

            card.append(top, body);
            feedListEl.appendChild(card);
          });
        }
      }
    };

    queue.subscribe(render);

    const dispatchHandler = async () => {};

    const initialRate = rateSlider ? Number(rateSlider.value) : 450;
    if (rateValueEl) rateValueEl.textContent = `${initialRate} ms`;
    queue.startDispatcher(initialRate, dispatchHandler);

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const payload = payloadInput ? payloadInput.value.trim() : '';
        const priority = prioritySelect ? prioritySelect.value : 'normal';
        if (!payload) {
          showAlert('Please enter an event payload.');
          return;
        }
        const accepted = queue.enqueue(payload, priority);
        if (!accepted) {
          showAlert('Backpressure active: queue at max capacity (event dropped).');
        } else if (payloadInput) {
          payloadInput.value = '';
          payloadInput.focus();
        }
      });
    }

    if (burstBtn) {
      burstBtn.addEventListener('click', () => {
        const samples = [
          ['Cryo-valve pressure spike on Node-7', 'urgent'],
          ['Qubit-12 phase calibration drift', 'high'],
          ['Telemetry frame sync #409', 'normal'],
          ['Archive diagnostic snapshot', 'low'],
          ['Error syndrome parity check', 'high'],
          ['Heartbeat ping', 'low']
        ];
        let dropped = 0;
        samples.forEach(([msg, prio]) => {
          if (!queue.enqueue(msg, prio)) dropped += 1;
        });
        if (dropped > 0) {
          showAlert(`Backpressure dropped ${dropped} burst event(s) due to queue saturation.`);
        }
      });
    }

    if (rateSlider) {
      rateSlider.addEventListener('input', () => {
        const ms = Number(rateSlider.value);
        if (rateValueEl) rateValueEl.textContent = `${ms} ms`;
        queue.setRateLimit(ms);
      });
    }

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        if (queue.getMetrics().running) {
          queue.stopDispatcher();
        } else {
          const ms = rateSlider ? Number(rateSlider.value) : 450;
          queue.startDispatcher(ms, dispatchHandler);
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        queue.clear();
      });
    }

    // Seed initial demonstration events
    queue.enqueue('QPU Entanglement Link Stabilized', 'normal');
    queue.enqueue('Thermal Shield Anomaly Detected', 'urgent');
    queue.enqueue('Gate Fidelity Telemetry Batch', 'high');
  });
}
