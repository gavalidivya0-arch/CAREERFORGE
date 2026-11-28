import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EdtechAcademyMerkleEngine } from './merkle-verifier.js';

function nodeSha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('EdtechAcademyMerkleEngine - SHA-256 digests match node:crypto standard vectors', () => {
  assert.equal(EdtechAcademyMerkleEngine.sha256(''), nodeSha256(''));
  assert.equal(EdtechAcademyMerkleEngine.sha256('abc'), nodeSha256('abc'));
  assert.equal(
    EdtechAcademyMerkleEngine.sha256('CERT-2026-101 | Maya Lin | 98%'),
    nodeSha256('CERT-2026-101 | Maya Lin | 98%')
  );
});

test('EdtechAcademyMerkleEngine - getRootHash returns null before buildTree and updates after buildTree', () => {
  const engine = new EdtechAcademyMerkleEngine();
  assert.equal(engine.getRootHash(), null);
  assert.equal(engine.getDepth(), 0);

  const root = engine.buildTree(['record-a', 'record-b']);
  assert.equal(typeof root, 'string');
  assert.equal(root.length, 64);
  assert.equal(engine.getRootHash(), root);
  assert.equal(engine.getDepth(), 1);
});

test('EdtechAcademyMerkleEngine - builds balanced binary tree for power-of-two leaves (4 leaves)', () => {
  const records = ['leaf-0', 'leaf-1', 'leaf-2', 'leaf-3'];
  const engine = new EdtechAcademyMerkleEngine();
  const root = engine.buildTree(records);

  const h0 = nodeSha256('leaf-0');
  const h1 = nodeSha256('leaf-1');
  const h2 = nodeSha256('leaf-2');
  const h3 = nodeSha256('leaf-3');
  const h01 = nodeSha256(h0 + h1);
  const h23 = nodeSha256(h2 + h3);
  const expectedRoot = nodeSha256(h01 + h23);

  assert.equal(root, expectedRoot);
  assert.equal(engine.getRootHash(), expectedRoot);
  assert.equal(engine.getDepth(), 2);
  assert.deepEqual(engine.getLevels(), [
    [h0, h1, h2, h3],
    [h01, h23],
    [expectedRoot]
  ]);
});

test('EdtechAcademyMerkleEngine - balances odd-count leaf trees by duplicating trailing node', () => {
  const records = ['alpha', 'beta', 'gamma'];
  const engine = new EdtechAcademyMerkleEngine(records);

  const h0 = nodeSha256('alpha');
  const h1 = nodeSha256('beta');
  const h2 = nodeSha256('gamma');
  const h01 = nodeSha256(h0 + h1);
  const h22 = nodeSha256(h2 + h2);
  const expectedRoot = nodeSha256(h01 + h22);

  assert.equal(engine.getRootHash(), expectedRoot);
  assert.equal(engine.getDepth(), 2);
  assert.equal(engine.verifyProof('gamma', engine.generateProof(2), expectedRoot), true);
});

test('EdtechAcademyMerkleEngine - handles single-leaf tree correctly', () => {
  const engine = new EdtechAcademyMerkleEngine(['solo-certificate']);
  const expectedRoot = nodeSha256('solo-certificate');

  assert.equal(engine.getRootHash(), expectedRoot);
  assert.equal(engine.getDepth(), 0);

  const proof = engine.generateProof(0);
  assert.deepEqual(proof, []);
  assert.equal(engine.verifyProof('solo-certificate', proof, expectedRoot), true);
  assert.equal(engine.verifyProof('tampered-certificate', proof, expectedRoot), false);
});

test('EdtechAcademyMerkleEngine - generates valid inclusion proofs for every leaf across even and odd trees', () => {
  for (const count of [2, 3, 5, 8]) {
    const records = Array.from({ length: count }, (_, idx) => `student-${idx}:score-${90 + idx}`);
    const engine = new EdtechAcademyMerkleEngine();
    const root = engine.buildTree(records);

    for (let i = 0; i < records.length; i++) {
      const proof = engine.generateProof(i);
      assert.equal(engine.verifyProof(records[i], proof, root), true);
    }
  }
});

test('EdtechAcademyMerkleEngine - detects tampering on modified leaf data, proof steps, and root', () => {
  const records = [
    'CERT-101 | Alice | 95%',
    'CERT-102 | Bob | 88%',
    'CERT-103 | Carol | 92%',
    'CERT-104 | Dave | 90%',
    'CERT-105 | Eve | 97%'
  ];
  const engine = new EdtechAcademyMerkleEngine(records);
  const root = engine.getRootHash();
  const proofForBob = engine.generateProof(1);

  assert.equal(engine.verifyProof('CERT-102 | Bob | 88%', proofForBob, root), true);

  // Modified leaf payload
  assert.equal(engine.verifyProof('CERT-102 | Bob | 100%', proofForBob, root), false);

  // Proof generated for Bob used against Alice's data
  assert.equal(engine.verifyProof('CERT-101 | Alice | 95%', proofForBob, root), false);

  // Tampered sibling hash inside proof
  const tamperedHashProof = proofForBob.map((step, idx) =>
    idx === 0 ? { ...step, hash: '0'.repeat(64) } : step
  );
  assert.equal(engine.verifyProof('CERT-102 | Bob | 88%', tamperedHashProof, root), false);

  // Flipped sibling position inside proof
  const flippedPosProof = proofForBob.map((step, idx) =>
    idx === 0 ? { ...step, position: step.position === 'left' ? 'right' : 'left' } : step
  );
  assert.equal(engine.verifyProof('CERT-102 | Bob | 88%', flippedPosProof, root), false);

  // Tampered root hash
  const tamperedRoot = `${root.slice(0, -1)}${root.endsWith('0') ? '1' : '0'}`;
  assert.equal(engine.verifyProof('CERT-102 | Bob | 88%', proofForBob, tamperedRoot), false);
});

test('EdtechAcademyMerkleEngine - validates inputs and executes in sub-millisecond time', () => {
  const engine = new EdtechAcademyMerkleEngine();

  assert.throws(() => engine.generateProof(0), Error);
  assert.throws(() => engine.buildTree([]), RangeError);
  assert.throws(() => engine.buildTree('invalid'), TypeError);
  assert.throws(() => engine.buildTree(['ok', null]), TypeError);

  const records = Array.from({ length: 16 }, (_, i) => `record-${i}`);
  const root = engine.buildTree(records);
  assert.throws(() => engine.generateProof(-1), RangeError);
  assert.throws(() => engine.generateProof(16), RangeError);
  assert.throws(() => engine.generateProof(1.5), RangeError);

  const proof = engine.generateProof(7);
  assert.throws(() => engine.verifyProof(null, proof, root), TypeError);
  assert.throws(() => engine.verifyProof('record-7', 'not-an-array', root), TypeError);

  const details = engine.verifyProofDetailed('record-7', proof, root);
  assert.equal(details.valid, true);
  assert.ok(details.durationMs < 5, `Expected sub-millisecond/fast verification, got ${details.durationMs}ms`);
});
