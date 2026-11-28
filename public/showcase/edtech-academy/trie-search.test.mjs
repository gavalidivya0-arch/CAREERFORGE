import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EdtechAcademyTrieEngine, EDTECH_STARTER_TERMS } from './trie-search.js';

test('EdtechAcademyTrieEngine - requires an array when constructed with initial terms', () => {
  for (const invalid of [null, 'PagedAttention', {}, 42]) {
    assert.throws(() => new EdtechAcademyTrieEngine(invalid), TypeError);
  }
  const empty = new EdtechAcademyTrieEngine();
  assert.equal(empty.size, 0);
});

test('EdtechAcademyTrieEngine - inserts terms and completes exact prefixes deterministically', () => {
  const engine = new EdtechAcademyTrieEngine([
    'Tensor Parallelism',
    'TensorRT Engine',
    'Tokenization',
    'KV Cache'
  ]);

  assert.deepEqual(engine.findWordsWithPrefix('tensor'), [
    'Tensor Parallelism',
    'TensorRT Engine'
  ]);
  assert.deepEqual(engine.findWordsWithPrefix('kv'), ['KV Cache']);
  assert.deepEqual(engine.findWordsWithPrefix('nonexistent'), []);
});

test('EdtechAcademyTrieEngine - empty and whitespace prefixes return all indexed words', () => {
  const engine = new EdtechAcademyTrieEngine(['Rust Kernel', 'AWQ Quantization', 'CUDA Kernels']);

  assert.deepEqual(engine.findWordsWithPrefix(''), [
    'AWQ Quantization',
    'CUDA Kernels',
    'Rust Kernel'
  ]);
  assert.deepEqual(engine.findWordsWithPrefix('   '), [
    'AWQ Quantization',
    'CUDA Kernels',
    'Rust Kernel'
  ]);
});

test('EdtechAcademyTrieEngine - enforces case-insensitivity and whitespace normalization', () => {
  const engine = new EdtechAcademyTrieEngine();

  assert.equal(engine.insert('  PagedAttention  '), true);
  assert.equal(engine.insert('pagedattention'), false);
  assert.equal(engine.insert('PAGEDATTENTION'), false);
  assert.equal(engine.size, 1);

  assert.equal(engine.has('pAgEdAtTeNtIoN'), true);
  assert.deepEqual(engine.findWordsWithPrefix('  PAGED '), ['PagedAttention']);
  assert.deepEqual(engine.fuzzySearch('pagedatention', 1), [
    { word: 'PagedAttention', distance: 1 }
  ]);
});

test('EdtechAcademyTrieEngine - calculates Levenshtein edit distance accurately', () => {
  assert.equal(EdtechAcademyTrieEngine.levenshteinDistance('kitten', 'sitting'), 3);
  assert.equal(EdtechAcademyTrieEngine.levenshteinDistance('quantization', 'quantization'), 0);
  assert.equal(EdtechAcademyTrieEngine.levenshteinDistance('cuda', 'cud'), 1);
  assert.equal(EdtechAcademyTrieEngine.levenshteinDistance('llm', 'llms'), 1);
  assert.equal(EdtechAcademyTrieEngine.levenshteinDistance('raft', 'rast'), 1);
  assert.equal(
    EdtechAcademyTrieEngine.levenshteinDistance('PagedAttention', 'pagedattention', { ignoreCase: true }),
    0
  );
});

test('EdtechAcademyTrieEngine - fuzzySearch finds insertion, deletion, and substitution matches ordered by distance', () => {
  const engine = new EdtechAcademyTrieEngine([
    'Quantization',
    'PagedAttention',
    'FlashAttention',
    'CUDA Kernels',
    'Tokenization'
  ]);

  assert.deepEqual(engine.fuzzySearch('quantzation', 1), [
    { word: 'Quantization', distance: 1 }
  ]);
  assert.deepEqual(engine.fuzzySearch('quantizations', 1), [
    { word: 'Quantization', distance: 1 }
  ]);
  assert.deepEqual(engine.fuzzySearch('quantizotion', 1), [
    { word: 'Quantization', distance: 1 }
  ]);
  assert.deepEqual(engine.fuzzySearch('QUANTIZATION', 0), [
    { word: 'Quantization', distance: 0 }
  ]);
  assert.deepEqual(engine.fuzzySearch('zzzzzzzz', 2), []);

  const orderedEngine = new EdtechAcademyTrieEngine(['cot', 'cut', 'cat', 'coat']);
  assert.deepEqual(orderedEngine.fuzzySearch('cat', 1), [
    { word: 'cat', distance: 0 },
    { word: 'coat', distance: 1 },
    { word: 'cot', distance: 1 },
    { word: 'cut', distance: 1 }
  ]);
});

test('EdtechAcademyTrieEngine - handles Unicode normalization and empty fuzzy queries accurately', () => {
  const engine = new EdtechAcademyTrieEngine(['Cafe\u0301', 'APR', 'APY', 'Vector']);

  assert.equal(engine.insert('CAFÉ'), false);
  assert.deepEqual(engine.fuzzySearch('cafe', 1), [{ word: 'Café', distance: 1 }]);
  assert.deepEqual(engine.fuzzySearch('', 0), []);
  assert.deepEqual(engine.fuzzySearch('', 3), [
    { word: 'APR', distance: 3 },
    { word: 'APY', distance: 3 }
  ]);
});

test('EdtechAcademyTrieEngine - rejects invalid inputs and supports remove, clear, and tree projection', () => {
  const engine = new EdtechAcademyTrieEngine(['Rust Kernel', 'Raft Protocol', 'RLHF Alignment']);

  assert.throws(() => engine.insert('   '), RangeError);
  assert.throws(() => engine.insert('a'.repeat(65)), RangeError);
  assert.throws(() => engine.insert('bad\nline'), RangeError);
  assert.throws(() => engine.insert(123), TypeError);
  assert.throws(() => engine.findWordsWithPrefix(null), TypeError);
  assert.throws(() => engine.fuzzySearch('rust', -1), RangeError);
  assert.throws(() => engine.fuzzySearch('rust', 1.5), RangeError);

  const subtree = engine.getTree('r');
  assert.equal(subtree.label, 'r');
  assert.equal(subtree.children.length, 3);
  assert.equal(engine.getTree('missing'), null);

  assert.equal(engine.remove('raft protocol'), true);
  assert.equal(engine.remove('raft protocol'), false);
  assert.equal(engine.has('Raft Protocol'), false);
  assert.equal(engine.size, 2);

  engine.clear();
  assert.equal(engine.size, 0);
  assert.deepEqual(engine.getAllWords(), []);
});

test('EdtechAcademyTrieEngine - starter curriculum terms load and search cleanly', () => {
  const engine = new EdtechAcademyTrieEngine(EDTECH_STARTER_TERMS);
  assert.equal(engine.size, EDTECH_STARTER_TERMS.length);
  assert.deepEqual(engine.findWordsWithPrefix('llm'), [
    'LLM Evaluation',
    'LLM Inference Architecture'
  ]);
  const suggestion = engine.fuzzySearch('pagdattenton', 2);
  assert.equal(suggestion[0].word, 'PagedAttention');
  assert.equal(suggestion[0].distance, 2);
});
