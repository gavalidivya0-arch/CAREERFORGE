const LIMITS = Object.freeze({
  words: 2000,
  characters: 64,
  treeNodes: 220
});

const hasControlCharacter = (text) => Array.from(text).some((character) => {
  const code = character.codePointAt(0);
  return code < 32 || code === 127;
});

const normalizeInput = (value, { allowEmpty = false, label = 'Term' } = {}) => {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  const trimmed = value.trim().normalize('NFC');
  if (!trimmed && !allowEmpty) {
    throw new RangeError(`${label} cannot be empty.`);
  }
  if (Array.from(trimmed).length > LIMITS.characters) {
    throw new RangeError(`${label} must be ${LIMITS.characters} characters or fewer.`);
  }
  if (hasControlCharacter(trimmed)) {
    throw new RangeError(`${label} cannot contain control characters.`);
  }
  return { trimmed, key: trimmed.toLowerCase() };
};

const createNode = () => ({
  children: new Map(),
  word: null
});

const sortedChildren = (node) => (
  [...node.children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
);

const compareWords = (a, b) => (
  a.toLowerCase().localeCompare(b.toLowerCase(), 'en') || a.localeCompare(b, 'en')
);

/**
 * In-memory Prefix Tree (Trie) search & Levenshtein spell-distance engine
 * for Synapse / Edtech Academy curriculum discovery.
 */
export class EdtechAcademyTrieEngine {
  constructor(words = []) {
    if (!Array.isArray(words)) {
      throw new TypeError('Initial terms must be an array.');
    }
    this.root = createNode();
    this.keys = new Set();
    for (const word of words) {
      this.insert(word);
    }
  }

  get size() {
    return this.keys.size;
  }

  get nodeCount() {
    let total = 0;
    const countNodes = (node) => {
      total += 1;
      for (const [, child] of node.children) {
        countNodes(child);
      }
    };
    countNodes(this.root);
    return total;
  }

  insert(word) {
    const { trimmed, key } = normalizeInput(word, { allowEmpty: false, label: 'Term' });
    if (this.keys.has(key)) {
      return false;
    }
    if (this.size >= LIMITS.words) {
      throw new RangeError(`The in-memory lexicon holds up to ${LIMITS.words} terms.`);
    }

    let current = this.root;
    for (const character of key) {
      if (!current.children.has(character)) {
        current.children.set(character, createNode());
      }
      current = current.children.get(character);
    }

    current.word = trimmed;
    this.keys.add(key);
    return true;
  }

  has(word) {
    const { key } = normalizeInput(word, { allowEmpty: false, label: 'Term' });
    let current = this.root;
    for (const character of key) {
      current = current.children.get(character);
      if (!current) {
        return false;
      }
    }
    return current.word !== null;
  }

  remove(word) {
    const { key } = normalizeInput(word, { allowEmpty: false, label: 'Term' });
    if (!this.keys.has(key)) {
      return false;
    }

    const trail = [];
    let current = this.root;
    for (const character of key) {
      trail.push([current, character]);
      current = current.children.get(character);
    }

    current.word = null;
    this.keys.delete(key);

    for (let index = trail.length - 1; index >= 0; index -= 1) {
      const [parent, character] = trail[index];
      const child = parent.children.get(character);
      if (!child || child.word !== null || child.children.size > 0) {
        break;
      }
      parent.children.delete(character);
    }

    return true;
  }

  locate(prefix) {
    const { key } = normalizeInput(prefix, { allowEmpty: true, label: 'Prefix' });
    let current = this.root;
    for (const character of key) {
      current = current.children.get(character);
      if (!current) {
        return null;
      }
    }
    return current;
  }

  findWordsWithPrefix(prefix, limit = Infinity) {
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError('Result limit must be a non-negative integer.');
    }

    const start = this.locate(prefix);
    if (!start || limit === 0) {
      return [];
    }

    const results = [];
    const visit = (node) => {
      if (results.length >= limit) return;
      if (node.word !== null) {
        results.push(node.word);
      }
      for (const [, child] of sortedChildren(node)) {
        if (results.length >= limit) return;
        visit(child);
      }
    };

    visit(start);
    return results;
  }

  getAllWords() {
    return this.findWordsWithPrefix('');
  }

  fuzzySearch(query, maxDistance = 2) {
    if (!Number.isInteger(maxDistance) || maxDistance < 0 || maxDistance > LIMITS.characters) {
      throw new RangeError(`Edit distance must be an integer from 0 to ${LIMITS.characters}.`);
    }

    const { key } = normalizeInput(query, { allowEmpty: true, label: 'Query' });
    const letters = Array.from(key);
    const results = [];
    const initialRow = Array.from({ length: letters.length + 1 }, (_, index) => index);

    const searchBranch = (node, character, previousRow) => {
      const row = [previousRow[0] + 1];
      let rowMin = row[0];

      for (let i = 1; i <= letters.length; i += 1) {
        const substitutionCost = letters[i - 1] === character ? 0 : 1;
        const distance = Math.min(
          row[i - 1] + 1,
          previousRow[i] + 1,
          previousRow[i - 1] + substitutionCost
        );
        row[i] = distance;
        if (distance < rowMin) rowMin = distance;
      }

      const terminalDistance = row[letters.length];
      if (node.word !== null && terminalDistance <= maxDistance) {
        results.push({ word: node.word, distance: terminalDistance });
      }

      if (rowMin <= maxDistance) {
        for (const [nextChar, child] of sortedChildren(node)) {
          searchBranch(child, nextChar, row);
        }
      }
    };

    for (const [character, child] of sortedChildren(this.root)) {
      searchBranch(child, character, initialRow);
    }

    return results.sort((a, b) => a.distance - b.distance || compareWords(a.word, b.word));
  }

  getTree(prefix = '') {
    const { key } = normalizeInput(prefix, { allowEmpty: true, label: 'Prefix' });
    const start = this.locate(prefix);
    if (!start) return null;

    let remaining = LIMITS.treeNodes;
    let truncated = false;

    const project = (node, label, depth) => {
      if (remaining <= 0) {
        truncated = true;
        return null;
      }
      remaining -= 1;

      const children = [];
      for (const [character, child] of sortedChildren(node)) {
        const projectedChild = project(child, character, depth + 1);
        if (projectedChild) {
          children.push(projectedChild);
        }
      }

      return {
        label,
        word: node.word,
        terminal: node.word !== null,
        depth,
        children
      };
    };

    const rootTree = project(start, key || 'root', 0);
    return rootTree ? { ...rootTree, truncated } : null;
  }

  clear() {
    this.root = createNode();
    this.keys.clear();
  }

  static levenshteinDistance(left, right, { ignoreCase = false } = {}) {
    if (typeof left !== 'string' || typeof right !== 'string') {
      throw new TypeError('Levenshtein distance requires two string arguments.');
    }

    const source = ignoreCase ? left.normalize('NFC').toLowerCase() : left.normalize('NFC');
    const target = ignoreCase ? right.normalize('NFC').toLowerCase() : right.normalize('NFC');
    const a = Array.from(source);
    const b = Array.from(target);

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + cost
        );
      }
      previous = current;
    }
    return previous[b.length];
  }
}

export const EDTECH_STARTER_TERMS = Object.freeze([
  'LLM Inference Architecture',
  'LLM Evaluation',
  'PagedAttention',
  'KV Cache',
  'Continuous Batching',
  'Quantization',
  'AWQ Quantization',
  'GPTQ Quantization',
  'FP8 Tensor Cores',
  'Tensor Parallelism',
  'Pipeline Parallelism',
  'Speculative Decoding',
  'FlashAttention',
  'LoRA Fine-Tuning',
  'RLHF Alignment',
  'Prompt Engineering',
  'Vector Search',
  'Retrieval Augmented Generation',
  'Transformer Architecture',
  'Tokenization',
  'CUDA Kernels',
  'vLLM Serving',
  'TensorRT Engine',
  'Rust Kernel',
  'eBPF Packet Filtering',
  'Zero-Copy Networking',
  'Distributed Consensus',
  'Raft Protocol',
  'Consistent Hashing',
  'Async Runtime',
  'Memory Paging',
  'Perplexity Profiling'
]);

const buildHighlightedTerm = (document, word, prefix) => {
  const fragment = document.createDocumentFragment();
  const wordChars = Array.from(word);
  const prefixChars = Array.from(prefix.trim().normalize('NFC').toLowerCase());

  let matchLen = 0;
  while (
    matchLen < prefixChars.length &&
    matchLen < wordChars.length &&
    wordChars[matchLen].toLowerCase() === prefixChars[matchLen]
  ) {
    matchLen += 1;
  }

  if (matchLen > 0) {
    const mark = document.createElement('mark');
    mark.className = 'prefix-highlight';
    mark.textContent = wordChars.slice(0, matchLen).join('');
    fragment.append(mark);
  }

  const remainder = wordChars.slice(matchLen).join('');
  if (remainder) {
    const rest = document.createElement('span');
    rest.className = 'term-remainder';
    rest.textContent = remainder;
    fragment.append(rest);
  }

  return fragment;
};

export function mountTrieSearch(document) {
  const searchInput = document.getElementById('term-search');
  if (!searchInput) return null;

  const engine = new EdtechAcademyTrieEngine(EDTECH_STARTER_TERMS);
  const suggestionsList = document.getElementById('suggestions');
  const statusEl = document.getElementById('search-status');
  const distanceSelect = document.getElementById('edit-distance');
  const fuzzyContainer = document.getElementById('fuzzy-list');
  const treeContainer = document.getElementById('trie-tree');
  const treeCaption = document.getElementById('tree-caption');
  const lexiconList = document.getElementById('lexicon-list');
  const lexiconStatus = document.getElementById('lexicon-status');
  const addForm = document.getElementById('add-term-form');
  const newTermInput = document.getElementById('new-term');
  const resetBtn = document.getElementById('reset-lexicon');
  const expandAllBtn = document.getElementById('expand-tree');
  const collapseAllBtn = document.getElementById('collapse-tree');
  const metricTerms = document.getElementById('metric-terms');
  const metricNodes = document.getElementById('metric-nodes');
  const metricPrefix = document.getElementById('metric-prefix');
  const metricFuzzy = document.getElementById('metric-fuzzy');
  const metricTime = document.getElementById('metric-time');

  let dropdownItems = [];
  let activeIndex = -1;
  let lastLookupMs = 0;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const closeSuggestions = () => {
    if (!suggestionsList) return;
    suggestionsList.classList.remove('is-open');
    suggestionsList.hidden = true;
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  };

  const openSuggestions = () => {
    if (!suggestionsList || dropdownItems.length === 0) return;
    suggestionsList.hidden = false;
    suggestionsList.classList.add('is-open');
    searchInput.setAttribute('aria-expanded', 'true');
  };

  const updateMetrics = (prefixCount, fuzzyCount) => {
    if (metricTerms) metricTerms.textContent = String(engine.size);
    if (metricNodes) metricNodes.textContent = String(engine.nodeCount);
    if (metricPrefix) metricPrefix.textContent = String(prefixCount);
    if (metricFuzzy) metricFuzzy.textContent = String(fuzzyCount);
    if (metricTime) metricTime.textContent = `${lastLookupMs.toFixed(2)} ms`;
  };

  const renderTree = (prefixQuery, fallbackBranch = '') => {
    if (!treeContainer) return;
    treeContainer.replaceChildren();

    const activePrefix = engine.locate(prefixQuery) ? prefixQuery : fallbackBranch;
    const isFallback = !engine.locate(prefixQuery) && Boolean(fallbackBranch);
    const projection = engine.getTree(activePrefix);

    if (treeCaption) {
      if (!projection) {
        treeCaption.textContent = 'No matching prefix branch found in the Trie.';
      } else if (isFallback) {
        treeCaption.textContent = `No exact prefix for "${prefixQuery.trim()}"; showing closest suggestion branch "${fallbackBranch}".`;
      } else if (prefixQuery.trim()) {
        treeCaption.textContent = `Subtree rooted at prefix "${prefixQuery.trim().toLowerCase()}"${projection.truncated ? ' (capped at 220 nodes)' : ''}`;
      } else {
        treeCaption.textContent = `Full curriculum Trie (${engine.nodeCount} nodes)${projection.truncated ? ' · preview capped at 220 nodes' : ''}`;
      }
    }

    if (!projection) {
      const empty = document.createElement('p');
      empty.className = 'tree-empty';
      empty.textContent = 'No subtree matches this prefix. Adjust spelling distance or insert a new topic.';
      treeContainer.append(empty);
      return;
    }

    const createTreeNodeElement = (item, isRootNode = false) => {
      const li = document.createElement('li');
      li.className = isRootNode ? 'tree-item tree-root-item' : 'tree-item';

      const displayEdge = item.label === ' ' ? '␠' : item.label;
      const hasChildren = item.children.length > 0;

      const buildBadgeContent = () => {
        const wrapper = document.createElement('span');
        wrapper.className = 'node-row';

        const edgePill = document.createElement('span');
        edgePill.className = isRootNode ? 'edge-pill edge-root' : 'edge-pill';
        edgePill.textContent = displayEdge;
        wrapper.append(edgePill);

        if (item.terminal && item.word) {
          const terminalBadge = document.createElement('span');
          terminalBadge.className = 'terminal-badge';
          terminalBadge.textContent = `→ ${item.word}`;
          wrapper.append(terminalBadge);
        }

        if (hasChildren) {
          const branchCount = document.createElement('span');
          branchCount.className = 'branch-count';
          branchCount.textContent = `${item.children.length}`;
          branchCount.title = `${item.children.length} child edge${item.children.length === 1 ? '' : 's'}`;
          wrapper.append(branchCount);
        }

        return wrapper;
      };

      if (hasChildren) {
        const details = document.createElement('details');
        details.className = 'tree-branch';
        details.open = true;

        const summary = document.createElement('summary');
        summary.className = 'tree-summary';
        summary.append(buildBadgeContent());
        details.append(summary);

        const childList = document.createElement('ul');
        childList.className = 'tree-children';
        for (const child of item.children) {
          childList.append(createTreeNodeElement(child, false));
        }
        details.append(childList);
        li.append(details);
      } else {
        const leaf = document.createElement('div');
        leaf.className = 'tree-leaf';
        leaf.append(buildBadgeContent());
        li.append(leaf);
      }

      return li;
    };

    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-list';
    rootUl.append(createTreeNodeElement(projection, true));
    treeContainer.append(rootUl);
  };

  const renderLexicon = () => {
    if (!lexiconList) return;
    lexiconList.replaceChildren();

    const words = engine.getAllWords();
    for (const word of words) {
      const li = document.createElement('li');
      li.className = 'lexicon-chip';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'lexicon-term-btn';
      selectBtn.textContent = word;
      selectBtn.addEventListener('click', () => {
        searchInput.value = word;
        runSearch({ keepDropdownClosed: true });
        searchInput.focus();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'lexicon-remove-btn';
      removeBtn.setAttribute('aria-label', `Remove ${word}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        engine.remove(word);
        if (lexiconStatus) {
          lexiconStatus.textContent = `Removed "${word}" from the in-memory Trie.`;
        }
        renderLexicon();
        runSearch({ keepDropdownClosed: true });
      });

      li.append(selectBtn, removeBtn);
      lexiconList.append(li);
    }
  };

  const chooseTerm = (word) => {
    searchInput.value = word;
    closeSuggestions();
    runSearch({ keepDropdownClosed: true });
    if (statusEl) {
      statusEl.textContent = `Selected "${word}" — inspecting its terminal Trie node.`;
    }
    searchInput.focus();
  };

  const renderSuggestionsDropdown = (items, rawQuery, hasExactPrefix) => {
    if (!suggestionsList) return;
    suggestionsList.replaceChildren();
    dropdownItems = items;
    activeIndex = -1;

    for (const [index, entry] of items.entries()) {
      const li = document.createElement('li');
      li.id = `trie-suggestion-${index}`;
      li.className = entry.kind === 'fuzzy' ? 'suggestion-item is-fuzzy' : 'suggestion-item';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');

      const labelSpan = document.createElement('span');
      labelSpan.className = 'suggestion-label';
      if (entry.kind === 'prefix' && hasExactPrefix) {
        labelSpan.append(buildHighlightedTerm(document, entry.word, rawQuery));
      } else {
        labelSpan.textContent = entry.word;
      }

      const badge = document.createElement('span');
      badge.className = entry.kind === 'prefix' ? 'suggestion-badge badge-prefix' : 'suggestion-badge badge-fuzzy';
      badge.textContent = entry.kind === 'prefix'
        ? 'prefix match'
        : `${entry.distance} edit${entry.distance === 1 ? '' : 's'}`;

      li.append(labelSpan, badge);
      li.addEventListener('mousedown', (event) => event.preventDefault());
      li.addEventListener('click', () => chooseTerm(entry.word));
      suggestionsList.append(li);
    }
  };

  const renderFuzzyPanel = (fuzzyMatches, rawQuery) => {
    if (!fuzzyContainer) return;
    fuzzyContainer.replaceChildren();

    const trimmed = rawQuery.trim();
    if (!trimmed) {
      const hint = document.createElement('p');
      hint.className = 'fuzzy-placeholder';
      hint.textContent = 'Type a query or typo (e.g. "pagdattenton", "quantzation") to inspect Levenshtein edit distances.';
      fuzzyContainer.append(hint);
      return;
    }

    if (fuzzyMatches.length === 0) {
      const none = document.createElement('p');
      none.className = 'fuzzy-placeholder';
      none.textContent = `No indexed terms within ${distanceSelect ? distanceSelect.value : 2} edit(s) of "${trimmed}".`;
      fuzzyContainer.append(none);
      return;
    }

    for (const match of fuzzyMatches.slice(0, 8)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fuzzy-pill';

      const term = document.createElement('span');
      term.className = 'fuzzy-pill-term';
      term.textContent = match.word;

      const dist = document.createElement('span');
      dist.className = match.distance === 0 ? 'fuzzy-dist dist-exact' : 'fuzzy-dist';
      dist.textContent = `d=${match.distance}`;

      btn.append(term, dist);
      btn.addEventListener('click', () => chooseTerm(match.word));
      fuzzyContainer.append(btn);
    }
  };

  function runSearch({ keepDropdownClosed = false } = {}) {
    const rawQuery = searchInput.value;
    const maxDistance = distanceSelect ? Number(distanceSelect.value) : 2;
    const started = now();

    try {
      const prefixMatches = engine.findWordsWithPrefix(rawQuery);
      const fuzzyMatches = rawQuery.trim()
        ? engine.fuzzySearch(rawQuery, maxDistance)
        : [];
      lastLookupMs = now() - started;

      const hasExactPrefix = prefixMatches.length > 0;
      const combined = hasExactPrefix
        ? prefixMatches.slice(0, 10).map((word) => ({ word, distance: 0, kind: 'prefix' }))
        : fuzzyMatches.slice(0, 10).map((item) => ({ ...item, kind: 'fuzzy' }));

      renderSuggestionsDropdown(combined, rawQuery, hasExactPrefix);
      renderFuzzyPanel(fuzzyMatches, rawQuery);
      updateMetrics(prefixMatches.length, fuzzyMatches.length);

      const fallbackBranch = !hasExactPrefix && fuzzyMatches.length > 0 ? fuzzyMatches[0].word : '';
      renderTree(rawQuery, fallbackBranch);

      if (statusEl) {
        if (!rawQuery.trim()) {
          statusEl.textContent = `Trie ready with ${engine.size} curriculum terms across ${engine.nodeCount} nodes.`;
        } else if (hasExactPrefix) {
          statusEl.textContent = `Found ${prefixMatches.length} prefix completion${prefixMatches.length === 1 ? '' : 's'} for "${rawQuery.trim()}" in ${lastLookupMs.toFixed(2)} ms.`;
        } else if (fuzzyMatches.length > 0) {
          statusEl.textContent = `No exact prefix for "${rawQuery.trim()}". Surfacing ${fuzzyMatches.length} Levenshtein spelling suggestion${fuzzyMatches.length === 1 ? '' : 's'} (max ${maxDistance} edit${maxDistance === 1 ? '' : 's'}).`;
        } else {
          statusEl.textContent = `No prefix or fuzzy matches found within ${maxDistance} edit${maxDistance === 1 ? '' : 's'} of "${rawQuery.trim()}".`;
        }
      }

      if (!keepDropdownClosed && combined.length > 0 && document.activeElement === searchInput) {
        openSuggestions();
      } else if (keepDropdownClosed || combined.length === 0) {
        closeSuggestions();
      }
    } catch (error) {
      lastLookupMs = now() - started;
      closeSuggestions();
      if (statusEl) statusEl.textContent = error.message;
    }
  }

  searchInput.addEventListener('input', () => runSearch({ keepDropdownClosed: false }));
  searchInput.addEventListener('focus', () => runSearch({ keepDropdownClosed: false }));
  searchInput.addEventListener('blur', () => {
    setTimeout(closeSuggestions, 100);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSuggestions();
      return;
    }

    if (event.key === 'Enter' && activeIndex >= 0 && dropdownItems[activeIndex]) {
      event.preventDefault();
      chooseTerm(dropdownItems[activeIndex].word);
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }

    event.preventDefault();
    if (suggestionsList?.hidden) {
      runSearch({ keepDropdownClosed: false });
    }
    if (!dropdownItems.length || !suggestionsList) return;

    activeIndex = activeIndex < 0
      ? (event.key === 'ArrowDown' ? 0 : dropdownItems.length - 1)
      : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + dropdownItems.length) % dropdownItems.length;

    Array.from(suggestionsList.children).forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === activeIndex));
    });

    const activeOption = suggestionsList.children[activeIndex];
    if (activeOption) {
      searchInput.setAttribute('aria-activedescendant', activeOption.id);
      activeOption.scrollIntoView?.({ block: 'nearest' });
    }
  });

  distanceSelect?.addEventListener('change', () => runSearch({ keepDropdownClosed: false }));

  addForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!newTermInput) return;

    try {
      const added = engine.insert(newTermInput.value);
      if (lexiconStatus) {
        lexiconStatus.textContent = added
          ? `Indexed "${newTermInput.value.trim()}" into the Trie.`
          : `"${newTermInput.value.trim()}" is already indexed (case-insensitive).`;
      }
      if (added) {
        newTermInput.value = '';
      }
      renderLexicon();
      runSearch({ keepDropdownClosed: true });
    } catch (error) {
      if (lexiconStatus) lexiconStatus.textContent = error.message;
    }
  });

  resetBtn?.addEventListener('click', () => {
    engine.clear();
    for (const term of EDTECH_STARTER_TERMS) {
      engine.insert(term);
    }
    if (lexiconStatus) {
      lexiconStatus.textContent = `Restored ${EDTECH_STARTER_TERMS.length} starter curriculum terms.`;
    }
    renderLexicon();
    runSearch({ keepDropdownClosed: true });
  });

  expandAllBtn?.addEventListener('click', () => {
    treeContainer?.querySelectorAll('details.tree-branch').forEach((node) => {
      node.open = true;
    });
  });

  collapseAllBtn?.addEventListener('click', () => {
    const branches = treeContainer?.querySelectorAll('details.tree-branch');
    branches?.forEach((node, index) => {
      if (index > 0) node.open = false;
    });
  });

  document.querySelectorAll('[data-sample-query]').forEach((button) => {
    button.addEventListener('click', () => {
      searchInput.value = button.getAttribute('data-sample-query') || '';
      searchInput.focus();
      runSearch({ keepDropdownClosed: false });
    });
  });

  renderLexicon();
  runSearch({ keepDropdownClosed: true });
  return engine;
}

if (typeof document !== 'undefined') {
  mountTrieSearch(document);
}
