import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHex,
  getLuminance,
  calculateRatio,
  evaluateWcagCompliance,
  formatRatio,
  generateContrastMatrix,
  findBestForeground,
  WCAG_THRESHOLDS,
  CONTRAST_RATING,
  FestivalHubContrastAuditor
} from './color-contrast-auditor.js';

// ---------------------------------------------------------------------------
// parseHex
// ---------------------------------------------------------------------------

test('parseHex - handles #RRGGBB format', () => {
  assert.deepEqual(parseHex('#ec4899'), [236, 72, 153]);
  assert.deepEqual(parseHex('#000000'), [0, 0, 0]);
  assert.deepEqual(parseHex('#ffffff'), [255, 255, 255]);
  assert.deepEqual(parseHex('#0b0716'), [11, 7, 22]);
});

test('parseHex - handles RRGGBB without hash', () => {
  assert.deepEqual(parseHex('ec4899'), [236, 72, 153]);
  assert.deepEqual(parseHex('000000'), [0, 0, 0]);
});

test('parseHex - handles #RGB shorthand', () => {
  assert.deepEqual(parseHex('#ec4'), [238, 204, 68]);
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('#000'), [0, 0, 0]);
});

test('parseHex - handles RGB shorthand without hash', () => {
  assert.deepEqual(parseHex('ec4'), [238, 204, 68]);
  assert.deepEqual(parseHex('fff'), [255, 255, 255]);
});

test('parseHex - throws on invalid length', () => {
  assert.throws(() => parseHex('#ec'), RangeError);
  assert.throws(() => parseHex('#ec489'), RangeError);
  assert.throws(() => parseHex('#ec48990'), RangeError);
  assert.throws(() => parseHex('ec'), RangeError);
});

test('parseHex - throws on non-hex characters', () => {
  assert.throws(() => parseHex('#zzzzzz'), RangeError);
  assert.throws(() => parseHex('#gggggg'), RangeError);
});

test('parseHex - throws on non-string input', () => {
  assert.throws(() => parseHex(123), TypeError);
  assert.throws(() => parseHex(null), TypeError);
  assert.throws(() => parseHex(undefined), TypeError);
});

// ---------------------------------------------------------------------------
// getLuminance
// ---------------------------------------------------------------------------

test('getLuminance - returns 0 for black', () => {
  assert.equal(getLuminance('#000000'), 0);
});

test('getLuminance - returns 1 for white', () => {
  assert.equal(getLuminance('#ffffff'), 1);
});

test('getLuminance - returns correct values for known colors', () => {
  // sRGB luminance values per WCAG
  assert.equal(getLuminance('#ec4899').toFixed(6), '0.247675');
  assert.equal(getLuminance('#0b0716').toFixed(6), '0.002810');
  assert.equal(getLuminance('#38bdf8').toFixed(6), '0.440133');
  assert.equal(getLuminance('#fde047').toFixed(6), '0.746489');
});

test('getLuminance - accepts formats without hash', () => {
  assert.equal(getLuminance('000000'), 0);
  assert.equal(getLuminance('ffffff'), 1);
});

// ---------------------------------------------------------------------------
// calculateRatio
// ---------------------------------------------------------------------------

test('calculateRatio - returns 21 for black on white', () => {
  const ratio = calculateRatio('#ffffff', '#000000');
  assert.equal(ratio.toFixed(2), '21.00');
});

test('calculateRatio - symmetric (order does not matter)', () => {
  const ratio1 = calculateRatio('#ffffff', '#000000');
  const ratio2 = calculateRatio('#000000', '#ffffff');
  assert.equal(ratio1, ratio2);
});

test('calculateRatio - returns correct ratio for festival colors', () => {
  const ratio = calculateRatio('#ec4899', '#0b0716');
  assert.ok(ratio > 5.6 && ratio < 5.7);
});

test('calculateRatio - returns 1 for same color', () => {
  const ratio = calculateRatio('#ec4899', '#ec4899');
  assert.equal(ratio.toFixed(2), '1.00');
});

test('calculateRatio - throws on invalid colors', () => {
  assert.throws(() => calculateRatio('#invalid', '#000000'), RangeError);
  assert.throws(() => calculateRatio('#000000', '#invalid'), RangeError);
});

// ---------------------------------------------------------------------------
// evaluateWcagCompliance
// ---------------------------------------------------------------------------

test('evaluateWcagCompliance - returns AAA for ratio >= 7', () => {
  const result = evaluateWcagCompliance(7.0);
  assert.equal(result.rating, CONTRAST_RATING.AAA);
  assert.equal(result.aaaNormal, true);
  assert.equal(result.aaaLarge, true);
  assert.equal(result.aaNormal, true);
  assert.equal(result.aaLarge, true);
});

test('evaluateWcagCompliance - returns AA for ratio >= 4.5', () => {
  const result = evaluateWcagCompliance(4.5);
  assert.equal(result.rating, CONTRAST_RATING.AA);
  assert.equal(result.aaNormal, true);
  assert.equal(result.aaLarge, true);
  assert.equal(result.aaaNormal, false);
  assert.equal(result.aaaLarge, true);
});

test('evaluateWcagCompliance - returns AA for ratio >= 3 (large text only)', () => {
  const result = evaluateWcagCompliance(3.5);
  assert.equal(result.rating, CONTRAST_RATING.AA);
  assert.equal(result.aaNormal, false);
  assert.equal(result.aaLarge, true);
  assert.equal(result.aaaNormal, false);
  assert.equal(result.aaaLarge, false);
  // Should still be rated AA even though normal text fails
  assert.equal(result.textSize, 'large');
});

test('evaluateWcagCompliance - returns FAIL for ratio < 3', () => {
  const result = evaluateWcagCompliance(2.5);
  assert.equal(result.rating, CONTRAST_RATING.FAIL);
  assert.equal(result.aaNormal, false);
  assert.equal(result.aaLarge, false);
  assert.equal(result.aaaNormal, false);
  assert.equal(result.aaaLarge, false);
});

test('evaluateWcagCompliance - textSize classification', () => {
  assert.equal(evaluateWcagCompliance(7).textSize, 'large');
  assert.equal(evaluateWcagCompliance(4.5).textSize, 'large');
  assert.equal(evaluateWcagCompliance(3).textSize, 'large');
  assert.equal(evaluateWcagCompliance(2.5).textSize, 'normal');
});

// ---------------------------------------------------------------------------
// formatRatio
// ---------------------------------------------------------------------------

test('formatRatio - formats with two decimal places', () => {
  assert.equal(formatRatio(4.5), '4.50:1');
  assert.equal(formatRatio(21), '21.00:1');
  assert.equal(formatRatio(3.14159), '3.14:1');
});

// ---------------------------------------------------------------------------
// generateContrastMatrix
// ---------------------------------------------------------------------------

test('generateContrastMatrix - returns square matrix', () => {
  const colors = ['#000000', '#ffffff', '#ec4899'];
  const matrix = generateContrastMatrix(colors);
  assert.equal(matrix.length, 3);
  assert.equal(matrix[0].length, 3);
  assert.equal(matrix[1].length, 3);
  assert.equal(matrix[2].length, 3);
});

test('generateContrastMatrix - diagonal entries are 1:1', () => {
  const colors = ['#000000', '#ffffff', '#ec4899'];
  const matrix = generateContrastMatrix(colors);
  assert.equal(matrix[0][0].ratio.toFixed(2), '1.00');
  assert.equal(matrix[1][1].ratio.toFixed(2), '1.00');
  assert.equal(matrix[2][2].ratio.toFixed(2), '1.00');
});

test('generateContrastMatrix - matrix is symmetric', () => {
  const colors = ['#000000', '#ffffff', '#ec4899'];
  const matrix = generateContrastMatrix(colors);
  for (let i = 0; i < colors.length; i++) {
    for (let j = 0; j < colors.length; j++) {
      assert.equal(matrix[i][j].ratio, matrix[j][i].ratio);
    }
  }
});

test('generateContrastMatrix - includes compliance info', () => {
  const colors = ['#000000', '#ffffff'];
  const matrix = generateContrastMatrix(colors);
  assert.ok('compliance' in matrix[0][1]);
  assert.ok('ratio' in matrix[0][1]);
  assert.ok('fg' in matrix[0][1]);
  assert.ok('bg' in matrix[0][1]);
});

// ---------------------------------------------------------------------------
// findBestForeground
// ---------------------------------------------------------------------------

test('findBestForeground - returns highest contrast color', () => {
  const bg = '#000000';
  const candidates = ['#333333', '#999999', '#ffffff'];
  const result = findBestForeground(bg, candidates);
  assert.equal(result.color, '#ffffff');
  assert.equal(result.ratio.toFixed(2), '21.00');
});

test('findBestForeground - works with dark background', () => {
  const bg = '#ffffff';
  const candidates = ['#000000', '#666666', '#cccccc'];
  const result = findBestForeground(bg, candidates);
  assert.equal(result.color, '#000000');
  assert.equal(result.ratio.toFixed(2), '21.00');
});

test('findBestForeground - returns null for empty candidates', () => {
  const result = findBestForeground('#000000', []);
  assert.equal(result.color, null);
  assert.equal(result.ratio, 0);
});

// ---------------------------------------------------------------------------
// WCAG_THRESHOLDS constants
// ---------------------------------------------------------------------------

test('WCAG_THRESHOLDS - correct values', () => {
  assert.equal(WCAG_THRESHOLDS.AA_NORMAL, 4.5);
  assert.equal(WCAG_THRESHOLDS.AA_LARGE, 3.0);
  assert.equal(WCAG_THRESHOLDS.AAA_NORMAL, 7.0);
  assert.equal(WCAG_THRESHOLDS.AAA_LARGE, 4.5);
});

// ---------------------------------------------------------------------------
// CONTRAST_RATING constants
// ---------------------------------------------------------------------------

test('CONTRAST_RATING - correct values', () => {
  assert.equal(CONTRAST_RATING.FAIL, 'FAIL');
  assert.equal(CONTRAST_RATING.AA, 'AA');
  assert.equal(CONTRAST_RATING.AAA, 'AAA');
});

// ---------------------------------------------------------------------------
// FestivalHubContrastAuditor class
// ---------------------------------------------------------------------------

test('FestivalHubContrastAuditor - calculateRatio method', () => {
  const auditor = new FestivalHubContrastAuditor();
  const ratio = auditor.calculateRatio('#ffffff', '#000000');
  assert.equal(ratio.toFixed(2), '21.00');
});

test('FestivalHubContrastAuditor - getLuminance method', () => {
  const auditor = new FestivalHubContrastAuditor();
  assert.equal(auditor.getLuminance('#000000'), 0);
  assert.equal(auditor.getLuminance('#ffffff'), 1);
});

test('FestivalHubContrastAuditor - evaluateWcagCompliance method', () => {
  const auditor = new FestivalHubContrastAuditor();
  const result = auditor.evaluateWcagCompliance(4.5);
  assert.equal(result.rating, 'AA');
});

test('FestivalHubContrastAuditor - formatRatio method', () => {
  const auditor = new FestivalHubContrastAuditor();
  assert.equal(auditor.formatRatio(3.5), '3.50:1');
});

test('FestivalHubContrastAuditor - getComplianceLabel method', () => {
  const auditor = new FestivalHubContrastAuditor();
  assert.equal(auditor.getComplianceLabel({ rating: 'AAA' }), 'AAA ✓');
  assert.equal(auditor.getComplianceLabel({ rating: 'AA' }), 'AA ✓');
  assert.equal(auditor.getComplianceLabel({ rating: 'FAIL' }), 'FAIL ✗');
});

test('FestivalHubContrastAuditor - generateContrastMatrix method', () => {
  const auditor = new FestivalHubContrastAuditor();
  const matrix = auditor.generateContrastMatrix(['#000000', '#ffffff']);
  assert.equal(matrix.length, 2);
  assert.equal(matrix[0].length, 2);
});

test('FestivalHubContrastAuditor - findBestForeground method', () => {
  const auditor = new FestivalHubContrastAuditor();
  const result = auditor.findBestForeground('#000000', ['#333333', '#ffffff']);
  assert.equal(result.color, '#ffffff');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('calculateRatio - handles very similar colors', () => {
  const ratio = calculateRatio('#123456', '#123457');
  assert.ok(ratio >= 1.0 && ratio < 1.1);
});

test('getLuminance - accepts lowercase hex', () => {
  assert.equal(getLuminance('#ec4899'), getLuminance('#EC4899'));
});

test('parseHex - case insensitive', () => {
  assert.deepEqual(parseHex('#EC4899'), parseHex('#ec4899'));
  assert.deepEqual(parseHex('#Ec4899'), parseHex('#ec4899'));
});

test('evaluateWcagCompliance - boundary values', () => {
  // Exactly at thresholds
  assert.equal(evaluateWcagCompliance(4.5).aaNormal, true);
  assert.equal(evaluateWcagCompliance(4.499).aaNormal, false);
  assert.equal(evaluateWcagCompliance(3).aaLarge, true);
  assert.equal(evaluateWcagCompliance(2.999).aaLarge, false);
  assert.equal(evaluateWcagCompliance(7).aaaNormal, true);
  assert.equal(evaluateWcagCompliance(6.999).aaaNormal, false);
});