/**
 * Charity Microloans (MICRO-IMPACT) — Cron Schedule Expression Builder & Next-Run Visualizer
 * Issue #3788 - NSoC '26 Level 2 Feature
 *
 * Parses standard 5-part cron expressions (minute hour day-of-month month day-of-week),
 * translates schedules into natural English, and forecasts chronological execution timestamps.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

const MONTH_ALIASES = Object.freeze({
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
});

const WEEKDAY_ALIASES = Object.freeze({
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6
});

const FIELD_DEFINITIONS = Object.freeze([
  {
    key: 'minute',
    label: 'Minute',
    shortLabel: 'MIN',
    min: 0,
    max: 59,
    guide: '0–59 · Examples: * (every minute), 0, */15 (every 15m), 0,30',
    examples: ['*', '0', '*/5', '*/15', '0,30']
  },
  {
    key: 'hour',
    label: 'Hour',
    shortLabel: 'HR',
    min: 0,
    max: 23,
    guide: '0–23 · Examples: * (every hour), 9 (09:00), */6 (every 6h), 9-17',
    examples: ['*', '0', '9', '*/6', '9-17', '14,18']
  },
  {
    key: 'day',
    label: 'Day',
    shortLabel: 'DOM',
    min: 1,
    max: 31,
    guide: '1–31 · Examples: * (every day), 1 (1st), 1,15, */2 (every 2nd day)',
    examples: ['*', '1', '15', '1,15', '1-7']
  },
  {
    key: 'month',
    label: 'Month',
    shortLabel: 'MON',
    min: 1,
    max: 12,
    aliases: MONTH_ALIASES,
    guide: '1–12 or JAN–DEC · Examples: * (every month), 1,6,12, JAN-MAR',
    examples: ['*', '1', 'JAN-MAR', '6,12', '*/3']
  },
  {
    key: 'weekday',
    label: 'Weekday',
    shortLabel: 'DOW',
    min: 0,
    max: 7,
    aliases: WEEKDAY_ALIASES,
    sundayIsSeven: true,
    guide: '0–6 (0/7 = Sun) or SUN–SAT · Examples: * (all), 1-5 (weekdays), 5-7',
    examples: ['*', '1-5', '0,6', '5-7', 'MON,THU']
  }
]);

const DEFAULT_EXPRESSION = '30 14 * * 1-5';
const MAX_FORECAST_YEARS = 20;
const MAX_RUN_LIMIT = 500;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(hour, minute) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

function joinNaturalList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function ordinal(num) {
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  switch (num % 10) {
    case 1: return `${num}st`;
    case 2: return `${num}nd`;
    case 3: return `${num}rd`;
    default: return `${num}th`;
  }
}

function isContiguous(values) {
  return values.every((val, idx) => idx === 0 || val === values[idx - 1] + 1);
}

function classifyToken(token) {
  if (token === '*') return 'wildcard';
  if (token.includes('/')) return 'step';
  if (token.includes(',')) return 'list';
  if (token.includes('-')) return 'range';
  if (/^[A-Za-z]+$/.test(token)) return 'alias';
  return 'fixed';
}

export class CharityMicroloansCronParser {
  #splitTokens(cronStr) {
    if (typeof cronStr !== 'string') {
      throw new TypeError('Cron expression must be a string');
    }
    const trimmed = cronStr.trim();
    const tokens = trimmed === '' ? [] : trimmed.split(/\s+/);
    if (tokens.length !== 5) {
      throw new Error(`Expected exactly 5 cron fields, received ${tokens.length}`);
    }
    return tokens;
  }

  #parseAtomicValue(raw, field) {
    const token = raw.trim();
    if (!token) {
      throw new Error(`Empty value in ${field.label} field`);
    }

    if (field.aliases) {
      const upper = token.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(field.aliases, upper)) {
        return field.aliases[upper];
      }
    }

    if (!/^\d+$/.test(token)) {
      throw new Error(`Invalid value "${token}" in ${field.label} field`);
    }

    const num = Number(token);
    if (num < field.min || num > field.max) {
      throw new Error(`Value ${token} out of range [${field.min}, ${field.max}] in ${field.label} field`);
    }
    return num;
  }

  #normalizeFieldValue(value, field) {
    return field.sundayIsSeven && value === 7 ? 0 : value;
  }

  #parseField(token, field) {
    const raw = String(token).trim();
    if (!raw) {
      throw new Error(`${field.label} field cannot be empty`);
    }

    const values = new Set();
    const chunks = raw.split(',');

    for (const chunk of chunks) {
      const part = chunk.trim();
      if (!part) {
        throw new Error(`Invalid list syntax "${raw}" in ${field.label} field`);
      }

      const stepParts = part.split('/');
      if (stepParts.length > 2) {
        throw new Error(`Invalid step syntax "${part}" in ${field.label} field`);
      }

      let step = 1;
      if (stepParts.length === 2) {
        const stepStr = stepParts[1].trim();
        if (!/^\d+$/.test(stepStr) || Number(stepStr) < 1) {
          throw new Error(`Invalid step "${part}" in ${field.label} field`);
        }
        step = Number(stepStr);
      }

      const base = stepParts[0].trim();
      if (!base) {
        throw new Error(`Invalid step base "${part}" in ${field.label} field`);
      }

      let start;
      let end;

      if (base === '*') {
        start = field.min;
        end = field.max;
      } else if (base.includes('-')) {
        const bounds = base.split('-');
        if (bounds.length !== 2) {
          throw new Error(`Invalid range "${base}" in ${field.label} field`);
        }
        start = this.#parseAtomicValue(bounds[0], field);
        end = this.#parseAtomicValue(bounds[1], field);
        if (start > end) {
          throw new Error(`Backwards range "${base}" in ${field.label} field`);
        }
      } else {
        start = this.#parseAtomicValue(base, field);
        end = stepParts.length === 2 ? field.max : start;
      }

      for (let v = start; v <= end; v += step) {
        values.add(this.#normalizeFieldValue(v, field));
      }
    }

    return Array.from(values).sort((a, b) => a - b);
  }

  /**
   * Parses a standard 5-part cron string into sorted integer arrays per field.
   * @param {string} cronStr
   * @returns {{ minutes: number[], hours: number[], daysOfMonth: number[], months: number[], daysOfWeek: number[], original: string }}
   */
  parseExpression(cronStr) {
    const tokens = this.#splitTokens(cronStr);
    const [minTok, hourTok, domTok, monTok, dowTok] = tokens;

    return {
      minutes: this.#parseField(minTok, FIELD_DEFINITIONS[0]),
      hours: this.#parseField(hourTok, FIELD_DEFINITIONS[1]),
      daysOfMonth: this.#parseField(domTok, FIELD_DEFINITIONS[2]),
      months: this.#parseField(monTok, FIELD_DEFINITIONS[3]),
      daysOfWeek: this.#parseField(dowTok, FIELD_DEFINITIONS[4]),
      original: cronStr
    };
  }

  /**
   * Inspects each individual field token, returning parsed values or per-field errors.
   * @param {string[]} tokens
   * @returns {Array<{ key: string, label: string, shortLabel: string, token: string, kind: string, valid: boolean, values: number[], error: string|null }>}
   */
  inspectFields(tokens) {
    return FIELD_DEFINITIONS.map((field, index) => {
      const token = String(tokens[index] ?? '').trim();
      try {
        const values = this.#parseField(token, field);
        return {
          key: field.key,
          label: field.label,
          shortLabel: field.shortLabel,
          token,
          kind: classifyToken(token),
          valid: true,
          values,
          error: null
        };
      } catch (err) {
        return {
          key: field.key,
          label: field.label,
          shortLabel: field.shortLabel,
          token,
          kind: 'invalid',
          valid: false,
          values: [],
          error: err.message
        };
      }
    });
  }

  #describeHoursSpan(hours) {
    if (hours.length === 1) {
      return `during the ${formatTime(hours[0], 0)} hour`;
    }
    if (hours.length >= 3 && isContiguous(hours)) {
      return `from ${formatTime(hours[0], 0)} to ${formatTime(hours[hours.length - 1], 0)}`;
    }
    return `during hours ${joinNaturalList(hours.map(h => formatTime(h, 0)))}`;
  }

  #describeTime(parsed, tokens) {
    const [minTok, hourTok] = tokens;
    const { minutes, hours } = parsed;

    const minWildcard = minTok === '*';
    const hourWildcard = hourTok === '*';
    const minStepMatch = /^\*\/(\d+)$/.exec(minTok);
    const hourStepMatch = /^\*\/(\d+)$/.exec(hourTok);

    if (minWildcard && hourWildcard) {
      return 'Every minute';
    }

    if (minStepMatch && hourWildcard) {
      const step = Number(minStepMatch[1]);
      return step === 1 ? 'Every minute' : `Every ${step} minutes`;
    }

    if (minWildcard) {
      return `Every minute ${this.#describeHoursSpan(hours)}`;
    }

    if (hourWildcard) {
      if (minutes.length === 1) {
        return minutes[0] === 0
          ? 'Every hour'
          : `At minute ${minutes[0]} of every hour`;
      }
      return `At minutes ${joinNaturalList(minutes.map(String))} of every hour`;
    }

    if (minStepMatch) {
      const step = Number(minStepMatch[1]);
      const base = step === 1 ? 'Every minute' : `Every ${step} minutes`;
      return `${base} ${this.#describeHoursSpan(hours)}`;
    }

    if (hourStepMatch && minutes.length === 1) {
      const step = Number(hourStepMatch[1]);
      const hourPart = step === 1 ? 'Every hour' : `Every ${step} hours`;
      return minutes[0] === 0 ? `${hourPart}, at minute 0` : `${hourPart}, at minute ${minutes[0]}`;
    }

    if (minutes.length === 1 && hours.length === 1) {
      return `At ${formatTime(hours[0], minutes[0])}`;
    }

    if (minutes.length * hours.length <= 8) {
      const times = [];
      for (const h of hours) {
        for (const m of minutes) {
          times.push(formatTime(h, m));
        }
      }
      return `At ${joinNaturalList(times)}`;
    }

    if (minutes.length === 1) {
      return `At minute ${minutes[0]} ${this.#describeHoursSpan(hours)}`;
    }

    return `At minutes ${joinNaturalList(minutes.map(String))} ${this.#describeHoursSpan(hours)}`;
  }

  #describeDayNumbers(days, domTok) {
    const stepMatch = /^\*\/(\d+)$/.exec(domTok);
    if (stepMatch && Number(stepMatch[1]) > 1) {
      return `every ${Number(stepMatch[1])} days starting on the 1st`;
    }
    if (days.length >= 3 && isContiguous(days)) {
      return `the ${ordinal(days[0])}–${ordinal(days[days.length - 1])}`;
    }
    if (days.length > 8) {
      return `${days.length} selected days (${ordinal(days[0])}, ${ordinal(days[1])}, … ${ordinal(days[days.length - 1])})`;
    }
    return `the ${joinNaturalList(days.map(ordinal))}`;
  }

  #describeWeekdays(days) {
    if (days.length === 5 && days.every(d => d >= 1 && d <= 5)) {
      return 'weekdays';
    }
    if (days.length === 2 && days.includes(0) && days.includes(6)) {
      return 'weekends';
    }
    const plural = days.map(d => `${WEEKDAY_NAMES[d]}s`);
    if (plural.length >= 3 && isContiguous(days)) {
      return `${plural[0]} through ${plural[plural.length - 1]}`;
    }
    // Handle week-wrap ranges such as Fri-Sun (5-7 -> [0, 5, 6]).
    if (days.length >= 3 && days[0] === 0) {
      const sundayLast = [...days.slice(1), 7];
      if (isContiguous(sundayLast)) {
        return `${WEEKDAY_NAMES[sundayLast[0]]}s through Sundays`;
      }
    }
    return joinNaturalList(plural);
  }

  #describeMonths(months) {
    if (months.length >= 3 && isContiguous(months)) {
      return `${MONTH_NAMES[months[0] - 1]} through ${MONTH_NAMES[months[months.length - 1] - 1]}`;
    }
    return joinNaturalList(months.map(m => MONTH_NAMES[m - 1]));
  }

  #describeDate(parsed, tokens, timePhrase) {
    const [, , domTok, monTok, dowTok] = tokens;
    const domRestricted = domTok !== '*';
    const monRestricted = monTok !== '*';
    const dowRestricted = dowTok !== '*';

    const domCoversAll = parsed.daysOfMonth.length === 31;
    const dowCoversAll = parsed.daysOfWeek.length === 7;
    const runsEveryDay =
      (!domRestricted && !dowRestricted) ||
      (domRestricted && domCoversAll && !dowRestricted) ||
      (dowRestricted && dowCoversAll && !domRestricted) ||
      (domRestricted && dowRestricted && (domCoversAll || dowCoversAll));

    const recursWithinDay = timePhrase.startsWith('Every ') || timePhrase.includes('of every hour');

    if (runsEveryDay) {
      if (!monRestricted) {
        return recursWithinDay ? '' : 'every day';
      }
      return recursWithinDay
        ? `in ${this.#describeMonths(parsed.months)}`
        : `every day in ${this.#describeMonths(parsed.months)}`;
    }

    if (domRestricted && dowRestricted) {
      const domPhrase = this.#describeDayNumbers(parsed.daysOfMonth, domTok);
      const dayClause = domPhrase.startsWith('every ')
        ? domPhrase
        : `on ${domPhrase} of the month`;
      const base = `${dayClause} or on ${this.#describeWeekdays(parsed.daysOfWeek)}`;
      return monRestricted ? `${base} in ${this.#describeMonths(parsed.months)}` : base;
    }

    if (domRestricted) {
      const domPhrase = this.#describeDayNumbers(parsed.daysOfMonth, domTok);
      if (domPhrase.startsWith('every ')) {
        return monRestricted
          ? `${domPhrase} in ${this.#describeMonths(parsed.months)}`
          : domPhrase;
      }
      return monRestricted
        ? `on ${domPhrase} of ${this.#describeMonths(parsed.months)}`
        : `on ${domPhrase} of every month`;
    }

    const weekdayPart = `on ${this.#describeWeekdays(parsed.daysOfWeek)}`;
    return monRestricted
      ? `${weekdayPart} in ${this.#describeMonths(parsed.months)}`
      : weekdayPart;
  }

  /**
   * Translates a 5-part cron expression into a natural English description.
   * @param {string} cronStr
   * @returns {string}
   */
  toHumanReadable(cronStr) {
    const parsed = this.parseExpression(cronStr);
    const tokens = this.#splitTokens(cronStr);
    const canonical = tokens.join(' ');

    if (canonical === '* * * * *') return 'Every minute of every day';
    if (canonical === '0 * * * *') return 'Every hour, at minute 0';

    const minStepOnly = /^\*\/(\d+)$/.exec(tokens[0]);
    if (
      minStepOnly &&
      tokens[1] === '*' &&
      tokens[2] === '*' &&
      tokens[3] === '*' &&
      tokens[4] === '*'
    ) {
      const step = Number(minStepOnly[1]);
      return step === 1 ? 'Every minute of every day' : `Every ${step} minutes`;
    }

    const hourStepOnly = /^\*\/(\d+)$/.exec(tokens[1]);
    if (
      tokens[0] === '0' &&
      hourStepOnly &&
      tokens[2] === '*' &&
      tokens[3] === '*' &&
      tokens[4] === '*'
    ) {
      const step = Number(hourStepOnly[1]);
      return step === 1 ? 'Every hour, at minute 0' : `Every ${step} hours, at minute 0`;
    }

    const timePhrase = this.#describeTime(parsed, tokens);
    const datePhrase = this.#describeDate(parsed, tokens, timePhrase);
    return datePhrase ? `${timePhrase} ${datePhrase}` : timePhrase;
  }

  /**
   * Calculates the next `count` execution Date instances strictly after `startDate`.
   * Uses standard cron OR semantics when both Day-of-Month and Weekday are restricted.
   * @param {string} cronStr
   * @param {number} [count=5]
   * @param {Date|string|number} [startDate=new Date()]
   * @returns {Date[]}
   */
  getNextExecutionDates(cronStr, count = 5, startDate = new Date()) {
    const parsed = this.parseExpression(cronStr);
    const tokens = this.#splitTokens(cronStr);

    const requested = Number(count);
    if (!Number.isFinite(requested) || requested <= 0) {
      return [];
    }
    const limit = Math.min(Math.floor(requested), MAX_RUN_LIMIT);

    const anchor = startDate instanceof Date
      ? new Date(startDate.getTime())
      : new Date(startDate);
    if (Number.isNaN(anchor.getTime())) {
      throw new TypeError('Start date must be a valid Date');
    }

    // Earliest eligible timestamp is the next whole minute strictly after anchor.
    const minEligible = new Date(anchor.getTime());
    minEligible.setSeconds(0, 0);
    minEligible.setMinutes(minEligible.getMinutes() + 1);
    const minEligibleMs = minEligible.getTime();

    const daySet = new Set(parsed.daysOfMonth);
    const monthSet = new Set(parsed.months);
    const weekdaySet = new Set(parsed.daysOfWeek);

    const domRestricted = tokens[2] !== '*';
    const dowRestricted = tokens[4] !== '*';

    const cursor = new Date(minEligible.getFullYear(), minEligible.getMonth(), minEligible.getDate());
    const maxYear = minEligible.getFullYear() + MAX_FORECAST_YEARS;
    const results = [];

    while (results.length < limit && cursor.getFullYear() <= maxYear) {
      const month = cursor.getMonth() + 1;
      if (!monthSet.has(month)) {
        cursor.setDate(1);
        cursor.setMonth(cursor.getMonth() + 1);
        continue;
      }

      const domMatches = daySet.has(cursor.getDate());
      const dowMatches = weekdaySet.has(cursor.getDay());
      const dateMatches = domRestricted && dowRestricted
        ? domMatches || dowMatches
        : domMatches && dowMatches;

      if (!dateMatches) {
        cursor.setDate(cursor.getDate() + 1);
        continue;
      }

      const year = cursor.getFullYear();
      const monthIdx = cursor.getMonth();
      const dayOfMonth = cursor.getDate();

      for (const hour of parsed.hours) {
        for (const minute of parsed.minutes) {
          const candidate = new Date(year, monthIdx, dayOfMonth, hour, minute, 0, 0);
          // Skip nonexistent timestamps jumped over by DST transitions.
          if (
            candidate.getHours() === hour &&
            candidate.getMinutes() === minute &&
            candidate.getTime() >= minEligibleMs
          ) {
            results.push(candidate);
            if (results.length >= limit) {
              return results;
            }
          }
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    return results;
  }
}

function formatRelativeTime(targetDate, nowDate = new Date()) {
  const diffMs = targetDate.getTime() - nowDate.getTime();
  const absMs = Math.abs(diffMs);

  if (absMs < 60_000) {
    const secs = Math.max(1, Math.round(diffMs / 1000));
    return `in ${secs}s`;
  }
  if (absMs < 3_600_000) {
    const mins = Math.round(diffMs / 60_000);
    return `in ${mins}m`;
  }
  if (absMs < 86_400_000) {
    const totalMins = Math.round(diffMs / 60_000);
    const hrs = Math.floor(totalMins / 60);
    const remMins = totalMins % 60;
    return remMins > 0 ? `in ${hrs}h ${remMins}m` : `in ${hrs}h`;
  }
  const days = Math.round(diffMs / 86_400_000);
  return days === 1 ? 'in 1 day' : `in ${days} days`;
}

function formatDeltaBetweenRuns(prevDate, nextDate) {
  const diffMs = nextDate.getTime() - prevDate.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `+${mins}m`;
  const hrs = diffMs / 3_600_000;
  if (hrs < 48) return `+${Number(hrs.toFixed(1))}h`;
  const days = diffMs / 86_400_000;
  return `+${Number(days.toFixed(1))}d`;
}

function formatFieldSummary(inspection) {
  if (!inspection.valid) return 'Invalid';
  if (inspection.kind === 'wildcard') return 'Every';
  const count = inspection.values.length;
  if (count === 1) {
    if (inspection.key === 'month') return MONTH_NAMES[inspection.values[0] - 1].slice(0, 3);
    if (inspection.key === 'weekday') return WEEKDAY_NAMES[inspection.values[0]].slice(0, 3);
    return inspection.key === 'hour' ? `${pad2(inspection.values[0])}:00` : String(inspection.values[0]);
  }
  return `${count} values`;
}

function resolveCadenceLabel(parsed) {
  const perDay = parsed.minutes.length * parsed.hours.length;
  const monthFactor = parsed.months.length / 12;
  if (perDay >= 1440 && parsed.daysOfMonth.length === 31 && parsed.months.length === 12) {
    return 'Every minute';
  }
  if (perDay >= 24) {
    return `${perDay} runs/active day`;
  }
  if (monthFactor < 1) {
    return `${parsed.months.length} active mo/yr`;
  }
  return perDay === 1 ? '1 run/active day' : `${perDay} runs/active day`;
}

function mountCronParserUI() {
  const root = document.querySelector('[data-cron-lab]');
  if (!root) return;

  const parser = new CharityMicroloansCronParser();

  const fieldInputs = FIELD_DEFINITIONS.map(def => ({
    def,
    card: root.querySelector(`[data-field-card="${def.key}"]`),
    input: root.querySelector(`#cron-${def.key}`)
  })).filter(entry => entry.card && entry.input);

  if (fieldInputs.length !== 5) return;

  const fullExprInput = root.querySelector('#full-expression-input');
  const tokenBar = root.querySelector('#cron-tokens');
  const guideText = root.querySelector('#field-guide-text');
  const guideExamples = root.querySelector('#field-guide-examples');
  const errorBox = root.querySelector('#cron-error');
  const humanOutput = root.querySelector('#cron-human');
  const breakdownGrid = root.querySelector('#field-breakdown');
  const nextCountdown = root.querySelector('#next-countdown');
  const cadenceBadge = root.querySelector('#cadence-badge');
  const timezoneLabel = root.querySelector('#timezone-label');
  const runsList = root.querySelector('#next-runs');
  const emptyRunsNote = root.querySelector('#runs-empty-note');
  const runCountSelect = root.querySelector('#run-count-select');
  const refreshBtn = root.querySelector('#refresh-runs-btn');
  const resetBtn = root.querySelector('#reset-expression-btn');
  const copyBtn = root.querySelector('#copy-expression-btn');
  const presetBtns = Array.from(root.querySelectorAll('.preset-btn'));

  let activeFieldIndex = 0;

  if (timezoneLabel) {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) timezoneLabel.textContent = tz;
    } catch {
      timezoneLabel.textContent = 'Local Time';
    }
  }

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  function currentTokens() {
    return fieldInputs.map(entry => entry.input.value.trim() || '');
  }

  function syncPresetHighlight(expr) {
    presetBtns.forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.cron === expr);
    });
  }

  function renderFieldGuide(index) {
    const def = FIELD_DEFINITIONS[index];
    if (!def) return;
    if (guideText) {
      guideText.textContent = `${def.label} (${def.shortLabel}): ${def.guide}`;
    }
    if (guideExamples) {
      guideExamples.replaceChildren();
      def.examples.forEach(example => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'guide-example-chip';
        chip.textContent = example;
        chip.title = `Insert "${example}" into ${def.label}`;
        chip.addEventListener('click', () => {
          fieldInputs[index].input.value = example;
          fieldInputs[index].input.focus();
          render();
        });
        guideExamples.appendChild(chip);
      });
    }
  }

  function setFocusedField(index) {
    activeFieldIndex = index;
    fieldInputs.forEach((entry, idx) => {
      entry.card.classList.toggle('is-focused', idx === index);
    });
    if (tokenBar) {
      Array.from(tokenBar.children).forEach((pill, idx) => {
        pill.classList.toggle('is-focused', idx === index);
      });
    }
    if (breakdownGrid) {
      Array.from(breakdownGrid.children).forEach((chip, idx) => {
        chip.classList.toggle('is-focused', idx === index);
      });
    }
    renderFieldGuide(index);
  }

  function applyExpression(cronStr) {
    const parts = String(cronStr).trim().split(/\s+/);
    if (parts.length !== 5) return;
    parts.forEach((part, idx) => {
      fieldInputs[idx].input.value = part;
    });
    render();
  }

  function renderTokenPillsAndBreakdown(inspections) {
    if (tokenBar) {
      tokenBar.replaceChildren();
      inspections.forEach((item, idx) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = `token-pill token-${item.kind}${idx === activeFieldIndex ? ' is-focused' : ''}`;
        pill.title = item.valid
          ? `${item.label}: ${item.values.length} matching value(s)`
          : `${item.label}: ${item.error}`;

        const labelSpan = document.createElement('span');
        labelSpan.className = 'token-pill-label';
        labelSpan.textContent = item.shortLabel;

        const valSpan = document.createElement('span');
        valSpan.className = 'token-pill-value';
        valSpan.textContent = item.token || '∅';

        pill.append(labelSpan, valSpan);
        pill.addEventListener('click', () => {
          fieldInputs[idx].input.focus();
          setFocusedField(idx);
        });
        tokenBar.appendChild(pill);
      });
    }

    if (breakdownGrid) {
      breakdownGrid.replaceChildren();
      inspections.forEach((item, idx) => {
        const chip = document.createElement('div');
        chip.className = `breakdown-chip${idx === activeFieldIndex ? ' is-focused' : ''}${item.valid ? '' : ' is-invalid'}`;

        const label = document.createElement('span');
        label.className = 'breakdown-label';
        label.textContent = item.label;

        const val = document.createElement('strong');
        val.className = 'breakdown-value';
        val.textContent = formatFieldSummary(item);

        chip.append(label, val);
        breakdownGrid.appendChild(chip);
      });
    }
  }

  function render(syncFullInput = true) {
    const tokens = currentTokens();
    const expr = tokens.join(' ');

    if (syncFullInput && fullExprInput) {
      fullExprInput.value = expr;
    }
    syncPresetHighlight(expr);

    const inspections = parser.inspectFields(tokens);
    fieldInputs.forEach((entry, idx) => {
      entry.card.classList.toggle('is-invalid', !inspections[idx].valid);
    });
    renderTokenPillsAndBreakdown(inspections);

    const firstInvalid = inspections.find(item => !item.valid);
    if (firstInvalid) {
      if (errorBox) {
        errorBox.textContent = firstInvalid.error;
        errorBox.hidden = false;
      }
      if (humanOutput) {
        humanOutput.textContent = 'Fix highlighted cron field to translate schedule.';
        humanOutput.classList.add('is-error');
      }
      if (nextCountdown) nextCountdown.textContent = '—';
      if (cadenceBadge) cadenceBadge.textContent = 'Invalid';
      if (runsList) runsList.replaceChildren();
      if (emptyRunsNote) emptyRunsNote.hidden = true;
      return;
    }

    try {
      const parsed = parser.parseExpression(expr);
      const human = parser.toHumanReadable(expr);
      const count = runCountSelect ? Number(runCountSelect.value) : 5;
      const now = new Date();
      const upcoming = parser.getNextExecutionDates(expr, count, now);

      if (errorBox) {
        errorBox.textContent = '';
        errorBox.hidden = true;
      }
      if (humanOutput) {
        humanOutput.textContent = human;
        humanOutput.classList.remove('is-error');
      }
      if (cadenceBadge) {
        cadenceBadge.textContent = resolveCadenceLabel(parsed);
      }

      if (upcoming.length === 0) {
        if (nextCountdown) nextCountdown.textContent = 'No match';
        if (runsList) runsList.replaceChildren();
        if (emptyRunsNote) {
          emptyRunsNote.textContent = `No matching calendar date found within the next ${MAX_FORECAST_YEARS} years (for example, Feb 30 or Apr 31).`;
          emptyRunsNote.hidden = false;
        }
        return;
      }

      if (emptyRunsNote) emptyRunsNote.hidden = true;
      if (nextCountdown) {
        nextCountdown.textContent = formatRelativeTime(upcoming[0], now);
      }

      if (!runsList) return;
      runsList.replaceChildren();

      upcoming.forEach((runDate, idx) => {
        const li = document.createElement('li');
        li.className = `run-item${idx === 0 ? ' is-imminent' : ''}`;

        const marker = document.createElement('span');
        marker.className = 'run-marker';
        marker.setAttribute('aria-hidden', 'true');

        const indexBadge = document.createElement('span');
        indexBadge.className = 'run-index';
        indexBadge.textContent = `#${pad2(idx + 1)}`;

        const info = document.createElement('div');
        info.className = 'run-info';

        const formatted = document.createElement('strong');
        formatted.className = 'run-timestamp';
        formatted.textContent = dateFormatter.format(runDate);

        const iso = document.createElement('span');
        iso.className = 'run-iso';
        iso.textContent = runDate.toISOString();

        info.append(formatted, iso);

        const meta = document.createElement('div');
        meta.className = 'run-meta';

        const relative = document.createElement('span');
        relative.className = 'run-relative';
        relative.textContent = formatRelativeTime(runDate, now);
        meta.appendChild(relative);

        if (idx > 0) {
          const delta = document.createElement('span');
          delta.className = 'run-delta';
          delta.textContent = formatDeltaBetweenRuns(upcoming[idx - 1], runDate);
          meta.appendChild(delta);
        } else {
          const badge = document.createElement('span');
          badge.className = 'run-next-badge';
          badge.textContent = 'NEXT';
          meta.appendChild(badge);
        }

        li.append(marker, indexBadge, info, meta);
        runsList.appendChild(li);
      });
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
      if (humanOutput) {
        humanOutput.textContent = 'Unable to decode expression.';
        humanOutput.classList.add('is-error');
      }
      if (runsList) runsList.replaceChildren();
    }
  }

  fieldInputs.forEach((entry, index) => {
    entry.input.addEventListener('focus', () => setFocusedField(index));
    entry.input.addEventListener('input', () => {
      // Allow pasting a full 5-part cron string into any individual box.
      const raw = entry.input.value.trim();
      if (raw.includes(' ') && raw.split(/\s+/).length === 5) {
        applyExpression(raw);
        return;
      }
      render();
    });
  });

  if (fullExprInput) {
    fullExprInput.addEventListener('input', () => {
      const val = fullExprInput.value.trim();
      const parts = val === '' ? [] : val.split(/\s+/);
      if (parts.length === 5) {
        parts.forEach((part, idx) => {
          fieldInputs[idx].input.value = part;
        });
        render(false);
      } else {
        syncPresetHighlight('');
        if (tokenBar) tokenBar.replaceChildren();
        if (errorBox) {
          errorBox.textContent = `Expected exactly 5 cron fields, received ${parts.length}`;
          errorBox.hidden = false;
        }
        if (humanOutput) {
          humanOutput.textContent = 'Enter 5 space-separated fields (min hour day month weekday).';
          humanOutput.classList.add('is-error');
        }
        if (nextCountdown) nextCountdown.textContent = '—';
        if (cadenceBadge) cadenceBadge.textContent = 'Invalid';
        if (runsList) runsList.replaceChildren();
        if (emptyRunsNote) {
          emptyRunsNote.textContent = 'Enter exactly 5 space-separated cron fields.';
          emptyRunsNote.hidden = false;
        }
      }
    });
  }

  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const cron = btn.dataset.cron;
      if (cron) applyExpression(cron);
    });
  });

  if (runCountSelect) {
    runCountSelect.addEventListener('change', () => render());
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => render());
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      applyExpression(DEFAULT_EXPRESSION);
      setFocusedField(0);
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const expr = currentTokens().join(' ');
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(expr);
        }
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('is-copied');
        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.classList.remove('is-copied');
        }, 1600);
      } catch {
        copyBtn.textContent = 'Select & Ctrl+C';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1600);
      }
    });
  }

  setFocusedField(0);
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountCronParserUI);
  } else {
    mountCronParserUI();
  }
}
