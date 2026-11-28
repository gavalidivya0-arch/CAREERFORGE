import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TravelOdysseyCommandPalette } from './command-palette.js';

function build(calls = []) {
  const palette = new TravelOdysseyCommandPalette();
  const handler = (action) => calls.push(action.id);
  palette.registerAction('voyage', 'Browse featured voyages (demo)', 'Trip planning', handler);
  palette.registerAction('visa', 'Check entry requirements (demo)', 'Safety', handler);
  palette.registerAction('packing', 'Check the packing list (demo)', 'Trip planning', handler);
  return palette;
}
const ids = (results) => results.map((action) => action.id);

test('an empty query lists everything grouped by category', () => {
  assert.deepEqual(ids(build().fuzzySearch('')), ['voyage', 'packing', 'visa']);
});

test('matches whole words, letter sequences and category names', () => {
  const palette = build();
  assert.equal(ids(palette.fuzzySearch('REQUIREMENTS'))[0], 'visa');
  assert.deepEqual(ids(palette.fuzzySearch('safety')), ['visa']);
  assert.deepEqual(palette.fuzzySearch('qqxz'), []);
});

test('selection wraps and executes the highlighted action', () => {
  const calls = [];
  const palette = build(calls);
  palette.fuzzySearch('');
  palette.moveSelection(-1);
  assert.equal(palette.executeSelected(), 'visa');
  palette.moveSelection(1);
  palette.executeSelected();
  assert.deepEqual(calls, ['visa', 'voyage']);
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
