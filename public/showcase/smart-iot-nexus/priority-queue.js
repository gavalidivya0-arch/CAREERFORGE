export class SmartIotNexusPriorityQueue {
  constructor() {
    this.heap = [];
    this.counter = 0;
  }

  enqueue(item, priority) {
    const entry = { item, priority, timestamp: this.counter++ };
    this.heap.push(entry);
    this.bubbleUp(this.heap.length - 1);
  }

  bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const priorityCompare =
        this.heap[index].priority < this.heap[parentIndex].priority
          || (this.heap[index].priority === this.heap[parentIndex].priority
            && this.heap[index].timestamp < this.heap[parentIndex].timestamp);
      if (priorityCompare) {
        [this.heap[index], this.heap[parentIndex]] = [
          this.heap[parentIndex],
          this.heap[index],
        ];
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  bubbleDown(index) {
    const length = this.heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (left < length) {
        const priorityCompare =
          this.heap[left].priority < this.heap[smallest].priority
            || (this.heap[left].priority === this.heap[smallest].priority
              && this.heap[left].timestamp < this.heap[smallest].timestamp);
        if (priorityCompare) {
          smallest = left;
        }
      }
      if (right < length) {
        const priorityCompare =
          this.heap[right].priority < this.heap[smallest].priority
            || (this.heap[right].priority === this.heap[smallest].priority
              && this.heap[right].timestamp < this.heap[smallest].timestamp);
        if (priorityCompare) {
          smallest = right;
        }
      }
      if (smallest !== index) {
        [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
        index = smallest;
      } else {
        break;
      }
    }
  }

  dequeue() {
    if (this.heap.length === 0) return null;
    const [top] = this.heap.splice(0, 1);
    if (this.heap.length > 0) {
      this.bubbleDown(0);
    }
    return top ? top.item : null;
  }

  peek() {
    return this.heap.length > 0 ? this.heap[0].item : null;
  }

  startDispatcher(rateLimitMs, handler) {
    let lastRun = 0;

    return async () => {
      const now = Date.now();
      const elapsed = now - lastRun;

      if (elapsed < rateLimitMs) {
        await new Promise(resolve => setTimeout(resolve, rateLimitMs - elapsed));
      }

      lastRun = Date.now();
      const item = this.dequeue();
      if (item === null) {
        return null;
      }

      try {
        await handler(item);
        return item;
      } catch (err) {
        this.enqueue(item, /* priority */ 0);
        throw err;
      }
    };
  }

  getQueueDepth() {
    return this.heap.length;
  }

  getMetrics() {
    return {
      queueDepth: this.heap.length,
    };
  }
}