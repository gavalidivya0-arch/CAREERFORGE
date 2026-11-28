import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RealEstateLuxeClipboardVault } from './smart-clipboard.js';

const texts = (items) => items.map((item) => item.text);

test('detects the format of a snippet', () => {
  const vault = new RealEstateLuxeClipboardVault();
  assert.equal(vault.pushItem('$4,250,000').type, 'price');
  assert.equal(vault.pushItem('https://example.com/a?b=1').type, 'link');
  assert.equal(vault.pushItem('const monthly = price * rate;').type, 'code');
  assert.equal(vault.pushItem('Private viewing on Friday.').type, 'text');
  assert.equal(vault.pushItem('forced', 'code').type, 'code');
});

test('ignores blank copies', () => {
  const vault = new RealEstateLuxeClipboardVault();
  assert.equal(vault.pushItem('   \n'), null);
  assert.equal(vault.items.length, 0);
});

test('moves repeats to the top and keeps only the newest items', () => {
  const vault = new RealEstateLuxeClipboardVault(3);
  for (const text of ['a', 'b', 'c', 'a', 'd']) vault.pushItem(text);
  assert.deepEqual(texts(vault.items), ['d', 'a', 'c']);
});

test('filters by text and format', () => {
  const vault = new RealEstateLuxeClipboardVault();
  vault.pushItem('Harbour view penthouse');
  vault.pushItem('https://example.com/harbour');
  assert.equal(vault.filterItems('HARBOUR').length, 2);
  assert.deepEqual(texts(vault.filterItems('HARBOUR', 'link')), ['https://example.com/harbour']);
  assert.deepEqual(vault.filterItems('qqxz'), []);
});

test('copies the chosen item and reports failures', async () => {
  const vault = new RealEstateLuxeClipboardVault();
  const item = vault.pushItem('$4,250,000');
  const written = [];
  assert.equal(await vault.copyToClipboard(item.id, { writeText: async (t) => written.push(t) }), true);
  assert.deepEqual(written, ['$4,250,000']);
  assert.equal(await vault.copyToClipboard(999, { writeText: async () => {} }), false);
  assert.equal(await vault.copyToClipboard(item.id, { writeText: async () => { throw new Error('denied'); } }), false);
});
