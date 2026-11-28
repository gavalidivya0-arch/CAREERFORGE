import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingCinemaHubTokenAnalyzer } from './token-counter.js';

test('StreamingCinemaHubTokenAnalyzer - estimateTokens handles empty and standard text with lossless reconstruction', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();

  assert.deepEqual(analyzer.estimateTokens(''), { count: 0, tokens: [] });

  const sample = 'Hello world! 123';
  const res = analyzer.estimateTokens(sample);
  assert.ok(res.count >= 4);
  assert.equal(res.tokens.length, res.count);
  assert.equal(res.tokens.join(''), sample);
});

test('StreamingCinemaHubTokenAnalyzer - estimateTokens applies BPE-like heuristics for contractions, camelCase, subwords, and numbers', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();

  const contraction = analyzer.estimateTokens("Don't stop streaming 2026!");
  assert.equal(contraction.tokens.join(''), "Don't stop streaming 2026!");
  assert.ok(contraction.tokens.includes("'t"));
  assert.ok(contraction.tokens.includes(' 202') && contraction.tokens.includes('6'));

  const camel = analyzer.estimateTokens('StreamingCinemaHub');
  assert.deepEqual(camel.tokens, ['Stream', 'ing', 'Cinema', 'Hub']);

  const affixed = analyzer.estimateTokens('unwatchable');
  assert.deepEqual(affixed.tokens, ['un', 'watch', 'able']);

  const numericRun = analyzer.estimateTokens('1234567');
  assert.deepEqual(numericRun.tokens, ['123', '456', '7']);
});

test('StreamingCinemaHubTokenAnalyzer - estimateTokens preserves multi-byte emoji and CJK without splitting surrogates', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();

  const text = '🎬 4K HDR 東京 🔥';
  const res = analyzer.estimateTokens(text);
  assert.equal(res.tokens.join(''), text);
  assert.ok(res.tokens.includes('🎬'));
  assert.ok(res.tokens.includes('東'));
  assert.ok(res.tokens.includes('京'));
  assert.ok(res.tokens.includes('🔥'));
});

test('StreamingCinemaHubTokenAnalyzer - getWordCount computes accurate word counts and validates types', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();

  assert.equal(analyzer.getWordCount('The quick brown fox jumps'), 5);
  assert.equal(analyzer.getWordCount('  line one\n\tline two  '), 4);
  assert.equal(analyzer.getWordCount('   \n\t  '), 0);
  assert.equal(analyzer.getWordCount(''), 0);
  assert.throws(() => analyzer.getWordCount(123), TypeError);
  assert.throws(() => analyzer.getWordCount(null), TypeError);
});

test('StreamingCinemaHubTokenAnalyzer - calculateByteSize computes exact UTF-8 byte lengths', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();

  assert.equal(analyzer.calculateByteSize(''), 0);
  assert.equal(analyzer.calculateByteSize('hello'), 5);
  assert.equal(analyzer.calculateByteSize('café'), 5);
  assert.equal(analyzer.calculateByteSize('映'), 3);
  assert.equal(analyzer.calculateByteSize('🚀'), 4);
  assert.equal(analyzer.calculateByteSize('🎬'), 4);
  assert.throws(() => analyzer.calculateByteSize(null), TypeError);
  assert.throws(() => analyzer.calculateByteSize({}), TypeError);
});

test('StreamingCinemaHubTokenAnalyzer - getCharacterFrequency and getCharacterDistribution categorize text accurately', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();

  const freq = analyzer.getCharacterFrequency('aba 🎬');
  assert.deepEqual(freq, { a: 2, b: 1, ' ': 1, '🎬': 1 });

  const dist = analyzer.getCharacterDistribution('Ab1! 🎬');
  assert.equal(dist.codeUnits, 7);
  assert.equal(dist.codePoints, 6);
  assert.equal(dist.letters, 2);
  assert.equal(dist.digits, 1);
  assert.equal(dist.punctuation, 1);
  assert.equal(dist.whitespace, 1);
  assert.equal(dist.symbols, 1);
  assert.equal(dist.multiByteChars, 1);
  assert.equal(dist.uniqueChars, 6);
});

test('StreamingCinemaHubTokenAnalyzer - getTokenDensity calculates ratios and threshold statuses', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();

  const emptyDensity = analyzer.getTokenDensity('', 100);
  assert.equal(emptyDensity.tokenCount, 0);
  assert.equal(emptyDensity.thresholdStatus, 'nominal');

  const nominal = analyzer.getTokenDensity('one two three', 100);
  assert.equal(nominal.tokenCount, 3);
  assert.equal(nominal.wordCount, 3);
  assert.equal(nominal.tokensPerWord, 1);
  assert.equal(nominal.thresholdStatus, 'nominal');

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

test('StreamingCinemaHubTokenAnalyzer - inspectTokens and analyze expose full metadata', () => {
  const analyzer = new StreamingCinemaHubTokenAnalyzer();
  const report = analyzer.analyze('Watch 🎬!', { contextLimit: 128 });

  assert.equal(report.tokenCount, report.tokens.length);
  assert.equal(report.wordCount, 2);
  assert.equal(report.byteSize, 11);
  assert.equal(report.tokenDetails[0].kind, 'word');
  assert.equal(report.tokenDetails.find(t => t.text === '🎬')?.byteLength, 4);
  assert.equal(report.tokenDetails.find(t => t.text === '🎬')?.utf8Hex, 'F0 9F 8E AC');
});
