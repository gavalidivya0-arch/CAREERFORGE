import test from 'node:test';
import assert from 'node:assert/strict';
import { PetAdoptionHavenMerkleEngine } from './merkle-verifier.js';

const sampleRecords = [
  'Pet ID #P-101: Milo (Beagle) - Rabies Vaccine',
  'Pet ID #P-102: Luna (Tabby Cat) - Microchip ISO',
  'Pet ID #P-103: Barnaby (Golden Retriever) - Spay Verification',
  'Pet ID #P-104: Cleo (Border Collie) - Legal Adoption Deed',
  'Pet ID #P-105: Oliver (Persian Cat) - Health Clearance'
];

test('PetAdoptionHavenMerkleEngine - builds binary tree and calculates deterministic root hash', async () => {
  const engine1 = new PetAdoptionHavenMerkleEngine();
  const engine2 = new PetAdoptionHavenMerkleEngine();

  const root1 = await engine1.buildTree(sampleRecords);
  const root2 = await engine2.buildTree(sampleRecords);

  assert.match(root1, /^[0-9a-f]{64}$/);
  assert.equal(root1, root2);
  assert.equal(engine1.getRootHash(), root1);
  assert.equal(engine1.getDepth(), 4); // 5 leaves -> 3 -> 2 -> 1 root => 4 levels
});

test('PetAdoptionHavenMerkleEngine - generates and validates inclusion proofs for every leaf', async () => {
  const engine = new PetAdoptionHavenMerkleEngine();
  const root = await engine.buildTree(sampleRecords);

  for (let i = 0; i < sampleRecords.length; i++) {
    const proof = engine.generateProof(i);
    assert.ok(Array.isArray(proof));
    assert.ok(proof.length > 0);

    const isValid = await engine.verifyProof(sampleRecords[i], proof, root);
    assert.equal(isValid, true, `Proof for leaf ${i} must verify successfully against root`);
  }
});

test('PetAdoptionHavenMerkleEngine - detects tampering when leaf record is modified', async () => {
  const engine = new PetAdoptionHavenMerkleEngine();
  const root = await engine.buildTree(sampleRecords);

  const proof = engine.generateProof(0);
  const tamperedRecord = 'Pet ID #P-101: Milo (Beagle) - FAKE Microchip #999999999';

  const isValid = await engine.verifyProof(tamperedRecord, proof, root);
  assert.equal(isValid, false, 'Tampered pet record must fail proof verification');
});

test('PetAdoptionHavenMerkleEngine - rejects corrupted proof sibling hashes and wrong root', async () => {
  const engine = new PetAdoptionHavenMerkleEngine();
  const root = await engine.buildTree(sampleRecords);

  const proof = engine.generateProof(2);

  // Corrupted sibling hash
  const corruptedProof = [{ ...proof[0], hash: '0'.repeat(64) }, ...proof.slice(1)];
  const isCorruptedValid = await engine.verifyProof(sampleRecords[2], corruptedProof, root);
  assert.equal(isCorruptedValid, false, 'Corrupted sibling hash must fail');

  // Wrong root hash
  const wrongRoot = 'e'.repeat(64);
  const isWrongRootValid = await engine.verifyProof(sampleRecords[2], proof, wrongRoot);
  assert.equal(isWrongRootValid, false, 'Verification against mismatched root must return false');
});

test('PetAdoptionHavenMerkleEngine - handles 2-leaf even trees and single-leaf edge cases', async () => {
  const engine = new PetAdoptionHavenMerkleEngine();

  // 2-leaf even tree
  const evenRecords = sampleRecords.slice(0, 2);
  const root2 = await engine.buildTree(evenRecords);
  assert.equal(engine.getDepth(), 2);
  const proof0 = engine.generateProof(0);
  assert.equal(await engine.verifyProof(evenRecords[0], proof0, root2), true);

  // Single-leaf tree
  const singleRecord = ['Pet ID #P-001: Found Kitten Triage Intake'];
  const rootSingle = await engine.buildTree(singleRecord);
  assert.equal(engine.getDepth(), 1);
  const proofSingle = engine.generateProof(0);
  assert.equal(await engine.verifyProof(singleRecord[0], proofSingle, rootSingle), true);
});
