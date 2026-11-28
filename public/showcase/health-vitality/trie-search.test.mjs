import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthVitalityTrieEngine } from './trie-search.js';

// --- Exact prefix completion ---

test('HealthVitalityTrieEngine - initial terms require an explicit array', () => {
  for (const value of [null, 'ledger', {}, 1]) {
    assert.throws(() => new HealthVitalityTrieEngine(value), TypeError);
  }
});

test('HealthVitalityTrieEngine - prefix traversal preserves complete words', () => {
  const engine = new HealthVitalityTrieEngine(['Alpha', 'Alpine', 'Beta']);
  assert.deepEqual(engine.findWordsWithPrefix(' alp '), ['Alpha', 'Alpine']);
  assert.deepEqual(engine.findWordsWithPrefix('unknown'), []);
});

test('HealthVitalityTrieEngine - empty prefix returns all words', () => {
  const engine = new HealthVitalityTrieEngine(['Alpha', 'Alpine', 'Beta']);
  const results = engine.findWordsWithPrefix('');
  assert.deepEqual(results.sort(), ['Alpha', 'Alpine', 'Beta'].sort());
});

// --- Case-insensitivity ---

test('HealthVitalityTrieEngine - case-insensitive insert and lookup', () => {
  const engine = new HealthVitalityTrieEngine(['Alpha', 'beta', 'GAMMA']);
  assert(engine.contains('alpha'));
  assert(engine.contains('ALPHA'));
  assert(engine.contains('Alpha'));
  assert(engine.contains('beta'));
  assert(engine.contains('BETA'));
  assert(engine.contains('gamma'));
  assert(engine.contains('GAMMA'));
});

test('HealthVitalityTrieEngine - case-insensitive prefix search', () => {
  const engine = new HealthVitalityTrieEngine(['Apple', 'application', 'Banana']);
  assert.deepEqual(engine.findWordsWithPrefix('ap'), ['Apple', 'application']);
  assert.deepEqual(engine.findWordsWithPrefix('AP'), ['Apple', 'application']);
  assert.deepEqual(engine.findWordsWithPrefix('ba'), ['Banana']);
  assert.deepEqual(engine.findWordsWithPrefix('BA'), ['Banana']);
});

// --- Levenshtein distance accuracy ---

test('HealthVitalityTrieEngine - fuzzySearch with zero distance', () => {
  const engine = new HealthVitalityTrieEngine(['Health', 'Fitness']);
  assert.deepEqual(engine.fuzzySearch('Health', 0), [{ word: 'Health', distance: 0 }]);
});

test('HealthVitalityTrieEngine - fuzzySearch calculates Levenshtein distance 1', () => {
  const engine = new HealthVitalityTrieEngine(['Health', 'Fitness']);
  assert.deepEqual(engine.fuzzySearch('helth', 1), [{ word: 'Health', distance: 1 }]);
});

test('HealthVitalityTrieEngine - fuzzySearch calculates Levenshtein distance 2', () => {
  const engine = new HealthVitalityTrieEngine(['Migration', 'Marginal']);
  assert.deepEqual(engine.fuzzySearch('migracion', 2).length >= 1, true);
});

test('HealthVitalityTrieEngine - fuzzySearch returns results sorted by distance', () => {
  const engine = new HealthVitalityTrieEngine(['cat', 'car', 'cart', 'carton']);
  const results = engine.fuzzySearch('ca', 2);
  for (let i = 1; i < results.length; i++) {
    assert(results[i].distance >= results[i - 1].distance,
      `Results should be sorted by distance: ${results[i - 1].distance} <= ${results[i].distance}`);
  }
});

test('HealthVitalityTrieEngine - fuzzySearch maxDistance 3', () => {
  const engine = new HealthVitalityTrieEngine(['internationalization']);
  assert.doesNotThrow(() => engine.fuzzySearch('intl', 3));
});

test('HealthVitalityTrieEngine - fuzzySearch throws on invalid maxDistance', () => {
  const engine = new HealthVitalityTrieEngine(['test']);
  assert.throws(() => engine.fuzzySearch('test', -1), RangeError);
  assert.throws(() => engine.fuzzySearch('test', 4), RangeError);
  assert.throws(() => engine.fuzzySearch('test', 1.5), RangeError);
});

// --- getAllWords ---

test('HealthVitalityTrieEngine - getAllWords returns all inserted words', () => {
  const engine = new HealthVitalityTrieEngine(['Alpha', 'Beta', 'Gamma']);
  const words = engine.getAllWords();
  assert.deepEqual(words.sort(), ['Alpha', 'Beta', 'Gamma'].sort());
});

// --- contains ---

test('HealthVitalityTrieEngine - contains exact word', () => {
  const engine = new HealthVitalityTrieEngine(['Hello', 'World']);
  assert(engine.contains('hello'));
  assert(engine.contains('WORLD'));
  assert(!engine.contains('foo'));
});

test('HealthVitalityTrieEngine - contains with mixed case', () => {
  const engine = new HealthVitalityTrieEngine(['Concatenate']);
  assert(engine.contains('concatenate'));
  assert(engine.contains('CONCATENATE'));
});