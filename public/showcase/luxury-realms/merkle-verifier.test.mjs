import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LuxuryRealmsMerkleEngine, sha256 } from './merkle-verifier.js';

function nodeSha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

test('sha256 matches Node crypto SHA-256 across ASCII and UTF-8 inputs', () => {
  const samples = [
    '',
    'Luxury Realms Sovereign Deed #LR-001',
    'The Azure Atoll Sanctuary — €42,000,000 🏝️',
    'a'.repeat(128)
  ];

  for (const sample of samples) {
    assert.equal(sha256(sample), nodeSha256(sample));
    assert.equal(sha256(sample).length, 64);
  }
});

test('LuxuryRealmsMerkleEngine builds balanced binary tree for power-of-two and odd datasets', () => {
  const engine = new LuxuryRealmsMerkleEngine();
  const fourLeaves = ['Deed-A', 'Deed-B', 'Deed-C', 'Deed-D'];
  const summary4 = engine.buildTree(fourLeaves);

  const hA = nodeSha256('Deed-A');
  const hB = nodeSha256('Deed-B');
  const hC = nodeSha256('Deed-C');
  const hD = nodeSha256('Deed-D');
  const hAB = nodeSha256(hA + hB);
  const hCD = nodeSha256(hC + hD);
  const expectedRoot4 = nodeSha256(hAB + hCD);

  assert.equal(summary4.depth, 3);
  assert.equal(summary4.leafCount, 4);
  assert.equal(engine.getRootHash(), expectedRoot4);

  // Odd leaf count (3 leaves duplicates trailing node at level 0)
  const threeLeaves = ['Villa-1', 'Villa-2', 'Villa-3'];
  const summary3 = engine.buildTree(threeLeaves);
  const v1 = nodeSha256('Villa-1');
  const v2 = nodeSha256('Villa-2');
  const v3 = nodeSha256('Villa-3');
  const v12 = nodeSha256(v1 + v2);
  const v33 = nodeSha256(v3 + v3);
  const expectedRoot3 = nodeSha256(v12 + v33);

  assert.equal(summary3.depth, 3);
  assert.equal(engine.getRootHash(), expectedRoot3);
});

test('LuxuryRealmsMerkleEngine generates and verifies valid inclusion proofs for every leaf', () => {
  const dataset = [
    'Title Deed #LR-001 | Azure Atoll | $42M',
    'Airworthiness #AV-204 | Global 7500 | $75M',
    'Escrow #ES-889 | St. Barts Villa | $28.5M',
    'Custody #GV-512 | Geneva Vault | $19.2M',
    'Registry #MR-404 | Monaco Berth | $14.8M'
  ];

  const engine = new LuxuryRealmsMerkleEngine();
  engine.buildTree(dataset);
  const root = engine.getRootHash();

  assert.ok(root);
  for (let i = 0; i < dataset.length; i++) {
    const proof = engine.generateProof(i);
    assert.equal(engine.verifyProof(dataset[i], proof, root), true);
  }
});

test('LuxuryRealmsMerkleEngine detects tampering on modified leaf data, proof siblings, and roots', () => {
  const dataset = [
    { deedId: 'LR-01', priceUsd: 42000000 },
    { deedId: 'LR-02', priceUsd: 75000000 },
    { deedId: 'LR-03', priceUsd: 28500000 },
    { deedId: 'LR-04', priceUsd: 19200000 }
  ];

  const engine = new LuxuryRealmsMerkleEngine();
  engine.buildTree(dataset);
  const root = engine.getRootHash();
  const proof = engine.generateProof(1);

  // Authentic object passes
  assert.equal(engine.verifyProof(dataset[1], proof, root), true);

  // Modified leaf data fails verification
  const tamperedLeaf = { deedId: 'LR-02', priceUsd: 99999999 };
  assert.equal(engine.verifyProof(tamperedLeaf, proof, root), false);

  // Modified sibling hash in proof fails verification
  const tamperedProof = proof.map((step, idx) =>
    idx === 0 ? { ...step, hash: '0'.repeat(64) } : step
  );
  assert.equal(engine.verifyProof(dataset[1], tamperedProof, root), false);

  // Swapped proof direction fails verification
  const flippedProof = proof.map((step, idx) =>
    idx === 0 ? { ...step, position: step.position === 'left' ? 'right' : 'left' } : step
  );
  assert.equal(engine.verifyProof(dataset[1], flippedProof, root), false);

  // Wrong root hash fails verification
  assert.equal(engine.verifyProof(dataset[1], proof, 'f'.repeat(64)), false);
});

test('LuxuryRealmsMerkleEngine handles single-leaf, empty trees, and out-of-bounds indices cleanly', () => {
  const engine = new LuxuryRealmsMerkleEngine();

  const emptySummary = engine.buildTree([]);
  assert.equal(emptySummary.rootHash, null);
  assert.equal(engine.getRootHash(), null);
  assert.throws(() => engine.generateProof(0), RangeError);

  engine.buildTree(['Solo Sovereign Asset']);
  const soloRoot = engine.getRootHash();
  const soloProof = engine.generateProof(0);
  assert.deepEqual(soloProof, []);
  assert.equal(engine.verifyProof('Solo Sovereign Asset', soloProof, soloRoot), true);
  assert.equal(engine.verifyProof('Tampered Asset', soloProof, soloRoot), false);
  assert.throws(() => engine.generateProof(1), RangeError);
  assert.throws(() => engine.generateProof(-1), RangeError);
});

test('LuxuryRealmsMerkleEngine builds and verifies proofs in sub-millisecond time', () => {
  const engine = new LuxuryRealmsMerkleEngine();
  const records = Array.from({ length: 16 }, (_, i) => `Luxury-Asset-Record-${i}`);

  const buildSummary = engine.buildTree(records);
  const proof = engine.generateProof(7);
  const result = engine.verifyProofDetailed(records[7], proof, engine.getRootHash());

  assert.equal(result.valid, true);
  assert.ok(buildSummary.durationMs < 50, `Expected fast build, got ${buildSummary.durationMs}ms`);
  assert.ok(result.durationMs < 5, `Expected sub-millisecond/fast verify, got ${result.durationMs}ms`);
});
