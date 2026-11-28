import test from 'node:test';
import assert from 'node:assert/strict';
import { BiotechGenomicsMerkleEngine, sha256 } from './merkle-verifier.js';

const testData = ['ATGCTG', 'GGTAAC', 'TTAGGC', 'ATCGAT'];

test('buildTree constructs a balanced binary hash tree from 4 leaves', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(testData);

  assert.ok(engine.getRootHash().length > 0, 'Root hash should be computed');
  assert.equal(engine.tree.length, 3, '4 leaves require 3 levels (leaves + 2)');
  assert.equal(engine.tree[0].length, 4, 'Leaf level holds one hash per item');
  assert.equal(engine.tree[1].length, 2, 'First parent level holds 2 hashes');
  assert.equal(engine.tree[2].length, 1, 'Root level holds 1 hash');
});

test('root hash matches manual pairwise SHA-256 computation', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(testData);

  const [h0, h1, h2, h3] = testData.map((item) => sha256(item));
  const p0 = sha256(h0 + h1);
  const p1 = sha256(h2 + h3);
  const expectedRoot = sha256(p0 + p1);

  assert.equal(engine.getRootHash(), expectedRoot, 'Root must equal pairwise hash');
  assert.deepEqual(engine.tree[0], [h0, h1, h2, h3], 'Leaf hashes must match SHA-256 of data');
});

test('generateProof returns audit path with one sibling per level', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(testData);

  for (let i = 0; i < testData.length; i++) {
    const proof = engine.generateProof(i);
    assert.equal(proof.length, 2, `Proof for leaf ${i} should have 2 steps`);
  }
});

test('verifyProof validates inclusion for every leaf', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(testData);

  for (let i = 0; i < testData.length; i++) {
    const proof = engine.generateProof(i);
    const isValid = engine.verifyProof(engine.tree[0][i], proof, engine.getRootHash());
    assert.equal(isValid, true, `Proof should validate for leaf ${i}`);
  }
});

test('tamper detection: modified leaf data fails verification', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(testData);
  const proof = engine.generateProof(0);

  const tamperedLeafHash = sha256(testData[0] + '-MUT');
  const isValid = engine.verifyProof(tamperedLeafHash, proof, engine.getRootHash());

  assert.equal(isValid, false, 'Proof should fail for tampered leaf data');
});

test('tamper detection: corrupted leaf hash string fails verification', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(testData);
  const proof = engine.generateProof(1);

  const corrupted = engine.tree[0][1].replace(/^./, (c) => (c === '0' ? '1' : '0'));
  const isValid = engine.verifyProof(corrupted, proof, engine.getRootHash());

  assert.equal(isValid, false, 'Proof should fail for corrupted leaf hash');
});

test('verifyProof rejects a valid leaf against a wrong root', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(testData);
  const proof = engine.generateProof(0);

  const wrongRoot = '0'.repeat(64);
  const isValid = engine.verifyProof(engine.tree[0][0], proof, wrongRoot);

  assert.equal(isValid, false, 'Proof should fail with wrong root hash');
});

test('odd leaf count duplicates the trailing node and still verifies', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(['A', 'B', 'C']);

  assert.ok(engine.getRootHash().length > 0);
  for (let i = 0; i < 3; i++) {
    const proof = engine.generateProof(i);
    const isValid = engine.verifyProof(engine.tree[0][i], proof, engine.getRootHash());
    assert.equal(isValid, true, `Odd-tree proof should validate for leaf ${i}`);
  }
});

test('empty data array produces no tree', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree([]);

  assert.equal(engine.getRootHash(), '', 'Root hash should be empty for empty data');
  assert.equal(engine.tree.length, 0, 'Tree should be empty for empty data');
});

test('single item tree root equals its own leaf hash', async () => {
  const engine = new BiotechGenomicsMerkleEngine();
  await engine.buildTree(['ATGCTG']);

  const expected = sha256('ATGCTG');
  assert.equal(engine.getRootHash(), expected, 'Single-item root equals leaf hash');

  const proof = engine.generateProof(0);
  const isValid = engine.verifyProof(engine.tree[0][0], proof, engine.getRootHash());
  assert.equal(isValid, true, 'Single-item proof should validate');
});