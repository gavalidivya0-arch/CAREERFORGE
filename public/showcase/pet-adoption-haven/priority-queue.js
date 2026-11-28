/**
 * PetAdoptionHavenPriorityQueue
 * In-memory Binary Heap Priority Event Queue & Asynchronous Backpressure Dispatcher.
 * Preserves binary max-heap ordering with FIFO secondary keys for identical priorities.
 */

export const PRIORITY_MAP = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1
};

export class PetAdoptionHavenPriorityQueue {
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

    const queue = new PetAdoptionHavenPriorityQueue();
    const processedEvents = [];

    const depthVal = root.querySelector('#depth-val');
    const topPriorityVal = root.querySelector('#top-priority-val');
    const dispatchedCountVal = root.querySelector('#dispatched-count-val');
    const dispatcherStatusVal = root.querySelector('#dispatcher-status-val');
    const enqueueForm = root.querySelector('#enqueue-form');
    const taskPayloadInput = root.querySelector('#task-payload');
    const priorityRankSelect = root.querySelector('#priority-rank');
    const presetSelect = root.querySelector('#preset-select');
    const depthProgressBar = root.querySelector('#depth-progress-bar');
    const gaugePercent = root.querySelector('#gauge-percent');
    const rateSlider = root.querySelector('#rate-slider');
    const rateSliderVal = root.querySelector('#rate-slider-val');
    const toggleDispatchBtn = root.querySelector('#toggle-dispatch-btn');
    const dequeueManualBtn = root.querySelector('#dequeue-manual-btn');
    const clearQueueBtn = root.querySelector('#clear-queue-btn');
    const heapNodesCount = root.querySelector('#heap-nodes-count');
    const heapNodesList = root.querySelector('#heap-nodes-list');
    const feedCount = root.querySelector('#feed-count');
    const eventFeed = root.querySelector('#event-feed');

    const priorityLabels = {
      4: 'Urgent',
      3: 'High',
      2: 'Normal',
      1: 'Low'
    };

    function renderUI() {
      // 1. Update Metrics
      const depth = queue.size();
      depthVal.textContent = depth;
      dispatchedCountVal.textContent = queue.dispatchedCount;
      dispatcherStatusVal.textContent = queue.isDispatching ? 'Active' : 'Paused';

      const topNode = queue.heap.length > 0 ? queue.heap[0] : null;
      topPriorityVal.textContent = topNode ? `${priorityLabels[topNode.priority]} (Rank ${topNode.priority})` : 'None';

      // 2. Update Depth Gauge (cap at 20 for 100% visualization)
      const maxVisualDepth = 20;
      const pct = Math.min(100, Math.round((depth / maxVisualDepth) * 100));
      gaugePercent.textContent = `${pct}% (${depth} items)`;
      depthProgressBar.style.width = `${pct}%`;

      // 3. Render Heap Nodes
      heapNodesCount.textContent = `${depth} queued`;
      if (depth === 0) {
        heapNodesList.innerHTML = `<p class="empty-hint">Queue is currently empty. Add shelter tasks to inspect the binary heap ordering.</p>`;
      } else {
        heapNodesList.innerHTML = '';
        queue.heap.forEach((node, idx) => {
          const card = document.createElement('div');
          const pLabel = priorityLabels[node.priority].toLowerCase();
          card.className = `heap-item-card ${idx === 0 ? 'top-heap-item' : ''}`;
          card.innerHTML = `
            <div class="item-left">
              <span class="item-index-badge">#${idx}</span>
              <span class="item-payload">${node.item}</span>
            </div>
            <div class="item-right">
              <span class="priority-badge priority-${pLabel}">${priorityLabels[node.priority]}</span>
            </div>
          `;
          heapNodesList.appendChild(card);
        });
      }

      // 4. Render Processed Feed
      feedCount.textContent = `${processedEvents.length} processed`;
      if (processedEvents.length === 0) {
        eventFeed.innerHTML = `<p class="empty-hint">Dispatched events will appear here in prioritized order.</p>`;
      } else {
        eventFeed.innerHTML = '';
        processedEvents.slice(0, 30).forEach((entry) => {
          const card = document.createElement('div');
          const pLabel = priorityLabels[entry.priority].toLowerCase();
          card.className = 'feed-item-card';
          card.innerHTML = `
            <div class="item-left">
              <span class="item-index-badge">DISPATCHED</span>
              <span class="item-payload">${entry.item}</span>
            </div>
            <div class="item-right">
              <span class="priority-badge priority-${pLabel}">${priorityLabels[entry.priority]}</span>
              <span class="item-time">${entry.time}</span>
            </div>
          `;
          eventFeed.appendChild(card);
        });
      }
    }

    // Handle Form Enqueue
    enqueueForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const payload = taskPayloadInput.value.trim();
      const priority = Number(priorityRankSelect.value);
      if (!payload) return;

      queue.enqueue(payload, priority);
      renderUI();
    });

    // Handle Preset Selector
    if (presetSelect) {
      presetSelect.addEventListener('change', () => {
        const val = presetSelect.value;
        if (!val) return;
        const [text, p] = val.split('|');
        taskPayloadInput.value = text;
        priorityRankSelect.value = p;
      });
    }

    // Handle Rate Slider
    let currentRate = Number(rateSlider.value);
    rateSlider.addEventListener('input', () => {
      currentRate = Number(rateSlider.value);
      rateSliderVal.textContent = `${currentRate} ms / event`;
      if (queue.isDispatching) {
        queue.startDispatcher(currentRate, handleDispatchedItem);
      }
    });

    function handleDispatchedItem(item, node) {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      processedEvents.unshift({
        item,
        priority: node ? node.priority : 2,
        time: timeStr
      });
      renderUI();
    }

    // Toggle Dispatcher
    toggleDispatchBtn.addEventListener('click', () => {
      if (queue.isDispatching) {
        queue.stopDispatcher();
        toggleDispatchBtn.textContent = '▶ Resume Dispatcher';
        toggleDispatchBtn.className = 'toggle-btn paused-state';
      } else {
        queue.startDispatcher(currentRate, handleDispatchedItem);
        toggleDispatchBtn.textContent = '⏸ Pause Dispatcher';
        toggleDispatchBtn.className = 'toggle-btn active-state';
      }
      renderUI();
    });

    // Manual Dequeue
    dequeueManualBtn.addEventListener('click', () => {
      if (queue.isEmpty()) return;
      const topNode = queue.heap[0];
      const item = queue.dequeue();
      handleDispatchedItem(item, topNode);
    });

    // Clear All
    clearQueueBtn.addEventListener('click', () => {
      queue.clear();
      renderUI();
    });

    // Start Dispatcher automatically
    queue.startDispatcher(currentRate, handleDispatchedItem);

    // Initial seed tasks
    queue.enqueue('Initial Shelter Check: Morning Feeding & Water Restock', 2);
    queue.enqueue('Critical Intake: Injured Kitten Found in Sector 4', 4);
    queue.enqueue('Adoption Paperwork Review: Max (Labrador)', 3);
    renderUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initQueueLab);
  } else {
    initQueueLab();
  }
}
