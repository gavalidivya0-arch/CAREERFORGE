import test from 'node:test';
import assert from 'node:assert/strict';
import { CharityMicroloansCronParser } from './cron-parser.js';

test('CharityMicroloansCronParser - parseExpression parses wildcards, steps, ranges, and lists', () => {
  const parser = new CharityMicroloansCronParser();
  const parsed = parser.parseExpression('*/15 0-2 * * 1-5');

  assert.deepEqual(parsed.minutes, [0, 15, 30, 45]);
  assert.deepEqual(parsed.hours, [0, 1, 2]);
  assert.equal(parsed.daysOfMonth.length, 31);
  assert.equal(parsed.months.length, 12);
  assert.deepEqual(parsed.daysOfWeek, [1, 2, 3, 4, 5]);
  assert.equal(parsed.original, '*/15 0-2 * * 1-5');
});

test('CharityMicroloansCronParser - parseExpression supports stepped starts, range steps, aliases, and Sunday 7', () => {
  const parser = new CharityMicroloansCronParser();

  assert.deepEqual(parser.parseExpression('5/20 * * * *').minutes, [5, 25, 45]);
  assert.deepEqual(parser.parseExpression('10-30/5 * * * *').minutes, [10, 15, 20, 25, 30]);
  assert.deepEqual(parser.parseExpression('30,15,30 * * * *').minutes, [15, 30]);
  assert.deepEqual(parser.parseExpression('0 0 * * 0,7').daysOfWeek, [0]);
  assert.deepEqual(parser.parseExpression('0 0 * jan,MAR *').months, [1, 3]);
  assert.deepEqual(parser.parseExpression('0 0 * * mon-fri').daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parser.parseExpression('0 0 * * 5-7').daysOfWeek, [0, 5, 6]);
});

test('CharityMicroloansCronParser - parseExpression rejects invalid syntax and non-string inputs', () => {
  const parser = new CharityMicroloansCronParser();

  assert.throws(() => parser.parseExpression(12345), TypeError);
  assert.throws(() => parser.parseExpression(null), TypeError);
  assert.throws(() => parser.parseExpression(''), /Expected exactly 5 cron fields/);
  assert.throws(() => parser.parseExpression('0 6 * *'), /Expected exactly 5 cron fields/);
  assert.throws(() => parser.parseExpression('65 * * * *'), /Value 65 out of range/);
  assert.throws(() => parser.parseExpression('0 24 * * *'), /Value 24 out of range/);
  assert.throws(() => parser.parseExpression('0 0 0 * *'), /Value 0 out of range/);
  assert.throws(() => parser.parseExpression('0 0 * 13 *'), /Value 13 out of range/);
  assert.throws(() => parser.parseExpression('0 0 * * 8'), /Value 8 out of range/);
  assert.throws(() => parser.parseExpression('*/0 * * * *'), /Invalid step/);
  assert.throws(() => parser.parseExpression('5-2 * * * *'), /Backwards range/);
  assert.throws(() => parser.parseExpression('1,2, * * * *'), /Invalid list syntax/);
  assert.throws(() => parser.parseExpression('1.5 * * * *'), /Invalid value/);
});

test('CharityMicroloansCronParser - toHumanReadable generates clear English descriptions', () => {
  const parser = new CharityMicroloansCronParser();

  assert.equal(parser.toHumanReadable('* * * * *'), 'Every minute of every day');
  assert.equal(parser.toHumanReadable('0 * * * *'), 'Every hour, at minute 0');
  assert.equal(parser.toHumanReadable('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(parser.toHumanReadable('0 */4 * * *'), 'Every 4 hours, at minute 0');
  assert.equal(parser.toHumanReadable('15 */4 * * 1-5'), 'Every 4 hours, at minute 15 on weekdays');
  assert.equal(parser.toHumanReadable('0 6 * * *'), 'At 06:00 every day');
  assert.equal(parser.toHumanReadable('30 14 * * 1-5'), 'At 14:30 on weekdays');
  assert.equal(parser.toHumanReadable('0 9 * * 0,6'), 'At 09:00 on weekends');
  assert.equal(parser.toHumanReadable('30 8 * * 1,4'), 'At 08:30 on Mondays and Thursdays');
  assert.equal(parser.toHumanReadable('0 0 1 * *'), 'At 00:00 on the 1st of every month');
  assert.equal(parser.toHumanReadable('0 0 1 1 *'), 'At 00:00 on the 1st of January');
  assert.equal(parser.toHumanReadable('0 0 13 * 5'), 'At 00:00 on the 13th of the month or on Fridays');
  assert.equal(parser.toHumanReadable('0 18 * * 5-7'), 'At 18:00 on Fridays through Sundays');
  assert.equal(parser.toHumanReadable('0 0 */2 * 5'), 'At 00:00 every 2 days starting on the 1st or on Fridays');
});

test('CharityMicroloansCronParser - getNextExecutionDates forecasts chronologically without mutating startDate', () => {
  const parser = new CharityMicroloansCronParser();
  const anchor = new Date(2026, 0, 1, 12, 0, 0);
  const anchorTime = anchor.getTime();

  const hourly = parser.getNextExecutionDates('0 * * * *', 3, anchor);
  assert.equal(hourly.length, 3);
  assert.deepEqual(hourly.map(d => d.getHours()), [13, 14, 15]);
  assert.deepEqual(hourly.map(d => d.getMinutes()), [0, 0, 0]);
  assert.equal(anchor.getTime(), anchorTime);

  const midMinute = new Date(2026, 0, 1, 12, 0, 30);
  const everyMin = parser.getNextExecutionDates('* * * * *', 2, midMinute);
  assert.deepEqual(everyMin.map(d => d.getMinutes()), [1, 2]);

  // Default count = 5
  assert.equal(parser.getNextExecutionDates('30 14 * * 1-5', undefined, anchor).length, 5);
});

test('CharityMicroloansCronParser - getNextExecutionDates honors cron OR vs AND rules for day and weekday', () => {
  const parser = new CharityMicroloansCronParser();
  const from = new Date(2026, 0, 1, 12, 0, 0);

  // Jan 2026: Jan 2 (Fri), Jan 9 (Fri), Jan 13 (Tue, 13th) -> OR semantics
  const orRuns = parser.getNextExecutionDates('0 0 13 * 5', 3, from);
  assert.deepEqual(orRuns.map(d => d.getDate()), [2, 9, 13]);

  // Stepped DOM (*/2 = odd days 1,3,5,7,9...) with Friday (5) uses OR semantics
  const steppedOrRuns = parser.getNextExecutionDates('0 0 */2 * 5', 4, from);
  assert.deepEqual(steppedOrRuns.map(d => d.getDate()), [2, 3, 5, 7]);

  // Month-end rollover: Jan 31 advancing into Feb/Mar must not skip Feb via Date overflow
  const janEnd = new Date(2026, 0, 31, 0, 0, 0);
  const febRuns = parser.getNextExecutionDates('0 0 1 2 *', 1, janEnd);
  assert.equal(febRuns.length, 1);
  assert.equal(febRuns[0].getFullYear(), 2026);
  assert.equal(febRuns[0].getMonth(), 1);
  assert.equal(febRuns[0].getDate(), 1);
});

test('CharityMicroloansCronParser - getNextExecutionDates handles leap years, zero count, and impossible dates', () => {
  const parser = new CharityMicroloansCronParser();
  const from = new Date(2026, 0, 1, 0, 0, 0);

  const leapRun = parser.getNextExecutionDates('0 0 29 2 *', 1, from);
  assert.equal(leapRun.length, 1);
  assert.equal(leapRun[0].getFullYear(), 2028);
  assert.equal(leapRun[0].getMonth(), 1);
  assert.equal(leapRun[0].getDate(), 29);

  // Annual schedule across 15 years (matches UI "Next 15" option)
  const annualRuns = parser.getNextExecutionDates('0 0 1 1 *', 15, from);
  assert.equal(annualRuns.length, 15);
  assert.equal(annualRuns[0].getFullYear(), 2027);
  assert.equal(annualRuns[14].getFullYear(), 2041);

  assert.deepEqual(parser.getNextExecutionDates('0 6 * * *', 0, from), []);
  assert.deepEqual(parser.getNextExecutionDates('0 6 * * *', -3, from), []);
  assert.deepEqual(parser.getNextExecutionDates('0 0 31 2 *', 3, from), []);
  assert.deepEqual(parser.getNextExecutionDates('0 0 31 4 *', 3, from), []);
  assert.throws(() => parser.getNextExecutionDates('0 6 * * *', 3, 'invalid-date'), TypeError);
});

test('CharityMicroloansCronParser - inspectFields returns token kinds and field-level errors', () => {
  const parser = new CharityMicroloansCronParser();
  const inspected = parser.inspectFields(['*/15', '14', '1,15', 'JAN-MAR', '99']);

  assert.equal(inspected.length, 5);
  assert.equal(inspected[0].kind, 'step');
  assert.equal(inspected[1].kind, 'fixed');
  assert.equal(inspected[2].kind, 'list');
  assert.equal(inspected[3].kind, 'range');
  assert.equal(inspected[4].valid, false);
  assert.equal(inspected[4].kind, 'invalid');
  assert.match(inspected[4].error, /out of range/);
});
