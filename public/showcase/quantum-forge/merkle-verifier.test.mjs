import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { QuantumForgeMerkleEngine, sha256 } from './merkle-verifier.js';

function nodeSha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('QuantumForgeMerkleEngine', () => {
  it('computes standard FIPS 180-4 SHA-256 digests matching node:crypto', () => {
    const vectors = [
      '',
      'abc',
      'Q0:HADAMARD(pi/2)',
      'quantum-forge-merkle-root-2026',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      '⚛️ quantum-entanglement-ψ'
    ];
    for (const input of vectors) {
      assert.equal(sha256(input), nodeSha256(input));
    }
  });

  it('builds a balanced binary Merkle tree and deterministic root hash', () => {
    const dataset = ['tx-alpha', 'tx-beta', 'tx-gamma', 'tx-delta'];
    const engine = new QuantumForgeMerkleEngine();
    const root = engine.buildTree(dataset);

    const h0 = nodeSha256('tx-alpha');
    const h1 = nodeSha256('tx-beta');
    const h2 = nodeSha256('tx-gamma');
    const h3 = nodeSha256('tx-delta');
    const h01 = nodeSha256(h0 + h1);
    const h23 = nodeSha256(h2 + h3);
    const expectedRoot = nodeSha256(h01 + h23);

    assert.equal(root, expectedRoot);
    assert.equal(engine.getRootHash(), expectedRoot);
    assert.equal(engine.getDepth(), 2);
  });

  it('handles odd-length datasets and single-leaf trees cleanly', () => {
    const oddEngine = new QuantumForgeMerkleEngine(['leaf-0', 'leaf-1', 'leaf-2']);
    const l0 = nodeSha256('leaf-0');
    const l1 = nodeSha256('leaf-1');
    const l2 = nodeSha256('leaf-2');
    const expectedOddRoot = nodeSha256(nodeSha256(l0 + l1) + nodeSha256(l2 + l2));

    assert.equal(oddEngine.getRootHash(), expectedOddRoot);
    for (let i = 0; i < 3; i++) {
      const proof = oddEngine.generateProof(i);
      assert.equal(oddEngine.verifyProof(`leaf-${i}`, proof, expectedOddRoot), true);
    }

    const singleEngine = new QuantumForgeMerkleEngine(['solo-qubit']);
    assert.equal(singleEngine.getRootHash(), nodeSha256('solo-qubit'));
    assert.equal(singleEngine.getDepth(), 0);
    const soloProof = singleEngine.generateProof(0);
    assert.deepEqual(soloProof, []);
    assert.equal(singleEngine.verifyProof('solo-qubit', soloProof, singleEngine.getRootHash()), true);
  });

  it('generates and verifies valid inclusion proofs for every leaf', () => {
    const dataset = [
      'Q0:HADAMARD',
      'Q1:PAULI-X',
      'Q2:CNOT',
      'Q3:PHASE',
      'Q4:SWAP',
      'Q5:MEASURE'
    ];
    const engine = new QuantumForgeMerkleEngine();
    const root = engine.buildTree(dataset);

    for (let i = 0; i < dataset.length; i++) {
      const proof = engine.generateProof(i);
      const isValid = engine.verifyProof(dataset[i], proof, root);
      assert.equal(isValid, true);
    }
  });

  it('detects tampering on modified leaf data, altered proof siblings, or wrong root', () => {
    const dataset = ['block-1', 'block-2', 'block-3', 'block-4'];
    const engine = new QuantumForgeMerkleEngine(dataset);
    const root = engine.getRootHash();
    const proof = engine.generateProof(1);

    assert.equal(engine.verifyProof('block-2', proof, root), true);
    assert.equal(engine.verifyProof('block-2-tampered', proof, root), false);
    assert.equal(engine.verifyProof('block-1', proof, root), false);

    const corruptedProof = proof.map((step, idx) =>
      idx === 0 ? { ...step, hash: nodeSha256('forged-sibling') } : step
    );
    assert.equal(engine.verifyProof('block-2', corruptedProof, root), false);
    assert.equal(engine.verifyProof('block-2', proof, nodeSha256('wrong-root')), false);
  });

  it('handles empty datasets and rejects out-of-bounds proof indices', () => {
    const engine = new QuantumForgeMerkleEngine();
    assert.equal(engine.buildTree([]), null);
    assert.equal(engine.getRootHash(), null);
    assert.throws(() => engine.generateProof(0), /empty/i);

    engine.buildTree(['only-one']);
    assert.throws(() => engine.generateProof(-1), RangeError);
    assert.throws(() => engine.generateProof(1), RangeError);
  });

  it('executes proof verification in sub-millisecond time', () => {
    const dataset = Array.from({ length: 64 }, (_, i) => `qubit-gate-event-${i}`);
    const engine = new QuantumForgeMerkleEngine(dataset);
    const root = engine.getRootHash();
    const proof = engine.generateProof(37);

    const details = engine.verifyProofDetailed(dataset[37], proof, root);
    assert.equal(details.isValid, true);
    assert.ok(details.executionTimeMs < 5, `Expected sub-millisecond/low-ms execution, got ${details.executionTimeMs}ms`);
  });
});
