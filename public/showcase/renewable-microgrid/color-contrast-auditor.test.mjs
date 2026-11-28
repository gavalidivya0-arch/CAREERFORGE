import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RenewableMicrogridContrastAuditor,
  DEFAULT_MICROGRID_PALETTE
} from './color-contrast-auditor.js';

test('getLuminance calculates accurate WCAG 2.1 luminance for primaries, black, and white', () => {
  const auditor = new RenewableMicrogridContrastAuditor();

  assert.equal(auditor.getLuminance('#000000'), 0);
  assert.equal(auditor.getLuminance('#ffffff'), 1);
  assert.equal(auditor.getLuminance('#000'), 0);
  assert.equal(auditor.getLuminance('  #FfF  '), 1);

  assert.ok(Math.abs(auditor.getLuminance('#ff0000') - 0.2126) < 1e-6);
  assert.ok(Math.abs(auditor.getLuminance('#00ff00') - 0.7152) < 1e-6);
  assert.ok(Math.abs(auditor.getLuminance('#0000ff') - 0.0722) < 1e-6);
});

test('normalizeHex validates and throws on malformed or non-string hex inputs', () => {
  const auditor = new RenewableMicrogridContrastAuditor();

  assert.equal(auditor.normalizeHex('84CC16'), '#84cc16');
  assert.equal(auditor.normalizeHex('#abc'), '#aabbcc');

  assert.throws(() => auditor.normalizeHex(12345), TypeError);
  assert.throws(() => auditor.normalizeHex('invalid-hex'), /Invalid hex color/);
  assert.throws(() => auditor.normalizeHex('#12345'), /Invalid hex color/);
  assert.throws(() => auditor.normalizeHex('#gggggg'), /Invalid hex color/);
});

test('calculateRatio computes 21:1, 1:1, symmetry, and avoids false rounding passes', () => {
  const auditor = new RenewableMicrogridContrastAuditor();

  assert.equal(auditor.calculateRatio('#000000', '#ffffff'), 21);
  assert.equal(auditor.calculateRatio('#ffffff', '#ffffff'), 1);

  const r1 = auditor.calculateRatio('#84cc16', '#090a0f');
  const r2 = auditor.calculateRatio('#090a0f', '#84cc16');
  assert.equal(r1, r2);
  assert.ok(r1 >= 9.0, `Expected Solar Lime on Obsidian to have strong contrast, got ${r1}`);

  // #767676 on #ffffff is ~4.54:1 (passes AA); #777777 on #ffffff is ~4.47:1 (fails AA)
  assert.equal(auditor.calculateRatio('#767676', '#ffffff'), 4.54);
  assert.equal(auditor.calculateRatio('#777777', '#ffffff'), 4.47);
});

test('evaluateWcagCompliance enforces AA and AAA threshold boundaries and rejects invalid ratios', () => {
  const auditor = new RenewableMicrogridContrastAuditor();

  const fail = auditor.evaluateWcagCompliance(2.99);
  assert.deepEqual(fail, {
    ratio: 2.99,
    normalAA: false,
    normalAAA: false,
    largeAA: false,
    largeAAA: false,
    uiComponents: false
  });

  const largePass = auditor.evaluateWcagCompliance(3.0);
  assert.equal(largePass.largeAA, true);
  assert.equal(largePass.uiComponents, true);
  assert.equal(largePass.normalAA, false);
  assert.equal(largePass.largeAAA, false);
  assert.equal(largePass.normalAAA, false);

  const normalAA = auditor.evaluateWcagCompliance(4.5);
  assert.equal(normalAA.normalAA, true);
  assert.equal(normalAA.largeAA, true);
  assert.equal(normalAA.largeAAA, true);
  assert.equal(normalAA.uiComponents, true);
  assert.equal(normalAA.normalAAA, false);

  const normalAAA = auditor.evaluateWcagCompliance(7.0);
  assert.equal(normalAAA.normalAA, true);
  assert.equal(normalAAA.normalAAA, true);
  assert.equal(normalAAA.largeAA, true);
  assert.equal(normalAAA.largeAAA, true);
  assert.equal(normalAAA.uiComponents, true);

  assert.throws(() => auditor.evaluateWcagCompliance(0), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance(-4.5), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance(Number.NaN), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance('4.5'), TypeError);
});

test('verifyPalette builds N x N contrast matrix and accurate summary counts', () => {
  const auditor = new RenewableMicrogridContrastAuditor();
  const result = auditor.verifyPalette(DEFAULT_MICROGRID_PALETTE);

  const n = DEFAULT_MICROGRID_PALETTE.length;
  assert.equal(result.colors.length, n);
  assert.equal(result.matrix.length, n);
  assert.equal(result.matrix[0].length, n);
  assert.equal(result.summary.totalPairs, n * (n - 1));
  assert.equal(
    result.summary.passingAA + result.summary.passingLargeOnly + result.summary.failing,
    result.summary.totalPairs
  );

  // Diagonal cells are marked isSame and symmetric cells have identical ratios
  assert.equal(result.matrix[0][0].isSame, true);
  assert.equal(result.matrix[0][2].ratio, result.matrix[2][0].ratio);

  assert.throws(() => auditor.verifyPalette(['#ffffff']), TypeError);
});

test('suggestAccessibleColor adjusts lightness to meet target ratio when reachable', () => {
  const auditor = new RenewableMicrogridContrastAuditor();

  const fixedAA = auditor.suggestAccessibleColor('#64748b', '#1e293b', 4.5);
  assert.ok(fixedAA);
  assert.ok(auditor.calculateRatio(fixedAA, '#1e293b') >= 4.5);

  const fixedAAA = auditor.suggestAccessibleColor('#64748b', '#090a0f', 7.0);
  assert.ok(fixedAAA);
  assert.ok(auditor.calculateRatio(fixedAAA, '#090a0f') >= 7.0);

  // Mid-gray #808080 cannot reach 7.0:1 against any color (max is ~5.31:1 against #000000)
  const impossible = auditor.suggestAccessibleColor('#94a3b8', '#808080', 7.0);
  assert.equal(impossible, null);
});
