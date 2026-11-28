import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DroneDeliverySkywayTokenAnalyzer,
  CONTEXT_BUDGETS,
  DRONE_TOKEN_PRESETS,
  mountTokenLab
} from './token-counter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('DroneDeliverySkywayTokenAnalyzer - estimateTokens handles empty and standard inputs losslessly', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  assert.deepEqual(analyzer.estimateTokens(''), { count: 0, tokens: [] });

  const samples = [
    'Hello world! 123',
    '  leading   spaces\tand\r\nCRLF lines\n',
    '<script>alert("xss")</script> __proto__ constructor',
    'UAV-Alpha  @ 180ft AGL... 100% cleared!!'
  ];

  for (const sample of samples) {
    const res = analyzer.estimateTokens(sample);
    assert.ok(res.count > 0);
    assert.equal(res.tokens.length, res.count);
    assert.equal(res.tokens.join(''), sample);
  }
});

test('DroneDeliverySkywayTokenAnalyzer - estimateTokens applies BPE-like heuristics for contractions, camelCase, subwords, and numbers', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  const contraction = analyzer.estimateTokens("Don't exceed 2026!");
  assert.equal(contraction.tokens.join(''), "Don't exceed 2026!");
  assert.ok(contraction.tokens.includes("'t"));
  assert.ok(contraction.tokens.includes(' 202') && contraction.tokens.includes('6'));

  const camel = analyzer.estimateTokens('DroneDeliverySkyway');
  assert.deepEqual(camel.tokens, ['Drone', 'Deli', 'very', 'Skyway']);

  const affixed = analyzer.estimateTokens('geofencing');
  assert.deepEqual(affixed.tokens, ['geo', 'fenc', 'ing']);

  const telemetryWord = analyzer.estimateTokens('telemetry');
  assert.deepEqual(telemetryWord.tokens, ['tele', 'metry']);

  const numericRun = analyzer.estimateTokens('1234567');
  assert.deepEqual(numericRun.tokens, ['123', '456', '7']);
});

test('DroneDeliverySkywayTokenAnalyzer - estimateTokens preserves multi-byte emoji, flags, and CJK without splitting surrogates', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  const text = '🚁 Corridor 東京 🇯🇵 👨‍🚀 🔋';
  const res = analyzer.estimateTokens(text);
  assert.equal(res.tokens.join(''), text);
  assert.ok(res.tokens.includes('🚁'));
  assert.ok(res.tokens.includes('東'));
  assert.ok(res.tokens.includes('京'));
  assert.ok(res.tokens.includes('🇯🇵'));
  assert.ok(res.tokens.includes('👨‍🚀'));
  assert.ok(res.tokens.includes('🔋'));
});

test('DroneDeliverySkywayTokenAnalyzer - getWordCount computes accurate word counts and validates types', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  assert.equal(analyzer.getWordCount('The quick brown fox jumps'), 5);
  assert.equal(analyzer.getWordCount('  corridor one\n\tsector two  '), 4);
  assert.equal(analyzer.getWordCount('   \n\t  '), 0);
  assert.equal(analyzer.getWordCount(''), 0);
  assert.throws(() => analyzer.getWordCount(123), TypeError);
  assert.throws(() => analyzer.getWordCount(null), TypeError);
});

test('DroneDeliverySkywayTokenAnalyzer - calculateByteSize computes exact UTF-8 byte lengths', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  assert.equal(analyzer.calculateByteSize(''), 0);
  assert.equal(analyzer.calculateByteSize('skyway'), 6);
  assert.equal(analyzer.calculateByteSize('café'), 5);
  assert.equal(analyzer.calculateByteSize('東'), 3);
  assert.equal(analyzer.calculateByteSize('🚁'), 4);
  assert.equal(analyzer.calculateByteSize('🚀'), 4);
  assert.throws(() => analyzer.calculateByteSize(null), TypeError);
  assert.throws(() => analyzer.calculateByteSize({}), TypeError);
});

test('DroneDeliverySkywayTokenAnalyzer - getCharacterFrequency and getCharacterDistribution categorize text accurately', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  const freq = analyzer.getCharacterFrequency('aba 🚁');
  assert.deepEqual(freq, { a: 2, b: 1, ' ': 1, '🚁': 1 });

  const dist = analyzer.getCharacterDistribution('Ab1! 🚁');
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

test('DroneDeliverySkywayTokenAnalyzer - getTokenDensity calculates ratios, kindBreakdown, and threshold statuses', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  const emptyDensity = analyzer.getTokenDensity('', 100);
  assert.equal(emptyDensity.tokenCount, 0);
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

test('DroneDeliverySkywayTokenAnalyzer - inspectTokens, analyze, and presets stay consistent', () => {
  const analyzer = new DroneDeliverySkywayTokenAnalyzer();
  const report = analyzer.analyze('Fly 🚁!', { contextLimit: 128 });

  assert.equal(report.tokenCount, report.tokens.length);
  assert.equal(report.wordCount, 2);
  assert.equal(report.byteSize, 9);
  assert.equal(report.tokenDetails[0].kind, 'word');
  assert.equal(report.tokenDetails.find(t => t.text === '🚁')?.byteLength, 4);
  assert.equal(report.tokenDetails.find(t => t.text === '🚁')?.utf8Hex, 'F0 9F 9A 81');

  for (const preset of DRONE_TOKEN_PRESETS) {
    const res = analyzer.estimateTokens(preset.text);
    assert.equal(res.tokens.join(''), preset.text);
  }
  assert.ok(CONTEXT_BUDGETS.some(b => b.limit === 512));

  const burstDensity = analyzer.getTokenDensity(
    DRONE_TOKEN_PRESETS.find(p => p.id === 'burst').text,
    512
  );
  assert.ok(
    burstDensity.thresholdStatus === 'warning' || burstDensity.thresholdStatus === 'critical',
    `Expected stress preset to reach warning or critical threshold, got ${burstDensity.thresholdStatus} (${burstDensity.usagePercent}%)`
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
  const createdElements = [];
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
    dispatch(type) {
      for (const fn of this.listeners[type] || []) fn({ target: this });
    }
    querySelectorAll() { return []; }
    focus() {}
  }

  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: tag => {
      const el = new MockElement(tag);
      createdElements.push(el);
      return el;
    }
  };

  try {
    const bySelector = new Map();
    const register = sel => {
      const el = new MockElement();
      bySelector.set(sel, el);
      return el;
    };

    const inputEl = register('#token-input');
    const budgetEl = register('#context-budget-select');
    budgetEl.value = '512';
    const tokenCountEl = register('#count-tokens');
    const wordCountEl = register('#count-words');
    const charCountEl = register('#count-chars');
    const byteCountEl = register('#count-bytes');
    const pillsEl = register('#token-pills');
    const badgeEl = register('#threshold-badge');
    const clearBtn = register('#clear-input-btn');
    register('#toggle-whitespace');
    register('#copy-report-btn');
    register('#sub-chars');
    register('#sub-bytes');
    register('#sub-words');
    register('#sub-tokens');
    register('#card-tokens');
    register('#card-bytes');
    register('#budget-summary');
    register('#budget-progress-fill');
    register('#budget-progress-track');
    register('#pill-count-label');
    register('#token-inspector');
    register('#toggle-all-tokens-btn');
    register('#density-chars-per-token');
    register('#density-bytes-per-token');
    register('#density-tokens-per-word');
    register('#density-utf8-overhead');
    register('#token-kind-bar');
    register('#token-kind-legend');
    register('#char-class-bar');
    register('#char-class-legend');
    register('#char-freq-list');
    register('#unique-chars-badge');

    const root = new MockElement('main');
    root.querySelector = sel => bySelector.get(sel) || null;
    root.querySelectorAll = () => [];

    const mounted = mountTokenLab(root);
    assert.ok(mounted);
    assert.ok(Number(tokenCountEl.textContent) > 0);
    assert.ok(Number(wordCountEl.textContent) > 0);
    assert.ok(Number(charCountEl.textContent) > 0);
    assert.ok(Number(byteCountEl.textContent) > 0);
    assert.ok(pillsEl.children.length > 0);
    assert.ok(badgeEl.classList.contains('threshold-nominal'));

    // Trigger threshold warning/critical via small budget
    budgetEl.value = '10';
    budgetEl.dispatch('change');
    assert.ok(badgeEl.classList.contains('threshold-critical'));
    assert.ok(createdElements.length > 0);

    // Click first rendered token pill to exercise token inspector
    const firstPill = pillsEl.children[0];
    firstPill.dispatch('click');
    assert.ok(firstPill.classList.contains('is-selected'));

    // Clear resets all counters cleanly
    clearBtn.dispatch('click');
    assert.equal(inputEl.value, '');
    assert.equal(tokenCountEl.textContent, '0');
    assert.equal(wordCountEl.textContent, '0');
    assert.equal(charCountEl.textContent, '0');
    assert.equal(byteCountEl.textContent, '0');
    assert.ok(badgeEl.classList.contains('threshold-nominal'));
  } finally {
    globalThis.document = prevDoc;
  }
});
