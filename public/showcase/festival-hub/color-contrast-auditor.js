/**
 * Festival Hub — WCAG 2.1 Color Contrast Auditor
 *
 * Computes relative luminance and contrast ratios per WCAG 2.1,
 * evaluates compliance against AA (4.5:1) and AAA (7:1) thresholds
 * for normal and large text.
 *
 * No external dependencies; pure functions for testability.
 */

export const WCAG_THRESHOLDS = Object.freeze({
  AA_NORMAL: 4.5,
  AA_LARGE: 3.0,
  AAA_NORMAL: 7.0,
  AAA_LARGE: 4.5
});

export const CONTRAST_RATING = Object.freeze({
  FAIL: 'FAIL',
  AA: 'AA',
  AAA: 'AAA'
});

/**
 * Parse a hex color string (#RRGGBB, #RGB, RRGGBB, RGB) to [r, g, b] with values 0-255.
 * Throws on invalid format.
 */
export function parseHex(hex) {
  if (typeof hex !== 'string') {
    throw new TypeError('Color must be a string');
  }
  const cleaned = hex.trim().replace(/^#/, '');
  let r, g, b;

  if (cleaned.length === 3) {
    // #RGB shorthand
    r = parseInt(cleaned[0] + cleaned[0], 16);
    g = parseInt(cleaned[1] + cleaned[1], 16);
    b = parseInt(cleaned[2] + cleaned[2], 16);
  } else if (cleaned.length === 6) {
    // #RRGGBB
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else {
    throw new RangeError('Invalid hex color format. Use #RRGGBB, #RGB, RRGGBB, or RGB.');
  }

  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new RangeError('Invalid hex color: contains non-hex characters');
  }

  return [r, g, b];
}

/**
 * Convert sRGB 0-255 channel to linear RGB 0-1.
 * Per WCAG 2.1 / sRGB spec.
 */
function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Calculate relative luminance of an RGB color.
 * Returns value between 0 (darkest) and 1 (lightest).
 */
export function getLuminance(hex) {
  const [r, g, b] = parseHex(hex);
  const rLin = srgbToLinear(r);
  const gLin = srgbToLinear(g);
  const bLin = srgbToLinear(b);
  // WCAG 2.1 coefficients
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Calculate contrast ratio between foreground and background colors.
 * Returns ratio as a number (e.g., 4.5 for 4.5:1).
 * Throws on invalid hex colors.
 */
export function calculateRatio(fgHex, bgHex) {
  const l1 = getLuminance(fgHex);
  const l2 = getLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Evaluate WCAG 2.1 compliance for a given contrast ratio.
 * Returns an object with pass/fail for each level and text size.
 */
export function evaluateWcagCompliance(ratio) {
  const aaNormal = ratio >= WCAG_THRESHOLDS.AA_NORMAL;
  const aaLarge = ratio >= WCAG_THRESHOLDS.AA_LARGE;
  const aaaNormal = ratio >= WCAG_THRESHOLDS.AAA_NORMAL;
  const aaaLarge = ratio >= WCAG_THRESHOLDS.AAA_LARGE;

  // Overall rating: highest passing level
  // AA is achieved if either normal or large text passes AA threshold
  let rating;
  if (aaaNormal) rating = CONTRAST_RATING.AAA;
  else if (aaNormal || aaLarge) rating = CONTRAST_RATING.AA;
  else rating = CONTRAST_RATING.FAIL;

  return {
    aaNormal,
    aaLarge,
    aaaNormal,
    aaaLarge,
    rating,
    // Best text size classification
    textSize: ratio >= WCAG_THRESHOLDS.AA_LARGE ? 'large' : 'normal'
  };
}

/**
 * Get a human-readable compliance summary string.
 */
export function getComplianceLabel(compliance) {
  if (compliance.rating === CONTRAST_RATING.AAA) return 'AAA ✓';
  if (compliance.rating === CONTRAST_RATING.AA) return 'AA ✓';
  return 'FAIL ✗';
}

/**
 * Format contrast ratio for display (e.g., "4.52:1").
 */
export function formatRatio(ratio) {
  return `${ratio.toFixed(2)}:1`;
}

/**
 * Generate a palette contrast matrix for multiple colors.
 * Returns a 2D array of { fg, bg, ratio, compliance } objects.
 */
export function generateContrastMatrix(colors) {
  const matrix = [];
  for (const fg of colors) {
    const row = [];
    for (const bg of colors) {
      const ratio = calculateRatio(fg, bg);
      const compliance = evaluateWcagCompliance(ratio);
      row.push({ fg, bg, ratio, compliance });
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * Find the best foreground color (highest contrast) for a given background
 * from a list of candidate colors.
 */
export function findBestForeground(bgHex, candidates) {
  let best = null;
  let bestRatio = 0;
  for (const fg of candidates) {
    const ratio = calculateRatio(fg, bgHex);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = fg;
    }
  }
  return { color: best, ratio: bestRatio };
}

/**
 * FestivalHubContrastAuditor - Class wrapper for the auditor functionality.
 * Provides a clean OOP interface for the web UI.
 */
export class FestivalHubContrastAuditor {
  constructor() {
    // Stateless - all methods are pure
  }

  calculateRatio(fgHex, bgHex) {
    return calculateRatio(fgHex, bgHex);
  }

  getLuminance(hex) {
    return getLuminance(hex);
  }

  evaluateWcagCompliance(ratio) {
    return evaluateWcagCompliance(ratio);
  }

  formatRatio(ratio) {
    return formatRatio(ratio);
  }

  getComplianceLabel(compliance) {
    return getComplianceLabel(compliance);
  }

  generateContrastMatrix(colors) {
    return generateContrastMatrix(colors);
  }

  findBestForeground(bgHex, candidates) {
    return findBestForeground(bgHex, candidates);
  }
}

// Auto-mount demo UI if in browser
if (typeof document !== 'undefined') {
  const mount = () => mountContrastAuditorDemo();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

/**
 * Mount the interactive demo UI.
 * Returns the auditor instance for programmatic access.
 */
export function mountContrastAuditorDemo(root = document) {
  const $ = (id) => root.getElementById?.(id) ?? null;
  const auditor = new FestivalHubContrastAuditor();

  // Elements
  const els = {
    fgInput: $('fg-color'),
    bgInput: $('bg-color'),
    fgPreset: $('fg-preset'),
    bgPreset: $('bg-preset'),
    swapBtn: $('btn-swap'),
    sampleText: $('sample-text'),
    ratioValue: $('ratio-value'),
    aaNormal: $('aa-normal'),
    aaLarge: $('aa-large'),
    aaaNormal: $('aaa-normal'),
    aaaLarge: $('aaa-large'),
    complianceBadge: $('compliance-badge'),
    complianceLabel: $('compliance-label'),
    matrixContainer: $('matrix-container'),
    luminanceFg: $('luminance-fg'),
    luminanceBg: $('luminance-bg'),
    ratioHistory: $('ratio-history'),
    clearHistory: $('btn-clear-history')
  };

  if (!els.fgInput || !els.bgInput || !els.sampleText) return null;

  // Festival Hub color palette
  const palette = [
    '#0b0716', // deep space
    '#1a0d2e', // dark purple
    '#ec4899', // neon pink
    '#38bdf8', // cyan
    '#fde047', // yellow
    '#a855f7', // purple
    '#22d3ee', // light cyan
    '#f472b6', // light pink
    '#ffffff', // white
    '#e5e7eb', // light gray
    '#9ca3af', // medium gray
    '#6b7280'  // dark gray
  ];

  // Populate preset dropdowns
  const populatePresets = (select, defaultValue) => {
    select.innerHTML = '';
    for (const color of palette) {
      const opt = document.createElement('option');
      opt.value = color;
      opt.textContent = color.toUpperCase();
      if (color === defaultValue) opt.selected = true;
      select.appendChild(opt);
    }
  };

  populatePresets(els.fgPreset, '#ec4899');
  populatePresets(els.bgPreset, '#0b0716');

  // History storage
  const historyKey = 'festival-hub-contrast-history';
  let history = JSON.parse(localStorage.getItem(historyKey) || '[]');
  const MAX_HISTORY = 20;

  const saveHistory = () => {
    localStorage.setItem(historyKey, JSON.stringify(history));
  };

  const renderHistory = () => {
    els.ratioHistory.innerHTML = '';
    if (history.length === 0) {
      els.ratioHistory.innerHTML = '<li class="history-empty">No history yet</li>';
      return;
    }
    for (const entry of history.slice().reverse()) {
      const li = document.createElement('li');
      li.className = `history-entry ${entry.compliance.rating.toLowerCase()}`;
      li.innerHTML = `
        <span class="history-colors">
          <span class="history-swatch fg" style="background:${entry.fg}"></span>
          <span class="history-swatch bg" style="background:${entry.bg}"></span>
        </span>
        <span class="history-ratio">${entry.ratio}:1</span>
        <span class="history-badge ${entry.compliance.rating.toLowerCase()}">${entry.compliance.rating}</span>
        <span class="history-time">${entry.timestamp}</span>
      `;
      els.ratioHistory.appendChild(li);
    }
  };

  const addToHistory = (fg, bg, ratio, compliance) => {
    history.unshift({
      fg,
      bg,
      ratio: ratio.toFixed(2),
      compliance,
      timestamp: new Date().toLocaleTimeString()
    });
    if (history.length > MAX_HISTORY) history.pop();
    saveHistory();
    renderHistory();
  };

  const renderMatrix = () => {
    const matrix = auditor.generateContrastMatrix(palette);
    els.matrixContainer.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'contrast-matrix';

    // Header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th class="matrix-corner">FG \\ BG</th>' +
      palette.map(c => `<th><span class="matrix-swatch" style="background:${c}"></span>${c.toUpperCase()}</th>`).join('');
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    matrix.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th><span class="matrix-swatch" style="background:${palette[i]}"></span>${palette[i].toUpperCase()}</th>` +
        row.map(cell => {
          const badge = cell.compliance.rating;
          return `<td class="matrix-cell ${badge.toLowerCase()}" title="Ratio: ${cell.ratio.toFixed(2)}:1">
            <span class="matrix-ratio">${cell.ratio.toFixed(2)}</span>
            <span class="matrix-badge ${badge.toLowerCase()}">${badge}</span>
          </td>`;
        }).join('');
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    els.matrixContainer.appendChild(table);
  };

  const update = () => {
    const fg = els.fgInput.value;
    const bg = els.bgInput.value;

    // Sync presets if they match
    if (els.fgPreset.value !== fg) els.fgPreset.value = fg;
    if (els.bgPreset.value !== bg) els.bgPreset.value = bg;

    try {
      const ratio = auditor.calculateRatio(fg, bg);
      const compliance = auditor.evaluateWcagCompliance(ratio);
      const formatted = auditor.formatRatio(ratio);
      const label = auditor.getComplianceLabel(compliance);

      // Update sample text colors
      els.sampleText.style.color = fg;
      els.sampleText.style.backgroundColor = bg;

      // Update ratio display
      els.ratioValue.textContent = formatted;
      els.ratioValue.dataset.rating = compliance.rating.toLowerCase();

      // Update compliance chips
      const updateChip = (el, pass, label) => {
        el.classList.toggle('pass', pass);
        el.classList.toggle('fail', !pass);
        el.querySelector('.chip-label').textContent = label;
        el.querySelector('.chip-status').textContent = pass ? 'PASS' : 'FAIL';
      };

      updateChip(els.aaNormal, compliance.aaNormal, 'AA Normal (4.5:1)');
      updateChip(els.aaLarge, compliance.aaLarge, 'AA Large (3:1)');
      updateChip(els.aaaNormal, compliance.aaaNormal, 'AAA Normal (7:1)');
      updateChip(els.aaaLarge, compliance.aaaLarge, 'AAA Large (4.5:1)');

      // Update compliance badge
      els.complianceBadge.className = `compliance-badge ${compliance.rating.toLowerCase()}`;
      els.complianceLabel.textContent = label;

      // Update luminance values
      if (els.luminanceFg) els.luminanceFg.textContent = auditor.getLuminance(fg).toFixed(4);
      if (els.luminanceBg) els.luminanceBg.textContent = auditor.getLuminance(bg).toFixed(4);

      // Add to history
      addToHistory(fg, bg, ratio, compliance);

    } catch {
      els.ratioValue.textContent = 'Error';
      els.complianceLabel.textContent = 'Invalid color';
      els.complianceBadge.className = 'compliance-badge fail';
    }
  };

  // Event listeners
  els.fgInput.addEventListener('input', update);
  els.bgInput.addEventListener('input', update);

  els.fgPreset.addEventListener('change', () => {
    els.fgInput.value = els.fgPreset.value;
    update();
  });

  els.bgPreset.addEventListener('change', () => {
    els.bgInput.value = els.bgPreset.value;
    update();
  });

  els.swapBtn?.addEventListener('click', () => {
    const temp = els.fgInput.value;
    els.fgInput.value = els.bgInput.value;
    els.bgInput.value = temp;
    update();
  });

  els.clearHistory?.addEventListener('click', () => {
    history = [];
    saveHistory();
    renderHistory();
  });

  // Initialize
  update();
  renderMatrix();
  renderHistory();

  // Expose for console debugging
  if (typeof window !== 'undefined') window.festivalHubContrastAuditor = auditor;

  return auditor;
}