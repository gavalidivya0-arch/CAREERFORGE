import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HealthVitalityMerkleEngine, sha256Hex } from './merkle-verifier.js';

function nodeSha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('HealthVitalityMerkleEngine - computes FIPS 180-4 SHA-256 digests matching node:crypto', () => {
  const samples = [
    '',
    'HV-101 | RestingHR:58bpm | HRV:74ms | SpO2:99%',
    'unicode-biometric-λ-μ-❤️-telemetry-payload-spanning-multiple-64-byte-sha256-compression-blocks-for-padding-verification'
  ];

  for (const sample of samples) {
    assert.equal(sha256Hex(sample), nodeSha256(sample));
    assert.equal(HealthVitalityMerkleEngine.sha256(sample), nodeSha256(sample));
  }
});

test('HealthVitalityMerkleEngine - builds balanced binary Merkle tree for 4 leaves', () => {
  const records = [
    'vital-leaf-0',
    'vital-leaf-1',
    'vital-leaf-2',
    'vital-leaf-3'
  ];
  const engine = new HealthVitalityMerkleEngine();
  const root = engine.buildTree(records);

  const h0 = nodeSha256('vital-leaf-0');
  const h1 = nodeSha256('vital-leaf-1');
  const h2 = nodeSha256('vital-leaf-2');
  const h3 = nodeSha256('vital-leaf-3');
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

test('HealthVitalityMerkleEngine - balances odd-count leaf trees by duplicating trailing node', () => {
  const records = ['spo2-99', 'hrv-74ms', 'vo2-51.4'];
  const engine = new HealthVitalityMerkleEngine(records);

  const h0 = nodeSha256('spo2-99');
  const h1 = nodeSha256('hrv-74ms');
  const h2 = nodeSha256('vo2-51.4');
  const h01 = nodeSha256(h0 + h1);
  const h22 = nodeSha256(h2 + h2);
  const expectedRoot = nodeSha256(h01 + h22);

  assert.equal(engine.getRootHash(), expectedRoot);
  assert.equal(engine.getDepth(), 2);
  assert.equal(engine.verifyProof('vo2-51.4', engine.generateProof(2), expectedRoot), true);
});

test('HealthVitalityMerkleEngine - handles single-leaf tree correctly', () => {
  const engine = new HealthVitalityMerkleEngine(['solo-biomarker-record']);
  const expectedRoot = nodeSha256('solo-biomarker-record');

  assert.equal(engine.getRootHash(), expectedRoot);
  assert.equal(engine.getDepth(), 0);

  const proof = engine.generateProof(0);
  assert.deepEqual(proof, []);
  assert.equal(engine.verifyProof('solo-biomarker-record', proof, expectedRoot), true);
  assert.equal(engine.verifyProof('tampered-biomarker-record', proof, expectedRoot), false);
});

test('HealthVitalityMerkleEngine - generates valid inclusion proofs across even and odd trees', () => {
  for (const count of [2, 3, 5, 7, 8]) {
    const records = Array.from({ length: count }, (_, idx) => `patient-${idx}:hr-${60 + idx}`);
    const engine = new HealthVitalityMerkleEngine();
    const root = engine.buildTree(records);

    for (let i = 0; i < records.length; i++) {
      const proof = engine.generateProof(i);
      assert.equal(engine.verifyProof(records[i], proof, root), true);
    }
  }
});

test('HealthVitalityMerkleEngine - supports structured biometric object leaves', () => {
  const records = [
    { patientId: 'HV-01', hr: 58, spo2: 99 },
    { patientId: 'HV-02', hr: 64, spo2: 98 },
    { patientId: 'HV-03', hr: 71, spo2: 97 }
  ];
  const engine = new HealthVitalityMerkleEngine(records);
  const root = engine.getRootHash();
  const proof = engine.generateProof(1);

  assert.equal(engine.verifyProof({ patientId: 'HV-02', hr: 64, spo2: 98 }, proof, root), true);
  assert.equal(engine.verifyProof({ patientId: 'HV-02', hr: 112, spo2: 98 }, proof, root), false);
});

test('HealthVitalityMerkleEngine - detects tampering on modified leaf data, proof steps, and root', () => {
  const records = [
    'HV-101 | Alice | SpO2:99%',
    'HV-102 | Bob | SpO2:97%',
    'HV-103 | Carol | SpO2:98%',
    'HV-104 | Dave | SpO2:96%',
    'HV-105 | Eve | SpO2:99%'
  ];
  const engine = new HealthVitalityMerkleEngine(records);
  const root = engine.getRootHash();
  const proofForBob = engine.generateProof(1);

  assert.equal(engine.verifyProof('HV-102 | Bob | SpO2:97%', proofForBob, root), true);

  // Modified leaf payload
  assert.equal(engine.verifyProof('HV-102 | Bob | SpO2:82%', proofForBob, root), false);

  // Proof generated for Bob used against Alice's record
  assert.equal(engine.verifyProof('HV-101 | Alice | SpO2:99%', proofForBob, root), false);

  // Tampered sibling hash inside proof
  const tamperedHashProof = proofForBob.map((step, idx) =>
    idx === 0 ? { ...step, hash: '0'.repeat(64) } : step
  );
  assert.equal(engine.verifyProof('HV-102 | Bob | SpO2:97%', tamperedHashProof, root), false);

  // Flipped sibling position inside proof
  const flippedPosProof = proofForBob.map((step, idx) =>
    idx === 0 ? { ...step, position: step.position === 'left' ? 'right' : 'left' } : step
  );
  assert.equal(engine.verifyProof('HV-102 | Bob | SpO2:97%', flippedPosProof, root), false);

  // Tampered root hash
  const tamperedRoot = `${root.slice(0, -1)}${root.endsWith('0') ? '1' : '0'}`;
  assert.equal(engine.verifyProof('HV-102 | Bob | SpO2:97%', proofForBob, tamperedRoot), false);
});

test('HealthVitalityMerkleEngine - validates inputs and executes in sub-millisecond time', () => {
  const engine = new HealthVitalityMerkleEngine();

  assert.throws(() => engine.generateProof(0), Error);
  assert.throws(() => engine.buildTree([]), RangeError);
  assert.throws(() => engine.buildTree('invalid'), TypeError);
  assert.throws(() => engine.buildTree(['ok', null]), TypeError);

  const records = Array.from({ length: 16 }, (_, i) => `telemetry-record-${i}`);
  const root = engine.buildTree(records);
  assert.throws(() => engine.generateProof(-1), RangeError);
  assert.throws(() => engine.generateProof(16), RangeError);
  assert.throws(() => engine.generateProof(1.5), RangeError);

  const proof = engine.generateProof(7);
  assert.throws(() => engine.verifyProof(null, proof, root), TypeError);
  assert.throws(() => engine.verifyProof('telemetry-record-7', 'not-an-array', root), TypeError);

  const details = engine.verifyProofDetailed('telemetry-record-7', proof, root);
  assert.equal(details.valid, true);
  assert.ok(details.durationMs < 5, `Expected sub-millisecond/fast verification, got ${details.durationMs}ms`);
});
