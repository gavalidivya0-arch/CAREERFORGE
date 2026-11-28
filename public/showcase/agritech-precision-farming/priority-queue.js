/**
 * AgritechPrecisionFarmingPriorityQueue
 * In-memory Binary Heap Priority Event Queue & Asynchronous Backpressure Dispatcher.
 * Preserves binary max-heap ordering with FIFO secondary keys for identical priorities.
 */

export const PRIORITY_MAP = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1
};

export class AgritechPrecisionFarmingPriorityQueue {
  constructor() {
    this.heap = [];
    this.sequenceCounter = 0;
    this.dispatcherTimer = null;
    this.isDispatching = false;
    this.dispatchedCount = 0;
    this.listeners = [];
  }

  /**
   * Enqueues an item into the binary heap.
   * @param {*} item - Task payload
   * @param {number|string} priority - Priority rank (4/urgent, 3/high, 2/normal, 1/low)
   * @returns {object} The enqueued node
   */
  enqueue(item, priority = 2) {
    let numericPriority = typeof priority === 'string'
      ? (PRIORITY_MAP[priority.toLowerCase()] ?? 2)
      : Number(priority);

    if (Number.isNaN(numericPriority)) {
      numericPriority = 2;
    }

    const node = {
      id: `task-${++this.sequenceCounter}`,
      item,
      priority: numericPriority,
      insertOrder: this.sequenceCounter,
      timestamp: Date.now()
    };

    this.heap.push(node);
    this.#bubbleUp(this.heap.length - 1);
    this.notify('enqueue', { node, depth: this.heap.length });
    return node;
  }

  /**
   * Dequeues the highest priority item from the binary heap.
   * @returns {*} The item payload or null if empty
   */
  dequeue() {
    if (this.heap.length === 0) return null;

    const top = this.heap[0];
    const bottom = this.heap.pop();

    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.#sinkDown(0);
    }

    this.dispatchedCount++;
    this.notify('dequeue', { node: top, depth: this.heap.length, dispatchedCount: this.dispatchedCount });
    return top.item;
  }

  /**
   * Peeks at the highest priority item without removing it.
   * @returns {*}
   */
  peek() {
    return this.heap.length > 0 ? this.heap[0].item : null;
  }

  /**
   * Returns current count of queued items.
   * @returns {number}
   */
  size() {
    return this.heap.length;
  }

  /**
   * Checks if heap is empty.
   * @returns {boolean}
   */
  isEmpty() {
    return this.heap.length === 0;
  }

  /**
   * Clears all items from the heap.
   */
  clear() {
    this.heap = [];
    this.notify('clear', { depth: 0 });
  }

  /**
   * Starts an asynchronous rate-controlled event dispatcher.
   * @param {number} rateLimitMs - Dispatch interval in milliseconds
   * @param {Function} [handler=null] - Optional handler callback invoked with (item, metadata)
   * @returns {object} Dispatcher controller { stop: Function, isRunning: Function }
   */
  startDispatcher(rateLimitMs = 500, handler = null) {
    this.stopDispatcher();
    this.isDispatching = true;

    this.dispatcherTimer = setInterval(() => {
      if (this.heap.length > 0) {
        const node = this.heap[0];
        const item = this.dequeue();
        if (typeof handler === 'function') {
          handler(item, node);
        }
      }
    }, rateLimitMs);

    this.notify('dispatcher_start', { rateLimitMs });

    return {
      stop: () => this.stopDispatcher(),
      isRunning: () => this.isDispatching
    };
  }

  /**
   * Stops the active dispatcher timer.
   */
  stopDispatcher() {
    if (this.dispatcherTimer) {
      clearInterval(this.dispatcherTimer);
      this.dispatcherTimer = null;
    }
    this.isDispatching = false;
    this.notify('dispatcher_stop', {});
  }

  /**
   * Subscribes a listener to queue state changes.
   * @param {Function} callback
   */
  subscribe(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }

  /**
   * Notifies registered listeners.
   */
  notify(event, data) {
    this.listeners.forEach((fn) => fn(event, data));
  }

  // --- Internal Binary Heap Mechanics ---

  /**
   * Compares two nodes: higher priority first, FIFO insertion order if priorities equal.
   */
  #isHigherPriority(a, b) {
    if (a.priority !== b.priority) {
      return a.priority > b.priority;
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

      if (targetIdx !== null) {
        this.heap[idx] = this.heap[targetIdx];
        this.heap[targetIdx] = node;
        idx = targetIdx;
      } else {
        break;
      }
    }
  }
}

// Browser DOM controller
if (typeof document !== 'undefined') {
  const initQueueLab = () => {
    const root = document.querySelector('[data-queue-lab]');
    if (!root) return;

    const queue = new AgritechPrecisionFarmingPriorityQueue();

    const depthVal = root.querySelector('#depth-val');
    const topPriorityVal = root.querySelector('#top-priority-val');
    const dispatchedCountVal = root.querySelector('#dispatched-count-val');
    const dispatcherStatusVal = root.querySelector('#dispatcher-status-val');
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
    const clearQueueBtn = root.querySelector('#clear-queue-btn');
    const heapNodesList = root.querySelector('#heap-nodes-list');
    const heapNodesCount = root.querySelector('#heap-nodes-count');
    const eventFeed = root.querySelector('#event-feed');
    const feedCount = root.querySelector('#feed-count');

    let processedHistory = [];
    const MAX_GAUGE_CAPACITY = 25;

    const getPriorityName = (rank) => {
      switch (Number(rank)) {
        case 4: return 'Urgent';
        case 3: return 'High';
        case 2: return 'Normal';
        case 1: return 'Low';
        default: return 'Normal';
      }
    };

    const getPriorityBadgeClass = (rank) => {
      switch (Number(rank)) {
        case 4: return 'badge-urgent';
        case 3: return 'badge-high';
        case 2: return 'badge-normal';
        case 1: return 'badge-low';
        default: return 'badge-normal';
      }
    };

    function updateUI() {
      const size = queue.size();
      const topNode = queue.heap[0];

      // Update counters
      depthVal.textContent = size;
      topPriorityVal.textContent = topNode ? `${getPriorityName(topNode.priority)} (P${topNode.priority})` : 'None';
      dispatchedCountVal.textContent = queue.dispatchedCount;
      heapNodesCount.textContent = `${size} queued`;
      feedCount.textContent = `${processedHistory.length} processed`;

      // Gauge progress
      const pct = Math.min(100, Math.round((size / MAX_GAUGE_CAPACITY) * 100));
      gaugePercent.textContent = `${pct}%`;
      depthProgressBar.style.width = `${pct}%`;

      // Render Heap List
      if (size === 0) {
        heapNodesList.innerHTML = `<p class="empty-hint">Queue is currently empty. Add tasks to inspect the binary heap ordering.</p>`;
      } else {
        heapNodesList.innerHTML = '';
        queue.heap.forEach((n, idx) => {
          const itemDiv = document.createElement('div');
          itemDiv.className = 'heap-node-item';
          itemDiv.innerHTML = `
            <div>
              <span class="node-idx">[Heap #${idx}]</span>
              <span class="node-title">${typeof n.item === 'string' ? n.item : JSON.stringify(n.item)}</span>
            </div>
            <span class="priority-badge ${getPriorityBadgeClass(n.priority)}">${getPriorityName(n.priority)}</span>
          `;
          heapNodesList.appendChild(itemDiv);
        });
      }

      // Render Event Feed
      if (processedHistory.length === 0) {
        eventFeed.innerHTML = `<p class="empty-hint">Dispatched events will appear here in prioritized order.</p>`;
      } else {
        eventFeed.innerHTML = '';
        processedHistory.slice(0, 15).forEach((event) => {
          const card = document.createElement('div');
          card.className = 'event-card';
          card.innerHTML = `
            <div class="event-card-header">
              <span class="priority-badge ${getPriorityBadgeClass(event.priority)}">${getPriorityName(event.priority)}</span>
              <span class="event-timestamp">${new Date(event.timestamp).toLocaleTimeString()}</span>
            </div>
            <span class="event-payload">${typeof event.item === 'string' ? event.item : JSON.stringify(event.item)}</span>
          `;
          eventFeed.appendChild(card);
        });
      }
    }

    function onEventProcessed(item, node) {
      processedHistory.unshift({
        item,
        priority: node.priority,
        timestamp: Date.now()
      });
      updateUI();
    }

    // Initialize dispatcher
    let currentRate = Number(rateSlider.value) || 500;
    queue.startDispatcher(currentRate, onEventProcessed);
    dispatcherStatusVal.textContent = 'Active (Auto-Pacing)';

    // Enqueue form handler
    enqueueForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const payload = taskPayloadInput.value.trim();
      const priority = Number(priorityRankSelect.value);
      if (payload) {
        queue.enqueue(payload, priority);
        updateUI();
      }
    });

    // Preset selector
    presetSelect.addEventListener('change', (e) => {
      const [text, p] = e.target.value.split('|');
      taskPayloadInput.value = text;
      priorityRankSelect.value = p;
    });

    // Rate Slider
    rateSlider.addEventListener('input', (e) => {
      currentRate = Number(e.target.value);
      rateSliderVal.textContent = `${currentRate} ms / event`;
      if (queue.isDispatching) {
        queue.startDispatcher(currentRate, onEventProcessed);
      }
    });

    // Toggle Dispatcher
    toggleDispatchBtn.addEventListener('click', () => {
      if (queue.isDispatching) {
        queue.stopDispatcher();
        toggleDispatchBtn.textContent = '▶ Resume Dispatcher';
        toggleDispatchBtn.className = 'toggle-btn paused-state';
        dispatcherStatusVal.textContent = 'Paused';
      } else {
        queue.startDispatcher(currentRate, onEventProcessed);
        toggleDispatchBtn.textContent = '⏸ Pause Dispatcher';
        toggleDispatchBtn.className = 'toggle-btn active-state';
        dispatcherStatusVal.textContent = 'Active (Auto-Pacing)';
      }
    });

    // Manual Dequeue
    dequeueManualBtn.addEventListener('click', () => {
      if (queue.size() > 0) {
        const topNode = queue.heap[0];
        const item = queue.dequeue();
        onEventProcessed(item, topNode);
      }
    });

    // Clear Queue
    clearQueueBtn.addEventListener('click', () => {
      queue.clear();
      updateUI();
    });

    // Seed default tasks for interactive display
    queue.enqueue('Telemetry Battery Level Check: Sensor #14', 1); // Low
    queue.enqueue('Drip Irrigation Valve Sector 4 Normal Cycle', 2); // Normal
    queue.enqueue('Frost Warning Alarm: Zone 2 Greenhouse', 3); // High
    queue.enqueue('EMERGENCY: Mainline Pressure Burst - Shutoff', 4); // Urgent

    updateUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initQueueLab);
  } else {
    initQueueLab();
  }
}
