import test from 'node:test';
import assert from 'node:assert/strict';
import { LegalSmartContractsMerkleEngine } from './merkle-verifier.js';

const sampleClauses = [
  'Clause 1: Escrow Deposit 50.0 ETH',
  'Clause 2: Arbitrator Dispute Resolution',
  'Clause 3: Milestone 1 Verification',
  'Clause 4: Milestone 2 Automated Settlement',
  'Clause 5: Force Majeure Liquidation'
];

test('LegalSmartContractsMerkleEngine - builds binary tree and calculates deterministic root hash', async () => {
  const engine1 = new LegalSmartContractsMerkleEngine();
  const engine2 = new LegalSmartContractsMerkleEngine();

  const root1 = await engine1.buildTree(sampleClauses);
  const root2 = await engine2.buildTree(sampleClauses);

  assert.match(root1, /^[0-9a-f]{64}$/);
  assert.equal(root1, root2);
  assert.equal(engine1.getRootHash(), root1);
  assert.equal(engine1.getDepth(), 4); // 5 leaves -> 3 -> 2 -> 1 root => 4 levels
});

test('LegalSmartContractsMerkleEngine - generates and validates inclusion proofs for every leaf', async () => {
  const engine = new LegalSmartContractsMerkleEngine();
  const root = await engine.buildTree(sampleClauses);

  for (let i = 0; i < sampleClauses.length; i++) {
    const proof = engine.generateProof(i);
    assert.ok(Array.isArray(proof));
    assert.ok(proof.length > 0);

    const isValid = await engine.verifyProof(sampleClauses[i], proof, root);
    assert.equal(isValid, true, `Proof for leaf ${i} must verify successfully against root`);
  }
});

test('LegalSmartContractsMerkleEngine - detects tampering when leaf data is modified', async () => {
  const engine = new LegalSmartContractsMerkleEngine();
  const root = await engine.buildTree(sampleClauses);

  const proof = engine.generateProof(0);
  const tamperedClause = 'Clause 1: Escrow Deposit 500.0 ETH [FRAUDULENT]';

  const isValid = await engine.verifyProof(tamperedClause, proof, root);
  assert.equal(isValid, false, 'Tampered clause payload must fail proof verification');
});

test('LegalSmartContractsMerkleEngine - rejects corrupted proof sibling hashes and wrong root', async () => {
  const engine = new LegalSmartContractsMerkleEngine();
  const root = await engine.buildTree(sampleClauses);

  const proof = engine.generateProof(2);

  // Corrupted sibling hash
  const corruptedProof = [{ ...proof[0], hash: '0'.repeat(64) }, ...proof.slice(1)];
  const isCorruptedValid = await engine.verifyProof(sampleClauses[2], corruptedProof, root);
  assert.equal(isCorruptedValid, false, 'Corrupted sibling hash must fail');

  // Wrong root hash
  const wrongRoot = 'a'.repeat(64);
  const isWrongRootValid = await engine.verifyProof(sampleClauses[2], proof, wrongRoot);
  assert.equal(isWrongRootValid, false, 'Verification against mismatched root must return false');
});

test('LegalSmartContractsMerkleEngine - handles 2-leaf even trees and single-leaf edge cases', async () => {
  const engine = new LegalSmartContractsMerkleEngine();

  // 2-leaf even tree
  const evenClauses = sampleClauses.slice(0, 2);
  const root2 = await engine.buildTree(evenClauses);
  assert.equal(engine.getDepth(), 2);
  const proof0 = engine.generateProof(0);
  assert.equal(await engine.verifyProof(evenClauses[0], proof0, root2), true);

  // Single-leaf tree
  const singleClause = ['Clause 1: Standalone Non-Disclosure Clause'];
  const rootSingle = await engine.buildTree(singleClause);
  assert.equal(engine.getDepth(), 1);
  const proofSingle = engine.generateProof(0);
  assert.equal(await engine.verifyProof(singleClause[0], proofSingle, rootSingle), true);
});
