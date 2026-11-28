/**
 * BEAT-FORGE // Music DAW Studio
 * WCAG 2.1 Color Contrast Matrix & Palette Verifier
 */

const WCAG_THRESHOLDS = Object.freeze({
  normalAA: 4.5,
  normalAAA: 7.0,
  largeAA: 3.0,
  largeAAA: 4.5,
  uiComponents: 3.0
});

export const DEFAULT_DAW_PALETTE = Object.freeze([
  { id: 'obsidian', name: 'Obsidian Deck', hex: '#090A0F' },
  { id: 'console', name: 'Console Slate', hex: '#0F172A' },
  { id: 'white', name: 'Studio White', hex: '#F8FAFC' },
  { id: 'orchid', name: 'Synth Orchid', hex: '#E879F9' },
  { id: 'magenta', name: 'Neon Magenta', hex: '#D946EF' },
  { id: 'cyan', name: 'Telemetry Cyan', hex: '#38BDF8' },
  { id: 'muted', name: 'Muted Fader', hex: '#94A3B8' }
]);

const DEFAULT_SAMPLE_COPY =
  'Channel 04 // Analog Bassline: 128.0 BPM · Low-Pass Cutoff 840 Hz · Master Bus -1.2 dBFS';

export class MusicDawStudioContrastAuditor {
  /**
   * Normalizes a 3-digit or 6-digit hex color string into lowercase #rrggbb format.
   * @param {string} hex
   * @returns {string}
   */
  normalizeHex(hex) {
    if (typeof hex !== 'string') {
      throw new TypeError('Hex color must be a string');
    }
    let cleaned = hex.trim().replace(/^#/, '');
    if (cleaned.length === 3) {
      cleaned = cleaned
        .split('')
        .map((ch) => ch + ch)
        .join('');
    }
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      throw new Error(`Invalid hex color: ${hex}`);
    }
    return `#${cleaned.toLowerCase()}`;
  }

  /**
   * Parses a hex color string into 8-bit RGB channel components (0-255).
   * @param {string} hex
   * @returns {{ r: number, g: number, b: number }}
   */
  parseHex(hex) {
    const normalized = this.normalizeHex(hex);
    const num = parseInt(normalized.slice(1), 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }

  /**
   * Computes relative luminance per WCAG 2.1 specification in range [0, 1].
   * @param {string} hex
   * @returns {number}
   */
  getLuminance(hex) {
    const { r, g, b } = this.parseHex(hex);
    const toLinear = (channel) => {
      const srgb = channel / 255;
      return srgb <= 0.04045
        ? srgb / 12.92
        : Math.pow((srgb + 0.055) / 1.055, 2.4);
    };

    const rLin = toLinear(r);
    const gLin = toLinear(g);
    const bLin = toLinear(b);

    return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
  }

  /**
   * Computes unrounded WCAG 2.1 contrast ratio between two hex colors.
   * @param {string} fgHex
   * @param {string} bgHex
   * @returns {number}
   */
  calculateExactRatio(fgHex, bgHex) {
    const l1 = this.getLuminance(fgHex);
    const l2 = this.getLuminance(bgHex);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Computes WCAG 2.1 contrast ratio truncated to 2 decimal places so borderline
   * failing values (e.g. 4.496) are never rounded up to a passing 4.50.
   * @param {string} fgHex
   * @param {string} bgHex
   * @returns {number}
   */
  calculateRatio(fgHex, bgHex) {
    const raw = this.calculateExactRatio(fgHex, bgHex);
    return Math.floor(raw * 100 + 1e-12) / 100;
  }

  /**
   * Evaluates a numeric contrast ratio against WCAG 2.1 AA and AAA thresholds.
   * @param {number} ratio
   * @returns {{ ratio: number, normalAA: boolean, normalAAA: boolean, largeAA: boolean, largeAAA: boolean, uiComponents: boolean }}
   */
  evaluateWcagCompliance(ratio) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
      throw new TypeError('Ratio must be a positive number');
    }

    return {
      ratio,
      normalAA: ratio >= WCAG_THRESHOLDS.normalAA,
      normalAAA: ratio >= WCAG_THRESHOLDS.normalAAA,
      largeAA: ratio >= WCAG_THRESHOLDS.largeAA,
      largeAAA: ratio >= WCAG_THRESHOLDS.largeAAA,
      uiComponents: ratio >= WCAG_THRESHOLDS.uiComponents
    };
  }

  /**
   * Returns a compact WCAG tier label for a ratio.
   * @param {number} ratio
   * @returns {'AAA' | 'AA' | 'AA Large' | 'FAIL'}
   */
  getComplianceGrade(ratio) {
    const compliance = this.evaluateWcagCompliance(ratio);
    if (compliance.normalAAA) return 'AAA';
    if (compliance.normalAA) return 'AA';
    if (compliance.largeAA) return 'AA Large';
    return 'FAIL';
  }

  /**
   * Verifies every foreground/background pairing in a palette and summarizes pass rates.
   * @param {Array<string | { id?: string, name?: string, hex: string }>} palette
   * @returns {{ colors: Array<{ id: string, name: string, hex: string, luminance: number }>, matrix: Array<Array<object>>, summary: object }}
   */
  verifyPalette(palette) {
    if (!Array.isArray(palette) || palette.length < 2) {
      throw new TypeError('Palette must be an array of at least 2 colors');
    }

    const colors = palette.map((entry, idx) => {
      const rawHex = typeof entry === 'string' ? entry : entry?.hex;
      const normalized = this.normalizeHex(rawHex);
      const name =
        typeof entry === 'object' && entry !== null && typeof entry.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : normalized.toUpperCase();
      const id =
        typeof entry === 'object' && entry !== null && typeof entry.id === 'string' && entry.id.trim()
          ? entry.id.trim()
          : `swatch-${idx}`;

      return {
        id,
        name,
        hex: normalized.toUpperCase(),
        luminance: this.getLuminance(normalized)
      };
    });

    let totalPairs = 0;
    let passingAA = 0;
    let passingAAA = 0;
    let passingLargeOnly = 0;
    let failing = 0;

    const matrix = colors.map((bgColor, rowIdx) =>
      colors.map((fgColor, colIdx) => {
        const isSame = rowIdx === colIdx;
        const ratio = this.calculateRatio(fgColor.hex, bgColor.hex);
        const compliance = this.evaluateWcagCompliance(ratio);
        const grade = this.getComplianceGrade(ratio);

        if (!isSame) {
          totalPairs += 1;
          if (compliance.normalAAA) {
            passingAAA += 1;
            passingAA += 1;
          } else if (compliance.normalAA) {
            passingAA += 1;
          } else if (compliance.largeAA) {
            passingLargeOnly += 1;
          } else {
            failing += 1;
          }
        }

        return {
          fg: fgColor,
          bg: bgColor,
          ratio,
          compliance,
          grade,
          isSame
        };
      })
    );

    const passRateAA = totalPairs > 0 ? Math.round((passingAA / totalPairs) * 100) : 0;
    const passRateAAA = totalPairs > 0 ? Math.round((passingAAA / totalPairs) * 100) : 0;

    return {
      colors,
      matrix,
      summary: {
        totalPairs,
        passingAA,
        passingAAA,
        passingLargeOnly,
        failing,
        passRateAA,
        passRateAAA
      }
    };
  }

  /**
   * Suggests the closest hue-preserving accessible foreground hex that achieves
   * targetRatio against bgHex, or null if the target ratio is unreachable.
   * @param {string} fgHex
   * @param {string} bgHex
   * @param {number} [targetRatio=4.5]
   * @returns {string | null}
   */
  suggestAccessibleColor(fgHex, bgHex, targetRatio = 4.5) {
    if (typeof targetRatio !== 'number' || !Number.isFinite(targetRatio) || targetRatio < 1 || targetRatio > 21) {
      throw new RangeError('Target ratio must be between 1 and 21');
    }

    const currentRatio = this.calculateRatio(fgHex, bgHex);
    if (currentRatio >= targetRatio) {
      return this.normalizeHex(fgHex).toUpperCase();
    }

    const { r, g, b } = this.parseHex(fgHex);
    const { h, s, l } = rgbToHsl(r, g, b);

    const lightCandidate = this.#searchLightness(h, s, l, 1, bgHex, targetRatio);
    const darkCandidate = this.#searchLightness(h, s, l, 0, bgHex, targetRatio);

    const candidates = [lightCandidate, darkCandidate].filter(Boolean);
    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, bItem) => a.distance - bItem.distance);
    return candidates[0].hex.toUpperCase();
  }

  #searchLightness(h, s, startL, boundL, bgHex, targetRatio) {
    const boundHex = hslToHex(h, s, boundL);
    if (this.calculateRatio(boundHex, bgHex) < targetRatio) {
      return null;
    }

    let low = Math.min(startL, boundL);
    let high = Math.max(startL, boundL);
    const goingUp = boundL >= startL;
    let bestHex = boundHex;

    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      const candidate = hslToHex(h, s, mid);
      const passes = this.calculateRatio(candidate, bgHex) >= targetRatio;

      if (goingUp) {
        if (passes) {
          bestHex = candidate;
          high = mid;
        } else {
          low = mid;
        }
      } else {
        if (passes) {
          bestHex = candidate;
          low = mid;
        } else {
          high = mid;
        }
      }
    }

    const bestRgb = this.parseHex(bestHex);
    const bestL = rgbToHsl(bestRgb.r, bestRgb.g, bestRgb.b).l;
    return {
      hex: bestHex,
      distance: Math.abs(bestL - startL)
    };
  }
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / delta + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / delta + 2;
        break;
      default:
        h = (rn - gn) / delta + 4;
        break;
    }
    h /= 6;
  }

  return { h, s, l };
}

function hslToHex(h, s, l) {
  const hueToRgb = (p, q, t) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };

  let r;
  let g;
  let b;
  if (s === 0) {
    r = l;
    g = l;
    b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }

  const toHex = (val) => Math.round(val * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mount() {
  const root = document.querySelector('[data-contrast-lab]');
  if (!root) return;

  const auditor = new MusicDawStudioContrastAuditor();
  const get = (id) => root.querySelector(`#${id}`);

  const state = {
    palette: DEFAULT_DAW_PALETTE.map((item) => ({ ...item })),
    matrixFilter: 'all',
    highContrastBorder: false
  };

  function setError(message) {
    const el = get('hex-error');
    if (el) {
      el.textContent = message || '';
    }
  }

  function applyPair(fgHex, bgHex) {
    const normalizedFg = auditor.normalizeHex(fgHex);
    const normalizedBg = auditor.normalizeHex(bgHex);
    get('fg-color').value = normalizedFg;
    get('bg-color').value = normalizedBg;
    get('fg-hex-input').value = normalizedFg.toUpperCase();
    get('bg-hex-input').value = normalizedBg.toUpperCase();
    updatePairView();
  }

  function updatePairView() {
    const fgRaw = get('fg-hex-input').value;
    const bgRaw = get('bg-hex-input').value;

    try {
      const fg = auditor.normalizeHex(fgRaw);
      const bg = auditor.normalizeHex(bgRaw);
      setError('');

      get('fg-color').value = fg;
      get('bg-color').value = bg;

      const fgLum = auditor.getLuminance(fg);
      const bgLum = auditor.getLuminance(bg);
      const ratio = auditor.calculateRatio(fg, bg);
      const compliance = auditor.evaluateWcagCompliance(ratio);
      const grade = auditor.getComplianceGrade(ratio);

      get('fg-luminance').textContent = `L = ${fgLum.toFixed(4)}`;
      get('bg-luminance').textContent = `L = ${bgLum.toFixed(4)}`;
      get('ratio-display').textContent = `${ratio.toFixed(2)} : 1`;

      const gradeEl = get('overall-grade');
      if (gradeEl) {
        gradeEl.textContent = grade === 'FAIL' ? 'FAILS WCAG' : `${grade} PASS`;
        gradeEl.className = `grade-pill grade-${grade.toLowerCase().replace(/\s+/g, '-')}`;
      }

      // Logarithmic gauge fill from 1:1 (0%) to 21:1 (100%) aligned with 3.0, 4.5, and 7.0 markers
      const gaugeFill = get('ratio-gauge-fill');
      const gaugeTrack = get('ratio-gauge-track');
      if (gaugeFill && gaugeTrack) {
        const pct = Math.min(100, Math.max(0, (Math.log(ratio) / Math.log(21)) * 100));
        gaugeFill.style.width = `${pct.toFixed(1)}%`;
        gaugeFill.className = `gauge-fill fill-${grade.toLowerCase().replace(/\s+/g, '-')}`;
        gaugeTrack.setAttribute('aria-valuenow', ratio.toFixed(2));
      }

      const previewBox = get('preview-frame');
      if (previewBox) {
        previewBox.style.backgroundColor = bg;
        previewBox.style.color = fg;
        previewBox.classList.toggle('high-contrast-border', state.highContrastBorder);
      }

      const setChip = (elemId, pass) => {
        const el = get(elemId);
        if (el) {
          el.textContent = pass ? 'PASS' : 'FAIL';
          el.className = `status-chip ${pass ? 'chip-pass' : 'chip-fail'}`;
        }
      };

      setChip('tag-normal-aa', compliance.normalAA);
      setChip('tag-normal-aaa', compliance.normalAAA);
      setChip('tag-large-aa', compliance.largeAA);
      setChip('tag-large-aaa', compliance.largeAAA);
      setChip('tag-ui', compliance.uiComponents);

      const fixAaBtn = get('fix-aa-btn');
      const fixAaaBtn = get('fix-aaa-btn');
      if (fixAaBtn) {
        fixAaBtn.disabled = compliance.normalAA || auditor.suggestAccessibleColor(fg, bg, 4.5) === null;
      }
      if (fixAaaBtn) {
        fixAaaBtn.disabled = compliance.normalAAA || auditor.suggestAccessibleColor(fg, bg, 7.0) === null;
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function renderPaletteSwatches(colors) {
    const container = get('palette-swatches');
    if (!container) return;

    const fragment = document.createDocumentFragment();
    colors.forEach((swatch, idx) => {
      const chip = document.createElement('div');
      chip.className = 'swatch-item';

      const dot = document.createElement('span');
      dot.className = 'swatch-dot';
      dot.style.backgroundColor = swatch.hex;

      const label = document.createElement('span');
      label.className = 'swatch-meta';
      label.textContent = `${swatch.name} (${swatch.hex})`;

      chip.append(dot, label);

      if (colors.length > 2) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'swatch-remove-btn';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', `Remove ${swatch.name}`);
        removeBtn.addEventListener('click', () => {
          state.palette.splice(idx, 1);
          renderMatrix();
        });
        chip.appendChild(removeBtn);
      }

      fragment.appendChild(chip);
    });

    container.replaceChildren(fragment);
  }

  function matchesFilter(cell) {
    if (cell.isSame) return true;
    switch (state.matrixFilter) {
      case 'aa':
        return cell.compliance.normalAA;
      case 'aaa':
        return cell.compliance.normalAAA;
      case 'large':
        return cell.compliance.largeAA && !cell.compliance.normalAA;
      case 'fail':
        return !cell.compliance.normalAA;
      default:
        return true;
    }
  }

  function renderMatrix() {
    const table = get('contrast-matrix-table');
    const summaryEl = get('matrix-summary');
    if (!table || !summaryEl) return;

    const { colors, matrix, summary } = auditor.verifyPalette(state.palette);
    renderPaletteSwatches(colors);

    summaryEl.textContent =
      `${summary.totalPairs} pairs · AA Pass: ${summary.passingAA} (${summary.passRateAA}%) · AAA Pass: ${summary.passingAAA} (${summary.passRateAAA}%) · Large Only: ${summary.passingLargeOnly} · Fail: ${summary.failing}`;

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.className = 'matrix-corner';
    corner.textContent = 'BG \\ FG';
    headRow.appendChild(corner);

    colors.forEach((fg) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.className = 'matrix-col-head';

      const dot = document.createElement('span');
      dot.className = 'head-dot';
      dot.style.backgroundColor = fg.hex;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = fg.name;

      th.append(dot, nameSpan);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    matrix.forEach((row, rowIdx) => {
      const bg = colors[rowIdx];
      const tr = document.createElement('tr');

      const rowHead = document.createElement('th');
      rowHead.scope = 'row';
      rowHead.className = 'matrix-row-head';

      const dot = document.createElement('span');
      dot.className = 'head-dot';
      dot.style.backgroundColor = bg.hex;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = bg.name;

      rowHead.append(dot, nameSpan);
      tr.appendChild(rowHead);

      row.forEach((cell) => {
        const td = document.createElement('td');
        if (cell.isSame) {
          td.className = 'matrix-cell-same';
          td.textContent = '—';
        } else if (!matchesFilter(cell)) {
          td.className = 'matrix-cell-dimmed';
          td.textContent = `${cell.ratio.toFixed(1)}:1`;
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `matrix-cell-btn cell-${cell.grade.toLowerCase().replace(/\s+/g, '-')}`;
          btn.style.backgroundColor = cell.bg.hex;
          btn.style.color = cell.fg.hex;
          btn.title = `${cell.fg.name} on ${cell.bg.name} — ${cell.ratio.toFixed(2)}:1 (${cell.grade})`;
          btn.setAttribute(
            'aria-label',
            `Inspect ${cell.fg.name} on ${cell.bg.name}: ratio ${cell.ratio.toFixed(2)} to 1, ${cell.grade}`
          );

          const sample = document.createElement('span');
          sample.className = 'cell-sample';
          sample.textContent = 'Aa';

          const ratioText = document.createElement('span');
          ratioText.className = 'cell-ratio';
          ratioText.textContent = `${cell.ratio.toFixed(2)}`;

          const gradeBadge = document.createElement('span');
          gradeBadge.className = 'cell-grade';
          gradeBadge.textContent = cell.grade;

          btn.append(sample, ratioText, gradeBadge);
          btn.addEventListener('click', () => {
            applyPair(cell.fg.hex, cell.bg.hex);
          });
          td.appendChild(btn);
        }
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    table.replaceChildren(thead, tbody);
  }

  // Color picker & hex input listeners
  get('fg-color')?.addEventListener('input', (e) => {
    get('fg-hex-input').value = e.target.value.toUpperCase();
    updatePairView();
  });

  get('bg-color')?.addEventListener('input', (e) => {
    get('bg-hex-input').value = e.target.value.toUpperCase();
    updatePairView();
  });

  get('fg-hex-input')?.addEventListener('input', () => {
    updatePairView();
  });

  get('bg-hex-input')?.addEventListener('input', () => {
    updatePairView();
  });

  get('fg-hex-input')?.addEventListener('change', (e) => {
    try {
      e.target.value = auditor.normalizeHex(e.target.value).toUpperCase();
      updatePairView();
    } catch {
      // keep user text so inline validation message remains visible
    }
  });

  get('bg-hex-input')?.addEventListener('change', (e) => {
    try {
      e.target.value = auditor.normalizeHex(e.target.value).toUpperCase();
      updatePairView();
    } catch {
      // keep user text so inline validation message remains visible
    }
  });

  // Swap colors
  get('swap-colors-btn')?.addEventListener('click', () => {
    const fg = get('fg-color').value;
    const bg = get('bg-color').value;
    applyPair(bg, fg);
  });

  // Auto-fix suggestions
  get('fix-aa-btn')?.addEventListener('click', () => {
    const suggested = auditor.suggestAccessibleColor(get('fg-color').value, get('bg-color').value, 4.5);
    if (suggested) {
      applyPair(suggested, get('bg-color').value);
    } else {
      setError('Cannot reach 4.5:1 AA contrast by adjusting foreground lightness against this background.');
    }
  });

  get('fix-aaa-btn')?.addEventListener('click', () => {
    const suggested = auditor.suggestAccessibleColor(get('fg-color').value, get('bg-color').value, 7.0);
    if (suggested) {
      applyPair(suggested, get('bg-color').value);
    } else {
      setError('Cannot reach 7.0:1 AAA contrast by adjusting foreground lightness against this background.');
    }
  });

  // High-contrast preview frame toggle
  get('toggle-frame-contrast-btn')?.addEventListener('click', (e) => {
    state.highContrastBorder = !state.highContrastBorder;
    e.currentTarget.setAttribute('aria-pressed', String(state.highContrastBorder));
    e.currentTarget.textContent = state.highContrastBorder
      ? 'High-Contrast Frame: ON'
      : 'High-Contrast Frame: OFF';
    updatePairView();
  });

  // Live custom sample text update
  get('sample-text-input')?.addEventListener('input', (e) => {
    const body = get('preview-body-copy');
    if (body) {
      body.textContent = e.target.value || DEFAULT_SAMPLE_COPY;
    }
  });

  // Quick BEAT-FORGE Music DAW Studio Presets
  get('preset-orchid-obsidian')?.addEventListener('click', () => applyPair('#E879F9', '#090A0F'));
  get('preset-cyan-obsidian')?.addEventListener('click', () => applyPair('#38BDF8', '#090A0F'));
  get('preset-white-console')?.addEventListener('click', () => applyPair('#F8FAFC', '#0F172A'));
  get('preset-low-contrast')?.addEventListener('click', () => applyPair('#D946EF', '#F8FAFC'));

  // Palette builder controls
  get('palette-add-btn')?.addEventListener('click', () => {
    if (state.palette.length >= 9) {
      setError('Palette matrix supports up to 9 swatches for readability.');
      return;
    }
    try {
      const hexInput = get('palette-new-color').value;
      const nameInput = get('palette-new-name').value.trim();
      const normalized = auditor.normalizeHex(hexInput).toUpperCase();
      if (state.palette.some((item) => item.hex.toUpperCase() === normalized)) {
        setError(`Swatch ${normalized} is already in the palette matrix.`);
        return;
      }
      state.palette.push({
        id: `custom-${Date.now()}`,
        name: nameInput || normalized,
        hex: normalized
      });
      get('palette-new-name').value = '';
      setError('');
      renderMatrix();
    } catch (err) {
      setError(err.message);
    }
  });

  get('palette-reset-btn')?.addEventListener('click', () => {
    state.palette = DEFAULT_DAW_PALETTE.map((item) => ({ ...item }));
    setError('');
    renderMatrix();
  });

  root.querySelectorAll('[data-matrix-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.matrixFilter = btn.getAttribute('data-matrix-filter') || 'all';
      root.querySelectorAll('[data-matrix-filter]').forEach((other) => {
        other.classList.toggle('is-active', other === btn);
        other.setAttribute('aria-pressed', String(other === btn));
      });
      renderMatrix();
    });
  });

  updatePairView();
  renderMatrix();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}
