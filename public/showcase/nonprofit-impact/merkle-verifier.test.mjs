import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NonprofitImpactMerkleEngine, sha256Hex } from './merkle-verifier.js';

const nodeSha256 = (data) => createHash('sha256').update(data).digest('hex');

test('sha256Hex matches Node native crypto SHA-256 across edge inputs', () => {
  const samples = [
    '',
    'abc',
    'Grant #TI-401 | Amazon Canopy Parcel A',
    '🌱 TerraInitia · Café · 100% Transparent 🌍',
    'x'.repeat(250)
  ];
  for (const sample of samples) {
    assert.equal(sha256Hex(sample), nodeSha256(sample));
  }
});

test('getRootHash returns null before buildTree and validates buildTree input', () => {
  const engine = new NonprofitImpactMerkleEngine();
  assert.equal(engine.getRootHash(), null);

  for (const invalid of [null, undefined, 'grant', 123, {}]) {
    assert.throws(() => engine.buildTree(invalid), TypeError);
  }
  assert.throws(() => engine.buildTree([]), RangeError);
});

test('binary tree calculation handles single, even, and odd leaf counts deterministically', () => {
  const engine = new NonprofitImpactMerkleEngine();

  // Single leaf: depth 1, root equals leaf hash, proof is empty
  const singleRoot = engine.buildTree(['Solo Grant #1']);
  assert.equal(engine.getDepth(), 1);
  assert.equal(singleRoot, engine.hashLeaf('Solo Grant #1'));
  assert.deepEqual(engine.generateProof(0), []);
  assert.equal(engine.verifyProof('Solo Grant #1', [], singleRoot), true);

  // Odd 5 leaves: 5 -> 3 -> 2 -> 1 (depth 4)
  const oddRecords = ['G1', 'G2', 'G3', 'G4', 'G5'];
  const oddRoot = engine.buildTree(oddRecords);
  assert.equal(engine.getDepth(), 4);
  assert.deepEqual(engine.getTreeLevels().map((lvl) => lvl.length), [5, 3, 2, 1]);
  assert.match(oddRoot, /^[0-9a-f]{64}$/);

  // Explicit binary calculation verification for 3 leaves [A, B, C]
  const hA = engine.hashLeaf('A');
  const hB = engine.hashLeaf('B');
  const hC = engine.hashLeaf('C');
  const expectedAB = engine.hashPair(hA, hB);
  const expectedCC = engine.hashPair(hC, hC);
  const expectedRoot = engine.hashPair(expectedAB, expectedCC);

  assert.equal(engine.buildTree(['A', 'B', 'C']), expectedRoot);
  assert.equal(engine.getRootHash(), expectedRoot);
});

test('object canonicalization makes root hash invariant to object key order', () => {
  const engineA = new NonprofitImpactMerkleEngine();
  const engineB = new NonprofitImpactMerkleEngine();

  const rootA = engineA.buildTree([{ id: 101, partner: 'Amazonia', saplings: 5000 }]);
  const rootB = engineB.buildTree([{ saplings: 5000, partner: 'Amazonia', id: 101 }]);

  assert.equal(rootA, rootB);
});

test('generateProof and verifyProof validate every leaf in balanced and odd trees', () => {
  const datasets = [
    ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'],
    ['Odd1', 'Odd2', 'Odd3', 'Odd4', 'Odd5', 'Odd6', 'Odd7']
  ];

  for (const data of datasets) {
    const engine = new NonprofitImpactMerkleEngine();
    const root = engine.buildTree(data);
    const expectedProofLen = Math.ceil(Math.log2(data.length));

    for (let i = 0; i < data.length; i += 1) {
      const proof = engine.generateProof(i);
      assert.equal(proof.length, expectedProofLen);
      assert.equal(engine.verifyProof(data[i], proof, root), true);
    }
  }
});

test('tamper detection rejects modified leaf data, altered proofs, and mismatched roots', () => {
  const engine = new NonprofitImpactMerkleEngine();
  const records = [
    { id: 1, project: 'Mangrove Belt', amount: 12000 },
    { id: 2, project: 'Rainforest Parcel', amount: 18500 },
    { id: 3, project: 'Coral Nursery', amount: 9400 },
    { id: 4, project: 'Peatland Buffer', amount: 21000 }
  ];

  const root = engine.buildTree(records);
  const proofForIndex1 = engine.generateProof(1);

  // Authentic leaf passes
  assert.equal(engine.verifyProof(records[1], proofForIndex1, root), true);

  // Modified numeric field in leaf fails
  assert.equal(
    engine.verifyProof({ id: 2, project: 'Rainforest Parcel', amount: 18501 }, proofForIndex1, root),
    false
  );

  // Modified string character fails
  assert.equal(
    engine.verifyProof({ id: 2, project: 'Rainforest Parcek', amount: 18500 }, proofForIndex1, root),
    false
  );

  // Valid leaf with another leaf's proof fails
  assert.equal(engine.verifyProof(records[0], proofForIndex1, root), false);

  // Tampered sibling hash in proof fails
  const corruptedProof = proofForIndex1.map((step, idx) =>
    idx === 0
      ? { ...step, hash: `${step.hash[0] === '0' ? '1' : '0'}${step.hash.slice(1)}` }
      : step
  );
  assert.equal(engine.verifyProof(records[1], corruptedProof, root), false);

  // Swapped sibling position in proof fails
  const flippedPositionProof = proofForIndex1.map((step, idx) =>
    idx === 0 ? { ...step, position: step.position === 'left' ? 'right' : 'left' } : step
  );
  assert.equal(engine.verifyProof(records[1], flippedPositionProof, root), false);

  // Wrong root or malformed inputs fail cleanly
  const wrongRoot = `${root[0] === 'a' ? 'b' : 'a'}${root.slice(1)}`;
  assert.equal(engine.verifyProof(records[1], proofForIndex1, wrongRoot), false);
  assert.equal(engine.verifyProof(records[1], null, root), false);
  assert.equal(engine.verifyProof(records[1], proofForIndex1, 'not-a-hex-root'), false);
});

test('generateProof enforces tree readiness and index bounds', () => {
  const emptyEngine = new NonprofitImpactMerkleEngine();
  assert.throws(() => emptyEngine.generateProof(0), Error);

  emptyEngine.buildTree(['Alpha', 'Beta']);
  assert.throws(() => emptyEngine.generateProof(1.5), TypeError);
  assert.throws(() => emptyEngine.generateProof('0'), TypeError);
  assert.throws(() => emptyEngine.generateProof(-1), RangeError);
  assert.throws(() => emptyEngine.generateProof(2), RangeError);
});

test('verifyProof executes in sub-millisecond average time', () => {
  const engine = new NonprofitImpactMerkleEngine();
  const data = Array.from({ length: 64 }, (_, i) => `Grant #${i} | Parcel ${i} | 1000 trees`);
  const root = engine.buildTree(data);
  const proof = engine.generateProof(37);

  const t0 = performance.now();
  const iterations = 100;
  for (let i = 0; i < iterations; i += 1) {
    assert.equal(engine.verifyProof(data[37], proof, root), true);
  }
  const avgMs = (performance.now() - t0) / iterations;
  assert.ok(avgMs < 1, `Expected sub-millisecond verification, got ${avgMs.toFixed(4)} ms`);
});
