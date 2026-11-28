/**
 * DefiYieldMatrixPriorityQueue - Binary min-heap priority queue with backpressure-aware dispatcher.
 * Lower priority rank = higher priority (0 is highest).
 * FIFO ordering is preserved for items with equal priority via a monotonically increasing insertion count.
 */

export class DefiYieldMatrixPriorityQueue {
  constructor() {
    this._heap = [];
    this._counter = 0;
  }

  enqueue(item, priority) {
    const entry = { item, priority, insertionCount: this._counter++ };
    this._push(entry);
  }

  dequeue() {
    if (this._heap.length === 0) return null;
    const root = this._heap[0];
    const last = this._heap[this._heap.length - 1];
    this._heap[0] = last;
    this._heap.length--;
    if (this._heap.length > 0) {
      this._siftDown(0);
    }
    return root.item;
  }

  peek() {
    if (this._heap.length === 0) return null;
    return this._heap[0].item;
  }

  get depth() {
    return this._heap.length;
  }

  _push(entry) {
    let index = this._heap.length;
    this._heap.push(entry);
    this._siftUp(index);
  }

  _siftUp(index) {
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = this._heap[parentIndex];
      if (
        this._heap[index].priority < parent.priority ||
        (this._heap[index].priority === parent.priority &&
          this._heap[index].insertionCount < parent.insertionCount)
      ) {
        [this._heap[parentIndex], this._heap[index]] = [
          this._heap[index],
          this._heap[parentIndex],
        ];
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  _siftDown(startIndex) {
    let index = startIndex;
    const length = this._heap.length;
    const element = this._heap[index];

    while (true) {
      let childIndex = (index << 1) + 1;
      if (childIndex >= length) break;

      const rightIndex = childIndex + 1;
      if (
        rightIndex < length &&
        this._heap[rightIndex].priority < this._heap[childIndex].priority
      ) {
        childIndex = rightIndex;
      }

      if (
        this._heap[childIndex].priority < element.priority ||
        (this._heap[childIndex].priority === element.priority &&
          this._heap[childIndex].insertionCount < element.insertionCount)
      ) {
        this._heap[index] = this._heap[childIndex];
        index = childIndex;
      } else {
        break;
      }
    }
    this._heap[index] = element;
  }

  startDispatcher(rateLimitMs, handler) {
    let scheduled = false;
    let timerId = null;
    const self = this;

    const run = () => {
      scheduled = false;
      if (self._heap.length > 0) {
        const item = self.dequeue();
        handler(item);
      }
      timerId = setTimeout(run, rateLimitMs);
    };

    run();

    return {
      enqueue(item, priority) {
        self.enqueue(item, priority);
        if (!scheduled) {
          scheduled = true;
          timerId = setTimeout(run, rateLimitMs);
        }
      },
      stop() {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        scheduled = false;
      },
    };
  }
}