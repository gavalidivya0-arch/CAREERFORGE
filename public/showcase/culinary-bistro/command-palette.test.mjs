import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CulinaryBistroCommandPalette } from './command-palette.js';

function build(calls = []) {
  const palette = new CulinaryBistroCommandPalette();
  const handler = (action) => calls.push(action.id);
  palette.registerAction('tasting', 'See tonight\'s tasting menu (demo)', 'Menu', handler);
  palette.registerAction('table', 'Hold a table for two (demo)', 'Reservations', handler);
  palette.registerAction('pairing', 'Ask for a wine pairing (demo)', 'Menu', handler);
  return palette;
}
const ids = (results) => results.map((action) => action.id);

test('an empty query lists everything grouped by category', () => {
  assert.deepEqual(ids(build().fuzzySearch('')), ['tasting', 'pairing', 'table']);
});

test('matches whole words, letter sequences and category names', () => {
  const palette = build();
  assert.equal(ids(palette.fuzzySearch('TABLE'))[0], 'table');
  assert.deepEqual(ids(palette.fuzzySearch('reservations')), ['table']);
  assert.deepEqual(palette.fuzzySearch('qqxz'), []);
});

test('selection wraps and executes the highlighted action', () => {
  const calls = [];
  const palette = build(calls);
  palette.fuzzySearch('');
  palette.moveSelection(-1);
  assert.equal(palette.executeSelected(), 'table');
  palette.moveSelection(1);
  palette.executeSelected();
  assert.deepEqual(calls, ['table', 'tasting']);
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
