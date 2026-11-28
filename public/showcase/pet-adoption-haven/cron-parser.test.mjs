import test from 'node:test';
import assert from 'node:assert/strict';
import { PetAdoptionHavenCronParser } from './cron-parser.js';

test('PetAdoptionHavenCronParser - parses wildcards, steps, and ranges', () => {
  const parser = new PetAdoptionHavenCronParser();
  const parsed = parser.parseExpression('*/15 0-2 * * 1-5');

  assert.deepEqual(parsed.minutes, [0, 15, 30, 45]);
  assert.deepEqual(parsed.hours, [0, 1, 2]);
  assert.equal(parsed.daysOfMonth.length, 31);
  assert.equal(parsed.months.length, 12);
  assert.deepEqual(parsed.daysOfWeek, [1, 2, 3, 4, 5]);
  assert.equal(parsed.original, '*/15 0-2 * * 1-5');
});

test('PetAdoptionHavenCronParser - supports lists, stepped starts, range steps, aliases, and Sunday 7', () => {
  const parser = new PetAdoptionHavenCronParser();

  assert.deepEqual(parser.parseExpression('5/20 * * * *').minutes, [5, 25, 45]);
  assert.deepEqual(parser.parseExpression('0 8-16/2 * * *').hours, [8, 10, 12, 14, 16]);
  assert.deepEqual(parser.parseExpression('0 0 * * 0,7').daysOfWeek, [0]);
  assert.deepEqual(parser.parseExpression('0 0 * JAN,MAR *').months, [1, 3]);
  assert.deepEqual(parser.parseExpression('0 0 * * MON-FRI').daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parser.parseExpression('0 0 * * 5-7').daysOfWeek, [0, 5, 6]);

  const compat = parser.parseExpression('*/20 9-11 1,15 jan-mar mon,7');
  assert.deepEqual(compat.minute, [0, 20, 40]);
  assert.deepEqual(compat.hour, [9, 10, 11]);
  assert.deepEqual(compat.dayOfMonth, [1, 15]);
  assert.deepEqual(compat.month, [1, 2, 3]);
  assert.deepEqual(compat.dayOfWeek, [0, 1]);
  assert.equal(parser.matchesDay(compat, new Date(2026, 0, 1)), true);
});

test('PetAdoptionHavenCronParser - rejects malformed expressions with contextual errors', () => {
  const parser = new PetAdoptionHavenCronParser();

  assert.throws(() => parser.parseExpression('0 6 * *'), /Expected exactly 5 cron fields/);
  assert.throws(() => parser.parseExpression('   '), /Expected exactly 5 cron fields/);
  assert.throws(() => parser.parseExpression('65 * * * *'), /Minute field: Value 65 out of range/);
  assert.throws(() => parser.parseExpression('0 24 * * *'), /Hour field: Value 24 out of range/);
  assert.throws(() => parser.parseExpression('0 0 0 * *'), /Day of month field: Value 0 out of range/);
  assert.throws(() => parser.parseExpression('0 0 * 13 *'), /Month field: Value 13 out of range/);
  assert.throws(() => parser.parseExpression('0 0 * * 8'), /Weekday field: Value 8 out of range/);
  assert.throws(() => parser.parseExpression('*/0 * * * *'), /Invalid step/);
  assert.throws(() => parser.parseExpression('10-5 * * * *'), /Invalid range/);
  assert.throws(() => parser.parseExpression(12345), TypeError);

  const malformed = ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', '1/2/3 * * * *', '- * * * *', '1, * * * *', 'a * * * *'];
  for (const expr of malformed) {
    assert.throws(() => parser.parseExpression(expr), Error, expr);
  }
});

test('PetAdoptionHavenCronParser - generates natural-language explanations', () => {
  const parser = new PetAdoptionHavenCronParser();

  assert.equal(parser.toHumanReadable('* * * * *'), 'Every minute of every day');
  assert.equal(parser.toHumanReadable('0 * * * *'), 'Every hour, at minute 0');
  assert.equal(parser.toHumanReadable('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(parser.toHumanReadable('0 */6 * * *'), 'Every 6 hours');
  assert.equal(parser.toHumanReadable('0 7 * * 1-5'), 'At 07:00 on weekdays');
  assert.equal(parser.toHumanReadable('30 18 * * *'), 'At 18:30 every day');
  assert.equal(parser.toHumanReadable('0 10 * * 0,6'), 'At 10:00 on weekends');
  assert.equal(parser.toHumanReadable('30 8 * * 1,4'), 'At 08:30 on Mondays and Thursdays');
  assert.equal(parser.toHumanReadable('0 9 1 * *'), 'At 09:00 on the 1st of every month');
  assert.equal(parser.toHumanReadable('0 0 1 1 *'), 'At 00:00 on the 1st of January');
});

test('PetAdoptionHavenCronParser - forecasts upcoming execution dates in chronological order', () => {
  const parser = new PetAdoptionHavenCronParser();
  const from = new Date(2026, 0, 1, 12, 0, 0);

  const hourly = parser.getNextExecutionDates('0 * * * *', 3, from);
  assert.equal(hourly.length, 3);
  assert.deepEqual(hourly.map(date => date.getHours()), [13, 14, 15]);
  assert.deepEqual(hourly.map(date => date.getMinutes()), [0, 0, 0]);

  const weekday = parser.getNextExecutionDates('0 7 * * 1-5', 3, from);
  assert.deepEqual(weekday.map(date => date.getDay()), [5, 1, 2]);
  assert.deepEqual(weekday.map(date => date.getHours()), [7, 7, 7]);
  for (let i = 1; i < weekday.length; i += 1) {
    assert(weekday[i].getTime() > weekday[i - 1].getTime());
  }
});

test('PetAdoptionHavenCronParser - applies standard cron OR semantics when day-of-month and weekday are both restricted', () => {
  const parser = new PetAdoptionHavenCronParser();
  const from = new Date(2026, 0, 1, 12, 0, 0);
  const runs = parser.getNextExecutionDates('0 0 13 * 5', 3, from);

  assert.deepEqual(runs.map(date => date.getDate()), [2, 9, 13]);

  const juneRuns = parser.getNextExecutionDates('0 0 3 6 mon', 3, new Date(2026, 4, 31));
  assert.deepEqual(juneRuns.map(date => [date.getMonth() + 1, date.getDate()]), [[6, 1], [6, 3], [6, 8]]);
});

test('PetAdoptionHavenCronParser - handles strictly-after start, defaults, zero count, leap day, and impossible schedules', () => {
  const parser = new PetAdoptionHavenCronParser();
  const from = new Date(2026, 0, 1, 12, 0, 0);

  const daily = parser.getNextExecutionDates('0 12 * * *', 2, from);
  assert.deepEqual(daily.map(date => date.getDate()), [2, 3]);

  assert.equal(parser.getNextExecutionDates('0 7 * * *', 5, from).length, 5);
  assert.deepEqual(parser.getNextExecutionDates('0 7 * * *', 0, from), []);
  assert.deepEqual(parser.getNextExecutionDates('0 0 30 2 *', 1, from), []);
  assert.deepEqual(parser.getNextExecutionDates('0 0 31 2 *', 3, from), []);

  const leapDay = parser.getNextExecutionDates('0 9 29 2 *', 1, from);
  assert.equal(leapDay.length, 1);
  assert.equal(leapDay[0].getFullYear(), 2028);
  assert.equal(leapDay[0].getMonth(), 1);
  assert.equal(leapDay[0].getDate(), 29);
});
