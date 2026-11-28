import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DefiYieldMatrixMerkleEngine } from './merkle-verifier.js';

const engine = new DefiYieldMatrixMerkleEngine();

test('buildTree creates tree with correct root hash for single element', () => {
  const root = engine.buildTree(['hello']);
  assert.equal(root, engine.getRootHash());
  const proof = engine.generateProof(0);
  assert.ok(Array.isArray(proof));
});

test('buildTree creates tree with correct root hash for multiple elements', () => {
  const data = ['a', 'b', 'c', 'd'];
  const root = engine.buildTree(data);
  assert.ok(root && root.length > 0);
});

test('buildTree handles odd number of elements by duplicating last leaf', () => {
  const data = ['a', 'b', 'c'];
  const root = engine.buildTree(data);
  assert.ok(root && root.length > 0);
  const proofA = engine.generateProof(0);
  const proofB = engine.generateProof(1);
  const proofC = engine.generateProof(2);
  assert.ok(Array.isArray(proofA));
  assert.ok(Array.isArray(proofB));
  assert.ok(Array.isArray(proofC));
});

test('verifyProof returns true for valid proof', () => {
  const data = ['hello', 'world', 'foo', 'bar'];
  const root = engine.buildTree(data);
  const proof0 = engine.generateProof(0);
  assert.ok(engine.verifyProof(engine.tree[0][0], proof0, root));
  const proof3 = engine.generateProof(3);
  assert.ok(engine.verifyProof(engine.tree[0][3], proof3, root));
});

test('verifyProof returns false for tampered leaf', () => {
  const data = ['hello', 'world', 'foo', 'bar'];
  const root = engine.buildTree(data);
  const proof0 = engine.generateProof(0);
  const modifiedLeaf = engine.tree[0][0] + 'tampered';
  assert.ok(!engine.verifyProof(modifiedLeaf, proof0, root));
});

test('verifyProof returns false for incorrect root', () => {
  const data = ['hello', 'world', 'foo', 'bar'];
  const root = engine.buildTree(data);
  const proof0 = engine.generateProof(0);
  const fakeRoot = '0'.repeat(64);
  assert.ok(!engine.verifyProof(engine.tree[0][0], proof0, fakeRoot));
});

test('generateProof produces proof that verifies against root', () => {
  for (const size of [1, 2, 3, 4, 5, 7, 8, 15, 16]) {
    const data = Array.from({ length: size }, (_, i) => `data-${i}`);
    const root = engine.buildTree(data);
    for (let i = 0; i < size; i++) {
      const proof = engine.generateProof(i);
      if (size > 1) {
        assert.ok(proof.length > 0, `proof should have entries for index ${i} with size ${size}`);
      }
      assert.ok(engine.verifyProof(engine.tree[0][i], proof, root), `proof at index ${i} should verify for size ${size}`);
    }
  }
});

test('tamper detection: modified leaf fails verification', () => {
  const data = ['alpha', 'beta', 'gamma', 'delta'];
  const root = engine.buildTree(data);
  const originalProofs = [];
  for (let i = 0; i < 4; i++) {
    originalProofs.push(engine.generateProof(i));
  }

  const modifiedData = [...data];
  modifiedData[1] = 'tampered_value';
  engine.buildTree(modifiedData);
  const tamperedRoot = engine.getRootHash();

  for (let i = 0; i < 4; i++) {
    const proof = originalProofs[i];
    const leaf = engine.tree[0][i];
    const result = engine.verifyProof(leaf, proof, tamperedRoot);
    assert.ok(!result, `proof at index ${i} should fail after tampering`);
  }
});

test('proof validation: correct proof validates after tree rebuild', () => {
  const data = ['one', 'two', 'three', 'four', 'five'];
  const root = engine.buildTree(data);

  for (let i = 0; i < 5; i++) {
    const proof = engine.generateProof(i);
    assert.ok(engine.verifyProof(engine.tree[0][i], proof, root), `proof at index ${i} should validate`);
  }
});