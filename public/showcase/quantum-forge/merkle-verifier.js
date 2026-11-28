/**
 * Quantum Forge — Merkle Tree Data Integrity & Cryptographic Proof Verification Engine
 * Issue #4155 — Isolated Modular Implementation
 *
 * Implements FIPS 180-4 SHA-256 hashing in pure JavaScript for deterministic,
 * sub-millisecond, zero-dependency execution across both Browser and Node.js.
 */

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

const textEncoder = new TextEncoder();

/**
 * Computes a standard SHA-256 hex digest for UTF-8 input.
 * @param {string} input
 * @returns {string} 64-character lowercase hexadecimal digest
 */
export function sha256(input) {
  const bytes = textEncoder.encode(String(input));
  const bitLen = bytes.length * 8;

  // Pad with 0x80, zeros, and 64-bit big-endian length so total length % 64 === 0
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  let [h0, h1, h2, h3, h4, h5, h6, h7] = SHA256_INIT;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }

    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
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
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
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

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function serializeLeaf(item) {
  if (typeof item === 'string') return item;
  if (item === null || item === undefined) return String(item);
  if (typeof item === 'object') return JSON.stringify(item);
  return String(item);
}

/**
 * Cryptographic Merkle tree builder, audit-path generator, and verifier.
 */
export class QuantumForgeMerkleEngine {
  constructor(initialData = []) {
    this.rawLeaves = [];
    this.levels = [];
    this.rootHash = null;
    this.lastBuildTimeMs = 0;

    if (Array.isArray(initialData) && initialData.length > 0) {
      this.buildTree(initialData);
    }
  }

  /**
   * Builds a balanced binary SHA-256 Merkle tree from an array of data items.
   * Odd-length levels duplicate their trailing node to preserve binary pairing.
   * @param {Array<unknown>} dataArray
   * @returns {string|null} Computed Merkle root hash (or null for empty input)
   */
  buildTree(dataArray) {
    if (!Array.isArray(dataArray)) {
      throw new TypeError('buildTree expects an array of leaf items.');
    }

    const start = nowMs();

    if (dataArray.length === 0) {
      this.rawLeaves = [];
      this.levels = [];
      this.rootHash = null;
      this.lastBuildTimeMs = Number((nowMs() - start).toFixed(4));
      return null;
    }

    this.rawLeaves = dataArray.map((item) => serializeLeaf(item));
    const leafLevel = this.rawLeaves.map((serialized, index) => ({
      hash: sha256(serialized),
      label: serialized,
      index,
      level: 0,
      duplicated: false
    }));

    const levels = [leafLevel];
    let current = leafLevel;
    let levelIdx = 1;

    while (current.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = i + 1 < current.length ? current[i + 1] : current[i];
        const combinedHash = sha256(left.hash + right.hash);

        nextLevel.push({
          hash: combinedHash,
          leftHash: left.hash,
          rightHash: right.hash,
          leftIndex: i,
          rightIndex: i + 1 < current.length ? i + 1 : i,
          duplicatedRight: i + 1 >= current.length,
          index: nextLevel.length,
          level: levelIdx
        });
      }
      levels.push(nextLevel);
      current = nextLevel;
      levelIdx += 1;
    }

    this.levels = levels;
    this.rootHash = current[0].hash;
    this.lastBuildTimeMs = Number((nowMs() - start).toFixed(4));
    return this.rootHash;
  }

  /**
   * Returns the current Merkle root hash, or null if no tree is built.
   * @returns {string|null}
   */
  getRootHash() {
    return this.rootHash;
  }

  /**
   * Returns tree depth (number of hashing layers above leaves; 0 for single leaf or empty).
   * @returns {number}
   */
  getDepth() {
    return Math.max(0, this.levels.length - 1);
  }

  /**
   * Returns levels ordered from root (top) to leaves (bottom) for visualization.
   * @returns {Array<Array<object>>}
   */
  getLevelsTopDown() {
    return [...this.levels].reverse();
  }

  /**
   * Generates a cryptographic inclusion proof (audit path) for a leaf at `index`.
   * @param {number} index
   * @returns {Array<{hash: string, position: 'left'|'right', level: number, siblingIndex: number}>}
   */
  generateProof(index) {
    if (this.levels.length === 0) {
      throw new Error('Cannot generate proof from an empty Merkle tree.');
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.rawLeaves.length) {
      throw new RangeError(`Leaf index ${index} is out of bounds (0..${this.rawLeaves.length - 1}).`);
    }

    const proof = [];
    let currentIndex = index;

    for (let level = 0; level < this.levels.length - 1; level++) {
      const nodes = this.levels[level];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode
        ? currentIndex - 1
        : (currentIndex + 1 < nodes.length ? currentIndex + 1 : currentIndex);

      proof.push({
        hash: nodes[siblingIndex].hash,
        position: isRightNode ? 'left' : 'right',
        level,
        siblingIndex
      });

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Verifies a Merkle inclusion proof against an expected root hash.
   * @param {unknown} leaf
   * @param {Array<{hash: string, position: 'left'|'right'}>} proof
   * @param {string} root
   * @returns {boolean}
   */
  verifyProof(leaf, proof, root) {
    return this.verifyProofDetailed(leaf, proof, root).isValid;
  }

  /**
   * Verifies a Merkle inclusion proof and returns execution timing and step trace.
   * @param {unknown} leaf
   * @param {Array<{hash: string, position: 'left'|'right'}>} proof
   * @param {string} root
   * @returns {{isValid: boolean, leafHash: string|null, computedRoot: string|null, expectedRoot: string|null, executionTimeMs: number, steps: Array<object>}}
   */
  verifyProofDetailed(leaf, proof, root) {
    const start = nowMs();

    if (leaf === undefined || leaf === null || !Array.isArray(proof) || typeof root !== 'string' || root.length === 0) {
      return {
        isValid: false,
        leafHash: null,
        computedRoot: null,
        expectedRoot: typeof root === 'string' ? root : null,
        executionTimeMs: Number((nowMs() - start).toFixed(4)),
        steps: []
      };
    }

    const leafHash = sha256(serializeLeaf(leaf));
    let currentHash = leafHash;
    const steps = [];

    for (let i = 0; i < proof.length; i++) {
      const step = proof[i];
      if (!step || typeof step.hash !== 'string' || (step.position !== 'left' && step.position !== 'right')) {
        return {
          isValid: false,
          leafHash,
          computedRoot: null,
          expectedRoot: root,
          executionTimeMs: Number((nowMs() - start).toFixed(4)),
          steps
        };
      }

      const leftHash = step.position === 'left' ? step.hash : currentHash;
      const rightHash = step.position === 'right' ? step.hash : currentHash;
      const nextHash = sha256(leftHash + rightHash);

      steps.push({
        step: i + 1,
        siblingPosition: step.position,
        siblingHash: step.hash,
        inputLeft: leftHash,
        inputRight: rightHash,
        outputHash: nextHash
      });

      currentHash = nextHash;
    }

    const isValid = currentHash === root;
    return {
      isValid,
      leafHash,
      computedRoot: currentHash,
      expectedRoot: root,
      executionTimeMs: Number((nowMs() - start).toFixed(4)),
      steps
    };
  }
}

const DEFAULT_DATASET = [
  'Q0:HADAMARD(pi/2)|fidelity=0.9982',
  'Q1:PAULI-X(1.000)|fidelity=0.9991',
  'Q0-Q1:CNOT(ctrl=0,tgt=1)|fidelity=0.9940',
  'Q2:PHASE_SHIFT(pi/4)|fidelity=0.9975',
  'Q3:RY_ROTATION(1.5708)|fidelity=0.9964',
  'Q2-Q3:SWAP_ENTANGLE|fidelity=0.9928'
];

const PRESET_DATASETS = {
  balanced4: [
    'GATE_0:H(Q0)',
    'GATE_1:X(Q1)',
    'GATE_2:CNOT(Q0,Q1)',
    'GATE_3:MEASURE(Q0,Q1)'
  ],
  odd5: [
    'EPOCH_1:INIT(|000>)',
    'EPOCH_2:HADAMARD(Q0)',
    'EPOCH_3:CNOT(Q0,Q1)',
    'EPOCH_4:PHASE(Q2,pi/8)',
    'EPOCH_5:COLLAPSE(|101>)'
  ],
  quantum6: DEFAULT_DATASET,
  deep8: [
    'CALIB_0:T1=142us',
    'CALIB_1:T2=98us',
    'CALIB_2:DRAG_BETA=0.41',
    'CALIB_3:READOUT_ERR=0.008',
    'CALIB_4:XTALK=-42dB',
    'CALIB_5:RZ_VIRTUAL=1.047',
    'CALIB_6:ECHO_SEQ=XY8',
    'CALIB_7:FIDELITY=99.61%'
  ]
};

function shortHash(hash, len = 10) {
  if (!hash) return '—';
  return `${hash.slice(0, len)}…${hash.slice(-6)}`;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.QuantumForgeMerkleEngine = QuantumForgeMerkleEngine;

  document.addEventListener('DOMContentLoaded', () => {
    const engine = new QuantumForgeMerkleEngine();

    const datasetInput = document.getElementById('dataset-input');
    const buildBtn = document.getElementById('build-tree-btn');
    const leafSelect = document.getElementById('leaf-select');
    const payloadInput = document.getElementById('verify-payload-input');
    const verifyBtn = document.getElementById('verify-proof-btn');
    const tamperBtn = document.getElementById('tamper-btn');
    const restoreBtn = document.getElementById('restore-btn');
    const presetButtons = document.querySelectorAll('[data-preset]');

    const rootPill = document.getElementById('root-hash-pill');
    const rootText = document.getElementById('root-hash-text');
    const depthValue = document.getElementById('tree-depth-val');
    const leafCountValue = document.getElementById('leaf-count-val');
    const buildLatencyValue = document.getElementById('build-latency-val');
    const verifyLatencyValue = document.getElementById('verify-latency-val');

    const statusCard = document.getElementById('verification-status-card');
    const statusBadge = document.getElementById('verification-badge');
    const expectedRootEl = document.getElementById('expected-root-val');
    const computedRootEl = document.getElementById('computed-root-val');
    const auditStepsEl = document.getElementById('audit-steps-list');
    const treeCanvas = document.getElementById('merkle-tree-canvas');
    const treeEmptyMsg = document.getElementById('tree-empty-msg');

    let selectedIndex = 0;
    let isTampered = false;
    let lastVerification = null;

    function parseDataset() {
      return datasetInput.value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    function populateLeafSelector() {
      const leaves = engine.rawLeaves;
      leafSelect.innerHTML = '';

      if (leaves.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No leaves available';
        leafSelect.appendChild(opt);
        leafSelect.disabled = true;
        payloadInput.value = '';
        return;
      }

      leafSelect.disabled = false;
      if (selectedIndex >= leaves.length) {
        selectedIndex = 0;
      }

      leaves.forEach((leaf, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        const preview = leaf.length > 36 ? `${leaf.slice(0, 36)}…` : leaf;
        opt.textContent = `Leaf #${idx} — ${preview}`;
        leafSelect.appendChild(opt);
      });

      leafSelect.value = String(selectedIndex);
      if (!isTampered) {
        payloadInput.value = leaves[selectedIndex];
      }
    }

    function drawTreeConnectors(wrapper, svg) {
      const wrapperRect = wrapper.getBoundingClientRect();
      if (wrapperRect.width === 0 || wrapperRect.height === 0) return;

      svg.setAttribute('viewBox', `0 0 ${wrapperRect.width} ${wrapperRect.height}`);
      svg.setAttribute('width', String(wrapperRect.width));
      svg.setAttribute('height', String(wrapperRect.height));
      svg.innerHTML = '';

      const nodeElements = new Map();
      wrapper.querySelectorAll('[data-node-id]').forEach((el) => {
        nodeElements.set(el.dataset.nodeId, el);
      });

      for (let level = 1; level < engine.levels.length; level++) {
        const parentNodes = engine.levels[level];
        for (let i = 0; i < parentNodes.length; i++) {
          const parent = parentNodes[i];
          const parentEl = nodeElements.get(`${level}-${i}`);
          const leftEl = nodeElements.get(`${level - 1}-${parent.leftIndex}`);
          const rightEl = nodeElements.get(`${level - 1}-${parent.rightIndex}`);
          if (!parentEl || !leftEl) continue;

          const targets = parent.duplicatedRight ? [leftEl] : [leftEl, rightEl];
          const pRect = parentEl.getBoundingClientRect();
          const x1 = pRect.left - wrapperRect.left + pRect.width / 2;
          const y1 = pRect.bottom - wrapperRect.top;

          for (const childEl of targets) {
            if (!childEl) continue;
            const cRect = childEl.getBoundingClientRect();
            const x2 = cRect.left - wrapperRect.left + cRect.width / 2;
            const y2 = cRect.top - wrapperRect.top;
            const midY = (y1 + y2) / 2;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
            path.classList.add('tree-connector');

            if (childEl.classList.contains('node-tampered') && parentEl.classList.contains('node-tampered')) {
              path.classList.add('connector-tampered');
            } else if (
              (childEl.classList.contains('node-target') || childEl.classList.contains('node-verified') || childEl.classList.contains('node-sibling')) &&
              (parentEl.classList.contains('node-verified') || parentEl.classList.contains('node-root'))
            ) {
              path.classList.add('connector-active');
            }

            svg.appendChild(path);
          }
        }
      }
    }

    function computeActivePathIndices(proof) {
      const siblingSet = new Set();
      const computedSet = new Set();
      let idx = selectedIndex;
      computedSet.add(`0-${idx}`);

      for (const item of proof) {
        siblingSet.add(`${item.level}-${item.siblingIndex}`);
        idx = Math.floor(idx / 2);
        computedSet.add(`${item.level + 1}-${idx}`);
      }

      return { siblingSet, computedSet };
    }

    function renderTree(proof = []) {
      treeCanvas.innerHTML = '';

      if (engine.levels.length === 0) {
        treeEmptyMsg.hidden = false;
        return;
      }

      treeEmptyMsg.hidden = true;
      const { siblingSet, computedSet } = computeActivePathIndices(proof);
      const valid = lastVerification ? lastVerification.isValid : true;

      const wrapper = document.createElement('div');
      wrapper.className = 'tree-diagram';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('tree-connectors-svg');
      svg.setAttribute('aria-hidden', 'true');
      wrapper.appendChild(svg);

      const totalLevels = engine.levels.length;
      for (let level = totalLevels - 1; level >= 0; level--) {
        const nodes = engine.levels[level];
        const row = document.createElement('div');
        row.className = 'tree-level-row';

        const levelMeta = document.createElement('div');
        levelMeta.className = 'level-label';
        const depthFromRoot = totalLevels - 1 - level;
        levelMeta.textContent = level === totalLevels - 1
          ? `Depth ${depthFromRoot} · Root`
          : level === 0
            ? `Depth ${depthFromRoot} · Leaves`
            : `Depth ${depthFromRoot}`;
        row.appendChild(levelMeta);

        const nodesGroup = document.createElement('div');
        nodesGroup.className = 'level-nodes';

        nodes.forEach((node, idx) => {
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'merkle-node';
          card.dataset.nodeId = `${level}-${idx}`;

          const key = `${level}-${idx}`;
          const isRoot = level === totalLevels - 1;
          const isTargetLeaf = level === 0 && idx === selectedIndex;

          if (isRoot) card.classList.add('node-root');
          if (isTargetLeaf) card.classList.add('node-target');

          if (!valid && computedSet.has(key)) {
            card.classList.add('node-tampered');
          } else if (valid && computedSet.has(key)) {
            card.classList.add('node-verified');
          } else if (siblingSet.has(key)) {
            card.classList.add('node-sibling');
          }

          if (level === 0) {
            card.title = `Select Leaf #${idx}: ${node.label}`;
            card.addEventListener('click', () => {
              selectedIndex = idx;
              isTampered = false;
              leafSelect.value = String(idx);
              payloadInput.value = engine.rawLeaves[idx];
              runVerification();
            });
          } else {
            card.disabled = true;
          }

          const titleEl = document.createElement('span');
          titleEl.className = 'node-title';
          titleEl.textContent = isRoot
            ? 'MERKLE ROOT'
            : level === 0
              ? `LEAF #${idx}`
              : `NODE L${level}:${idx}`;

          const hashEl = document.createElement('code');
          hashEl.className = 'node-hash';
          hashEl.textContent = shortHash(node.hash, 8);

          card.appendChild(titleEl);
          card.appendChild(hashEl);

          if (level === 0) {
            const dataEl = document.createElement('span');
            dataEl.className = 'node-leaf-preview';
            dataEl.textContent = node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label;
            card.appendChild(dataEl);
          } else if (node.duplicatedRight) {
            const dupTag = document.createElement('span');
            dupTag.className = 'node-dup-tag';
            dupTag.textContent = 'paired-dup';
            card.appendChild(dupTag);
          }

          nodesGroup.appendChild(card);
        });

        row.appendChild(nodesGroup);
        wrapper.appendChild(row);
      }

      treeCanvas.appendChild(wrapper);
      requestAnimationFrame(() => drawTreeConnectors(wrapper, svg));
    }

    function runVerification() {
      const root = engine.getRootHash();
      if (!root || engine.rawLeaves.length === 0) {
        statusCard.className = 'status-card state-idle';
        statusBadge.className = 'status-pill idle';
        statusBadge.textContent = 'Awaiting Dataset';
        rootPill.className = 'root-pill idle';
        rootText.textContent = 'No Root Computed';
        expectedRootEl.textContent = '—';
        computedRootEl.textContent = '—';
        verifyLatencyValue.textContent = '0.000 ms';
        auditStepsEl.innerHTML = '<li class="audit-empty">Add at least one leaf item to generate a proof.</li>';
        renderTree([]);
        return;
      }

      const proof = engine.generateProof(selectedIndex);
      const candidateLeaf = payloadInput.value;
      const result = engine.verifyProofDetailed(candidateLeaf, proof, root);
      lastVerification = result;

      isTampered = !result.isValid;
      verifyLatencyValue.textContent = `${result.executionTimeMs.toFixed(4)} ms`;
      expectedRootEl.textContent = result.expectedRoot;
      computedRootEl.textContent = result.computedRoot || '—';

      if (result.isValid) {
        statusCard.className = 'status-card state-verified';
        statusBadge.className = 'status-pill verified';
        statusBadge.textContent = 'Inclusion Proof Verified';
        rootPill.className = 'root-pill verified';
      } else {
        statusCard.className = 'status-card state-tampered';
        statusBadge.className = 'status-pill tampered';
        statusBadge.textContent = 'Tamper Detected · Root Mismatch';
        rootPill.className = 'root-pill tampered';
      }

      rootText.textContent = shortHash(root, 12);
      rootPill.title = root;

      auditStepsEl.innerHTML = '';
      if (result.steps.length === 0) {
        const li = document.createElement('li');
        li.className = 'audit-step';
        li.textContent = `Single-leaf tree: Leaf SHA-256 directly equals Root (${shortHash(result.leafHash, 10)})`;
        auditStepsEl.appendChild(li);
      } else {
        result.steps.forEach((step) => {
          const li = document.createElement('li');
          li.className = 'audit-step';
          li.innerHTML = `
            <span class="step-index">#${step.step}</span>
            <span class="step-pos">${step.siblingPosition.toUpperCase()} SIBLING</span>
            <code class="step-hash">${shortHash(step.siblingHash, 10)}</code>
            <span class="step-arrow">→</span>
            <code class="step-out">${shortHash(step.outputHash, 10)}</code>
          `;
          auditStepsEl.appendChild(li);
        });
      }

      renderTree(proof);
    }

    function rebuildTree() {
      const items = parseDataset();
      isTampered = false;
      engine.buildTree(items);

      depthValue.textContent = String(engine.getDepth());
      leafCountValue.textContent = String(engine.rawLeaves.length);
      buildLatencyValue.textContent = `${engine.lastBuildTimeMs.toFixed(4)} ms`;

      populateLeafSelector();
      runVerification();
    }

    buildBtn.addEventListener('click', rebuildTree);

    leafSelect.addEventListener('change', () => {
      selectedIndex = Number.parseInt(leafSelect.value, 10) || 0;
      isTampered = false;
      payloadInput.value = engine.rawLeaves[selectedIndex] || '';
      runVerification();
    });

    verifyBtn.addEventListener('click', () => {
      runVerification();
    });

    tamperBtn.addEventListener('click', () => {
      if (engine.rawLeaves.length === 0) return;
      const original = engine.rawLeaves[selectedIndex];
      payloadInput.value = `${original} [TAMPERED_SIG]`;
      runVerification();
    });

    restoreBtn.addEventListener('click', () => {
      if (engine.rawLeaves.length === 0) return;
      isTampered = false;
      payloadInput.value = engine.rawLeaves[selectedIndex];
      runVerification();
    });

    presetButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.preset;
        if (PRESET_DATASETS[key]) {
          datasetInput.value = PRESET_DATASETS[key].join('\n');
          selectedIndex = 0;
          rebuildTree();
        }
      });
    });

    window.addEventListener('resize', () => {
      const wrapper = treeCanvas.querySelector('.tree-diagram');
      const svg = treeCanvas.querySelector('.tree-connectors-svg');
      if (wrapper && svg) {
        drawTreeConnectors(wrapper, svg);
      }
    });

    datasetInput.value = DEFAULT_DATASET.join('\n');
    rebuildTree();
  });
}
