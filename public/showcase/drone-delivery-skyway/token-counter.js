/**
 * Drone Delivery Skyway — Client-Side Tokenizer & Text Byte Length Meter
 * Issue #3794 - NSoC '26 Level 2 Feature
 *
 * Implements BPE-like heuristic tokenization, UTF-8 byte sizing, word counting,
 * character distribution analysis, and token density/budget threshold metering.
 */

const COMMON_PREFIXES = [
  'inter', 'trans', 'super', 'multi', 'under', 'micro', 'ultra',
  'over', 'anti', 'auto', 'semi', 'tele', 'aero', 'geo',
  'un', 're', 'in', 'im', 'dis', 'pre', 'pro', 'sub', 'non', 'mis'
];

const COMMON_SUFFIXES = [
  'ization', 'isation', 'ational', 'fulness',
  'ation', 'ition', 'ments', 'ingly', 'edly',
  'ment', 'ness', 'able', 'ible', 'tion', 'sion', 'ally',
  'less', 'ship', 'hood', 'ward', 'wise', 'izer', 'iser',
  'ity', 'ous', 'ful', 'ing', 'est', 'ers', 'ies', 'ied', 'ize', 'ise',
  'ed', 'ly', 'er', 'es'
];

const TOKEN_COLORS = Object.freeze([
  'token-c1',
  'token-c2',
  'token-c3',
  'token-c4',
  'token-c5'
]);

const CJK_CHAR_PATTERN = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]';
const EMOJI_PATTERN =
  '(?:[\\u{1F1E6}-\\u{1F1FF}]{2}|\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F|\\u200D\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?)*)';

const PRE_TOKEN_RE = new RegExp(
  [
    '\\r\\n|\\n|\\r',
    "['\\u2019](?:s|t|re|ve|m|ll|d)(?![\\p{L}\\p{N}])",
    EMOJI_PATTERN,
    CJK_CHAR_PATTERN,
    ' ?[\\p{Script=Latin}\\p{M}]+',
    ` ?(?:(?!${CJK_CHAR_PATTERN})\\p{L})(?:(?!${CJK_CHAR_PATTERN})[\\p{L}\\p{M}])*`,
    ' ?\\p{N}{1,3}',
    ' ?([^\\s\\p{L}\\p{N}\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}])\\1{0,2}',
    '[ \\t]+',
    '[^\\S\\r\\n]+',
    '.'
  ].join('|'),
  'giu'
);

const CONTRACTION_RE = /^['\u2019](?:s|t|re|ve|m|ll|d)$/i;
const EMOJI_OR_CJK_RE =
  /^(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/u;
const WORD_SEGMENT_RE = /^ ?\p{L}[\p{L}\p{M}]*$/u;
const NUMBER_SEGMENT_RE = /^ ?\p{N}+$/u;
const WHITESPACE_ONLY_RE = /^\s+$/u;

const DEFAULT_CONTEXT_LIMIT = 512;
const INITIAL_PILL_RENDER_LIMIT = 240;

const UTF8_ENCODER = new TextEncoder();

export const CONTEXT_BUDGETS = Object.freeze([
  { id: 'beacon-frame', label: 'Telemetry Beacon Frame (128 tok)', limit: 128 },
  { id: 'clearance-prompt', label: 'Flight Clearance Prompt (512 tok)', limit: 512 },
  { id: 'corridor-planner', label: 'Airspace Corridor Planner (4,096 tok)', limit: 4096 },
  { id: 'fleet-batch', label: 'Fleet Dispatch Batch (8,192 tok)', limit: 8192 }
]);

export const DRONE_TOKEN_PRESETS = Object.freeze([
  {
    id: 'dispatch',
    label: 'Flight Clearance',
    text:
      "SKYWAY-EXPRESS Clearance #DX-409: UAV-Alpha cleared for Corridor B4 at 180ft AGL. " +
      "Don't exceed 25kt headwind—payload 3.2kg medical parcel!"
  },
  {
    id: 'metar',
    label: 'METAR & Geofence',
    text:
      'METAR KSKY 281755Z 24014G22KT 10SM FEW035 18/09 A3012\n' +
      '[GEOFENCE-LOCK] Altitudes: 120ft-400ft AGL\n' +
      "Wait—we've rerouted around Sector-7 hospital helipad!"
  },
  {
    id: 'multilingual',
    label: 'Global Cargo & Emoji',
    text:
      '🚁 Corridor Express · 東京 / Zürich / São Paulo\n' +
      'Cargo: Cryo-Vial #A9 — Priority MedEvac 🔋⚡📦'
  },
  {
    id: 'burst',
    label: 'Threshold Stress Prompt',
    text: Array.from({ length: 8 }, (_, idx) =>
      `[Corridor ${idx + 1}] Evaluate autonomous drone dispatch telemetry across Skyway Airspace Sector 2026: ` +
      'verify anemometer wind gusts (18.4 kt, 24.1 kt), lithium battery discharge slopes, geofenced altitude corridors, ' +
      'and obstacle-avoidance lidar packet latency across North, Central, and Harbor vertiport relays.'
    ).join('\n')
  }
]);

function assertString(value, name = 'Text') {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
}

function splitWordSubwords(word) {
  const camelParts = word.split(
    /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u
  );
  const subwords = [];

  for (const part of camelParts) {
    let remaining = part;
    const codePoints = Array.from(remaining);

    if (codePoints.length <= 6) {
      subwords.push(remaining);
      continue;
    }

    const lower = remaining.toLowerCase();
    let prefix = '';
    for (const candidate of COMMON_PREFIXES) {
      if (lower.startsWith(candidate)) {
        const prefixLen = Array.from(candidate).length;
        if (codePoints.length - prefixLen >= 3) {
          prefix = codePoints.slice(0, prefixLen).join('');
          remaining = codePoints.slice(prefixLen).join('');
          break;
        }
      }
    }

    const remCodePoints = Array.from(remaining);
    const remLower = remaining.toLowerCase();
    let suffix = '';
    for (const candidate of COMMON_SUFFIXES) {
      if (remLower.endsWith(candidate)) {
        const suffixLen = Array.from(candidate).length;
        if (remCodePoints.length - suffixLen >= 3) {
          const splitAt = remCodePoints.length - suffixLen;
          suffix = remCodePoints.slice(splitAt).join('');
          remaining = remCodePoints.slice(0, splitAt).join('');
          break;
        }
      }
    }

    if (prefix) subwords.push(prefix);

    const stemCodePoints = Array.from(remaining);
    if (stemCodePoints.length <= 6) {
      if (remaining) subwords.push(remaining);
    } else {
      for (let i = 0; i < stemCodePoints.length; i += 4) {
        subwords.push(stemCodePoints.slice(i, i + 4).join(''));
      }
    }

    if (suffix) subwords.push(suffix);
  }

  return subwords;
}

function classifyTokenKind(token, isSubwordPiece) {
  if (WHITESPACE_ONLY_RE.test(token)) return 'whitespace';
  if (CONTRACTION_RE.test(token)) return 'contraction';
  if (NUMBER_SEGMENT_RE.test(token)) return 'number';
  if (EMOJI_OR_CJK_RE.test(token)) return 'unicode';
  if (WORD_SEGMENT_RE.test(token)) return isSubwordPiece ? 'subword' : 'word';
  return 'punctuation';
}

function formatVisibleWhitespace(text) {
  return text
    .replace(/\r\n/g, '↵')
    .replace(/[\r\n]/g, '↵')
    .replace(/\t/g, '⇥')
    .replace(/ /g, '␣');
}

function formatVisibleChar(char) {
  if (char === ' ') return '␣ (Space)';
  if (char === '\n') return '↵ (LF)';
  if (char === '\r') return '↵ (CR)';
  if (char === '\t') return '⇥ (Tab)';
  return char;
}

function bytesToHex(uint8Array) {
  return Array.from(uint8Array, byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export class DroneDeliverySkywayTokenAnalyzer {
  /**
   * Computes exact UTF-8 byte length of a string.
   * @param {string} text
   * @returns {number}
   */
  calculateByteSize(text) {
    assertString(text);
    return UTF8_ENCODER.encode(text).length;
  }

  /**
   * Counts whitespace-delimited words in a string.
   * @param {string} text
   * @returns {number}
   */
  getWordCount(text) {
    assertString(text);
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  /**
   * Internal shared tokenization pipeline returning raw token pieces and split flags.
   * @param {string} text
   * @returns {Array<{ text: string, isSubwordPiece: boolean }>}
   */
  #tokenizeSegments(text) {
    if (!text) return [];

    const segments = text.match(PRE_TOKEN_RE) || [];
    const output = [];

    for (const segment of segments) {
      if (WORD_SEGMENT_RE.test(segment)) {
        const hasLeadingSpace = segment.startsWith(' ');
        const word = hasLeadingSpace ? segment.slice(1) : segment;
        const pieces = splitWordSubwords(word);
        const isSplit = pieces.length > 1;
        if (hasLeadingSpace && pieces.length > 0) {
          pieces[0] = ` ${pieces[0]}`;
        }
        for (const piece of pieces) {
          output.push({ text: piece, isSubwordPiece: isSplit });
        }
      } else {
        output.push({ text: segment, isSubwordPiece: false });
      }
    }

    return output;
  }

  /**
   * Estimates LLM tokens using BPE-like pre-tokenization, numeric chunking,
   * contraction splitting, and subword affix/length heuristics.
   * Preserves lossless reconstruction: tokens.join('') === text.
   *
   * @param {string} text
   * @returns {{ count: number, tokens: string[] }}
   */
  estimateTokens(text) {
    assertString(text);
    const tokens = this.#tokenizeSegments(text).map(item => item.text);
    return {
      count: tokens.length,
      tokens
    };
  }

  /**
   * Returns rich per-token telemetry including UTF-8 byte size, hex encoding,
   * and token classification.
   *
   * @param {string} text
   * @returns {Array<{index: number, text: string, display: string, charLength: number, codePointLength: number, byteLength: number, utf8Hex: string, kind: string}>}
   */
  inspectTokens(text) {
    assertString(text);
    return this.#tokenizeSegments(text).map((item, index) => {
      const encoded = UTF8_ENCODER.encode(item.text);
      return {
        index,
        text: item.text,
        display: formatVisibleWhitespace(item.text),
        charLength: item.text.length,
        codePointLength: Array.from(item.text).length,
        byteLength: encoded.length,
        utf8Hex: bytesToHex(encoded),
        kind: classifyTokenKind(item.text, item.isSubwordPiece)
      };
    });
  }

  /**
   * Counts character occurrences over Unicode code points.
   * @param {string} text
   * @returns {Record<string, number>}
   */
  getCharacterFrequency(text) {
    assertString(text);
    const freq = {};
    for (const char of text) {
      freq[char] = Object.hasOwn(freq, char) ? freq[char] + 1 : 1;
    }
    return freq;
  }

  /**
   * Summarizes character categories, Unicode overhead, and top frequent characters.
   * @param {string} text
   * @param {number} [topLimit=12]
   */
  getCharacterDistribution(text, topLimit = 12) {
    assertString(text);
    if (typeof topLimit !== 'number' || !Number.isFinite(topLimit) || topLimit < 0) {
      throw new RangeError('topLimit must be a non-negative finite number');
    }

    const freq = this.getCharacterFrequency(text);
    const codePoints = Array.from(text);
    const totalCodePoints = codePoints.length;

    let letters = 0;
    let digits = 0;
    let whitespace = 0;
    let punctuation = 0;
    let symbols = 0;
    let nonAscii = 0;
    let multiByteChars = 0;

    for (const char of codePoints) {
      const cp = char.codePointAt(0);
      if (cp > 127) {
        nonAscii++;
        multiByteChars++;
      }

      if (/\p{L}/u.test(char)) {
        letters++;
      } else if (/\p{N}/u.test(char)) {
        digits++;
      } else if (/\s/u.test(char)) {
        whitespace++;
      } else if (/\p{P}/u.test(char)) {
        punctuation++;
      } else {
        symbols++;
      }
    }

    const lines = text.length === 0 ? 0 : text.split(/\r\n|\n|\r/).length;

    const topCharacters = Object.entries(freq)
      .map(([char, count]) => {
        const utf8Bytes = UTF8_ENCODER.encode(char).length;
        const cp = char.codePointAt(0);
        return {
          char,
          display: formatVisibleChar(char),
          count,
          percentage: totalCodePoints > 0 ? Number(((count / totalCodePoints) * 100).toFixed(1)) : 0,
          utf8Bytes,
          codePointHex: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
        };
      })
      .sort((a, b) => b.count - a.count || a.char.codePointAt(0) - b.char.codePointAt(0))
      .slice(0, Math.floor(topLimit));

    return {
      codeUnits: text.length,
      codePoints: totalCodePoints,
      letters,
      digits,
      whitespace,
      punctuation,
      symbols,
      nonAscii,
      multiByteChars,
      lines,
      uniqueChars: Object.keys(freq).length,
      topCharacters
    };
  }

  /**
   * Calculates token density metrics, token composition breakdown, and context budget thresholds.
   * Thresholds: nominal (< 70%), warning (70% - 89.9%), critical (>= 90%).
   *
   * @param {string} text
   * @param {number} [contextLimit=512]
   */
  getTokenDensity(text, contextLimit = DEFAULT_CONTEXT_LIMIT) {
    assertString(text);
    if (typeof contextLimit !== 'number' || !Number.isFinite(contextLimit) || contextLimit <= 0) {
      throw new RangeError('Context limit must be a positive finite number');
    }

    const tokenDetails = this.inspectTokens(text);
    const tokenCount = tokenDetails.length;
    const wordCount = this.getWordCount(text);
    const charCount = text.length;
    const codePointCount = Array.from(text).length;
    const byteSize = this.calculateByteSize(text);

    const kindBreakdown = {
      word: 0,
      subword: 0,
      number: 0,
      contraction: 0,
      punctuation: 0,
      whitespace: 0,
      unicode: 0
    };

    for (const detail of tokenDetails) {
      if (Object.hasOwn(kindBreakdown, detail.kind)) {
        kindBreakdown[detail.kind]++;
      }
    }

    const charsPerToken = tokenCount > 0 ? Number((charCount / tokenCount).toFixed(2)) : 0;
    const bytesPerToken = tokenCount > 0 ? Number((byteSize / tokenCount).toFixed(2)) : 0;
    const tokensPerWord = wordCount > 0 ? Number((tokenCount / wordCount).toFixed(2)) : 0;
    const utf8OverheadBytes = Math.max(0, byteSize - codePointCount);

    const rawUsagePercent = (tokenCount / contextLimit) * 100;
    const usagePercent = Number(rawUsagePercent.toFixed(1));

    let thresholdStatus = 'nominal';
    if (rawUsagePercent >= 90) {
      thresholdStatus = 'critical';
    } else if (rawUsagePercent >= 70) {
      thresholdStatus = 'warning';
    }

    return {
      tokenCount,
      wordCount,
      charCount,
      codePointCount,
      byteSize,
      charsPerToken,
      bytesPerToken,
      tokensPerWord,
      utf8OverheadBytes,
      contextLimit,
      usagePercent,
      thresholdStatus,
      kindBreakdown
    };
  }

  /**
   * Produces a unified analysis report for UI rendering or API inspection.
   * @param {string} text
   * @param {{ contextLimit?: number, topCharLimit?: number }} [options]
   */
  analyze(text, options = {}) {
    assertString(text);
    const contextLimit = options.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    const topCharLimit = options.topCharLimit ?? 12;

    const tokenDetails = this.inspectTokens(text);
    const tokens = tokenDetails.map(item => item.text);
    const distribution = this.getCharacterDistribution(text, topCharLimit);
    const density = this.getTokenDensity(text, contextLimit);

    return {
      tokens,
      tokenCount: tokens.length,
      tokenDetails,
      wordCount: density.wordCount,
      charCount: density.charCount,
      codePointCount: density.codePointCount,
      byteSize: density.byteSize,
      distribution,
      density
    };
  }
}

function setThresholdClass(el, status) {
  if (!el) return;
  el.classList.remove('threshold-nominal', 'threshold-warning', 'threshold-critical');
  el.classList.add(`threshold-${status}`);
}

function renderSegmentedBar(barEl, legendEl, total, segments) {
  if (!barEl || !legendEl) return;
  barEl.replaceChildren();
  legendEl.replaceChildren();

  if (total === 0) {
    const emptySeg = document.createElement('div');
    emptySeg.className = 'class-segment seg-empty';
    emptySeg.style.width = '100%';
    barEl.appendChild(emptySeg);
  } else {
    for (const seg of segments) {
      if (seg.count === 0) continue;
      const pct = (seg.count / total) * 100;
      const barPart = document.createElement('div');
      barPart.className = `class-segment ${seg.cls}`;
      barPart.style.width = `${pct.toFixed(2)}%`;
      barPart.title = `${seg.label}: ${seg.count} (${pct.toFixed(1)}%)`;
      barEl.appendChild(barPart);
    }
  }

  for (const seg of segments) {
    const pct = total > 0 ? ((seg.count / total) * 100).toFixed(1) : '0.0';
    const item = document.createElement('div');
    item.className = 'legend-chip';

    const dot = document.createElement('span');
    dot.className = `legend-dot ${seg.cls}`;

    const name = document.createElement('span');
    name.className = 'legend-name';
    name.textContent = seg.label;

    const val = document.createElement('span');
    val.className = 'legend-count';
    val.textContent = `${seg.count} (${pct}%)`;

    item.append(dot, name, val);
    legendEl.appendChild(item);
  }
}

export function mountTokenLab(rootOverride) {
  if (typeof document === 'undefined' && !rootOverride) return null;
  const root = rootOverride || document.querySelector('[data-token-lab]');
  if (!root) return null;

  const analyzer = new DroneDeliverySkywayTokenAnalyzer();

  const inputEl = root.querySelector('#token-input');
  const budgetSelectEl = root.querySelector('#context-budget-select');
  const showWhitespaceEl = root.querySelector('#toggle-whitespace');
  const clearBtn = root.querySelector('#clear-input-btn');
  const copyReportBtn = root.querySelector('#copy-report-btn');
  const presetBtns = Array.from(root.querySelectorAll('[data-preset-id]'));

  const tokenCountEl = root.querySelector('#count-tokens');
  const wordCountEl = root.querySelector('#count-words');
  const charCountEl = root.querySelector('#count-chars');
  const byteCountEl = root.querySelector('#count-bytes');

  const charSubEl = root.querySelector('#sub-chars');
  const byteSubEl = root.querySelector('#sub-bytes');
  const wordSubEl = root.querySelector('#sub-words');
  const tokenSubEl = root.querySelector('#sub-tokens');

  const tokenCardEl = root.querySelector('#card-tokens');
  const byteCardEl = root.querySelector('#card-bytes');

  const thresholdBadgeEl = root.querySelector('#threshold-badge');
  const budgetSummaryEl = root.querySelector('#budget-summary');
  const budgetFillEl = root.querySelector('#budget-progress-fill');
  const budgetTrackEl = root.querySelector('#budget-progress-track');

  const pillsWrapperEl = root.querySelector('#token-pills');
  const pillCountLabelEl = root.querySelector('#pill-count-label');
  const tokenInspectorEl = root.querySelector('#token-inspector');
  const toggleAllTokensBtn = root.querySelector('#toggle-all-tokens-btn');

  const densityCharsEl = root.querySelector('#density-chars-per-token');
  const densityBytesEl = root.querySelector('#density-bytes-per-token');
  const densityRatioEl = root.querySelector('#density-tokens-per-word');
  const densityOverheadEl = root.querySelector('#density-utf8-overhead');

  const tokenKindBarEl = root.querySelector('#token-kind-bar');
  const tokenKindLegendEl = root.querySelector('#token-kind-legend');
  const classBarEl = root.querySelector('#char-class-bar');
  const classLegendEl = root.querySelector('#char-class-legend');
  const charFreqListEl = root.querySelector('#char-freq-list');
  const uniqueCharsBadgeEl = root.querySelector('#unique-chars-badge');

  let showAllTokens = false;
  let selectedTokenIndex = null;
  let lastSnapshot = null;

  function renderTokenInspector(detail) {
    if (!tokenInspectorEl) return;
    tokenInspectorEl.replaceChildren();

    if (!detail) {
      const placeholder = document.createElement('span');
      placeholder.className = 'inspector-placeholder';
      placeholder.textContent = 'Hover or click any token pill to inspect raw text, UTF-8 byte size, and hex sequence.';
      tokenInspectorEl.appendChild(placeholder);
      return;
    }

    const pairs = [
      ['Token', `#${detail.index + 1}`],
      ['Slice', detail.display || '""'],
      ['Class', detail.kind.toUpperCase()],
      ['Bytes', `${detail.byteLength} B (${detail.codePointLength} cp)`],
      ['UTF-8 Hex', detail.utf8Hex]
    ];

    for (const [label, value] of pairs) {
      const chip = document.createElement('span');
      chip.className = 'inspector-chip';

      const k = document.createElement('span');
      k.className = 'inspector-key';
      k.textContent = label;

      const v = document.createElement('code');
      v.className = 'inspector-val';
      v.textContent = value;

      chip.append(k, v);
      tokenInspectorEl.appendChild(chip);
    }
  }

  function renderTokenComposition(density) {
    const kb = density.kindBreakdown;
    renderSegmentedBar(tokenKindBarEl, tokenKindLegendEl, density.tokenCount, [
      { label: 'Words', count: kb.word, cls: 'seg-word' },
      { label: 'Subwords', count: kb.subword, cls: 'seg-subword' },
      { label: 'Numbers', count: kb.number, cls: 'seg-number' },
      { label: 'Contractions', count: kb.contraction, cls: 'seg-contraction' },
      { label: 'Punctuation', count: kb.punctuation, cls: 'seg-punctuation' },
      { label: 'Whitespace', count: kb.whitespace, cls: 'seg-whitespace' },
      { label: 'Unicode / Emoji', count: kb.unicode, cls: 'seg-unicode' }
    ]);
  }

  function renderClassDistribution(distribution) {
    renderSegmentedBar(classBarEl, classLegendEl, distribution.codePoints, [
      { label: 'Letters', count: distribution.letters, cls: 'seg-letters' },
      { label: 'Digits', count: distribution.digits, cls: 'seg-digits' },
      { label: 'Whitespace', count: distribution.whitespace, cls: 'seg-whitespace' },
      { label: 'Punctuation', count: distribution.punctuation, cls: 'seg-punctuation' },
      { label: 'Symbols / Emoji', count: distribution.symbols, cls: 'seg-symbols' }
    ]);
  }

  function renderCharFrequency(distribution) {
    if (!charFreqListEl) return;
    charFreqListEl.replaceChildren();

    if (uniqueCharsBadgeEl) {
      uniqueCharsBadgeEl.textContent = `${distribution.uniqueChars} unique`;
    }

    if (distribution.topCharacters.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'Enter text above to inspect character and UTF-8 byte frequency distributions.';
      charFreqListEl.appendChild(empty);
      return;
    }

    const maxCount = distribution.topCharacters[0].count || 1;

    for (const item of distribution.topCharacters) {
      const row = document.createElement('div');
      row.className = 'freq-row';

      const glyph = document.createElement('code');
      glyph.className = 'freq-char';
      glyph.textContent = item.display;

      const track = document.createElement('div');
      track.className = 'freq-bar-track';

      const fill = document.createElement('div');
      fill.className = 'freq-bar-fill';
      fill.style.width = `${((item.count / maxCount) * 100).toFixed(1)}%`;
      track.appendChild(fill);

      const meta = document.createElement('span');
      meta.className = 'freq-meta';
      meta.textContent = `${item.count}\u00d7 (${item.percentage}%) \u00b7 ${item.utf8Bytes}B \u00b7 ${item.codePointHex}`;

      row.append(glyph, track, meta);
      charFreqListEl.appendChild(row);
    }
  }

  function renderPills(tokenDetails, preserveSelection) {
    if (!pillsWrapperEl) return;
    pillsWrapperEl.replaceChildren();

    const showMarkers = showWhitespaceEl ? showWhitespaceEl.checked : true;
    const total = tokenDetails.length;

    if (pillCountLabelEl) {
      pillCountLabelEl.textContent = `${total} token${total === 1 ? '' : 's'}`;
    }

    if (total === 0) {
      const empty = document.createElement('span');
      empty.className = 'empty-note';
      empty.textContent = 'Tokenized segments will appear here in real time.';
      pillsWrapperEl.appendChild(empty);
      if (toggleAllTokensBtn) toggleAllTokensBtn.hidden = true;
      selectedTokenIndex = null;
      renderTokenInspector(null);
      return;
    }

    const visibleList = showAllTokens
      ? tokenDetails
      : tokenDetails.slice(0, INITIAL_PILL_RENDER_LIMIT);

    for (const detail of visibleList) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const colorClass = TOKEN_COLORS[detail.index % TOKEN_COLORS.length];
      btn.className = `token-pill ${colorClass}`;
      if (detail.kind === 'whitespace') {
        btn.classList.add('is-whitespace');
      }
      if (selectedTokenIndex === detail.index) {
        btn.classList.add('is-selected');
      }
      btn.textContent = showMarkers ? detail.display : detail.text;
      btn.title = `Token #${detail.index + 1} (${detail.kind}) — ${detail.byteLength} UTF-8 bytes`;
      btn.setAttribute('aria-label', `Token ${detail.index + 1}: ${detail.display}, ${detail.byteLength} bytes`);

      btn.addEventListener('mouseenter', () => renderTokenInspector(detail));
      btn.addEventListener('focus', () => renderTokenInspector(detail));
      btn.addEventListener('click', () => {
        selectedTokenIndex = detail.index;
        for (const el of pillsWrapperEl.querySelectorAll('.token-pill.is-selected')) {
          el.classList.remove('is-selected');
        }
        btn.classList.add('is-selected');
        renderTokenInspector(detail);
      });

      pillsWrapperEl.appendChild(btn);
    }

    if (toggleAllTokensBtn) {
      if (total > INITIAL_PILL_RENDER_LIMIT) {
        toggleAllTokensBtn.hidden = false;
        toggleAllTokensBtn.textContent = showAllTokens
          ? `Collapse to ${INITIAL_PILL_RENDER_LIMIT}`
          : `Show all ${total} tokens (+${total - INITIAL_PILL_RENDER_LIMIT} hidden)`;
      } else {
        toggleAllTokensBtn.hidden = true;
      }
    }

    if (!preserveSelection || selectedTokenIndex === null || selectedTokenIndex >= total) {
      selectedTokenIndex = null;
      renderTokenInspector(null);
    } else {
      renderTokenInspector(tokenDetails[selectedTokenIndex]);
    }
  }

  function syncPresetHighlight(currentText) {
    for (const btn of presetBtns) {
      const preset = DRONE_TOKEN_PRESETS.find(p => p.id === btn.dataset.presetId);
      btn.classList.toggle('is-active', Boolean(preset && preset.text === currentText));
    }
  }

  function render(preserveSelection = false) {
    const text = inputEl ? inputEl.value : '';
    const contextLimit = budgetSelectEl ? Number(budgetSelectEl.value) || DEFAULT_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT;
    const snapshot = analyzer.analyze(text, { contextLimit });
    lastSnapshot = snapshot;

    const { density, distribution, tokenDetails } = snapshot;

    if (tokenCountEl) tokenCountEl.textContent = String(snapshot.tokenCount);
    if (wordCountEl) wordCountEl.textContent = String(snapshot.wordCount);
    if (charCountEl) charCountEl.textContent = String(snapshot.charCount);
    if (byteCountEl) byteCountEl.textContent = String(snapshot.byteSize);

    if (tokenSubEl) {
      tokenSubEl.textContent = `${density.usagePercent}% of ${density.contextLimit} limit`;
    }
    if (wordSubEl) {
      wordSubEl.textContent = `${distribution.lines} line${distribution.lines === 1 ? '' : 's'}`;
    }
    if (charSubEl) {
      charSubEl.textContent = `${snapshot.codePointCount} Unicode code pt${snapshot.codePointCount === 1 ? '' : 's'}`;
    }
    if (byteSubEl) {
      byteSubEl.textContent = distribution.multiByteChars > 0
        ? `+${density.utf8OverheadBytes}B multi-byte (${distribution.multiByteChars} chars)`
        : '100% single-byte ASCII';
    }

    setThresholdClass(root, density.thresholdStatus);
    setThresholdClass(tokenCardEl, density.thresholdStatus);
    setThresholdClass(byteCardEl, density.thresholdStatus);
    setThresholdClass(thresholdBadgeEl, density.thresholdStatus);
    setThresholdClass(budgetFillEl, density.thresholdStatus);

    if (thresholdBadgeEl) {
      if (density.thresholdStatus === 'critical') {
        thresholdBadgeEl.textContent =
          density.usagePercent > 100
            ? `CRITICAL \u00b7 OVERFLOW (${density.usagePercent}%)`
            : `CRITICAL >=90% (${density.usagePercent}%)`;
      } else if (density.thresholdStatus === 'warning') {
        thresholdBadgeEl.textContent = `WARNING 70\u201389% (${density.usagePercent}%)`;
      } else {
        thresholdBadgeEl.textContent = `NOMINAL <70% (${density.usagePercent}%)`;
      }
    }

    if (budgetSummaryEl) {
      const remaining = Math.max(0, density.contextLimit - snapshot.tokenCount);
      budgetSummaryEl.textContent = snapshot.tokenCount > density.contextLimit
        ? `${snapshot.tokenCount} / ${density.contextLimit} tokens (+${snapshot.tokenCount - density.contextLimit} over budget)`
        : `${snapshot.tokenCount} / ${density.contextLimit} tokens (${remaining} remaining)`;
    }

    if (budgetFillEl) {
      budgetFillEl.style.width = `${Math.min(100, density.usagePercent)}%`;
    }
    if (budgetTrackEl) {
      budgetTrackEl.setAttribute('aria-valuenow', String(Math.min(100, density.usagePercent)));
    }

    if (densityCharsEl) densityCharsEl.textContent = String(density.charsPerToken);
    if (densityBytesEl) densityBytesEl.textContent = String(density.bytesPerToken);
    if (densityRatioEl) densityRatioEl.textContent = String(density.tokensPerWord);
    if (densityOverheadEl) densityOverheadEl.textContent = `${density.utf8OverheadBytes} B`;

    syncPresetHighlight(text);
    renderPills(tokenDetails, preserveSelection);
    renderTokenComposition(density);
    renderClassDistribution(distribution);
    renderCharFrequency(distribution);
  }

  if (inputEl) {
    if (!inputEl.value) {
      inputEl.value = DRONE_TOKEN_PRESETS[0].text;
    }
    inputEl.addEventListener('input', () => {
      showAllTokens = false;
      render(false);
    });
  }

  if (budgetSelectEl) {
    budgetSelectEl.addEventListener('change', () => render(true));
  }

  if (showWhitespaceEl) {
    showWhitespaceEl.addEventListener('change', () => render(true));
  }

  if (toggleAllTokensBtn) {
    toggleAllTokensBtn.addEventListener('click', () => {
      showAllTokens = !showAllTokens;
      render(true);
    });
  }

  for (const btn of presetBtns) {
    btn.addEventListener('click', () => {
      const preset = DRONE_TOKEN_PRESETS.find(p => p.id === btn.dataset.presetId);
      if (preset && inputEl) {
        inputEl.value = preset.text;
        showAllTokens = false;
        render(false);
      }
    });
  }

  if (clearBtn && inputEl) {
    clearBtn.addEventListener('click', () => {
      inputEl.value = '';
      showAllTokens = false;
      render(false);
      inputEl.focus();
    });
  }

  if (copyReportBtn) {
    copyReportBtn.addEventListener('click', async () => {
      if (!lastSnapshot) return;
      const summary = JSON.stringify(
        {
          tokens: lastSnapshot.tokenCount,
          words: lastSnapshot.wordCount,
          characters: lastSnapshot.charCount,
          codePoints: lastSnapshot.codePointCount,
          utf8Bytes: lastSnapshot.byteSize,
          density: lastSnapshot.density
        },
        null,
        2
      );
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(summary);
          copyReportBtn.textContent = 'Copied Metrics!';
          copyReportBtn.classList.add('is-copied');
        } else {
          copyReportBtn.textContent = 'Clipboard Unavailable';
        }
        setTimeout(() => {
          copyReportBtn.textContent = 'Copy JSON Metrics';
          copyReportBtn.classList.remove('is-copied');
        }, 1600);
      } catch {
        copyReportBtn.textContent = 'Clipboard Unavailable';
        setTimeout(() => {
          copyReportBtn.textContent = 'Copy JSON Metrics';
        }, 1600);
      }
    });
  }

  render(false);
  return { analyzer, render };
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountTokenLab());
  } else {
    mountTokenLab();
  }
}
