import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FintechVaultClipboardVault } from './smart-clipboard.js';

const texts = (items) => items.map((item) => item.text);

test('detects the format of a snippet', () => {
  const vault = new FintechVaultClipboardVault();
  assert.equal(vault.pushItem('GB82 WEST 1234 5698 7654 32').type, 'account');
  assert.equal(vault.pushItem('https://example.com/a?b=1').type, 'link');
  assert.equal(vault.pushItem('const total = principal * growth;').type, 'code');
  assert.equal(vault.pushItem('Rebalance next quarter.').type, 'text');
  assert.equal(vault.pushItem('forced', 'code').type, 'code');
});

test('ignores blank copies', () => {
  const vault = new FintechVaultClipboardVault();
  assert.equal(vault.pushItem('   \n'), null);
  assert.equal(vault.items.length, 0);
});

test('moves repeats to the top and keeps only the newest items', () => {
  const vault = new FintechVaultClipboardVault(3);
  for (const text of ['a', 'b', 'c', 'a', 'd']) vault.pushItem(text);
  assert.deepEqual(texts(vault.items), ['d', 'a', 'c']);
});

test('filters by text and format', () => {
  const vault = new FintechVaultClipboardVault();
  vault.pushItem('Quarterly yield report');
  vault.pushItem('https://example.com/yield');
  assert.equal(vault.filterItems('YIELD').length, 2);
  assert.deepEqual(texts(vault.filterItems('YIELD', 'link')), ['https://example.com/yield']);
  assert.deepEqual(vault.filterItems('qqxz'), []);
});

test('copies the chosen item and reports failures', async () => {
  const vault = new FintechVaultClipboardVault();
  const item = vault.pushItem('GB82 WEST 1234 5698 7654 32');
  const written = [];
  assert.equal(await vault.copyToClipboard(item.id, { writeText: async (t) => written.push(t) }), true);
  assert.deepEqual(written, ['GB82 WEST 1234 5698 7654 32']);
  assert.equal(await vault.copyToClipboard(999, { writeText: async () => {} }), false);
  assert.equal(await vault.copyToClipboard(item.id, { writeText: async () => { throw new Error('denied'); } }), false);
});
