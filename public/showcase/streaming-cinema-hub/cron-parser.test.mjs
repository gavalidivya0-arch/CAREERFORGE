import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingCinemaHubCronParser } from './cron-parser.js';

test('StreamingCinemaHubCronParser - parseExpression parses wildcards, steps, ranges, and lists', () => {
  const parser = new StreamingCinemaHubCronParser();
  const parsed = parser.parseExpression('*/15 0-2 * * 1-5');

  assert.deepEqual(parsed.minutes, [0, 15, 30, 45]);
  assert.deepEqual(parsed.hours, [0, 1, 2]);
  assert.equal(parsed.daysOfMonth.length, 31);
  assert.equal(parsed.months.length, 12);
  assert.deepEqual(parsed.daysOfWeek, [1, 2, 3, 4, 5]);
  assert.equal(parsed.original, '*/15 0-2 * * 1-5');
});

test('StreamingCinemaHubCronParser - parseExpression supports offset steps, range steps, aliases, and Sunday 7', () => {
  const parser = new StreamingCinemaHubCronParser();

  assert.deepEqual(parser.parseExpression('5/20 * * * *').minutes, [5, 25, 45]);
  assert.deepEqual(parser.parseExpression('1-10/3 * * * *').minutes, [1, 4, 7, 10]);
  assert.deepEqual(parser.parseExpression('0 0 * JAN,MAR,DEC *').months, [1, 3, 12]);
  assert.deepEqual(parser.parseExpression('0 0 * * MON-FRI').daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parser.parseExpression('0 0 * * 0,7').daysOfWeek, [0]);
  assert.deepEqual(parser.parseExpression('0 18 * * 5-7').daysOfWeek, [0, 5, 6]);
});

test('StreamingCinemaHubCronParser - parseExpression rejects invalid types, field counts, ranges, and steps', () => {
  const parser = new StreamingCinemaHubCronParser();

  assert.throws(() => parser.parseExpression(12345), TypeError);
  assert.throws(() => parser.parseExpression('   '), /Expected exactly 5 cron fields, received 0/);
  assert.throws(() => parser.parseExpression('0 6 * *'), /Expected exactly 5 cron fields, received 4/);
  assert.throws(() => parser.parseExpression('0 6 * * * *'), /Expected exactly 5 cron fields, received 6/);
  assert.throws(() => parser.parseExpression('65 * * * *'), /out of range/);
  assert.throws(() => parser.parseExpression('0 24 * * *'), /out of range/);
  assert.throws(() => parser.parseExpression('0 0 0 * *'), /out of range/);
  assert.throws(() => parser.parseExpression('0 0 * 13 *'), /out of range/);
  assert.throws(() => parser.parseExpression('0 0 * * 8'), /out of range/);
  assert.throws(() => parser.parseExpression('*/0 * * * *'), /Invalid step/);
  assert.throws(() => parser.parseExpression('10-5 * * * *'), /Backwards range/);
  assert.throws(() => parser.parseExpression('12abc * * * *'), /Invalid value/);
  assert.throws(() => parser.parseExpression('1,,2 * * * *'), /Invalid list syntax/);
});

test('StreamingCinemaHubCronParser - toHumanReadable generates accurate natural English summaries', () => {
  const parser = new StreamingCinemaHubCronParser();

  assert.equal(parser.toHumanReadable('* * * * *'), 'Every minute of every day');
  assert.equal(parser.toHumanReadable('0 * * * *'), 'Every hour, at minute 0');
  assert.equal(parser.toHumanReadable('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(parser.toHumanReadable('0 */6 * * *'), 'Every 6 hours, at minute 0');
  assert.equal(parser.toHumanReadable('0 6 * * *'), 'At 06:00 every day');
  assert.equal(parser.toHumanReadable('0 9 * * 1-5'), 'At 09:00 on weekdays');
  assert.equal(parser.toHumanReadable('30 8 * * 1,4'), 'At 08:30 on Mondays and Thursdays');
  assert.equal(parser.toHumanReadable('0 0 1 * *'), 'At 00:00 on the 1st of every month');
  assert.equal(parser.toHumanReadable('0 0 1 1 *'), 'At 00:00 on the 1st of January');
  assert.equal(parser.toHumanReadable('0 0 13 * 5'), 'At 00:00 on the 13th of the month or on Fridays');
  assert.equal(parser.toHumanReadable('0 18 * * 5-7'), 'At 18:00 on Fridays through Sundays');
  assert.equal(parser.toHumanReadable('0 0 */2 * 5'), 'At 00:00 every 2 days starting on the 1st or on Fridays');
});

test('StreamingCinemaHubCronParser - getNextExecutionDates forecasts runs chronologically without mutating startDate', () => {
  const parser = new StreamingCinemaHubCronParser();
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
});

test('StreamingCinemaHubCronParser - getNextExecutionDates honors cron OR vs AND rules for day and weekday', () => {
  const parser = new StreamingCinemaHubCronParser();
  const from = new Date(2026, 0, 1, 12, 0, 0);

  // Jan 2026: Jan 2 (Fri), Jan 9 (Fri), Jan 13 (Tue, 13th) -> OR semantics
  const orRuns = parser.getNextExecutionDates('0 0 13 * 5', 3, from);
  assert.deepEqual(orRuns.map(d => d.getDate()), [2, 9, 13]);

  // Stepped DOM (*/2 = odd days 1,3,5,7,9...) with Friday (5) still uses OR semantics (not wildcard!)
  const steppedOrRuns = parser.getNextExecutionDates('0 0 */2 * 5', 4, from);
  assert.deepEqual(steppedOrRuns.map(d => d.getDate()), [2, 3, 5, 7]);
});

test('StreamingCinemaHubCronParser - getNextExecutionDates handles leap years, zero count, and impossible dates', () => {
  const parser = new StreamingCinemaHubCronParser();
  const from = new Date(2026, 0, 1, 0, 0, 0);

  const leapRun = parser.getNextExecutionDates('0 0 29 2 *', 1, from);
  assert.equal(leapRun.length, 1);
  assert.equal(leapRun[0].getFullYear(), 2028);
  assert.equal(leapRun[0].getMonth(), 1);
  assert.equal(leapRun[0].getDate(), 29);

  assert.deepEqual(parser.getNextExecutionDates('0 6 * * *', 0, from), []);
  assert.deepEqual(parser.getNextExecutionDates('0 6 * * *', -3, from), []);
  assert.deepEqual(parser.getNextExecutionDates('0 0 31 2 *', 3, from), []);
  assert.throws(() => parser.getNextExecutionDates('0 6 * * *', 3, 'invalid-date'), TypeError);
});
