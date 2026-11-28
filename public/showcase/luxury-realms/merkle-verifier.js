/**
 * Luxury Realms — Merkle Tree Data Integrity & Cryptographic Proof Verification Engine
 * Issue #4140 — NSoC '26 Level 3 Core Engine
 *
 * Self-contained ES module: runs in both modern browsers and Node.js without external dependencies.
 */

const utf8Encoder = new TextEncoder();

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

const W_BUFFER = new Uint32Array(64);

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Synchronous FIPS 180-4 SHA-256 hash returning a 64-character lowercase hex digest.
 * @param {string} message
 * @returns {string}
 */
export function sha256(message) {
  const bytes = utf8Encoder.encode(String(message));
  const byteLen = bytes.length;
  const bitLen = byteLen * 8;

  // Pad to a multiple of 64 bytes (512 bits): data + 0x80 + zeros + 8-byte big-endian length
  const paddedLen = Math.ceil((byteLen + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[byteLen] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  let h0 = SHA256_INIT[0];
  let h1 = SHA256_INIT[1];
  let h2 = SHA256_INIT[2];
  let h3 = SHA256_INIT[3];
  let h4 = SHA256_INIT[4];
  let h5 = SHA256_INIT[5];
  let h6 = SHA256_INIT[6];
  let h7 = SHA256_INIT[7];

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W_BUFFER[i] = view.getUint32(offset + i * 4, false);
    }

    for (let i = 16; i < 64; i++) {
      const w15 = W_BUFFER[i - 15];
      const w2 = W_BUFFER[i - 2];
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W_BUFFER[i] = (W_BUFFER[i - 16] + s0 + W_BUFFER[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + W_BUFFER[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

export class LuxuryRealmsMerkleEngine {
  /**
   * @param {{ hashFn?: (input: string) => string }} [options]
   */
  constructor(options = {}) {
    this.hashFn = typeof options.hashFn === 'function' ? options.hashFn : sha256;
    this.rawLeaves = [];
    this.leaves = [];
    this.levels = [];
    this.rootHash = null;
    this.lastBuildTimeMs = 0;
    this.lastVerifyTimeMs = 0;
  }

  serializeLeaf(data) {
    if (typeof data === 'string') return data;
    if (data === null || data === undefined) return String(data);
    return JSON.stringify(data);
  }

  hashLeaf(data) {
    return this.hashFn(this.serializeLeaf(data));
  }

  hashPair(leftHash, rightHash) {
    return this.hashFn(`${leftHash}${rightHash}`);
  }

  /**
   * Builds a balanced binary Merkle tree from the provided dataset.
   * Odd node counts at any level duplicate the final hash to maintain pairing.
   * @param {Array<*>} dataArray
   */
  buildTree(dataArray) {
    if (!Array.isArray(dataArray)) {
      throw new TypeError('buildTree requires an array of leaf records');
    }

    const start = nowMs();

    if (dataArray.length === 0) {
      this.rawLeaves = [];
      this.leaves = [];
      this.levels = [];
      this.rootHash = null;
      this.lastBuildTimeMs = nowMs() - start;
      return {
        rootHash: null,
        depth: 0,
        leafCount: 0,
        levels: [],
        durationMs: this.lastBuildTimeMs
      };
    }

    this.rawLeaves = [...dataArray];
    this.leaves = dataArray.map((item) => this.hashLeaf(item));

    const levels = [this.leaves];
    let currentLevel = this.leaves;

    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : currentLevel[i];
        nextLevel.push(this.hashPair(left, right));
      }
      levels.push(nextLevel);
      currentLevel = nextLevel;
    }

    this.levels = levels;
    this.rootHash = levels[levels.length - 1][0];
    this.lastBuildTimeMs = nowMs() - start;

    return {
      rootHash: this.rootHash,
      depth: this.levels.length,
      leafCount: this.leaves.length,
      levels: this.getLevels(),
      durationMs: this.lastBuildTimeMs
    };
  }

  getRootHash() {
    return this.rootHash;
  }

  getDepth() {
    return this.levels.length;
  }

  getLevels() {
    return this.levels.map((level) => [...level]);
  }

  /**
   * Generates the cryptographic audit path (Merkle inclusion proof) for leaf at `index`.
   * @param {number} index
   * @returns {Array<{ hash: string, position: 'left' | 'right', level: number, siblingIndex: number }>}
   */
  generateProof(index) {
    if (this.leaves.length === 0) {
      throw new RangeError('Cannot generate proof from an empty Merkle tree');
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new RangeError(`Leaf index ${index} out of bounds [0, ${this.leaves.length - 1}]`);
    }

    const proof = [];
    let currentIndex = index;

    for (let levelIndex = 0; levelIndex < this.levels.length - 1; levelIndex++) {
      const level = this.levels[levelIndex];
      const isRightNode = currentIndex % 2 === 1;
      const rawSiblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      const siblingIndex = rawSiblingIndex < level.length ? rawSiblingIndex : currentIndex;

      proof.push({
        hash: level[siblingIndex],
        position: isRightNode ? 'left' : 'right',
        level: levelIndex,
        siblingIndex
      });

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Verifies a leaf's inclusion proof against an expected root hash and returns detailed trace data.
   * @param {*} leaf
   * @param {Array<{ hash: string, position: 'left' | 'right' }>} proof
   * @param {string} root
   */
  verifyProofDetailed(leaf, proof, root) {
    const start = nowMs();

    if (typeof root !== 'string' || root.length === 0 || !Array.isArray(proof)) {
      this.lastVerifyTimeMs = nowMs() - start;
      return {
        valid: false,
        leafHash: null,
        computedRoot: null,
        expectedRoot: root ?? null,
        steps: [],
        durationMs: this.lastVerifyTimeMs
      };
    }

    let currentHash = this.hashLeaf(leaf);
    const leafHash = currentHash;
    const steps = [];

    for (let i = 0; i < proof.length; i++) {
      const sibling = proof[i];
      if (
        !sibling ||
        typeof sibling.hash !== 'string' ||
        (sibling.position !== 'left' && sibling.position !== 'right')
      ) {
        this.lastVerifyTimeMs = nowMs() - start;
        return {
          valid: false,
          leafHash,
          computedRoot: null,
          expectedRoot: root,
          steps,
          durationMs: this.lastVerifyTimeMs
        };
      }

      const left = sibling.position === 'left' ? sibling.hash : currentHash;
      const right = sibling.position === 'left' ? currentHash : sibling.hash;
      const nextHash = this.hashPair(left, right);

      steps.push({
        level: i,
        inputHash: currentHash,
        siblingHash: sibling.hash,
        position: sibling.position,
        outputHash: nextHash
      });

      currentHash = nextHash;
    }

    const durationMs = nowMs() - start;
    this.lastVerifyTimeMs = durationMs;

    return {
      valid: currentHash === root,
      leafHash,
      computedRoot: currentHash,
      expectedRoot: root,
      steps,
      durationMs
    };
  }

  /**
   * Verifies inclusion of `leaf` via `proof` against `root`.
   * @param {*} leaf
   * @param {Array<{ hash: string, position: 'left' | 'right' }>} proof
   * @param {string} root
   * @returns {boolean}
   */
  verifyProof(leaf, proof, root) {
    return this.verifyProofDetailed(leaf, proof, root).valid;
  }
}

// Browser UI Controller
const DEFAULT_DATASET = [
  'The Azure Atoll Sanctuary | Title Deed #LR-001 | $42,000,000',
  'Global Express 7500 Tail N750LR | Airworthiness #AV-204 | $75,000,000',
  'St. Barts Cliffside Villa | Escrow Settlement #ES-889 | $28,500,000',
  'Geneva Sovereign Vault Lot #GV-512 | Custody Hash #CU-118 | $19,200,000',
  'Monaco Superyacht Berth #M-17 | Maritime Registry #MR-404 | $14,800,000',
  'Gstaad Alpine Chalet | Sovereign Deed #CH-309 | $34,600,000'
];

function shortHash(hash, length = 12) {
  if (!hash) return '—';
  return `${hash.slice(0, length)}…${hash.slice(-6)}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMs(ms) {
  if (ms < 0.01) return '< 0.01 ms';
  return `${ms.toFixed(3)} ms`;
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const engine = new LuxuryRealmsMerkleEngine();

    const datasetInput = document.getElementById('datasetInput');
    const newRecordInput = document.getElementById('newRecordInput');
    const addRecordBtn = document.getElementById('addRecordBtn');
    const buildTreeBtn = document.getElementById('buildTreeBtn');
    const resetDatasetBtn = document.getElementById('resetDatasetBtn');

    const rootStatusPill = document.getElementById('rootStatusPill');
    const rootHashDisplay = document.getElementById('rootHashDisplay');
    const treeDepthMetric = document.getElementById('treeDepthMetric');
    const leafCountMetric = document.getElementById('leafCountMetric');
    const execTimeMetric = document.getElementById('execTimeMetric');

    const leafSelect = document.getElementById('leafSelect');
    const claimedLeafInput = document.getElementById('claimedLeafInput');
    const verifyProofBtn = document.getElementById('verifyProofBtn');
    const simulateTamperBtn = document.getElementById('simulateTamperBtn');
    const restoreLeafBtn = document.getElementById('restoreLeafBtn');

    const proofStatusCard = document.getElementById('proofStatusCard');
    const verificationBadge = document.getElementById('verificationBadge');
    const verificationSummary = document.getElementById('verificationSummary');
    const expectedRootValue = document.getElementById('expectedRootValue');
    const computedRootValue = document.getElementById('computedRootValue');
    const auditPathList = document.getElementById('auditPathList');
    const treeVisualizer = document.getElementById('treeVisualizer');

    let activeIndex = 0;
    let currentProof = [];
    let currentVerification = null;

    function parseDataset() {
      if (!datasetInput) return [];
      return datasetInput.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }

    function setRootPillState(state, label) {
      if (!rootStatusPill) return;
      rootStatusPill.textContent = label;
      rootStatusPill.className = `root-status-pill status-${state}`;
    }

    function populateLeafSelector(records) {
      if (!leafSelect) return;
      leafSelect.innerHTML = records
        .map((record, idx) => `<option value="${idx}">Leaf #${idx}: ${escapeHtml(record.slice(0, 48))}${record.length > 48 ? '…' : ''}</option>`)
        .join('');
      if (records.length > 0) {
        activeIndex = Math.min(activeIndex, records.length - 1);
        leafSelect.value = String(activeIndex);
      }
    }

    function getHighlightedNodeSets() {
      const pathNodes = new Set();
      const siblingNodes = new Set();

      if (!currentProof.length || engine.getDepth() === 0) {
        return { pathNodes, siblingNodes };
      }

      let cursor = activeIndex;
      for (let lvl = 0; lvl < engine.levels.length; lvl++) {
        pathNodes.add(`${lvl}:${cursor}`);
        if (lvl < currentProof.length) {
          siblingNodes.add(`${lvl}:${currentProof[lvl].siblingIndex}`);
        }
        cursor = Math.floor(cursor / 2);
      }

      return { pathNodes, siblingNodes };
    }

    function renderTree() {
      if (!treeVisualizer) return;
      const levels = engine.getLevels();

      if (levels.length === 0) {
        treeVisualizer.innerHTML = '<div class="empty-tree-state">Add at least one record and build the Merkle tree to inspect node hierarchy.</div>';
        return;
      }

      const { pathNodes, siblingNodes } = getHighlightedNodeSets();
      const isVerified = currentVerification ? currentVerification.valid : false;
      const isTampered = currentVerification ? !currentVerification.valid : false;

      // Render top-down from Root (levels.length - 1) down to Leaves (0)
      const levelBlocks = [];
      for (let lvl = levels.length - 1; lvl >= 0; lvl--) {
        const nodes = levels[lvl];
        const levelLabel =
          lvl === levels.length - 1
            ? `Root (Level ${lvl})`
            : lvl === 0
              ? `Leaves (Level 0 • ${nodes.length})`
              : `Internal (Level ${lvl} • ${nodes.length})`;

        const nodeCards = nodes
          .map((hash, idx) => {
            const key = `${lvl}:${idx}`;
            const isTargetPath = pathNodes.has(key);
            const isSibling = siblingNodes.has(key);
            const classes = ['tree-node'];
            if (lvl === levels.length - 1) classes.push('tree-node-root');
            if (lvl === 0) classes.push('tree-node-leaf');

            if (isTargetPath) {
              classes.push(isTampered ? 'node-tampered' : isVerified ? 'node-verified' : 'node-active');
            } else if (isSibling) {
              classes.push('node-proof-sibling');
            }

            const rawLabel =
              lvl === 0 && engine.rawLeaves[idx]
                ? `<div class="node-raw">${escapeHtml(String(engine.rawLeaves[idx]).slice(0, 26))}${String(engine.rawLeaves[idx]).length > 26 ? '…' : ''}</div>`
                : '';

            const roleTag =
              lvl === levels.length - 1
                ? 'ROOT'
                : isTargetPath && lvl === 0
                  ? 'TARGET LEAF'
                  : isSibling
                    ? 'PROOF SIBLING'
                    : `L${lvl}#${idx}`;

            return `
              <div class="tree-node-slot ${lvl < levels.length - 1 ? 'has-parent-connector' : ''}" data-level="${lvl}" data-index="${idx}">
                <div class="${classes.join(' ')}" title="${hash}">
                  <div class="node-meta">
                    <span class="node-role">${roleTag}</span>
                    <span class="node-idx">#${idx}</span>
                  </div>
                  <div class="node-hash">${shortHash(hash, 10)}</div>
                  ${rawLabel}
                </div>
              </div>
            `;
          })
          .join('');

        levelBlocks.push(`
          <div class="tree-level ${lvl === levels.length - 1 ? 'is-root-level' : ''} ${lvl === 0 ? 'is-leaf-level' : ''}">
            <div class="level-badge">${levelLabel}</div>
            <div class="level-nodes">${nodeCards}</div>
          </div>
        `);
      }

      treeVisualizer.innerHTML = levelBlocks.join('');
    }

    function renderProofSection() {
      if (!proofStatusCard) return;

      const root = engine.getRootHash();
      if (!root) {
        setRootPillState('idle', 'NO ROOT');
        if (verificationBadge) {
          verificationBadge.textContent = 'AWAITING TREE';
          verificationBadge.className = 'verification-badge status-idle';
        }
        if (verificationSummary) {
          verificationSummary.textContent = 'Build a Merkle tree to compute a root hash and verify inclusion proofs.';
        }
        if (expectedRootValue) expectedRootValue.textContent = '—';
        if (computedRootValue) computedRootValue.textContent = '—';
        if (auditPathList) auditPathList.innerHTML = '';
        proofStatusCard.classList.remove('status-card-verified', 'status-card-tampered');
        return;
      }

      const valid = currentVerification?.valid ?? false;
      proofStatusCard.classList.toggle('status-card-verified', valid);
      proofStatusCard.classList.toggle('status-card-tampered', !valid);

      setRootPillState(valid ? 'verified' : 'tampered', valid ? 'ROOT VERIFIED' : 'TAMPER DETECTED');

      if (verificationBadge) {
        verificationBadge.textContent = valid ? 'PROOF VALID' : 'PROOF FAILED (TAMPERED)';
        verificationBadge.className = `verification-badge ${valid ? 'status-verified' : 'status-tampered'}`;
      }

      if (verificationSummary) {
        verificationSummary.textContent = valid
          ? `Inclusion proof for Leaf #${activeIndex} matched the anchored Merkle Root in ${formatMs(currentVerification.durationMs)}.`
          : `Integrity mismatch! Recomputed root hash diverges from the anchored Merkle Root (${formatMs(currentVerification.durationMs)}).`;
      }

      if (expectedRootValue) expectedRootValue.textContent = root;
      if (computedRootValue) computedRootValue.textContent = currentVerification?.computedRoot || '—';
      if (execTimeMetric) {
        execTimeMetric.textContent = formatMs(engine.lastBuildTimeMs + (currentVerification?.durationMs ?? 0));
      }

      if (auditPathList) {
        if (currentProof.length === 0) {
          auditPathList.innerHTML = '<li class="audit-step-empty">Single-leaf tree: leaf hash equals root hash (0 sibling steps).</li>';
        } else {
          auditPathList.innerHTML = currentProof
            .map(
              (step, idx) => `
              <li class="audit-step">
                <span class="step-num">Step ${idx + 1}</span>
                <span class="step-dir step-dir-${step.position}">${step.position.toUpperCase()} SIBLING</span>
                <code class="step-hash">${shortHash(step.hash, 14)}</code>
              </li>
            `
            )
            .join('');
        }
      }
    }

    function runVerification(payloadOverride = null) {
      const root = engine.getRootHash();
      if (!root) {
        currentProof = [];
        currentVerification = null;
        renderProofSection();
        renderTree();
        return;
      }

      currentProof = engine.generateProof(activeIndex);
      const claimedPayload =
        payloadOverride !== null
          ? payloadOverride
          : claimedLeafInput
            ? claimedLeafInput.value
            : engine.rawLeaves[activeIndex];

      currentVerification = engine.verifyProofDetailed(claimedPayload, currentProof, root);
      renderProofSection();
      renderTree();
    }

    function rebuildFromDataset() {
      const records = parseDataset();
      const summary = engine.buildTree(records);

      if (rootHashDisplay) rootHashDisplay.textContent = summary.rootHash || '—';
      if (treeDepthMetric) treeDepthMetric.textContent = `${summary.depth} levels`;
      if (leafCountMetric) leafCountMetric.textContent = `${summary.leafCount} leaves`;
      if (execTimeMetric) execTimeMetric.textContent = formatMs(summary.durationMs);

      populateLeafSelector(records);

      if (records.length > 0 && claimedLeafInput) {
        claimedLeafInput.value = records[activeIndex];
      } else if (claimedLeafInput) {
        claimedLeafInput.value = '';
      }

      runVerification();
    }

    if (buildTreeBtn) {
      buildTreeBtn.addEventListener('click', rebuildFromDataset);
    }

    if (addRecordBtn && newRecordInput && datasetInput) {
      addRecordBtn.addEventListener('click', () => {
        const entry = newRecordInput.value.trim();
        if (!entry) return;
        const current = datasetInput.value.trim();
        datasetInput.value = current ? `${current}\n${entry}` : entry;
        newRecordInput.value = '';
        rebuildFromDataset();
      });
    }

    if (resetDatasetBtn && datasetInput) {
      resetDatasetBtn.addEventListener('click', () => {
        datasetInput.value = DEFAULT_DATASET.join('\n');
        activeIndex = 0;
        rebuildFromDataset();
      });
    }

    if (leafSelect) {
      leafSelect.addEventListener('change', () => {
        activeIndex = Number.parseInt(leafSelect.value, 10) || 0;
        if (claimedLeafInput && engine.rawLeaves[activeIndex] !== undefined) {
          claimedLeafInput.value = engine.rawLeaves[activeIndex];
        }
        runVerification();
      });
    }

    if (verifyProofBtn) {
      verifyProofBtn.addEventListener('click', () => {
        runVerification();
      });
    }

    if (simulateTamperBtn && claimedLeafInput) {
      simulateTamperBtn.addEventListener('click', () => {
        if (!engine.getRootHash()) return;
        const original = engine.rawLeaves[activeIndex] ?? '';
        const tampered = original.includes('$')
          ? original.replace(/\$[\d,]+/, '$999,999,999 [FORGED]')
          : `${original} [TAMPERED]`;
        claimedLeafInput.value = tampered;
        runVerification(tampered);
      });
    }

    if (restoreLeafBtn && claimedLeafInput) {
      restoreLeafBtn.addEventListener('click', () => {
        if (!engine.getRootHash()) return;
        const authentic = engine.rawLeaves[activeIndex] ?? '';
        claimedLeafInput.value = authentic;
        runVerification(authentic);
      });
    }

    if (datasetInput && !datasetInput.value.trim()) {
      datasetInput.value = DEFAULT_DATASET.join('\n');
    }
    rebuildFromDataset();
  });
}
