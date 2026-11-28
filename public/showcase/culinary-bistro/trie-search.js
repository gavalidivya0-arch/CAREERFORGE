/**
 * Culinary Bistro — Trie typeahead & Levenshtein spell-distance engine.
 *
 * The module has two halves:
 *   1. `CulinaryBistroTrieEngine` — a dependency-free prefix tree with
 *      case-insensitive lookups, edit-distance fuzzy search, and tree
 *      serialization for the visualizer.
 *   2. `mount()` — progressive enhancement for trie-search.html. It only runs
 *      in a browser, so the engine stays fully testable under `node:test`.
 */

const LIMITS = Object.freeze({
  words: 1000,
  characters: 64,
  treeNodes: 500,
  suggestions: 50
});

const DEFAULT_DISTANCE = 2;
const MAX_DISTANCE = 3;

/** A small bistro lexicon used by the standalone demo page. */
export const BISTRO_LEXICON = Object.freeze([
  'almond', 'amaretto', 'anchovy', 'apple', 'apricot', 'artichoke', 'arugula', 'asparagus',
  'basil', 'beetroot', 'brioche', 'burrata', 'butter', 'cabbage', 'cardamom', 'caramel',
  'caviar', 'charcuterie', 'cheesecake', 'chevre', 'chocolate', 'cinnamon', 'citrus', 'clove',
  'coriander', 'croissant', 'cumin', 'espresso', 'fennel', 'fig', 'foie gras', 'focaccia',
  'ganache', 'garlic', 'gazpacho', 'gnocchi', 'harissa', 'hollandaise', 'honey', 'juniper',
  'lavender', 'lemon', 'lemongrass', 'lobster', 'macaron', 'mascarpone', 'meringue', 'miso',
  'mozzarella', 'mushroom', 'olive', 'oregano', 'paprika', 'parmesan', 'pistachio', 'prosciutto',
  'radicchio', 'raspberry', 'risotto', 'rosemary', 'saffron', 'sage', 'salmon', 'sourdough',
  'tarragon', 'thyme', 'truffle', 'vanilla', 'vinaigrette', 'wasabi', 'yuzu', 'zucchini'
]);

function hasControlCharacter(character) {
  const code = character.codePointAt(0);
  return code < 32 || code === 127;
}

function normalizeTerm(value) {
  if (typeof value !== 'string') {
    throw new TypeError('A lexicon term must be a string.');
  }

  const display = value.trim().normalize('NFC');
  if (!display) {
    throw new RangeError('A lexicon term cannot be empty.');
  }

  const characters = Array.from(display);
  if (characters.length > LIMITS.characters) {
    throw new RangeError(`A lexicon term must be at most ${LIMITS.characters} characters.`);
  }
  if (characters.some(hasControlCharacter)) {
    throw new RangeError('A lexicon term cannot contain control characters.');
  }

  return { display, key: display.toLowerCase() };
}

function normalizeQuery(value, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') {
    throw new TypeError('A search query must be a string.');
  }

  const display = value.trim().normalize('NFC');
  const characters = Array.from(display);
  if (characters.length > LIMITS.characters) {
    throw new RangeError(`A search query must be at most ${LIMITS.characters} characters.`);
  }
  if (characters.some(hasControlCharacter)) {
    throw new RangeError('A search query cannot contain control characters.');
  }
  if (!allowEmpty && characters.length === 0) {
    throw new RangeError('A search query cannot be empty.');
  }

  const key = display.toLowerCase();
  return { display, key, characters: Array.from(key) };
}

function normalizeDistance(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DISTANCE) {
    throw new RangeError(`Edit distance must be an integer from 0 to ${MAX_DISTANCE}.`);
  }
  return value;
}

function normalizeLimit(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.suggestions) {
    throw new RangeError(`Result limit must be an integer from 1 to ${LIMITS.suggestions}.`);
  }
  return value;
}

function normalizeTreeLimit(value) {
  if (value === undefined) return LIMITS.treeNodes;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new RangeError('Tree node limit must be an integer from 1 to 500.');
  }
  return value;
}

function compareKeys(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createNode(character = '', depth = 0) {
  return { character, depth, children: new Map(), word: null };
}

function sortedChildren(node) {
  return [...node.children.values()].sort((left, right) => compareKeys(left.character, right.character));
}

function comparableCharacters(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Both spellings must be strings.');
  }
  return Array.from(value.trim().normalize('NFC').toLowerCase());
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export class CulinaryBistroTrieEngine {
  constructor(words = []) {
    if (!Array.isArray(words)) {
      throw new TypeError('Initial terms must be an array.');
    }
    this.root = createNode();
    this.keys = new Set();
    for (const word of words) this.insert(word);
  }

  get size() {
    return this.keys.size;
  }

  get nodeCount() {
    let count = 0;
    const walk = (node) => {
      count += 1;
      for (const child of node.children.values()) walk(child);
    };
    walk(this.root);
    return count;
  }

  insert(word) {
    const { display, key } = normalizeTerm(word);
    if (this.keys.has(key)) return false;
    if (this.keys.size >= LIMITS.words) {
      throw new RangeError(`The local lexicon holds up to ${LIMITS.words} terms.`);
    }

    let current = this.root;
    for (const character of key) {
      let child = current.children.get(character);
      if (!child) {
        child = createNode(character, current.depth + 1);
        current.children.set(character, child);
      }
      current = child;
    }
    current.word = display;
    this.keys.add(key);
    return true;
  }

  has(word) {
    return this.keys.has(normalizeTerm(word).key);
  }

  delete(word) {
    const { key } = normalizeTerm(word);
    if (!this.keys.has(key)) return false;

    const path = [this.root];
    let current = this.root;
    for (const character of key) {
      current = current.children.get(character);
      path.push(current);
    }
    current.word = null;
    this.keys.delete(key);

    for (let index = path.length - 1; index > 0; index -= 1) {
      const node = path[index];
      if (node.word !== null || node.children.size > 0) break;
      path[index - 1].children.delete(node.character);
    }
    return true;
  }

  clear() {
    this.root = createNode();
    this.keys.clear();
  }

  locate(prefix) {
    return this.#locateKey(normalizeQuery(prefix).key);
  }

  #locateKey(key) {
    let current = this.root;
    for (const character of key) {
      current = current.children.get(character);
      if (!current) return null;
    }
    return current;
  }

  #collect(node, output, limit) {
    if (output.length >= limit) return;
    if (node.word !== null) output.push(node.word);
    for (const child of sortedChildren(node)) {
      if (output.length >= limit) return;
      this.#collect(child, output, limit);
    }
  }

  findWordsWithPrefix(prefix, options = {}) {
    const { key } = normalizeQuery(prefix);
    const limit = normalizeLimit(options.limit, LIMITS.suggestions);
    const start = this.#locateKey(key);
    if (!start) return [];

    const words = [];
    this.#collect(start, words, limit);
    return words;
  }

  countWordsWithPrefix(prefix) {
    const start = this.#locateKey(normalizeQuery(prefix).key);
    if (!start) return 0;

    let count = 0;
    const walk = (node) => {
      if (node.word !== null) count += 1;
      for (const child of node.children.values()) walk(child);
    };
    walk(start);
    return count;
  }

  fuzzySearch(query, maxDistance = DEFAULT_DISTANCE) {
    const { characters } = normalizeQuery(query);
    const distanceLimit = normalizeDistance(maxDistance);
    const results = [];
    const initialRow = Array.from({ length: characters.length + 1 }, (_, index) => index);

    const visit = (node, previousRow) => {
      const row = new Array(characters.length + 1);
      row[0] = previousRow[0] + 1;
      let rowMinimum = row[0];

      for (let index = 1; index <= characters.length; index += 1) {
        const substitution = previousRow[index - 1] + (characters[index - 1] === node.character ? 0 : 1);
        const value = Math.min(row[index - 1] + 1, previousRow[index] + 1, substitution);
        row[index] = value;
        if (value < rowMinimum) rowMinimum = value;
      }

      if (node.word !== null && row[characters.length] <= distanceLimit) {
        results.push({ word: node.word, distance: row[characters.length] });
      }

      // Every value in a row is a lower bound for its subtree, so an
      // out-of-budget row can be pruned without losing valid matches.
      if (rowMinimum <= distanceLimit) {
        for (const child of sortedChildren(node)) visit(child, row);
      }
    };

    for (const child of sortedChildren(this.root)) visit(child, initialRow);

    return results.sort((left, right) => (
      left.distance - right.distance
      || compareKeys(left.word.toLowerCase(), right.word.toLowerCase())
    ));
  }

  levenshtein(left, right) {
    return editDistance(comparableCharacters(left), comparableCharacters(right));
  }

  /**
   * Computes a full Levenshtein matrix and backtracks the alignment so the UI
   * can highlight which characters in `word` actually matched the query.
   */
  align(query, word) {
    const queryInfo = normalizeQuery(query);
    const wordInfo = normalizeQuery(word);
    const queryCharacters = queryInfo.characters;
    const wordCharacters = wordInfo.characters;
    const matrix = Array.from(
      { length: queryCharacters.length + 1 },
      () => new Array(wordCharacters.length + 1).fill(0)
    );

    for (let row = 0; row <= queryCharacters.length; row += 1) matrix[row][0] = row;
    for (let column = 0; column <= wordCharacters.length; column += 1) matrix[0][column] = column;

    for (let row = 1; row <= queryCharacters.length; row += 1) {
      for (let column = 1; column <= wordCharacters.length; column += 1) {
        matrix[row][column] = Math.min(
          matrix[row - 1][column] + 1,
          matrix[row][column - 1] + 1,
          matrix[row - 1][column - 1] + (queryCharacters[row - 1] === wordCharacters[column - 1] ? 0 : 1)
        );
      }
    }

    const operations = [];
    const matches = [];
    let row = queryCharacters.length;
    let column = wordCharacters.length;

    while (row > 0 || column > 0) {
      if (
        row > 0
        && column > 0
        && queryCharacters[row - 1] === wordCharacters[column - 1]
        && matrix[row][column] === matrix[row - 1][column - 1]
      ) {
        operations.push({ type: 'match', queryIndex: row - 1, wordIndex: column - 1 });
        matches.push(column - 1);
        row -= 1;
        column -= 1;
      } else if (row > 0 && column > 0 && matrix[row][column] === matrix[row - 1][column - 1] + 1) {
        operations.push({ type: 'substitute', queryIndex: row - 1, wordIndex: column - 1 });
        row -= 1;
        column -= 1;
      } else if (row > 0 && matrix[row][column] === matrix[row - 1][column] + 1) {
        operations.push({ type: 'delete', queryIndex: row - 1 });
        row -= 1;
      } else {
        operations.push({ type: 'insert', wordIndex: column - 1 });
        column -= 1;
      }
    }

    operations.reverse();
    matches.reverse();

    return {
      query: queryInfo.display,
      word: wordInfo.display,
      queryCharacters,
      wordCharacters,
      distance: matrix[queryCharacters.length][wordCharacters.length],
      matrix,
      matches,
      operations
    };
  }

  /**
   * Rich suggestions for the typeahead. Prefix mode returns every completion
   * with the matched character indexes; fuzzy mode returns ranked spell fixes
   * with an alignment highlight.
   */
  suggest(query, options = {}) {
    const mode = options.mode === 'fuzzy' ? 'fuzzy' : 'prefix';
    const limit = normalizeLimit(options.limit, 8);
    const queryInfo = normalizeQuery(query);

    if (mode === 'fuzzy') {
      const maxDistance = normalizeDistance(options.maxDistance ?? DEFAULT_DISTANCE);
      return this.fuzzySearch(queryInfo.key, maxDistance).slice(0, limit).map((match) => {
        const alignment = this.align(queryInfo.key, match.word);
        return {
          word: match.word,
          distance: match.distance,
          kind: match.distance === 0 ? 'exact' : 'fuzzy',
          matchedLength: queryInfo.characters.length,
          matches: alignment.matches
        };
      });
    }

    return this.findWordsWithPrefix(queryInfo.key, { limit }).map((word) => {
      const key = word.toLowerCase();
      const wordLength = Array.from(word).length;
      return {
        word,
        distance: 0,
        kind: !queryInfo.key ? 'term' : key === queryInfo.key ? 'exact' : 'prefix',
        matchedLength: queryInfo.characters.length,
        matches: Array.from(
          { length: Math.min(queryInfo.characters.length, wordLength) },
          (_, index) => index
        )
      };
    });
  }

  prefixTrace(prefix) {
    const { key } = normalizeQuery(prefix);
    const steps = [];
    let current = this.root;

    for (const character of key) {
      const next = current.children.get(character);
      if (!next) {
        steps.push({ character, found: false, childCount: 0, word: null });
        break;
      }
      current = next;
      steps.push({ character, found: true, childCount: next.children.size, word: next.word });
    }
    return steps;
  }

  /**
   * Serializes the trie into a bounded, deterministic hierarchy for rendering.
   * Nodes on the path of `options.prefix` are flagged with `onPath`.
   */
  buildTree(options = {}) {
    const maxNodes = normalizeTreeLimit(options.maxNodes);
    const prefixInfo = normalizeQuery(options.prefix ?? '');
    const pathKey = prefixInfo.key;
    const pathPrefixes = new Set(['']);
    let pathPrefix = '';
    for (const character of pathKey) {
      pathPrefix += character;
      pathPrefixes.add(pathPrefix);
    }

    let budget = maxNodes;
    let truncated = false;

    const build = (node, path) => {
      budget -= 1;
      const ordered = sortedChildren(node);
      const pathChild = ordered.findIndex((child) => pathPrefixes.has(path + child.character));
      if (pathChild > 0) {
        const [child] = ordered.splice(pathChild, 1);
        ordered.unshift(child);
      }

      const children = [];
      for (const child of ordered) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        children.push(build(child, path + child.character));
      }

      return {
        character: node.character,
        depth: node.depth,
        path,
        word: node.word,
        terminal: node.word !== null,
        childCount: node.children.size,
        onPath: pathPrefixes.has(path),
        children
      };
    };

    return {
      ...build(this.root, ''),
      prefix: prefixInfo.display,
      maxNodes,
      truncated
    };
  }

  stats() {
    let nodes = 0;
    let leaves = 0;
    let maxDepth = 0;
    let wordCharacters = 0;

    const walk = (node) => {
      nodes += 1;
      if (node.depth > maxDepth) maxDepth = node.depth;
      if (node.word !== null) wordCharacters += Array.from(node.word).length;
      if (node.children.size === 0) leaves += 1;
      for (const child of node.children.values()) walk(child);
    };
    walk(this.root);

    return {
      terms: this.size,
      nodes,
      leaves,
      maxDepth,
      averageWordLength: this.size === 0 ? 0 : wordCharacters / this.size
    };
  }
}

// ---------------------------------------------------------------------------
// Browser UI
// ---------------------------------------------------------------------------

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function highlightedWord(word, matches) {
  const fragment = document.createDocumentFragment();
  const matched = new Set(matches);
  let buffer = '';
  let bufferMatched = false;

  const flush = () => {
    if (!buffer) return;
    if (bufferMatched) fragment.append(createElement('mark', 'match-char', buffer));
    else fragment.append(document.createTextNode(buffer));
    buffer = '';
  };

  Array.from(word).forEach((character, index) => {
    const isMatched = matched.has(index);
    if (buffer && isMatched !== bufferMatched) flush();
    bufferMatched = isMatched;
    buffer += character;
  });
  flush();
  return fragment;
}

function mount() {
  const root = document.querySelector('[data-trie-lab]');
  if (!root || root.dataset.trieMounted === 'true') return;
  root.dataset.trieMounted = 'true';

  const find = (selector) => root.querySelector(selector);
  const elements = {
    query: find('#trie-query'),
    clear: find('#trie-clear'),
    status: find('#trie-status'),
    distance: find('#trie-distance'),
    distanceControl: find('#trie-distance-control'),
    suggestions: find('#trie-suggestions'),
    trace: find('#trie-trace'),
    traceCaption: find('#trace-caption'),
    traceDistance: find('#trace-distance'),
    tree: find('#trie-tree'),
    treeCount: find('#tree-count'),
    expand: find('#tree-expand'),
    collapse: find('#tree-collapse'),
    addForm: find('#trie-add-form'),
    addInput: find('#trie-add-input'),
    addStatus: find('#trie-add-status'),
    seed: find('#trie-seed'),
    stats: {
      terms: find('#stat-terms'),
      nodes: find('#stat-nodes'),
      matches: find('#stat-matches'),
      depth: find('#stat-depth')
    }
  };

  if (!elements.query || !elements.suggestions || !elements.tree) return;

  let engine = new CulinaryBistroTrieEngine(BISTRO_LEXICON);
  let mode = 'prefix';
  let maxDistance = DEFAULT_DISTANCE;
  let suggestions = [];
  let activeIndex = -1;
  let lastTreeQuery = null;
  const expanded = new Set(['']);

  const seedExpanded = () => {
    expanded.clear();
    expanded.add('');
    for (const term of BISTRO_LEXICON) {
      const [first] = Array.from(term.toLowerCase());
      if (first) expanded.add(first);
    }
  };
  seedExpanded();

  const setText = (element, value) => {
    if (element) element.textContent = String(value);
  };

  function setAddStatus(message, isError = false) {
    if (!elements.addStatus) return;
    elements.addStatus.textContent = message;
    elements.addStatus.classList.toggle('is-error', isError);
  }

  function setActive(index) {
    if (suggestions.length === 0) return;
    activeIndex = index;
    const options = elements.suggestions.querySelectorAll('[role="option"]');
    options.forEach((option, optionIndex) => {
      const active = optionIndex === activeIndex;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', String(active));
    });

    const activeOption = options[activeIndex];
    if (activeOption) {
      elements.query.setAttribute('aria-activedescendant', activeOption.id);
      if (typeof activeOption.scrollIntoView === 'function') {
        activeOption.scrollIntoView({ block: 'nearest' });
      }
    } else {
      elements.query.removeAttribute('aria-activedescendant');
    }
  }

  function selectWord(word) {
    elements.query.value = word;
    activeIndex = -1;
    render();
    elements.query.focus();
  }

  function renderSuggestions() {
    elements.suggestions.replaceChildren();
    if (activeIndex < 0) elements.query.removeAttribute('aria-activedescendant');

    if (suggestions.length === 0) {
      const empty = createElement('li', 'suggestion-empty');
      empty.setAttribute('role', 'presentation');
      empty.textContent = elements.query.value.trim()
        ? 'No terms match this query yet.'
        : 'The lexicon is empty — add a term below.';
      elements.suggestions.append(empty);
      elements.query.setAttribute('aria-expanded', 'false');
      elements.query.removeAttribute('aria-activedescendant');
      return;
    }

    suggestions.forEach((suggestion, index) => {
      const option = createElement('li', 'suggestion');
      option.id = `trie-option-${index}`;
      option.dataset.index = String(index);
      option.dataset.word = suggestion.word;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.tabIndex = -1;

      const word = createElement('span', 'suggestion-word');
      word.append(highlightedWord(suggestion.word, suggestion.matches));

      const kind = createElement(
        'span',
        `suggestion-kind is-${suggestion.kind}`,
        suggestion.kind === 'fuzzy' ? `Δ ${suggestion.distance}` : suggestion.kind
      );

      option.append(word, kind);
      elements.suggestions.append(option);
    });

    elements.query.setAttribute('aria-expanded', 'true');
    if (activeIndex >= 0) {
      setActive(Math.min(activeIndex, suggestions.length - 1));
    }
  }

  function renderStatus(totalMatches) {
    const query = elements.query.value.trim();
    if (!query) {
      setText(
        elements.status,
        mode === 'prefix'
          ? `${engine.size} terms indexed. Start typing to walk the prefix tree.`
          : `${engine.size} terms indexed. Type a misspelling to rank it by edit distance.`
      );
      return;
    }

    if (suggestions.length === 0) {
      setText(
        elements.status,
        mode === 'prefix'
          ? `No term starts with “${query}”.`
          : `No term is within Δ${maxDistance} of “${query}”.`
      );
      return;
    }

    if (mode === 'prefix') {
      const hidden = Math.max(0, totalMatches - suggestions.length);
      setText(
        elements.status,
        `${totalMatches} ${totalMatches === 1 ? 'term shares' : 'terms share'} “${query}”${hidden ? ` · showing first ${suggestions.length}` : ''}.`
      );
    } else {
      setText(
        elements.status,
        `${totalMatches} spelling suggestion${totalMatches === 1 ? '' : 's'} within Δ${maxDistance} of “${query}”${totalMatches > suggestions.length ? ` · showing first ${suggestions.length}` : ''}.`
      );
    }
  }

  function renderTraceIntro() {
    const stats = engine.stats();
    const intro = createElement('div', 'trace-intro');
    const facts = [
      ['Prefix walk', 'Follow one edge per character, then collect the subtree.'],
      ['Spell rescue', `Rows above Δ${maxDistance} prune the whole branch.`],
      ['Local index', `${stats.terms} terms · ${stats.nodes} nodes · no network calls.`]
    ];
    for (const [title, detail] of facts) {
      const card = createElement('div', 'trace-fact');
      card.append(createElement('strong', '', title), createElement('span', '', detail));
      intro.append(card);
    }
    elements.trace.replaceChildren(intro);
  }

  function renderPrefixTrace(query) {
    const steps = engine.prefixTrace(query);
    if (steps.length === 0) {
      renderTraceIntro();
      setText(elements.traceDistance, '—');
      setText(elements.traceCaption, 'Walk the trie: each character narrows the branch.');
      return;
    }

    const list = createElement('ol', 'prefix-trace');
    steps.forEach((step) => {
      const item = createElement('li', `trace-step ${step.found ? 'is-found' : 'is-missing'}`);
      item.append(createElement('span', 'trace-char', step.character));
      item.append(createElement(
        'span',
        'trace-meta',
        step.found
          ? `${step.childCount} branch${step.childCount === 1 ? '' : 'es'}${step.word ? ` · “${step.word}”` : ''}`
          : 'branch missing'
      ));
      list.append(item);
    });
    elements.trace.replaceChildren(list);

    const hits = engine.countWordsWithPrefix(query);
    setText(elements.traceDistance, `${hits} hit${hits === 1 ? '' : 's'}`);
    setText(
      elements.traceCaption,
      `“${query.trim()}” traverses ${steps.filter((step) => step.found).length} node${steps.filter((step) => step.found).length === 1 ? '' : 's'} and reaches ${hits} term${hits === 1 ? '' : 's'}.`
    );
  }

  function renderFuzzyTrace(query) {
    if (!query.trim()) {
      renderTraceIntro();
      setText(elements.traceDistance, '—');
      setText(elements.traceCaption, 'Each cell is the cheapest edit cost for that prefix pair.');
      return;
    }

    if (suggestions.length === 0) {
      elements.trace.replaceChildren(createElement('p', 'trace-empty', `No word is within Δ${maxDistance}. Widen the distance to see a matrix.`));
      setText(elements.traceDistance, '—');
      setText(elements.traceCaption, 'A Levenshtein matrix appears when a candidate is found.');
      return;
    }

    const trace = engine.align(query, suggestions[0].word);
    const table = createElement('table', 'trace-matrix');
    const caption = createElement('caption', 'sr-only', `Levenshtein matrix for ${trace.query} and ${trace.word}`);
    table.append(caption);

    const head = createElement('thead');
    const headRow = createElement('tr');
    headRow.append(createElement('th', 'trace-corner', '∅'));
    trace.queryCharacters.forEach((character) => {
      headRow.append(createElement('th', 'trace-query', character));
    });
    head.append(headRow);
    table.append(head);

    const body = createElement('tbody');
    const emptyRow = createElement('tr');
    emptyRow.append(createElement('th', 'trace-word', '∅'));
    for (let column = 0; column <= trace.queryCharacters.length; column += 1) {
      emptyRow.append(createElement('td', '', String(trace.matrix[column][0])));
    }
    body.append(emptyRow);

    trace.wordCharacters.forEach((character, wordIndex) => {
      const row = createElement('tr');
      row.append(createElement('th', 'trace-word', character));
      for (let column = 0; column <= trace.queryCharacters.length; column += 1) {
        const cell = createElement('td', '', String(trace.matrix[column][wordIndex + 1]));
        if (column === trace.queryCharacters.length && wordIndex === trace.wordCharacters.length - 1) {
          cell.classList.add('is-final');
        }
        row.append(cell);
      }
      body.append(row);
    });
    table.append(body);

    const legend = createElement('div', 'trace-legend');
    legend.append(createElement('span', '', '∅ = empty prefix'));
    legend.append(createElement('span', 'legend-final', 'final distance'));
    elements.trace.replaceChildren(table, legend);

    setText(elements.traceDistance, `Δ ${trace.distance}`);
    setText(
      elements.traceCaption,
      `“${trace.query}” → “${trace.word}” · ${trace.distance} edit${trace.distance === 1 ? '' : 's'} · ${trace.matches.length} matched character${trace.matches.length === 1 ? '' : 's'}.`
    );
  }

  function renderTrace(query) {
    if (mode === 'fuzzy') renderFuzzyTrace(query);
    else renderPrefixTrace(query);
  }

  function buildTreeRow(node, isRoot = false) {
    const item = createElement('li', 'tree-item');
    const row = createElement('div', 'tree-row');
    row.style.setProperty('--depth', String(node.depth));
    if (node.onPath) row.classList.add('is-path');
    if (node.terminal) row.classList.add('is-terminal');

    const hasChildren = node.children.length > 0;
    const open = isRoot || expanded.has(node.path);
    const toggle = createElement('button', 'tree-toggle', hasChildren ? (open ? '▾' : '▸') : '·');
    toggle.type = 'button';
    toggle.dataset.treeToggle = node.path;
    toggle.setAttribute('aria-label', `Toggle ${node.path || 'root'} branch`);
    toggle.setAttribute('aria-expanded', String(open));
    if (!hasChildren) toggle.disabled = true;

    const label = createElement('button', 'tree-label');
    label.type = 'button';
    label.dataset.treePrefix = node.path;
    label.append(createElement('span', 'tree-char', isRoot ? '∅' : node.character));
    if (node.word !== null) {
      label.append(createElement('span', 'tree-word', node.word));
      label.append(createElement('span', 'tree-terminal', 'word'));
    } else {
      label.append(createElement('span', 'tree-word is-empty', isRoot ? 'root' : ''));
    }
    if (node.childCount > 0) {
      label.append(createElement('span', 'tree-branches', String(node.childCount)));
    }
    if (node.childCount > node.children.length) {
      label.append(createElement('span', 'tree-more', '…'));
    }

    row.append(toggle, label);
    item.append(row);

    if (hasChildren) {
      const children = createElement('ul', 'tree-children');
      children.hidden = !open;
      for (const child of node.children) children.append(buildTreeRow(child));
      item.append(children);
    }
    return item;
  }

  function renderTree(query) {
    const scrollTop = elements.tree.scrollTop;
    const tree = engine.buildTree({ prefix: query, maxNodes: LIMITS.treeNodes });

    const prefixKey = query.trim().toLowerCase();
    if (prefixKey !== lastTreeQuery) {
      const prefixCharacters = Array.from(prefixKey);
      for (let index = 1; index <= prefixCharacters.length; index += 1) {
        expanded.add(prefixCharacters.slice(0, index).join(''));
      }
      lastTreeQuery = prefixKey;
    }

    const stats = engine.stats();
    setText(
      elements.treeCount,
      `${stats.nodes} node${stats.nodes === 1 ? '' : 's'}${tree.truncated ? ` · showing first ${tree.maxNodes}` : ''}`
    );

    if (engine.size === 0) {
      elements.tree.replaceChildren(createElement('p', 'tree-empty', 'Insert a term to grow the first branch.'));
      return;
    }

    const list = createElement('ul', 'tree-root');
    list.append(buildTreeRow(tree, true));
    elements.tree.replaceChildren(list);
    elements.tree.scrollTop = scrollTop;
  }

  function updateModeButtons() {
    root.querySelectorAll('[data-mode]').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function render() {
    const query = elements.query.value;
    elements.clear.hidden = query.length === 0;
    elements.distanceControl.hidden = mode !== 'fuzzy';
    elements.distance.value = String(maxDistance);
    updateModeButtons();

    const stats = engine.stats();
    setText(elements.stats.terms, stats.terms);
    setText(elements.stats.nodes, stats.nodes);
    setText(elements.stats.depth, stats.maxDepth);

    let totalMatches = 0;
    try {
      suggestions = engine.suggest(query, { mode, maxDistance, limit: 8 });
      totalMatches = mode === 'fuzzy'
        ? engine.fuzzySearch(query, maxDistance).length
        : engine.countWordsWithPrefix(query);
      setText(elements.stats.matches, totalMatches);
      renderSuggestions();
      renderTrace(query);
      renderStatus(totalMatches);
    } catch (error) {
      suggestions = [];
      setText(elements.stats.matches, 0);
      renderSuggestions();
      elements.trace.replaceChildren(createElement('p', 'trace-empty is-error', error.message));
      setText(elements.traceDistance, '—');
      setText(elements.traceCaption, 'Adjust the query and try again.');
      setText(elements.status, error.message);
    }

    try {
      renderTree(query);
    } catch {
      renderTree('');
    }
  }

  elements.query.addEventListener('input', () => {
    activeIndex = -1;
    render();
  });

  elements.query.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (suggestions.length > 0) setActive((activeIndex + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (suggestions.length > 0) {
        setActive(activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1);
      }
    } else if (event.key === 'Enter' && activeIndex >= 0 && suggestions[activeIndex]) {
      event.preventDefault();
      selectWord(suggestions[activeIndex].word);
    } else if (event.key === 'Escape') {
      activeIndex = -1;
      setActive(-1);
      elements.query.setAttribute('aria-expanded', String(suggestions.length > 0));
    }
  });

  elements.suggestions.addEventListener('click', (event) => {
    const option = event.target.closest('[data-word]');
    if (option) selectWord(option.dataset.word);
  });

  elements.suggestions.addEventListener('pointermove', (event) => {
    const option = event.target.closest('[data-index]');
    if (option) setActive(Number(option.dataset.index));
  });

  elements.clear.addEventListener('click', () => {
    elements.query.value = '';
    activeIndex = -1;
    render();
    elements.query.focus();
  });

  elements.distance.addEventListener('change', () => {
    maxDistance = Number(elements.distance.value);
    render();
  });

  root.addEventListener('click', (event) => {
    const modeButton = event.target.closest('[data-mode]');
    if (modeButton) {
      mode = modeButton.dataset.mode === 'fuzzy' ? 'fuzzy' : 'prefix';
      activeIndex = -1;
      render();
      return;
    }

    const sample = event.target.closest('[data-sample-query]');
    if (sample) {
      elements.query.value = sample.dataset.sampleQuery;
      render();
      elements.query.focus();
    }
  });

  elements.tree.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-tree-toggle]');
    if (toggle && !toggle.disabled) {
      const path = toggle.dataset.treeToggle;
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      renderTree(elements.query.value);
      return;
    }

    const label = event.target.closest('[data-tree-prefix]');
    if (label) {
      elements.query.value = label.dataset.treePrefix;
      render();
      elements.query.focus();
    }
  });

  elements.expand.addEventListener('click', () => {
    const tree = engine.buildTree({ prefix: elements.query.value, maxNodes: LIMITS.treeNodes });
    const walk = (node) => {
      expanded.add(node.path);
      for (const child of node.children) walk(child);
    };
    walk(tree);
    renderTree(elements.query.value);
  });

  elements.collapse.addEventListener('click', () => {
    expanded.clear();
    expanded.add('');
    renderTree(elements.query.value);
  });

  elements.addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = elements.addInput.value;
    try {
      const added = engine.insert(value);
      if (added) {
        setAddStatus(`Added “${value.trim()}”.`);
        elements.addInput.value = '';
        render();
      } else {
        setAddStatus(`“${value.trim()}” is already in the lexicon.`);
      }
    } catch (error) {
      setAddStatus(error.message, true);
    }
  });

  elements.seed.addEventListener('click', () => {
    engine = new CulinaryBistroTrieEngine(BISTRO_LEXICON);
    seedExpanded();
    elements.query.value = '';
    elements.addInput.value = '';
    setAddStatus('Bistro lexicon restored.');
    render();
  });

  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}
