import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CulinaryBistroTrieEngine,
  BISTRO_LEXICON
} from './trie-search.js';

function referenceDistance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let row = 0; row <= a.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= b.length; column += 1) matrix[0][column] = column;
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
    }
  }
  return matrix[a.length][b.length];
}

function mulberry32(seed) {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

test('CulinaryBistroTrieEngine - initial terms require an explicit array', () => {
  for (const value of [null, 'ledger', {}, 1]) {
    assert.throws(() => new CulinaryBistroTrieEngine(value), TypeError);
  }
  assert.equal(new CulinaryBistroTrieEngine().size, 0);
});

test('CulinaryBistroTrieEngine - insert trims, normalizes, and deduplicates case-insensitively', () => {
  const engine = new CulinaryBistroTrieEngine();
  const decomposed = 'Cre\u0300me Bru\u0302le\u0301e';

  assert.equal(engine.insert(`  ${decomposed}  `), true);
  assert.equal(engine.insert('CRÈME BRÛLÉE'), false);
  assert.equal(engine.size, 1);
  assert.equal(engine.has(' crème brûlée '), true);
  assert.deepEqual(engine.findWordsWithPrefix('CRÈME'), ['Crème Brûlée']);
});

test('CulinaryBistroTrieEngine - insert rejects invalid terms with descriptive errors', () => {
  const engine = new CulinaryBistroTrieEngine();

  assert.throws(() => engine.insert(42), TypeError);
  assert.throws(() => engine.insert(null), TypeError);
  assert.throws(() => engine.insert('   '), RangeError);
  assert.throws(() => engine.insert('a'.repeat(65)), RangeError);
  assert.throws(() => engine.insert('bad\u0000term'), RangeError);
  assert.throws(() => engine.insert('line\nbreak'), RangeError);
});

test('CulinaryBistroTrieEngine - lexicon size is capped', () => {
  const words = Array.from({ length: 1000 }, (_, index) => `term${index}`);
  const engine = new CulinaryBistroTrieEngine(words);
  assert.equal(engine.size, 1000);
  assert.throws(() => engine.insert('one more'), RangeError);
});

test('CulinaryBistroTrieEngine - prefix traversal returns sorted completions', () => {
  const engine = new CulinaryBistroTrieEngine(['Almond', 'Alpine', 'Alpha', 'Beta']);

  assert.deepEqual(engine.findWordsWithPrefix('al'), ['Almond', 'Alpha', 'Alpine']);
  assert.deepEqual(engine.findWordsWithPrefix(' alpha '), ['Alpha']);
  assert.deepEqual(engine.findWordsWithPrefix('ALP'), ['Alpha', 'Alpine']);
  assert.deepEqual(engine.findWordsWithPrefix('unknown'), []);
});

test('CulinaryBistroTrieEngine - empty prefix returns every term in order', () => {
  const engine = new CulinaryBistroTrieEngine(['Beta', 'alpha', 'Gamma']);

  assert.deepEqual(engine.findWordsWithPrefix(''), ['alpha', 'Beta', 'Gamma']);
  assert.deepEqual(engine.findWordsWithPrefix('   '), ['alpha', 'Beta', 'Gamma']);
  assert.equal(engine.findWordsWithPrefix('', { limit: 2 }).length, 2);
  assert.throws(() => engine.findWordsWithPrefix('', { limit: 0 }), RangeError);
  assert.throws(() => engine.findWordsWithPrefix('', { limit: 51 }), RangeError);
});

test('CulinaryBistroTrieEngine - fuzzy search ranks by distance then alphabetically', () => {
  const engine = new CulinaryBistroTrieEngine(['cat', 'coat', 'cut', 'dog']);

  assert.deepEqual(engine.fuzzySearch('cot', 1), [
    { word: 'cat', distance: 1 },
    { word: 'coat', distance: 1 },
    { word: 'cut', distance: 1 }
  ]);
  assert.deepEqual(engine.fuzzySearch('cat', 0), [{ word: 'cat', distance: 0 }]);
  assert.deepEqual(engine.fuzzySearch('cot', 0), []);
  assert.deepEqual(engine.fuzzySearch('zzz', 2), []);
});

test('CulinaryBistroTrieEngine - fuzzy search handles an empty query by word length', () => {
  const engine = new CulinaryBistroTrieEngine(['a', 'ab', 'abc', 'abcd']);

  assert.deepEqual(engine.fuzzySearch('', 2), [
    { word: 'a', distance: 1 },
    { word: 'ab', distance: 2 }
  ]);
  assert.deepEqual(engine.fuzzySearch('', 0), []);
});

test('CulinaryBistroTrieEngine - fuzzy search validates its inputs', () => {
  const engine = new CulinaryBistroTrieEngine(['tea']);

  for (const distance of [-1, 4, 1.5, '2', null]) {
    assert.throws(() => engine.fuzzySearch('tea', distance), RangeError);
  }
  assert.throws(() => engine.fuzzySearch(9, 1), TypeError);
  assert.throws(() => engine.fuzzySearch('a'.repeat(65), 1), RangeError);
  assert.throws(() => engine.fuzzySearch('bad\u0000', 1), RangeError);
});

test('CulinaryBistroTrieEngine - Levenshtein distance is accurate for known pairs', () => {
  const engine = new CulinaryBistroTrieEngine();

  assert.equal(engine.levenshtein('kitten', 'sitting'), 3);
  assert.equal(engine.levenshtein('truffle', 'truffel'), 2);
  assert.equal(engine.levenshtein('saffron', 'safron'), 1);
  assert.equal(engine.levenshtein('', 'abc'), 3);
  assert.equal(engine.levenshtein('same', 'same'), 0);
  assert.equal(engine.levenshtein('  TRUFFLE ', 'truffel'), 2);
  assert.equal(engine.levenshtein('café', 'cafe'), 1);
  assert.equal(engine.levenshtein('🍣', '🍤'), 1);
  assert.equal(engine.levenshtein('a🍣b', 'ab'), 1);
});

test('CulinaryBistroTrieEngine - Levenshtein distance matches a reference matrix', () => {
  const engine = new CulinaryBistroTrieEngine();
  const random = mulberry32(20261128);
  const alphabet = ['a', 'b', 'c', 'd'];

  for (let sample = 0; sample < 250; sample += 1) {
    const length = Math.floor(random() * 8);
    let left = '';
    let right = '';
    for (let index = 0; index < length; index += 1) {
      left += alphabet[Math.floor(random() * alphabet.length)];
      right += alphabet[Math.floor(random() * alphabet.length)];
    }
    assert.equal(
      engine.levenshtein(left, right),
      referenceDistance(left, right),
      `${left} -> ${right}`
    );
  }
});

test('CulinaryBistroTrieEngine - alignment exposes a valid matrix and backtrack', () => {
  const engine = new CulinaryBistroTrieEngine();
  const trace = engine.align('trufel', 'truffle');

  assert.equal(trace.distance, 2);
  assert.equal(trace.matrix.length, Array.from('trufel').length + 1);
  assert.equal(trace.matrix[0].length, Array.from('truffle').length + 1);
  assert.equal(trace.matrix.at(-1).at(-1), trace.distance);
  assert.ok(trace.matches.every((index) => index >= 0 && index < trace.wordCharacters.length));
  const matched = trace.operations.filter((operation) => operation.type === 'match');
  assert.deepEqual(trace.matches, matched.map((operation) => operation.wordIndex));
  assert.ok(matched.every((operation) => (
    trace.queryCharacters[operation.queryIndex] === trace.wordCharacters[operation.wordIndex]
  )));
  assert.equal(
    trace.operations.filter((operation) => operation.type !== 'match').length,
    trace.distance
  );
  assert.equal(engine.align('', 'tea').distance, 3);
  assert.equal(engine.align('tea', '').distance, 3);
});

test('CulinaryBistroTrieEngine - suggest returns rich prefix and fuzzy results', () => {
  const engine = new CulinaryBistroTrieEngine(['truffle', 'truffel', 'trifle', 'waffle']);

  const prefix = engine.suggest('tru', { mode: 'prefix', limit: 2 });
  assert.deepEqual(prefix.map((entry) => entry.word), ['truffel', 'truffle']);
  assert.deepEqual(prefix[0].matches, [0, 1, 2]);
  assert.equal(prefix[0].kind, 'prefix');
  assert.equal(prefix[0].distance, 0);

  const exact = engine.suggest('truffle', { mode: 'prefix', limit: 1 });
  assert.equal(exact[0].kind, 'exact');

  const fuzzy = engine.suggest('trufel', { mode: 'fuzzy', maxDistance: 2, limit: 3 });
  assert.ok(fuzzy.length > 0);
  assert.ok(fuzzy.every((entry) => entry.distance <= 2));
  assert.ok(fuzzy.every((entry) => entry.kind === 'fuzzy' || entry.kind === 'exact'));
  assert.ok(fuzzy.every((entry) => Array.isArray(entry.matches)));

  assert.deepEqual(engine.suggest('', { mode: 'prefix', limit: 2 }).map((entry) => entry.word), ['trifle', 'truffel']);
  assert.equal(engine.suggest('', { mode: 'prefix', limit: 1 })[0].kind, 'term');
  assert.throws(() => engine.suggest('tru', { limit: 0 }), RangeError);
  assert.throws(() => engine.suggest('tru', { mode: 'fuzzy', maxDistance: 9 }), RangeError);
});

test('CulinaryBistroTrieEngine - buildTree serializes the hierarchy and marks the prefix path', () => {
  const engine = new CulinaryBistroTrieEngine(['tea', 'ted', 'ten', 'toast']);
  const tree = engine.buildTree({ prefix: 'te' });

  assert.equal(tree.character, '');
  assert.equal(tree.childCount, 1);
  assert.equal(tree.onPath, true);
  assert.equal(tree.children[0].character, 't');
  assert.equal(tree.children[0].onPath, true);
  assert.equal(tree.children[0].childCount, 2);

  const branch = tree.children[0].children.find((node) => node.character === 'e');
  assert.equal(branch.onPath, true);
  assert.equal(branch.childCount, 3);
  assert.deepEqual(branch.children.map((node) => node.character), ['a', 'd', 'n']);
  assert.deepEqual(branch.children.map((node) => node.word), ['tea', 'ted', 'ten']);

  const truncated = engine.buildTree({ maxNodes: 2 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.children[0].children.length, 0);
  assert.throws(() => engine.buildTree({ maxNodes: 0 }), RangeError);

  const focused = engine.buildTree({ prefix: 'ten', maxNodes: 4 });
  assert.equal(focused.children[0].character, 't');
  assert.equal(focused.children[0].children[0].character, 'e');
  assert.equal(focused.children[0].children[0].children[0].character, 'n');
  assert.equal(focused.children[0].children[0].children[0].onPath, true);
});

test('CulinaryBistroTrieEngine - prefixTrace and countWordsWithPrefix describe the walk', () => {
  const engine = new CulinaryBistroTrieEngine(['tea', 'ted', 'ten', 'toast']);

  assert.deepEqual(engine.prefixTrace('te').map((step) => step.character), ['t', 'e']);
  assert.ok(engine.prefixTrace('te').every((step) => step.found));
  assert.equal(engine.prefixTrace('te')[1].childCount, 3);
  assert.equal(engine.prefixTrace('tex').at(-1).found, false);
  assert.deepEqual(engine.prefixTrace(''), []);
  assert.equal(engine.countWordsWithPrefix('te'), 3);
  assert.equal(engine.countWordsWithPrefix('to'), 1);
  assert.equal(engine.countWordsWithPrefix('zz'), 0);
});

test('CulinaryBistroTrieEngine - delete prunes empty branches and clear resets the tree', () => {
  const engine = new CulinaryBistroTrieEngine(['tea', 'ted', 'ten']);

  assert.equal(engine.delete('TED'), true);
  assert.equal(engine.delete('ted'), false);
  assert.deepEqual(engine.findWordsWithPrefix('te'), ['tea', 'ten']);
  assert.equal(engine.has('ted'), false);

  assert.equal(engine.delete('tea'), true);
  assert.equal(engine.delete('ten'), true);
  assert.equal(engine.size, 0);
  assert.equal(engine.nodeCount, 1);

  engine.insert('sage');
  engine.clear();
  assert.equal(engine.size, 0);
  assert.equal(engine.nodeCount, 1);
  assert.deepEqual(engine.findWordsWithPrefix(''), []);
});

test('CulinaryBistroTrieEngine - stats report nodes, leaves, depth, and average length', () => {
  const engine = new CulinaryBistroTrieEngine(['tea', 'ten']);
  const stats = engine.stats();

  assert.equal(stats.terms, 2);
  assert.equal(stats.nodes, 5);
  assert.equal(stats.leaves, 2);
  assert.equal(stats.maxDepth, 3);
  assert.equal(stats.averageWordLength, 3);

  const empty = new CulinaryBistroTrieEngine().stats();
  assert.deepEqual(empty, {
    terms: 0,
    nodes: 1,
    leaves: 1,
    maxDepth: 0,
    averageWordLength: 0
  });
});

test('CulinaryBistroTrieEngine - returned collections are fresh snapshots', () => {
  const engine = new CulinaryBistroTrieEngine(['tea', 'ten']);
  const first = engine.findWordsWithPrefix('te');
  first.push('mutated');
  first[0] = 'changed';

  assert.deepEqual(engine.findWordsWithPrefix('te'), ['tea', 'ten']);
  const firstTree = engine.buildTree();
  firstTree.children.length = 0;
  assert.equal(engine.buildTree().children.length, 1);
});

test('CulinaryBistroTrieEngine - bundled bistro lexicon is clean and insertable', () => {
  assert.ok(BISTRO_LEXICON.length >= 60);
  const keys = new Set(BISTRO_LEXICON.map((term) => term.toLowerCase()));
  assert.equal(keys.size, BISTRO_LEXICON.length);

  const engine = new CulinaryBistroTrieEngine(BISTRO_LEXICON);
  assert.equal(engine.size, BISTRO_LEXICON.length);
  assert.ok(engine.findWordsWithPrefix('tru').includes('truffle'));
  assert.ok(engine.fuzzySearch('safron', 1).some((entry) => entry.word === 'saffron'));
});
