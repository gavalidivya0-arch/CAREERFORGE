/**
 * HealthVitality LRU In-Memory Cache
 * Doubly-linked list and hash-map backed with O(1) get/put operations.
 * Supports automatic eviction of oldest entries and eviction visualizer integration.
 */
export class HealthVitalityLruCache {
  /**
   * @param {number} capacity - Maximum number of entries the cache can hold
   */
  constructor(capacity = 4) {
    if (typeof capacity !== 'number' || capacity <= 0) {
      throw new RangeError('Capacity must be a positive integer greater than 0');
    }
    this.capacity = capacity;
    this.map = new Map();
    this.evictedEntries = [];

    // Doubly-linked list sentinel nodes for LRU ordering
    // Most recently used (MRU) is next to head, Least Recently Used (LRU) is prev to tail
    this.head = new Node('__HEAD__', null);
    this.tail = new Node('__TAIL__', null);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Remove a node from the doubly-linked list
   * @param {Node} node
   * @private
   */
  #remove(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  /**
   * Insert a node at the head (MRU position)
   * @param {Node} node
   * @private
   */
  #insertAtHead(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  /**
   * Move an existing node to the head (MRU position)
   * @param {Node} node
   * @private
   */
  #moveToHead(node) {
    this.#remove(node);
    this.#insertAtHead(node);
  }

  /**
   * Get a value by key. Updates recency order (moves to head).
   * @param {*} key
   * @returns {*} The value, or null if not found
   */
  get(key) {
    const node = this.map.get(key);
    if (!node) return null;
    this.#moveToHead(node);
    return node.value;
  }

  /**
   * Insert or update a key-value pair.
   * If the key already exists, its value is updated and it becomes MRU.
   * If the cache is at capacity, the LRU entry is evicted before inserting.
   * @param {*} key
   * @param {*} value
   * @returns {void}
   */
  put(key, value) {
    if (this.map.has(key)) {
      const node = this.map.get(key);
      node.value = value;
      this.#moveToHead(node);
      return;
    }

    // Evict LRU entry if at capacity
    if (this.map.size >= this.capacity) {
      const lruNode = this.tail.prev;
      this.#remove(lruNode);
      this.map.delete(lruNode.key);
      this.evictedEntries.push({
        key: lruNode.key,
        value: lruNode.value,
        timestamp: Date.now(),
        order: this.evictedEntries.length + 1
      });
    }

    const newNode = new Node(key, value);
    this.#insertAtHead(newNode);
    this.map.set(key, newNode);
  }

  /**
   * Get the list of evicted entries in FIFO order (oldest first).
   * @returns {Array} Array of {key, value, timestamp, order} objects
   */
  getEvictedEntries() {
    return [...this.evictedEntries];
  }

  /**
   * Get entries in their current ordered chain (from MRU to LRU).
   * @returns {Array} Array of {key, value} objects ordered from head to tail
   */
  getOrderedEntries() {
    const entries = [];
    let curr = this.head.next;
    while (curr !== this.tail) {
      entries.push({ key: curr.key, value: curr.value });
      curr = curr.next;
    }
    return entries;
  }

  /**
   * Clear the cache, resetting all mappings, eviction history, and node order.
   * @returns {void}
   */
  clear() {
    this.map.clear();
    this.evictedEntries = [];
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }
}

/**
 * Doubly-linked list node for LRU cache
 * @param {*} key   - The key associated with this node
 * @param {*} value - The value stored in this node
 */
class Node {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}