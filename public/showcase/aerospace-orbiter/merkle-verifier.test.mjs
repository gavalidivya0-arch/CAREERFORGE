import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AerospaceOrbiterMerkleEngine, sha256Bytes } from './merkle-verifier.js';

function nodeSha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

test('sha256Bytes matches node:crypto FIPS 180-4 SHA-256 across block boundaries', () => {
  const vectors = [
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'AEROSPACE_ORBITER_TELEMETRY_PAYLOAD_'.repeat(5),
  ];

  for (const input of vectors) {
    const encoded = new TextEncoder().encode(input);
    assert.equal(bytesToHex(sha256Bytes(encoded)), nodeSha256Hex(encoded));
  }
});

test('AerospaceOrbiterMerkleEngine builds deterministic balanced binary trees', () => {
  const telemetry = [
    'PKT-01:ALT=408.2',
    'PKT-02:VEL=7.66',
    'PKT-03:TEMP=22.1',
    'PKT-04:FUEL=89.4',
  ];

  const engineA = new AerospaceOrbiterMerkleEngine();
  const engineB = new AerospaceOrbiterMerkleEngine();

  const rootA = engineA.buildTree(telemetry);
  const rootB = engineB.buildTree(telemetry);

  assert.match(rootA, /^[0-9a-f]{64}$/);
  assert.equal(rootA, rootB);
  assert.equal(engineA.getRootHash(), rootA);
  assert.equal(engineA.getTreeDepth(), 2);
  assert.deepEqual(engineA.levels.map((lvl) => lvl.length), [4, 2, 1]);

  // Verify root independently with domain-separated SHA-256
  const leafHashes = telemetry.map((item) =>
    createHash('sha256')
      .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(item)]))
      .digest()
  );
  const n0 = createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x01]), leafHashes[0], leafHashes[1]]))
    .digest();
  const n1 = createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x01]), leafHashes[2], leafHashes[3]]))
    .digest();
  const expectedRoot = nodeSha256Hex(Buffer.concat([Buffer.from([0x01]), n0, n1]));

  assert.equal(rootA, expectedRoot);
});

test('AerospaceOrbiterMerkleEngine generates and verifies proofs for single, even, and odd datasets', () => {
  const datasets = [
    ['SINGLE_PACKET'],
    ['PKT-1', 'PKT-2'],
    ['PKT-1', 'PKT-2', 'PKT-3'],
    ['PKT-1', 'PKT-2', 'PKT-3', 'PKT-4', 'PKT-5'],
    ['PKT-1', 'PKT-2', 'PKT-3', 'PKT-4', 'PKT-5', 'PKT-6', 'PKT-7'],
  ];

  for (const data of datasets) {
    const engine = new AerospaceOrbiterMerkleEngine();
    const root = engine.buildTree(data);

    for (let i = 0; i < data.length; i++) {
      const proof = engine.generateProof(i);
      assert.equal(engine.verifyProof(data[i], proof, root), true);
    }
  }
});

test('AerospaceOrbiterMerkleEngine detects tampered leaf data, sibling hashes, positions, and root', () => {
  const telemetry = [
    { packet: 'ORB-01', deltaV: 12.4 },
    { packet: 'ORB-02', deltaV: 8.9 },
    { packet: 'ORB-03', deltaV: 3.1 },
    { packet: 'ORB-04', deltaV: 0.4 },
    { packet: 'ORB-05', deltaV: 15.2 },
  ];

  const engine = new AerospaceOrbiterMerkleEngine();
  const root = engine.buildTree(telemetry);
  const proof = engine.generateProof(2);

  // Canonical key order invariance holds for untampered object
  assert.equal(engine.verifyProof({ deltaV: 3.1, packet: 'ORB-03' }, proof, root), true);

  // Modified leaf payload fails verification
  assert.equal(engine.verifyProof({ packet: 'ORB-03', deltaV: 3.2 }, proof, root), false);

  // Modified sibling hash in proof fails verification
  const tamperedProofHash = [
    { ...proof[0], hash: 'f'.repeat(64) },
    ...proof.slice(1),
  ];
  assert.equal(engine.verifyProof(telemetry[2], tamperedProofHash, root), false);

  // Flipped sibling position fails verification
  const flippedPositionProof = [
    { ...proof[0], position: proof[0].position === 'left' ? 'right' : 'left' },
    ...proof.slice(1),
  ];
  assert.equal(engine.verifyProof(telemetry[2], flippedPositionProof, root), false);

  // Modified root hash fails verification
  assert.equal(engine.verifyProof(telemetry[2], proof, '0'.repeat(64)), false);
});

test('AerospaceOrbiterMerkleEngine validates inputs and preserves existing tree on error', () => {
  const engine = new AerospaceOrbiterMerkleEngine();
  assert.equal(engine.getRootHash(), null);
  assert.throws(() => engine.generateProof(0), /before building/);
  assert.throws(() => engine.buildTree([]), TypeError);

  const initialRoot = engine.buildTree(['A', 'B']);
  assert.throws(() => engine.buildTree([null]), TypeError);
  assert.equal(engine.getRootHash(), initialRoot);
  assert.throws(() => engine.generateProof(-1), RangeError);
  assert.throws(() => engine.generateProof(2), RangeError);
  assert.throws(() => engine.generateProof(0.5), RangeError);
});

test('AerospaceOrbiterMerkleEngine verifies inclusion proof in sub-millisecond time', () => {
  const telemetry = Array.from({ length: 64 }, (_, i) => `ORB-TELEMETRY-${i}`);
  const engine = new AerospaceOrbiterMerkleEngine();
  const root = engine.buildTree(telemetry);
  const proof = engine.generateProof(37);

  // Warm-up call
  assert.equal(engine.verifyProof(telemetry[37], proof, root), true);

  const start = performance.now();
  const verified = engine.verifyProof(telemetry[37], proof, root);
  const elapsedMs = performance.now() - start;

  assert.equal(verified, true);
  assert.ok(elapsedMs < 1, `Expected sub-millisecond verification, got ${elapsedMs} ms`);
});
