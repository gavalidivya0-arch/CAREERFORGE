import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PetAdoptionHavenTokenAnalyzer,
  CONTEXT_BUDGETS,
  PET_TOKEN_PRESETS,
  mountTokenLab
} from './token-counter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('PetAdoptionHavenTokenAnalyzer - estimateTokens handles empty and standard inputs losslessly', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();

  assert.deepEqual(analyzer.estimateTokens(''), { count: 0, tokens: [] });

  const samples = [
    'Hello world! 123',
    '  leading   spaces\tand\r\nCRLF lines\n',
    '<script>alert("xss")</script> __proto__ constructor',
    'Barnaby #PH-409 @ Paws & Haven... 100% friendly!!',
    'Line\u2028Separator\u2029Test\u00A0NBSP'
  ];

  for (const sample of samples) {
    const res = analyzer.estimateTokens(sample);
    assert.ok(res.count > 0);
    assert.equal(res.tokens.length, res.count);
    assert.equal(res.tokens.join(''), sample);
  }
});

test('PetAdoptionHavenTokenAnalyzer - estimateTokens applies BPE-like heuristics for contractions, camelCase, subwords, and numbers', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();

  const contraction = analyzer.estimateTokens("Don't miss 2026!");
  assert.equal(contraction.tokens.join(''), "Don't miss 2026!");
  assert.ok(contraction.tokens.includes("'t"));
  assert.ok(contraction.tokens.includes(' 202') && contraction.tokens.includes('6'));

  const camel = analyzer.estimateTokens('PetAdoptionHaven');
  assert.deepEqual(camel.tokens, ['Pet', 'Adopt', 'ion', 'Haven']);

  const affixed = analyzer.estimateTokens('fostering');
  assert.deepEqual(affixed.tokens, ['foster', 'ing']);

  const vaccination = analyzer.estimateTokens('vaccination');
  assert.deepEqual(vaccination.tokens, ['vaccin', 'ation']);

  const numericRun = analyzer.estimateTokens('9851410');
  assert.deepEqual(numericRun.tokens, ['985', '141', '0']);
});

test('PetAdoptionHavenTokenAnalyzer - estimateTokens preserves multi-byte emoji, flags, and CJK without splitting surrogates', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();

  const text = '🐾 Haven 東京 🇯🇵 👨‍👩‍👧 🐕';
  const res = analyzer.estimateTokens(text);
  assert.equal(res.tokens.join(''), text);
  assert.ok(res.tokens.includes('🐾'));
  assert.ok(res.tokens.includes('東'));
  assert.ok(res.tokens.includes('京'));
  assert.ok(res.tokens.includes('🇯🇵'));
  assert.ok(res.tokens.includes('🐕'));
});

test('PetAdoptionHavenTokenAnalyzer - getWordCount computes accurate word counts and validates types', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();

  assert.equal(analyzer.getWordCount('The gentle golden retriever plays'), 5);
  assert.equal(analyzer.getWordCount('  kennel one\n\tfoster two  '), 4);
  assert.equal(analyzer.getWordCount('   \n\t  '), 0);
  assert.equal(analyzer.getWordCount(''), 0);
  assert.throws(() => analyzer.getWordCount(123), TypeError);
  assert.throws(() => analyzer.getWordCount(null), TypeError);
});

test('PetAdoptionHavenTokenAnalyzer - calculateByteSize computes exact UTF-8 byte lengths', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();

  assert.equal(analyzer.calculateByteSize(''), 0);
  assert.equal(analyzer.calculateByteSize('haven'), 5);
  assert.equal(analyzer.calculateByteSize('café'), 5);
  assert.equal(analyzer.calculateByteSize('東'), 3);
  assert.equal(analyzer.calculateByteSize('🐾'), 4);
  assert.equal(analyzer.calculateByteSize('🐕'), 4);
  assert.throws(() => analyzer.calculateByteSize(null), TypeError);
  assert.throws(() => analyzer.calculateByteSize({}), TypeError);
});

test('PetAdoptionHavenTokenAnalyzer - getCharacterFrequency and getCharacterDistribution categorize text accurately', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();

  const freq = analyzer.getCharacterFrequency('aba 🐾');
  assert.deepEqual(freq, { a: 2, b: 1, ' ': 1, '🐾': 1 });

  const dist = analyzer.getCharacterDistribution('Ab1! 🐾');
  assert.equal(dist.codeUnits, 7);
  assert.equal(dist.codePoints, 6);
  assert.equal(dist.letters, 2);
  assert.equal(dist.digits, 1);
  assert.equal(dist.punctuation, 1);
  assert.equal(dist.whitespace, 1);
  assert.equal(dist.symbols, 1);
  assert.equal(dist.multiByteChars, 1);
  assert.equal(dist.uniqueChars, 6);
  assert.equal(dist.lines, 1);

  assert.equal(analyzer.getCharacterDistribution('').lines, 0);
  assert.throws(() => analyzer.getCharacterDistribution('abc', -1), RangeError);
});

test('PetAdoptionHavenTokenAnalyzer - getTokenDensity calculates ratios, kindBreakdown, and threshold statuses', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();

  const emptyDensity = analyzer.getTokenDensity('', 100);
  assert.equal(emptyDensity.tokenCount, 0);
  assert.equal(emptyDensity.charsPerToken, 0);
  assert.equal(emptyDensity.bytesPerToken, 0);
  assert.equal(emptyDensity.tokensPerWord, 0);
  assert.equal(emptyDensity.usagePercent, 0);
  assert.equal(emptyDensity.thresholdStatus, 'nominal');

  const nominal = analyzer.getTokenDensity('one two three', 100);
  assert.equal(nominal.tokenCount, 3);
  assert.equal(nominal.wordCount, 3);
  assert.equal(nominal.tokensPerWord, 1);
  assert.equal(nominal.thresholdStatus, 'nominal');
  const sumKinds = Object.values(nominal.kindBreakdown).reduce((a, b) => a + b, 0);
  assert.equal(sumKinds, nominal.tokenCount);

  const warningText = 'word '.repeat(7).trim();
  const warning = analyzer.getTokenDensity(warningText, 10);
  assert.equal(warning.tokenCount, 7);
  assert.equal(warning.usagePercent, 70);
  assert.equal(warning.thresholdStatus, 'warning');

  const criticalText = 'word '.repeat(9).trim();
  const critical = analyzer.getTokenDensity(criticalText, 10);
  assert.equal(critical.tokenCount, 9);
  assert.equal(critical.usagePercent, 90);
  assert.equal(critical.thresholdStatus, 'critical');

  assert.throws(() => analyzer.getTokenDensity('abc', 0), RangeError);
  assert.throws(() => analyzer.estimateTokens(42), TypeError);
});

test('PetAdoptionHavenTokenAnalyzer - inspectTokens, analyze, and presets stay consistent', () => {
  const analyzer = new PetAdoptionHavenTokenAnalyzer();
  const report = analyzer.analyze('Adopt 🐾!', { contextLimit: 128 });

  assert.equal(report.tokenCount, report.tokens.length);
  assert.equal(report.wordCount, 2);
  assert.equal(report.byteSize, 11);
  assert.equal(report.tokenDetails[0].kind, 'word');
  assert.equal(report.tokenDetails.find(t => t.text === '🐾')?.byteLength, 4);
  assert.equal(report.tokenDetails.find(t => t.text === '🐾')?.utf8Hex, 'F0 9F 90 BE');

  for (const preset of PET_TOKEN_PRESETS) {
    const res = analyzer.estimateTokens(preset.text);
    assert.equal(res.tokens.join(''), preset.text);
  }
  assert.ok(CONTEXT_BUDGETS.some(b => b.limit === 512));

  const stressDensity = analyzer.getTokenDensity(
    PET_TOKEN_PRESETS.find(p => p.id === 'stress-prompt').text,
    512
  );
  assert.ok(
    stressDensity.thresholdStatus === 'warning' || stressDensity.thresholdStatus === 'critical',
    `Expected stress preset to reach warning or critical threshold, got ${stressDensity.thresholdStatus} (${stressDensity.usagePercent}%)`
  );
});

test('HTML, CSS, and mountTokenLab DOM wiring align with all required selectors and interactions', () => {
  const html = fs.readFileSync(path.join(__dirname, 'token-counter.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'token-counter.css'), 'utf8');

  for (const id of [
    'token-input',
    'count-tokens',
    'count-words',
    'count-chars',
    'count-bytes',
    'token-pills',
    'context-budget-select',
    'threshold-badge',
    'budget-progress-fill',
    'budget-progress-track',
    'token-kind-bar',
    'char-class-bar',
    'char-freq-list'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Missing id="${id}" in token-counter.html`);
  }

  assert.ok(html.includes('href="./token-counter.css"'));
  assert.ok(html.includes('src="./token-counter.js"'));
  assert.ok(html.includes('data-token-lab'));

  for (const cls of [
    '.metric-card',
    '.token-pill',
    '.token-c1',
    '.token-c2',
    '.threshold-nominal',
    '.threshold-warning',
    '.threshold-critical'
  ]) {
    assert.ok(css.includes(cls), `Missing ${cls} in token-counter.css`);
  }

  // Minimal DOM harness to verify mountTokenLab executes cleanly on real inputs
  class MockClassList {
    constructor() {
      this.set = new Set();
    }
    add(...names) { names.forEach(n => this.set.add(n)); }
    remove(...names) { names.forEach(n => this.set.delete(n)); }
    toggle(name, force) {
      if (force === undefined) {
        if (this.set.has(name)) this.set.delete(name);
        else this.set.add(name);
      } else if (force) {
        this.set.add(name);
      } else {
        this.set.delete(name);
      }
    }
    contains(name) { return this.set.has(name); }
  }

  class MockElement {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.classList = new MockClassList();
      this.className = '';
      this.style = {};
      this.dataset = {};
      this.attributes = {};
      this.children = [];
      this.listeners = {};
      this.textContent = '';
      this.value = '';
      this.checked = true;
      this.hidden = false;
    }
    appendChild(child) { this.children.push(child); return child; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    }
    dispatchEvent(type) {
      for (const fn of this.listeners[type] || []) fn({ type, target: this });
    }
    querySelectorAll() { return []; }
    focus() {}
  }

  const elementsById = new Map([
    ['token-input', new MockElement('textarea')],
    ['context-budget-select', new MockElement('select')],
    ['toggle-whitespace', new MockElement('input')],
    ['clear-input-btn', new MockElement('button')],
    ['copy-report-btn', new MockElement('button')],
    ['count-tokens', new MockElement('strong')],
    ['count-words', new MockElement('strong')],
    ['count-chars', new MockElement('strong')],
    ['count-bytes', new MockElement('strong')],
    ['sub-chars', new MockElement('span')],
    ['sub-bytes', new MockElement('span')],
    ['sub-words', new MockElement('span')],
    ['sub-tokens', new MockElement('span')],
    ['card-tokens', new MockElement('article')],
    ['card-bytes', new MockElement('article')],
    ['threshold-badge', new MockElement('span')],
    ['budget-summary', new MockElement('span')],
    ['budget-progress-fill', new MockElement('div')],
    ['budget-progress-track', new MockElement('div')],
    ['token-pills', new MockElement('div')],
    ['pill-count-label', new MockElement('span')],
    ['token-inspector', new MockElement('div')],
    ['toggle-all-tokens-btn', new MockElement('button')],
    ['density-chars-per-token', new MockElement('strong')],
    ['density-bytes-per-token', new MockElement('strong')],
    ['density-tokens-per-word', new MockElement('strong')],
    ['density-utf8-overhead', new MockElement('strong')],
    ['token-kind-bar', new MockElement('div')],
    ['token-kind-legend', new MockElement('div')],
    ['char-class-bar', new MockElement('div')],
    ['char-class-legend', new MockElement('div')],
    ['char-freq-list', new MockElement('div')],
    ['unique-chars-badge', new MockElement('span')]
  ]);

  elementsById.get('context-budget-select').value = '512';
  const presetBtn = new MockElement('button');
  presetBtn.dataset.presetId = 'multilingual';

  const mockRoot = new MockElement('main');
  mockRoot.querySelector = selector => {
    if (selector.startsWith('#')) return elementsById.get(selector.slice(1)) || null;
    return null;
  };
  mockRoot.querySelectorAll = selector => (selector === '[data-preset-id]' ? [presetBtn] : []);

  const prevDocument = globalThis.document;
  globalThis.document = {
    readyState: 'complete',
    createElement: tag => new MockElement(tag),
    querySelector: () => mockRoot
  };

  try {
    const mounted = mountTokenLab(mockRoot);
    assert.ok(mounted);

    const inputEl = elementsById.get('token-input');
    inputEl.value = 'Adopt Luna 🐈';
    inputEl.dispatchEvent('input');

    assert.equal(elementsById.get('count-words').textContent, '3');
    assert.equal(elementsById.get('count-bytes').textContent, '15');
    assert.ok(Number(elementsById.get('count-tokens').textContent) >= 3);
    assert.ok(elementsById.get('token-pills').children.length >= 3);
    assert.ok(elementsById.get('card-tokens').classList.contains('threshold-nominal'));

    // Test stress prompt threshold escalation
    presetBtn.dataset.presetId = 'stress-prompt';
    presetBtn.dispatchEvent('click');
    const badgeText = elementsById.get('threshold-badge').textContent;
    assert.ok(
      badgeText.startsWith('WARNING') || badgeText.startsWith('CRITICAL'),
      `Expected warning/critical badge after stress-prompt preset, got: ${badgeText}`
    );

    // Test clear resets counts to zero
    elementsById.get('clear-input-btn').dispatchEvent('click');
    assert.equal(elementsById.get('count-tokens').textContent, '0');
    assert.equal(elementsById.get('count-bytes').textContent, '0');
    assert.equal(elementsById.get('count-words').textContent, '0');
  } finally {
    if (prevDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = prevDocument;
    }
  }
});
