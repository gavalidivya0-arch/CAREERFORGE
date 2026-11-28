/**
 * Nonprofit Impact Trie (Prefix Tree) Search Engine
 * Supports exact prefix lookups, fuzzy spelling suggestions via Levenshtein distance,
 * and interactive hierarchy tree rendering.
 */

export class NonprofitImpactTrieEngine {
  constructor() {
    this.root = this._createNode();
    this.words = new Set();
  }

  _createNode() {
    return {
      children: new Map(),
      isEnd: false,
      word: '',
    };
  }

  /**
   * Insert a word into the trie.
   * @param {string} word
   */
  insert(word) {
    if (typeof word !== 'string') return;
    const normalized = word.toLowerCase().trim();
    if (!normalized) return;

    let node = this.root;
    for (const ch of normalized) {
      if (!node.children.has(ch)) {
        node.children.set(ch, this._createNode());
      }
      node = node.children.get(ch);
    }
    node.isEnd = true;
    node.word = normalized;
    this.words.add(normalized);
  }

  /**
   * Find all words that start with the given prefix.
   * @param {string} prefix
   * @returns {string[]}
   */
  findWordsWithPrefix(prefix) {
    if (typeof prefix !== 'string') return [];
    const normalized = prefix.toLowerCase().trim();
    if (!normalized) return Array.from(this.words);

    let node = this.root;
    for (const ch of normalized) {
      if (!node.children.has(ch)) {
        return [];
      }
      node = node.children.get(ch);
    }

    // Collect all words under this node via DFS
    const results = [];
    this._collectWords(node, normalized, results);
    return results;
  }

  _collectWords(node, prefix, results) {
    if (node.isEnd) {
      results.push(node.word);
    }
    for (const [ch, child] of node.children) {
      this._collectWords(child, prefix + ch, results);
    }
  }

  /**
   * Levenshtein distance between two strings.
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  _levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = new Array(a.length + 1)
      .fill(null)
      .map(() => new Array(b.length + 1).fill(null));

    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost  // substitution
        );
      }
    }

    return matrix[a.length][b.length];
  }

  /**
   * Fuzzy search: find words within maxLevenshtein distance of the query.
   * @param {string} query
   * @param {number} maxDistance
   * @returns {string[]}
   */
  fuzzySearch(query, maxDistance) {
    if (typeof query !== 'string') return [];
    if (typeof maxDistance !== 'number') maxDistance = 1;
    const normalized = query.toLowerCase().trim();
    if (!normalized) return [];

    const results = [];
    for (const word of this.words) {
      const distance = this._levenshteinDistance(normalized, word);
      if (distance <= maxDistance) {
        results.push(word);
      }
    }
    return results;
  }
}