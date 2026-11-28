import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EdtechAcademyClipboardVault } from './smart-clipboard.js';

const texts = (items) => items.map((item) => item.text);

test('detects the format of a snippet', () => {
  const vault = new EdtechAcademyClipboardVault();
  assert.equal(vault.pushItem('pip install torch').type, 'command');
  assert.equal(vault.pushItem('https://example.com/a?b=1').type, 'link');
  assert.equal(vault.pushItem('def attention(q, k, v):').type, 'code');
  assert.equal(vault.pushItem('Revise the scheduler chapter.').type, 'text');
  assert.equal(vault.pushItem('forced', 'code').type, 'code');
});

test('ignores blank copies', () => {
  const vault = new EdtechAcademyClipboardVault();
  assert.equal(vault.pushItem('   \n'), null);
  assert.equal(vault.items.length, 0);
});

test('moves repeats to the top and keeps only the newest items', () => {
  const vault = new EdtechAcademyClipboardVault(3);
  for (const text of ['a', 'b', 'c', 'a', 'd']) vault.pushItem(text);
  assert.deepEqual(texts(vault.items), ['d', 'a', 'c']);
});

test('filters by text and format', () => {
  const vault = new EdtechAcademyClipboardVault();
  vault.pushItem('Attention lesson notes');
  vault.pushItem('https://example.com/attention');
  assert.equal(vault.filterItems('ATTENTION').length, 2);
  assert.deepEqual(texts(vault.filterItems('ATTENTION', 'link')), ['https://example.com/attention']);
  assert.deepEqual(vault.filterItems('qqxz'), []);
});

test('copies the chosen item and reports failures', async () => {
  const vault = new EdtechAcademyClipboardVault();
  const item = vault.pushItem('pip install torch');
  const written = [];
  assert.equal(await vault.copyToClipboard(item.id, { writeText: async (t) => written.push(t) }), true);
  assert.deepEqual(written, ['pip install torch']);
  assert.equal(await vault.copyToClipboard(999, { writeText: async () => {} }), false);
  assert.equal(await vault.copyToClipboard(item.id, { writeText: async () => { throw new Error('denied'); } }), false);
});
