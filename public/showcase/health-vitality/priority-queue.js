/**
 * HealthVitalityPriorityQueue
 * In-memory binary heap priority event queue & asynchronous backpressure dispatcher
 * for Health Vitality biometric telemetry and clinical triage pipelines.
 *
 * Supports max-heap (default: Urgent=4 > High=3 > Normal=2 > Low=1) or min-heap mode,
 * strict FIFO ordering for identical priorities, token-bucket dispatch pacing,
 * and backpressure queue metrics.
 */

export const PRIORITY_MAP = Object.freeze({
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
});

export const PRIORITY_LABELS = Object.freeze({
  4: 'Urgent',
  3: 'High',
  2: 'Normal',
  1: 'Low',
});

/**
 * Normalizes a numeric or string priority rank into a finite number.
 * @param {number|string} priority
 * @returns {number}
 */
function normalizePriority(priority) {
  if (typeof priority === 'string') {
    const mapped = PRIORITY_MAP[priority.trim().toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  const numeric = Number(priority);
  return Number.isFinite(numeric) ? numeric : PRIORITY_MAP.normal;
}

/**
 * Formats a priority value into a human-readable badge label.
 * @param {number} rank
 * @returns {string}
 */
export function getPriorityLabel(rank) {
  return PRIORITY_LABELS[Number(rank)] ?? `P${rank}`;
}

export class HealthVitalityPriorityQueue {
  /**
   * @param {object} [options]
   * @param {'max'|'min'} [options.mode='max'] - Heap comparison mode
   * @param {number} [options.maxCapacity=100] - Soft/hard capacity baseline for backpressure metrics
   * @param {boolean} [options.enforceCapacity=false] - Whether enqueue drops items once at maxCapacity
   * @param {number} [options.highWatermarkRatio=0.75] - Ratio (0..1] above which backpressure is flagged
   * @param {number} [options.bucketCapacity=1] - Max token bucket capacity for dispatch bursts
   * @param {Function} [options.clock] - Injectable clock returning ms (defaults to Date.now)
   */
  constructor(options = {}) {
    const {
      mode = 'max',
      maxCapacity = 100,
      enforceCapacity = false,
      highWatermarkRatio = 0.75,
      bucketCapacity = 1,
      clock = () => Date.now(),
    } = options;

    if (mode !== 'max' && mode !== 'min') {
      throw new RangeError("mode must be 'max' or 'min'.");
    }
    if (!Number.isFinite(maxCapacity) && maxCapacity !== Infinity) {
      throw new RangeError('maxCapacity must be a positive number or Infinity.');
    }
    if (maxCapacity < 1) {
      throw new RangeError('maxCapacity must be at least 1.');
    }
    if (!Number.isFinite(highWatermarkRatio) || highWatermarkRatio <= 0 || highWatermarkRatio > 1) {
      throw new RangeError('highWatermarkRatio must be within (0, 1].');
    }
    if (!Number.isFinite(bucketCapacity) || bucketCapacity < 1) {
      throw new RangeError('bucketCapacity must be at least 1.');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function.');
    }

    this.mode = mode;
    this.maxCapacity = maxCapacity;
    this.enforceCapacity = Boolean(enforceCapacity);
    this.highWatermarkRatio = highWatermarkRatio;
    this.bucketCapacity = bucketCapacity;
    this.clock = clock;

    this.heap = [];
    this.sequenceCounter = 0;
    this.dispatcherTimer = null;
    this.isDispatching = false;
    this.rateLimitMs = 500;

    // Token-bucket pacing state
    this.tokens = 0;
    this.lastRefillAt = this.clock();

    // Backpressure & telemetry metrics
    this.enqueuedCount = 0;
    this.dispatchedCount = 0;
    this.droppedCount = 0;
    this.maxDepthObserved = 0;
    this.totalWaitTimeMs = 0;
    this.lastWaitTimeMs = 0;
    this.throttledCycles = 0;

    this.listeners = new Set();
  }

  /**
   * Enqueues an item into the binary heap with the specified priority.
   * @param {*} item - Event payload
   * @param {number|string} [priority=2] - Priority rank (4/urgent, 3/high, 2/normal, 1/low, or custom number)
   * @returns {object|null} Enqueued node metadata, or null if rejected due to enforceCapacity backpressure
   */
  enqueue(item, priority = PRIORITY_MAP.normal) {
    if (this.enforceCapacity && this.heap.length >= this.maxCapacity) {
      this.droppedCount++;
      this.notify('backpressure_drop', {
        item,
        priority: normalizePriority(priority),
        metrics: this.getMetrics(),
      });
      return null;
    }

    const numericPriority = normalizePriority(priority);
    const now = this.clock();
    const order = ++this.sequenceCounter;

    const node = {
      id: `hv-evt-${order}`,
      item,
      priority: numericPriority,
      insertOrder: order,
      timestamp: now,
    };

    this.heap.push(node);
    this.#bubbleUp(this.heap.length - 1);

    this.enqueuedCount++;
    if (this.heap.length > this.maxDepthObserved) {
      this.maxDepthObserved = this.heap.length;
    }

    this.notify('enqueue', { node, depth: this.heap.length, metrics: this.getMetrics() });
    return node;
  }

  /**
   * Dequeues and returns the highest-priority item (FIFO on ties), or null if empty.
   * @returns {*} The dequeued item payload or null
   */
  dequeue() {
    const node = this.#popTopNode();
    return node ? node.item : null;
  }

  /**
   * Returns the highest-priority item without removing it, or null if empty.
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
   * Returns current number of queued items.
   * @returns {number}
   */
  size() {
    return this.heap.length;
  }

  /**
   * Returns true if no items are queued.
   * @returns {boolean}
   */
  isEmpty() {
    return this.heap.length === 0;
  }

  /**
   * Removes all pending items from the heap.
   */
  clear() {
    this.heap = [];
    this.notify('clear', { depth: 0, metrics: this.getMetrics() });
  }

  /**
   * Returns a shallow snapshot of the current binary heap array.
   * @returns {Array<object>}
   */
  getHeapSnapshot() {
    return this.heap.map((node) => ({ ...node }));
  }

  /**
   * Returns current queue depth, token-bucket state, and backpressure metrics.
   * @returns {object}
   */
  getMetrics() {
    const depth = this.heap.length;
    const finiteCapacity = Number.isFinite(this.maxCapacity) ? this.maxCapacity : Math.max(depth, 1);
    const utilization = Number((depth / finiteCapacity).toFixed(4));
    const isBackpressured = Number.isFinite(this.maxCapacity)
      ? utilization >= this.highWatermarkRatio
      : false;
    const avgWaitTimeMs = this.dispatchedCount > 0
      ? Math.round(this.totalWaitTimeMs / this.dispatchedCount)
      : 0;

    return {
      depth,
      maxCapacity: this.maxCapacity,
      utilization,
      utilizationPercent: Math.min(100, Math.round(utilization * 100)),
      isBackpressured,
      enqueuedCount: this.enqueuedCount,
      dispatchedCount: this.dispatchedCount,
      droppedCount: this.droppedCount,
      maxDepthObserved: this.maxDepthObserved,
      avgWaitTimeMs,
      lastWaitTimeMs: this.lastWaitTimeMs,
      throttledCycles: this.throttledCycles,
      tokensAvailable: Number(this.tokens.toFixed(3)),
      bucketCapacity: this.bucketCapacity,
      isDispatching: this.isDispatching,
      rateLimitMs: this.rateLimitMs,
    };
  }

  /**
   * Starts an asynchronous rate-controlled dispatcher backed by token-bucket pacing.
   * @param {number} [rateLimitMs=500] - Interval in ms between token refills / dispatches
   * @param {Function|null} [handler=null] - Callback invoked with (item, metadata)
   * @param {object} [options]
   * @param {number} [options.burstCapacity] - Optional override for token-bucket capacity
   * @returns {{ stop: Function, isRunning: Function, setRate: Function }}
   */
  startDispatcher(rateLimitMs = 500, handler = null, options = {}) {
    const intervalMs = Number(rateLimitMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError('rateLimitMs must be a positive number.');
    }

    this.stopDispatcher({ silent: true });

    if (options.burstCapacity !== undefined) {
      if (!Number.isFinite(options.burstCapacity) || options.burstCapacity < 1) {
        throw new RangeError('burstCapacity must be at least 1.');
      }
      this.bucketCapacity = options.burstCapacity;
    }

    this.rateLimitMs = intervalMs;
    this.isDispatching = true;
    this.tokens = 0;
    this.lastRefillAt = this.clock();

    const step = () => {
      if (!this.isDispatching) return;

      this.#refillBucket();

      if (this.heap.length === 0) {
        return;
      }

      if (this.tokens < 1) {
        this.throttledCycles++;
        return;
      }

      // Dispatch at most 1 item per interval when bucketCapacity is 1,
      // or drain burst tokens when burstCapacity > 1.
      while (this.heap.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const node = this.#popTopNode();
        if (node && typeof handler === 'function') {
          handler(node.item, {
            ...node,
            waitTimeMs: this.lastWaitTimeMs,
            metrics: this.getMetrics(),
          });
        }
      }
    };

    this.dispatcherTimer = setInterval(step, intervalMs);
    this.notify('dispatcher_start', { rateLimitMs: intervalMs, metrics: this.getMetrics() });

    return {
      stop: () => this.stopDispatcher(),
      isRunning: () => this.isDispatching,
      setRate: (nextRateMs) => this.startDispatcher(nextRateMs, handler, options),
    };
  }

  /**
   * Stops the active rate-controlled dispatcher.
   * @param {object} [options]
   * @param {boolean} [options.silent=false]
   */
  stopDispatcher(options = {}) {
    if (this.dispatcherTimer !== null) {
      clearInterval(this.dispatcherTimer);
      this.dispatcherTimer = null;
    }
    const wasRunning = this.isDispatching;
    this.isDispatching = false;
    if (!options.silent && wasRunning) {
      this.notify('dispatcher_stop', { metrics: this.getMetrics() });
    }
  }

  /**
   * Subscribes a listener to queue and dispatcher events.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Listener callback must be a function.');
    }
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notifies registered listeners of state transitions.
   * @param {string} event
   * @param {object} data
   */
  notify(event, data) {
    for (const fn of this.listeners) {
      fn(event, data);
    }
  }

  // --- Internal Token Bucket & Binary Heap Mechanics ---

  #refillBucket() {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.lastRefillAt);
    // Guarantee at least 1 token per scheduled interval tick even under timer jitter,
    // while capping accumulated burst capacity at bucketCapacity.
    const earned = Math.max(1, elapsed / this.rateLimitMs);
    this.tokens = Math.min(this.bucketCapacity, this.tokens + earned);
    this.lastRefillAt = now;
  }

  #popTopNode() {
    if (this.heap.length === 0) return null;

    const top = this.heap[0];
    const bottom = this.heap.pop();

    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.#sinkDown(0);
    }

    const waitTimeMs = Math.max(0, this.clock() - top.timestamp);
    this.dispatchedCount++;
    this.lastWaitTimeMs = waitTimeMs;
    this.totalWaitTimeMs += waitTimeMs;

    this.notify('dequeue', {
      node: top,
      waitTimeMs,
      depth: this.heap.length,
      dispatchedCount: this.dispatchedCount,
      metrics: this.getMetrics(),
    });

    return top;
  }

  #isHigherPriority(a, b) {
    if (a.priority !== b.priority) {
      return this.mode === 'max' ? a.priority > b.priority : a.priority < b.priority;
    }
    return a.insertOrder < b.insertOrder;
  }

  #bubbleUp(index) {
    let idx = index;
    const node = this.heap[idx];

    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      const parent = this.heap[parentIdx];

      if (this.#isHigherPriority(node, parent)) {
        this.heap[idx] = parent;
        this.heap[parentIdx] = node;
        idx = parentIdx;
      } else {
        break;
      }
    }
  }

  #sinkDown(index) {
    let idx = index;
    const length = this.heap.length;
    const node = this.heap[idx];

    while (true) {
      const leftChildIdx = 2 * idx + 1;
      const rightChildIdx = 2 * idx + 2;
      let targetIdx = null;

      if (leftChildIdx < length) {
        const leftChild = this.heap[leftChildIdx];
        if (this.#isHigherPriority(leftChild, node)) {
          targetIdx = leftChildIdx;
        }
      }

      if (rightChildIdx < length) {
        const rightChild = this.heap[rightChildIdx];
        const compareTarget = targetIdx === null ? node : this.heap[leftChildIdx];
        if (this.#isHigherPriority(rightChild, compareTarget)) {
          targetIdx = rightChildIdx;
        }
      }

      if (targetIdx === null) break;

      this.heap[idx] = this.heap[targetIdx];
      this.heap[targetIdx] = node;
      idx = targetIdx;
    }
  }
}

// --- Browser DOM Controller ---
if (typeof document !== 'undefined') {
  const initPriorityQueueLab = () => {
    const root = document.querySelector('[data-priority-queue-lab]');
    if (!root) return;

    const MAX_QUEUE_CAPACITY = 20;
    const queue = new HealthVitalityPriorityQueue({
      mode: 'max',
      maxCapacity: MAX_QUEUE_CAPACITY,
      enforceCapacity: true,
      highWatermarkRatio: 0.7,
      bucketCapacity: 1,
    });

    const depthVal = root.querySelector('#depth-val');
    const topPriorityVal = root.querySelector('#top-priority-val');
    const dispatchedCountVal = root.querySelector('#dispatched-count-val');
    const dispatcherStatusVal = root.querySelector('#dispatcher-status-val');
    const backpressureBadge = root.querySelector('#backpressure-status-val');
    const droppedCountVal = root.querySelector('#dropped-count-val');
    const avgWaitVal = root.querySelector('#avg-wait-val');
    const depthProgressBar = root.querySelector('#depth-progress-bar');
    const gaugePercent = root.querySelector('#gauge-percent');
    const enqueueForm = root.querySelector('#enqueue-form');
    const taskPayloadInput = root.querySelector('#task-payload');
    const priorityRankSelect = root.querySelector('#priority-rank');
    const presetSelect = root.querySelector('#preset-select');
    const rateSlider = root.querySelector('#rate-slider');
    const rateSliderVal = root.querySelector('#rate-slider-val');
    const toggleDispatchBtn = root.querySelector('#toggle-dispatch-btn');
    const dequeueManualBtn = root.querySelector('#dequeue-manual-btn');
    const burstBtn = root.querySelector('#burst-btn');
    const clearQueueBtn = root.querySelector('#clear-queue-btn');
    const heapNodesList = root.querySelector('#heap-nodes-list');
    const heapNodesCount = root.querySelector('#heap-nodes-count');
    const eventFeed = root.querySelector('#event-feed');
    const feedCount = root.querySelector('#feed-count');

    const processedHistory = [];

    const getPriorityBadgeClass = (rank) => {
      switch (Number(rank)) {
        case 4: return 'badge-urgent';
        case 3: return 'badge-high';
        case 2: return 'badge-normal';
        case 1: return 'badge-low';
        default: return 'badge-normal';
      }
    };

    const formatPayload = (item) => (typeof item === 'string' ? item : JSON.stringify(item));

    function updateUI() {
      const metrics = queue.getMetrics();
      const topNode = queue.peekNode();

      depthVal.textContent = `${metrics.depth} / ${MAX_QUEUE_CAPACITY}`;
      topPriorityVal.textContent = topNode
        ? `${getPriorityLabel(topNode.priority)} (P${topNode.priority})`
        : 'None';
      dispatchedCountVal.textContent = String(metrics.dispatchedCount);
      droppedCountVal.textContent = String(metrics.droppedCount);
      avgWaitVal.textContent = `${metrics.avgWaitTimeMs} ms`;
      heapNodesCount.textContent = `${metrics.depth} queued`;
      feedCount.textContent = `${processedHistory.length} processed`;

      // Gauge progress & backpressure indicator
      const pct = metrics.utilizationPercent;
      gaugePercent.textContent = `${pct}%`;
      depthProgressBar.style.width = `${pct}%`;
      depthProgressBar.classList.toggle('bar-warning', pct >= 50 && pct < 70);
      depthProgressBar.classList.toggle('bar-critical', pct >= 70);

      if (metrics.depth >= MAX_QUEUE_CAPACITY) {
        backpressureBadge.textContent = 'Saturated (Shedding)';
        backpressureBadge.className = 'bp-pill bp-critical';
      } else if (metrics.isBackpressured) {
        backpressureBadge.textContent = 'Backpressure Active';
        backpressureBadge.className = 'bp-pill bp-warning';
      } else {
        backpressureBadge.textContent = 'Nominal';
        backpressureBadge.className = 'bp-pill bp-nominal';
      }

      // Render Heap Nodes safely
      heapNodesList.replaceChildren();
      const snapshot = queue.getHeapSnapshot();
      if (snapshot.length === 0) {
        const emptyHint = document.createElement('p');
        emptyHint.className = 'empty-hint';
        emptyHint.textContent = 'Heap is currently empty. Enqueue telemetry events to inspect binary heap ordering.';
        heapNodesList.appendChild(emptyHint);
      } else {
        snapshot.forEach((node, idx) => {
          const itemDiv = document.createElement('div');
          itemDiv.className = 'heap-node-item';

          const leftWrap = document.createElement('div');
          leftWrap.className = 'heap-node-main';

          const idxSpan = document.createElement('span');
          idxSpan.className = 'node-idx';
          idxSpan.textContent = `[#${idx}]`;

          const titleSpan = document.createElement('span');
          titleSpan.className = 'node-title';
          titleSpan.textContent = formatPayload(node.item);

          leftWrap.append(idxSpan, titleSpan);

          const badge = document.createElement('span');
          badge.className = `priority-badge ${getPriorityBadgeClass(node.priority)}`;
          badge.textContent = getPriorityLabel(node.priority);

          itemDiv.append(leftWrap, badge);
          heapNodesList.appendChild(itemDiv);
        });
      }

      // Render Processed Event Feed safely
      eventFeed.replaceChildren();
      if (processedHistory.length === 0) {
        const emptyFeed = document.createElement('p');
        emptyFeed.className = 'empty-hint';
        emptyFeed.textContent = 'Dispatched clinical events will stream here in prioritized order.';
        eventFeed.appendChild(emptyFeed);
      } else {
        processedHistory.slice(0, 18).forEach((evt) => {
          const card = document.createElement('article');
          card.className = 'event-card';

          const header = document.createElement('div');
          header.className = 'event-card-header';

          const badge = document.createElement('span');
          badge.className = `priority-badge ${getPriorityBadgeClass(evt.priority)}`;
          badge.textContent = getPriorityLabel(evt.priority);

          const metaSpan = document.createElement('span');
          metaSpan.className = 'event-timestamp';
          metaSpan.textContent = `${new Date(evt.dispatchedAt).toLocaleTimeString()} • wait ${evt.waitTimeMs}ms`;

          header.append(badge, metaSpan);

          const payloadEl = document.createElement('p');
          payloadEl.className = 'event-payload';
          payloadEl.textContent = formatPayload(evt.item);

          card.append(header, payloadEl);
          eventFeed.appendChild(card);
        });
      }
    }

    function recordDispatched(item, metadata) {
      processedHistory.unshift({
        item,
        priority: metadata.priority,
        waitTimeMs: metadata.waitTimeMs ?? 0,
        dispatchedAt: Date.now(),
      });
      updateUI();
    }

    let currentRateMs = Number(rateSlider.value) || 650;
    queue.startDispatcher(currentRateMs, recordDispatched);
    dispatcherStatusVal.textContent = 'Active (Token-Bucket)';

    enqueueForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const payload = taskPayloadInput.value.trim();
      const priority = Number(priorityRankSelect.value);
      if (!payload) return;
      queue.enqueue(payload, priority);
      updateUI();
    });

    presetSelect.addEventListener('change', (event) => {
      const [text, priority] = event.target.value.split('|');
      if (text && priority) {
        taskPayloadInput.value = text;
        priorityRankSelect.value = priority;
      }
    });

    rateSlider.addEventListener('input', (event) => {
      currentRateMs = Number(event.target.value);
      rateSliderVal.textContent = `${currentRateMs} ms / event`;
      if (queue.isDispatching) {
        queue.startDispatcher(currentRateMs, recordDispatched);
      }
    });

    toggleDispatchBtn.addEventListener('click', () => {
      if (queue.isDispatching) {
        queue.stopDispatcher();
        toggleDispatchBtn.textContent = 'Resume Dispatcher';
        toggleDispatchBtn.className = 'toggle-btn paused-state';
        dispatcherStatusVal.textContent = 'Paused';
      } else {
        queue.startDispatcher(currentRateMs, recordDispatched);
        toggleDispatchBtn.textContent = 'Pause Dispatcher';
        toggleDispatchBtn.className = 'toggle-btn active-state';
        dispatcherStatusVal.textContent = 'Active (Token-Bucket)';
      }
    });

    dequeueManualBtn.addEventListener('click', () => {
      const topNode = queue.peekNode();
      if (!topNode) return;
      const item = queue.dequeue();
      recordDispatched(item, {
        ...topNode,
        waitTimeMs: Math.max(0, Date.now() - topNode.timestamp),
      });
    });

    burstBtn.addEventListener('click', () => {
      const burstEvents = [
        ['Wearable Step Count Sync: Ward 2', 1],
        ['Continuous Glucose Trend Packet: Room 408', 2],
        ['SpO2 Dip Warning (<91%): ICU Bed 7', 3],
        ['ECG Arrhythmia Tachycardia Spike: ICU Bed 3', 4],
        ['Hydration & Sleep Recovery Log: Outpatient #92', 1],
        ['Infusion Pump Occlusion Alert: Ward 5', 4],
      ];
      burstEvents.forEach(([msg, rank]) => queue.enqueue(msg, rank));
      updateUI();
    });

    clearQueueBtn.addEventListener('click', () => {
      queue.clear();
      updateUI();
    });

    // Seed initial clinical events
    queue.enqueue('Wearable Sleep Stage Telemetry Sync: Patient #104', 1);
    queue.enqueue('Metabolic Glucose Panel Polling: Ward B', 2);
    queue.enqueue('Elevated Blood Pressure Alert: Telemetry Bed 12', 3);
    queue.enqueue('CRITICAL: Ventricular Arrhythmia Detected — Bed 04', 4);
    updateUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPriorityQueueLab);
  } else {
    initPriorityQueueLab();
  }
}
