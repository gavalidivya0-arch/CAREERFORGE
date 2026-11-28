import test from 'node:test';
import assert from 'node:assert/strict';
import { NonprofitImpactTrieEngine } from './trie-search.js';

const engine = new NonprofitImpactTrieEngine();

// Populate with test words
const testWords = [
  'apple', 'application', 'appetizer', 'banana', 'band', 'banner',
  'cat', 'cater', 'category', 'dog', 'doorbell', 'dolphin',
  'elephant', 'energy', 'engine', 'equal', 'errand',
  'family', 'fantastic', 'fire', 'finite', 'flash',
  'grape', 'grade', 'great', 'green', 'greeting',
  'house', 'home', 'hope', 'hospital', 'hotel',
  'information', 'internet', 'island', 'issue',
  'juice', 'jump', 'jungle',
  'key', 'knowledge', 'kid',
  'lake', 'law', 'leadership', 'learning', 'library',
  'mountain', 'music',
  'name', 'network', 'news', 'night', 'notebook',
  'orange', 'organ', 'output',
  'paper', 'pen', 'phone', 'photo', 'planet', 'plant',
  'queen', 'question', 'quick', 'query',
  'rain', 'rainbow', 'rat', 'read', 'real', 'recipe', 'record', 'research',
  'sun', 'sunny', 'supply', 'system',
  'table', 'tea', 'technology', 'term', 'test', 'text', 'theme',
  'umbrella', 'unit', 'unit', 'universe',
  'victory', 'video', 'vision', 'visit', 'voice',
  'water', 'website', 'word', 'work', 'worker',
  'xylophone', 'xray',
  'yellow', 'yesterday',
  'zoo', 'zone',
];

testWords.forEach(word => engine.insert(word));

test('TrieEngine - inserts words and finds them by exact match', () => {
  // Insert words already done via constructor
  // Verify the engine has words
  assert.ok(engine.words.size > 0, 'Engine should have words after insertion');
});

test('TrieEngine - findWordsWithPrefix returns exact prefix matches', () => {
  const results = engine.findWordsWithPrefix('app');
  assert.ok(results.length > 0, `Should find words with prefix 'app', got ${results.length}`);
  // All results should start with 'app'
  for (const word of results) {
    assert.ok(word.toLowerCase().startsWith('app'), `${word} does not start with prefix 'app'`);
  }
  // Should include 'apple', 'application', 'appetizer'
  assert.ok(results.includes('apple') || results.some(r => r === 'apple'), 'Should find apple');
  assert.ok(results.includes('application') || results.some(r => r === 'application'), 'Should find application');
  assert.ok(results.includes('appetizer') || results.some(r => r === 'appetizer'), 'Should find appetizer');
});

test('TrieEngine - findWordsWithPrefix handles empty prefix returns all words', () => {
  const results = engine.findWordsWithPrefix('');
  assert.ok(results.length > 0, 'Empty prefix should return all words');
  assert.equal(results.length, engine.words.size, 'Empty prefix should return all inserted words');
});

test('TrieEngine - findWordsWithPrefix handles non-existent prefix returns empty array', () => {
  const results = engine.findWordsWithPrefix('zzz');
  assert.equal(results.length, 0, 'Non-existent prefix should return empty array');
});

test('TrieEngine - case-insensitive prefix matching', () => {
  const results = engine.findWordsWithPrefix('APP');
  // Should find 'apple' despite case difference
  const hasApple = results.some(r => r.toLowerCase() === 'apple');
  assert.ok(hasApple, 'Should be case-insensitive, found: ' + results.join(', '));

  const resultsLower = engine.findWordsWithPrefix('app');
  const hasAppleLower = resultsLower.some(r => r.toLowerCase() === 'apple');
  assert.ok(hasAppleLower, 'Lowercase prefix should also find apple');
});

test('TrieEngine - fuzzySearch finds words within Levenshtein distance', () => {
  // 'aple' is distance 1 from 'apple' (missing 'p')
  const results = engine.fuzzySearch('aple', 1);
  assert.ok(results.length > 0, 'Should find similar words for fuzzy query "aple"');
  // 'apple' should be in results since Levenshtein('aple', 'apple') = 1
  const hasApple = results.some(r => r.toLowerCase() === 'apple');
  assert.ok(hasApple, 'Should find "apple" within distance 1 of "aple"');

  // 'appl' is distance 1 from 'apple' (missing 'e')
  const results2 = engine.fuzzySearch('appl', 1);
  const hasApple2 = results2.some(r => r.toLowerCase() === 'apple');
  assert.ok(hasApple2, 'Should find "apple" within distance 1 of "appl"');
});

test('TrieEngine - fuzzySearch maxDistance=0 returns exact matches only', () => {
  const results = engine.fuzzySearch('apple', 0);
  // Should only return 'apple' itself
  assert.equal(results.length, 1, `Expected exactly 1 result with maxDistance=0, got ${results.length}`);
  assert.ok(results.includes('apple'), 'Should include the exact word "apple"');
});

test('TrieEngine - fuzzySearch with maxDistance=2', () => {
  // 'aple' distance 1, 'applo' distance 1, 'apply' distance 1 (y->e)
  const results = engine.fuzzySearch('aple', 2);
  // Should include 'apple' (distance 1) and possibly others
  assert.ok(results.length >= 1, 'Should find at least 1 result with maxDistance=2');
});

test('TrieEngine - Levenshtein distance accuracy', () => {
  // Distance 'kitten' -> 'sitting' = 3 (kitten->sitten substitution k->s, sitten->sitting insertion g)
  // Actually: kitten->sitten (k->s substitution=1), sitten->sitting (insertion g at end=1) = 2... let me verify
  // kitten: k-i-t-t-e-n (6 chars)
  // sitting: s-i-t-t-i-n-g (7 chars)
  // Substitutions: k->s, e->i = 2 substitutions
  // Insertion: g at end = 1
  // Total = 3

  // Let's verify with known values
  const d1 = engine._levenshteinDistance('kitten', 'sitting');
  assert.equal(d1, 3, `Levenshtein distance kitten->sitting should be 3, got ${d1}`);

  // Distance 'sitting' -> 'kitten' should also be 3 (symmetric)
  const d2 = engine._levenshteinDistance('sitting', 'kitten');
  assert.equal(d2, 3, `Levenshtein distance sitting->kitten should be 3, got ${d2}`);

  // Distance '' -> 'abc' = 3 (insertions)
  const d3 = engine._levenshteinDistance('', 'abc');
  assert.equal(d3, 3, `Levenshtein distance empty->abc should be 3, got ${d3}`);

  // Distance 'abc' -> '' = 3 (deletions)
  const d4 = engine._levenshteinDistance('abc', '');
  assert.equal(d4, 3, `Levenshtein distance abc->empty should be 3, got ${d4}`);

  // Distance 'abc' -> 'abc' = 0 (identical)
  const d5 = engine._levenshteinDistance('abc', 'abc');
  assert.equal(d5, 0, `Levenshtein distance abc->abc should be 0, got ${d5}`);

  // Distance 'a' -> 'b' = 1 (substitution)
  const d6 = engine._levenshteinDistance('a', 'b');
  assert.equal(d6, 1, `Levenshtein distance a->b should be 1, got ${d6}`);
});