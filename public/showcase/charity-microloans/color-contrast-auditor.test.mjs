import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CharityMicroloansContrastAuditor,
  DEFAULT_CHARITY_PALETTE
} from './color-contrast-auditor.js';

test('getLuminance calculates accurate WCAG 2.1 luminance across primaries and sRGB piecewise branches', () => {
  const auditor = new CharityMicroloansContrastAuditor();

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
  const auditor = new CharityMicroloansContrastAuditor();

  assert.equal(auditor.normalizeHex('059669'), '#059669');
  assert.equal(auditor.normalizeHex('#abc'), '#aabbcc');
  assert.equal(auditor.normalizeHex('  #34D399 '), '#34d399');

  assert.throws(() => auditor.normalizeHex(12345), TypeError);
  assert.throws(() => auditor.normalizeHex(null), TypeError);
  assert.throws(() => auditor.normalizeHex('invalid-hex'), /Invalid hex color/);
  assert.throws(() => auditor.normalizeHex('#12345'), /Invalid hex color/);
  assert.throws(() => auditor.normalizeHex('#gggggg'), /Invalid hex color/);
});

test('calculateRatio computes 21:1, 1:1, symmetry, and never rounds failing ratios up to pass', () => {
  const auditor = new CharityMicroloansContrastAuditor();

  assert.equal(auditor.calculateRatio('#000000', '#ffffff'), 21);
  assert.equal(auditor.calculateRatio('#ffffff', '#ffffff'), 1);

  const r1 = auditor.calculateRatio('#34d399', '#090a0f');
  const r2 = auditor.calculateRatio('#090a0f', '#34d399');
  assert.equal(r1, r2);
  assert.ok(r1 >= 10.0, `Expected Mint Verified on Obsidian to achieve AAA contrast, got ${r1}`);

  // #767676 on #ffffff is ~4.54:1 (passes AA); #777777 on #ffffff is ~4.47:1 (fails AA)
  assert.equal(auditor.calculateRatio('#767676', '#ffffff'), 4.54);
  assert.equal(auditor.calculateRatio('#777777', '#ffffff'), 4.47);
});

test('evaluateWcagCompliance and getComplianceGrade enforce exact AA and AAA thresholds', () => {
  const auditor = new CharityMicroloansContrastAuditor();

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
  const auditor = new CharityMicroloansContrastAuditor();
  const result = auditor.verifyPalette(DEFAULT_CHARITY_PALETTE);

  const n = DEFAULT_CHARITY_PALETTE.length;
  assert.equal(result.colors.length, n);
  assert.equal(result.matrix.length, n);
  assert.equal(result.matrix[0].length, n);
  assert.equal(result.summary.totalPairs, n * (n - 1));
  assert.equal(
    result.summary.passingAA + result.summary.passingLargeOnly + result.summary.failing,
    result.summary.totalPairs
  );

  // Diagonal cells are marked isSame and off-diagonal symmetric cells match ratios
  assert.equal(result.matrix[0][0].isSame, true);
  assert.equal(result.matrix[1][3].ratio, result.matrix[3][1].ratio);

  // Accepts plain hex string arrays too
  const custom = auditor.verifyPalette(['#090a0f', '#f8fafc', '#059669']);
  assert.equal(custom.summary.totalPairs, 6);

  assert.throws(() => auditor.verifyPalette(['#ffffff']), TypeError);
  assert.throws(() => auditor.verifyPalette('not-an-array'), TypeError);
});

test('suggestAccessibleColor adjusts lightness to meet target ratio when reachable', () => {
  const auditor = new CharityMicroloansContrastAuditor();

  // Already passing pair returns normalized uppercase hex unchanged
  assert.equal(auditor.suggestAccessibleColor('#f8fafc', '#090a0f', 4.5), '#F8FAFC');

  // Impact Emerald (#059669) on Impact White (#F8FAFC) fails normal AA (~3.55:1); should darken to pass >= 4.5:1
  const fixedAA = auditor.suggestAccessibleColor('#059669', '#f8fafc', 4.5);
  assert.ok(fixedAA);
  assert.ok(auditor.calculateRatio(fixedAA, '#f8fafc') >= 4.5);

  // Impact Emerald (#059669) on Obsidian (#090A0F) fails AAA (~5.35:1); should lighten to pass >= 7.0:1
  const fixedAAA = auditor.suggestAccessibleColor('#059669', '#090a0f', 7.0);
  assert.ok(fixedAAA);
  assert.ok(auditor.calculateRatio(fixedAAA, '#090a0f') >= 7.0);

  // Mid-gray #808080 cannot reach 7.0:1 against any color (max is ~5.31:1 against #000000)
  const impossible = auditor.suggestAccessibleColor('#94a3b8', '#808080', 7.0);
  assert.equal(impossible, null);

  assert.throws(() => auditor.suggestAccessibleColor('#059669', '#090a0f', 25), RangeError);
});

test('HTML template wires every DOM ID referenced by color-contrast-auditor.js safely', () => {
  const html = fs.readFileSync(new URL('./color-contrast-auditor.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./color-contrast-auditor.js', import.meta.url), 'utf8');

  assert.match(html, /data-contrast-lab/);
  assert.match(html, /href="\.\/color-contrast-auditor\.css"/);
  assert.match(html, /src="\.\/color-contrast-auditor\.js"/);

  const referencedIds = [...js.matchAll(/get\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(referencedIds.length > 0);
  for (const id of new Set(referencedIds)) {
    assert.ok(
      html.includes(`id="${id}"`),
      `Expected HTML to contain element with id="${id}" referenced in JS`
    );
  }

  assert.equal(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b/.test(js), false);
});
