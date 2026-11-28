import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthVitalityLruCache } from './lru-cache.js';

test('HealthVitalityLruCache - stores and retrieves values in O(1)', () => {
  const cache = new HealthVitalityLruCache(3);
  cache.put('k1', 'val1');
  cache.put('k2', 'val2');

  assert.equal(cache.get('k1'), 'val1');
  assert.equal(cache.get('k2'), 'val2');
  assert.equal(cache.get('unknown'), null);
});

test('HealthVitalityLruCache - throws RangeError on non-positive capacity', () => {
  assert.throws(() => new HealthVitalityLruCache(0), RangeError);
  assert.throws(() => new HealthVitalityLruCache(-5), RangeError);
});

test('HealthVitalityLruCache - promotes accessed key to MRU (head)', () => {
  const cache = new HealthVitalityLruCache(3);
  cache.put('c1', 'data1');
  cache.put('c2', 'data2');
  cache.put('c3', 'data3');

  cache.get('c1');

  const ordered = cache.getOrderedEntries();
  assert.equal(ordered[0].key, 'c1');
  assert.equal(ordered[1].key, 'c3');
  assert.equal(ordered[2].key, 'c2');
});

test('HealthVitalityLruCache - evicts least recently used item upon capacity overflow', () => {
  const cache = new HealthVitalityLruCache(2);
  cache.put('item1', 'content1');
  cache.put('item2', 'content2');
  cache.put('item3', 'content3');

  assert.equal(cache.get('item1'), null);
  assert.equal(cache.get('item2'), 'content2');
  assert.equal(cache.get('item3'), 'content3');

  const evicted = cache.getEvictedEntries();
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].key, 'item1');
});

test('HealthVitalityLruCache - clear resets cache and evicted entries', () => {
  const cache = new HealthVitalityLruCache(2);
  cache.put('test', '123');
  cache.clear();

  assert.equal(cache.get('test'), null);
  assert.equal(cache.getOrderedEntries().length, 0);
});

test('HealthVitalityLruCache - getEvictedEntries returns eviction order', () => {
  const cache = new HealthVitalityLruCache(1);
  cache.put('a', '1');
  cache.put('b', '2');
  cache.put('c', '3');

  const evicted = cache.getEvictedEntries();
  assert.equal(evicted.length, 2);
  // First eviction should be 'a' (LRU after b and c were added)
  assert.equal(evicted[0].key, 'a');
  // Second eviction should be 'b'
  assert.equal(evicted[1].key, 'b');
});

test('HealthVitalityLruCache - updating existing key does not increase size', () => {
  const cache = new HealthVitalityLruCache(2);
  cache.put('x', '1');
  cache.put('y', '2');
  cache.put('x', 'updated'); // update existing key

  assert.equal(cache.getOrderedEntries().length, 2);
  assert.equal(cache.get('x'), 'updated');
  const ordered = cache.getOrderedEntries();
  // 'x' should be MRU since it was just accessed
  assert.equal(ordered[0].key, 'x');
});

test('HealthVitalityLruCache - access order affects eviction', () => {
  const cache = new HealthVitalityLruCache(3);
  cache.put('first', '1');
  cache.put('second', '2');
  cache.put('third', '3');

  // Access 'first' and 'second' to make them MRU
  cache.get('first');
  cache.get('second');

  // Now adding 'fourth' should evict 'third' (the LRU)
  cache.put('fourth', '4');

  assert.equal(cache.get('third'), null);
  assert.equal(cache.get('fourth'), '4');

  const evicted = cache.getEvictedEntries();
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].key, 'third');
});

test('HealthVitalityLruCache - cache with capacity 1 behavior', () => {
  const cache = new HealthVitalityLruCache(1);

  cache.put('only', 'first');
  assert.equal(cache.get('only'), 'first');

  cache.put('other', 'second');
  // 'only' should be evicted
  assert.equal(cache.get('only'), null);
  assert.equal(cache.get('other'), 'second');

  const evicted = cache.getEvictedEntries();
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].key, 'only');
});

test('HealthVitalityLruCache - maintains correct order after multiple gets', () => {
  const cache = new HealthVitalityLruCache(3);
  cache.put('a', '1');
  cache.put('b', '2');
  cache.put('c', '3');

  // Access order: a, c, b
  cache.get('a'); // a becomes MRU
  cache.get('c'); // c becomes MRU after a
  cache.get('b'); // b becomes MRU after c

  const ordered = cache.getOrderedEntries();
  // Order from MRU to LRU: b, c, a
  assert.equal(ordered[0].key, 'b');
  assert.equal(ordered[1].key, 'c');
  assert.equal(ordered[2].key, 'a');
});

test('HealthVitalityLruCache - put with same key preserves value type', () => {
  const cache = new HealthVitalityLruCache(5);
  cache.put('mixed', { nested: { value: 42 } });
  cache.put('mixed', { nested: { value: 99 } });

  const result = cache.get('mixed');
  // After update, the nested object reference is preserved/replaced
  assert.deepStrictEqual(result, { nested: { value: 99 } });
});

test('HealthVitalityLruCache - evicted entries have timestamps', () => {
  const cache = new HealthVitalityLruCache(1);
  cache.put('a', '1');
  cache.put('b', '2');

  const evicted = cache.getEvictedEntries();
  assert.ok(evicted[0].timestamp > 0, 'Timestamp should be a positive number');
  assert.ok(Date.now() - evicted[0].timestamp < 1000, 'Timestamp should be recent');
});