import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  MusicDawStudioContrastAuditor,
  DEFAULT_DAW_PALETTE
} from './color-contrast-auditor.js';

test('getLuminance calculates accurate WCAG 2.1 luminance across primaries and sRGB piecewise branches', () => {
  const auditor = new MusicDawStudioContrastAuditor();

  assert.equal(auditor.getLuminance('#000000'), 0);
  assert.equal(auditor.getLuminance('#ffffff'), 1);
  assert.equal(auditor.getLuminance('#000'), 0);
  assert.equal(auditor.getLuminance('  #FfF  '), 1);

  assert.ok(Math.abs(auditor.getLuminance('#ff0000') - 0.2126) < 1e-6);
  assert.ok(Math.abs(auditor.getLuminance('#00ff00') - 0.7152) < 1e-6);
  assert.ok(Math.abs(auditor.getLuminance('#0000ff') - 0.0722) < 1e-6);

  // Linear sRGB branch (channel 10/255 = 0.039215... <= 0.04045)
  assert.ok(Math.abs(auditor.getLuminance('#0a0a0a') - (10 / 255 / 12.92)) < 1e-10);
});

test('normalizeHex validates and rejects malformed or non-string inputs', () => {
  const auditor = new MusicDawStudioContrastAuditor();

  assert.equal(auditor.normalizeHex('d946ef'), '#d946ef');
  assert.equal(auditor.normalizeHex('#abc'), '#aabbcc');
  assert.equal(auditor.normalizeHex('  #E879F9 '), '#e879f9');

  assert.throws(() => auditor.normalizeHex(12345), TypeError);
  assert.throws(() => auditor.normalizeHex(null), TypeError);
  assert.throws(() => auditor.normalizeHex('invalid-hex'), /Invalid hex color/);
  assert.throws(() => auditor.normalizeHex('#12345'), /Invalid hex color/);
  assert.throws(() => auditor.normalizeHex('#gggggg'), /Invalid hex color/);
});

test('calculateRatio computes 21:1, 1:1, symmetry, and never rounds failing ratios up to pass', () => {
  const auditor = new MusicDawStudioContrastAuditor();

  assert.equal(auditor.calculateRatio('#000000', '#ffffff'), 21);
  assert.equal(auditor.calculateRatio('#ffffff', '#ffffff'), 1);

  const r1 = auditor.calculateRatio('#e879f9', '#090a0f');
  const r2 = auditor.calculateRatio('#090a0f', '#e879f9');
  assert.equal(r1, r2);
  assert.ok(r1 >= 7.0, `Expected Synth Orchid on Obsidian Deck to achieve AAA contrast, got ${r1}`);

  // #767676 on #ffffff is ~4.54:1 (passes AA); #777777 on #ffffff is ~4.47:1 (fails AA)
  assert.equal(auditor.calculateRatio('#767676', '#ffffff'), 4.54);
  assert.equal(auditor.calculateRatio('#777777', '#ffffff'), 4.47);
});

test('evaluateWcagCompliance and getComplianceGrade enforce exact AA and AAA thresholds', () => {
  const auditor = new MusicDawStudioContrastAuditor();

  const fail = auditor.evaluateWcagCompliance(2.99);
  assert.deepEqual(fail, {
    ratio: 2.99,
    normalAA: false,
    normalAAA: false,
    largeAA: false,
    largeAAA: false,
    uiComponents: false
  });
  assert.equal(auditor.getComplianceGrade(2.99), 'FAIL');

  const largePass = auditor.evaluateWcagCompliance(3.0);
  assert.equal(largePass.largeAA, true);
  assert.equal(largePass.uiComponents, true);
  assert.equal(largePass.normalAA, false);
  assert.equal(largePass.largeAAA, false);
  assert.equal(largePass.normalAAA, false);
  assert.equal(auditor.getComplianceGrade(3.0), 'AA Large');

  const justBelowAA = auditor.evaluateWcagCompliance(4.49);
  assert.equal(justBelowAA.normalAA, false);
  assert.equal(justBelowAA.largeAAA, false);

  const normalAA = auditor.evaluateWcagCompliance(4.5);
  assert.equal(normalAA.normalAA, true);
  assert.equal(normalAA.largeAA, true);
  assert.equal(normalAA.largeAAA, true);
  assert.equal(normalAA.uiComponents, true);
  assert.equal(normalAA.normalAAA, false);
  assert.equal(auditor.getComplianceGrade(4.5), 'AA');

  const normalAAA = auditor.evaluateWcagCompliance(7.0);
  assert.equal(normalAAA.normalAA, true);
  assert.equal(normalAAA.normalAAA, true);
  assert.equal(normalAAA.largeAA, true);
  assert.equal(normalAAA.largeAAA, true);
  assert.equal(normalAAA.uiComponents, true);
  assert.equal(auditor.getComplianceGrade(7.0), 'AAA');

  assert.throws(() => auditor.evaluateWcagCompliance(0), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance(-4.5), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance(Number.NaN), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => auditor.evaluateWcagCompliance('4.5'), TypeError);
});

test('verifyPalette builds N x N contrast matrix and accurate summary counts', () => {
  const auditor = new MusicDawStudioContrastAuditor();
  const result = auditor.verifyPalette(DEFAULT_DAW_PALETTE);

  const n = DEFAULT_DAW_PALETTE.length;
  assert.equal(result.colors.length, n);
  assert.equal(result.matrix.length, n);
  assert.equal(result.summary.totalPairs, n * (n - 1));

  const { passingAAA, passingAA, passingLargeOnly, failing, totalPairs } = result.summary;
  assert.ok(passingAAA <= passingAA);
  assert.equal(passingAA + passingLargeOnly + failing, totalPairs);

  for (let i = 0; i < n; i += 1) {
    assert.equal(result.matrix[i][i].isSame, true);
    assert.equal(result.matrix[i][i].ratio, 1);
  }

  assert.throws(() => auditor.verifyPalette(['#000000']), TypeError);
  assert.throws(() => auditor.verifyPalette(null), TypeError);
});

test('suggestAccessibleColor finds closest compliant hue-preserving color or returns null when unreachable', () => {
  const auditor = new MusicDawStudioContrastAuditor();

  // Neon Magenta (#D946EF) on Studio White (#F8FAFC) fails normal AA (4.5:1)
  const failingBefore = auditor.calculateRatio('#D946EF', '#F8FAFC');
  assert.ok(failingBefore < 4.5, `Expected low contrast before fix, got ${failingBefore}`);

  const fixedAA = auditor.suggestAccessibleColor('#D946EF', '#F8FAFC', 4.5);
  assert.ok(fixedAA !== null);
  assert.ok(auditor.calculateRatio(fixedAA, '#F8FAFC') >= 4.5);

  const fixedAAA = auditor.suggestAccessibleColor('#D946EF', '#F8FAFC', 7.0);
  assert.ok(fixedAAA !== null);
  assert.ok(auditor.calculateRatio(fixedAAA, '#F8FAFC') >= 7.0);

  // Already passing pair returns normalized uppercase unchanged
  assert.equal(auditor.suggestAccessibleColor('#e879f9', '#090a0f', 4.5), '#E879F9');

  // Mid-gray (#777777) cannot reach 7:1 against any color
  assert.equal(auditor.suggestAccessibleColor('#ffffff', '#777777', 7.0), null);
});

test('dedicated HTML, CSS, and JS files implement all required WCAG UI and module hooks', () => {
  const html = fs.readFileSync(new URL('./color-contrast-auditor.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('./color-contrast-auditor.css', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./color-contrast-auditor.js', import.meta.url), 'utf8');

  assert.match(html, /href="\.\/color-contrast-auditor\.css"/);
  assert.match(html, /src="\.\/color-contrast-auditor\.js"/);
  assert.match(html, /id="fg-color"/);
  assert.match(html, /id="bg-color"/);
  assert.match(html, /id="preview-frame"/);
  assert.match(html, /id="tag-normal-aa"/);
  assert.match(html, /id="tag-normal-aaa"/);
  assert.match(html, /id="contrast-matrix-table"/);

  assert.match(css, /\.ratio-gauge/);
  assert.match(css, /\.status-chip/);
  assert.match(css, /\.preview-frame\.high-contrast-border/);

  assert.match(js, /export class MusicDawStudioContrastAuditor/);
  assert.ok(!js.includes('innerHTML'), 'Must use safe DOM APIs instead of innerHTML');
});
