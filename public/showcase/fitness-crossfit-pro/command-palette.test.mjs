import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FitnessCrossfitProCommandPalette } from './command-palette.js';

function build(calls = []) {
  const palette = new FitnessCrossfitProCommandPalette();
  const handler = (action) => calls.push(action.id);
  palette.registerAction('amrap', 'Start a 12 minute AMRAP (demo)', 'Workout', handler);
  palette.registerAction('zones', 'Review heart-rate zones (demo)', 'Recovery', handler);
  palette.registerAction('emom', 'Start a 10 round EMOM (demo)', 'Workout', handler);
  return palette;
}
const ids = (results) => results.map((action) => action.id);

test('an empty query lists everything grouped by category', () => {
  assert.deepEqual(ids(build().fuzzySearch('')), ['amrap', 'emom', 'zones']);
});

test('matches whole words, letter sequences and category names', () => {
  const palette = build();
  assert.equal(ids(palette.fuzzySearch('HEART-RATE'))[0], 'zones');
  assert.deepEqual(ids(palette.fuzzySearch('recovery')), ['zones']);
  assert.deepEqual(palette.fuzzySearch('qqxz'), []);
});

test('selection wraps and executes the highlighted action', () => {
  const calls = [];
  const palette = build(calls);
  palette.fuzzySearch('');
  palette.moveSelection(-1);
  assert.equal(palette.executeSelected(), 'zones');
  palette.moveSelection(1);
  palette.executeSelected();
  assert.deepEqual(calls, ['zones', 'amrap']);
});

test('a new search resets the selection and no match runs nothing', () => {
  const calls = [];
  const palette = build(calls);
  palette.fuzzySearch('');
  palette.moveSelection(2);
  palette.fuzzySearch('qqxz');
  assert.equal(palette.moveSelection(1), 0);
  assert.equal(palette.executeSelected(), null);
  assert.deepEqual(calls, []);
});

test('rejects incomplete actions', () => {
  assert.throws(() => build().registerAction('x', 'No handler', 'Other'), TypeError);
});
