/**
 * Aerospace Orbiter — Merkle Tree Data Integrity & Cryptographic Proof Verification Engine
 *
 * Implements a zero-dependency FIPS 180-4 SHA-256 Merkle tree engine with
 * domain-separated hashing (RFC 6962), balanced binary tree construction,
 * cryptographic inclusion proof generation, and sub-millisecond verification.
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const textEncoder = new TextEncoder();
const HEX_HASH_RE = /^[0-9a-f]{64}$/i;

/**
 * Compute a standard FIPS 180-4 SHA-256 digest over a Uint8Array and return raw 32 bytes.
 * @param {Uint8Array} message
 * @returns {Uint8Array}
 */
export function sha256Bytes(message) {
  const bitLen = message.length * 8;
  const padLen = ((55 - (message.length % 64)) + 64) % 64;
  const totalLen = message.length + 1 + padLen + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(message, 0);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(totalLen - 8, highBits, false);
  view.setUint32(totalLen - 4, lowBits, false);

  const hash = new Uint32Array(SHA256_INIT);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25))
        ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14))
        ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15))
        ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13))
        ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

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

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, hash[i], false);
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex) {
  const clean = hex.toLowerCase();
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function canonicalSerialize(value) {
  if (value === undefined || value === null) {
    throw new TypeError('Leaf data cannot be null or undefined');
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(sortNested(value[key]))}`);
    return `{${entries.join(',')}}`;
  }
  return String(value);
}

function sortNested(val) {
  if (Array.isArray(val)) return val.map(sortNested);
  if (val && typeof val === 'object') {
    const sorted = {};
    for (const key of Object.keys(val).sort()) {
      sorted[key] = sortNested(val[key]);
    }
    return sorted;
  }
  return val;
}

function hashLeafBytes(leafData) {
  const serialized = canonicalSerialize(leafData);
  const payload = textEncoder.encode(serialized);
  const prefixed = new Uint8Array(payload.length + 1);
  prefixed[0] = 0x00; // Domain separation tag for leaves
  prefixed.set(payload, 1);
  return sha256Bytes(prefixed);
}

function hashParentBytes(leftBytes, rightBytes) {
  const prefixed = new Uint8Array(65);
  prefixed[0] = 0x01; // Domain separation tag for internal nodes
  prefixed.set(leftBytes, 1);
  prefixed.set(rightBytes, 33);
  return sha256Bytes(prefixed);
}

/**
 * Cryptographic Merkle tree engine for Aerospace Orbiter telemetry verification.
 */
export class AerospaceOrbiterMerkleEngine {
  constructor() {
    this.leaves = [];
    this.leafHashes = [];
    this.levels = [];
    this.levelBytes = [];
    this.lastBuildMs = 0;
  }

  /**
   * Hash leaf values and build a balanced binary SHA-256 Merkle tree.
   * Odd levels duplicate the trailing node to preserve binary structure.
   * @param {Array<*>} dataArray
   * @returns {string} Hexadecimal Merkle root hash
   */
  buildTree(dataArray) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
      throw new TypeError('buildTree requires a non-empty array of leaf entries');
    }

    const t0 = performance.now();
    const clonedLeaves = dataArray.map((item) => {
      canonicalSerialize(item);
      return item;
    });

    const baseBytes = clonedLeaves.map((item) => hashLeafBytes(item));
    const byteLevels = [baseBytes];

    while (byteLevels[byteLevels.length - 1].length > 1) {
      const current = byteLevels[byteLevels.length - 1];
      const nextLevel = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = i + 1 < current.length ? current[i + 1] : current[i];
        nextLevel.push(hashParentBytes(left, right));
      }
      byteLevels.push(nextLevel);
    }

    const hexLevels = byteLevels.map((lvl) => lvl.map(bytesToHex));
    this.leaves = clonedLeaves;
    this.leafHashes = hexLevels[0];
    this.levelBytes = byteLevels;
    this.levels = hexLevels;
    this.lastBuildMs = performance.now() - t0;

    return this.getRootHash();
  }

  /**
   * Return the 64-char hex Merkle root hash, or null if no tree has been built.
   * @returns {string|null}
   */
  getRootHash() {
    if (this.levels.length === 0) return null;
    return this.levels[this.levels.length - 1][0];
  }

  /**
   * Return the tree depth (0 for single-leaf tree, levels.length - 1 otherwise).
   * @returns {number}
   */
  getTreeDepth() {
    return this.levels.length === 0 ? 0 : this.levels.length - 1;
  }

  /**
   * Generate the sibling audit path from the leaf at `index` up to the root.
   * @param {number} index
   * @returns {Array<{ hash: string, position: 'left'|'right' }>}
   */
  generateProof(index) {
    if (this.levels.length === 0) {
      throw new Error('Cannot generate proof before building a Merkle tree');
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new RangeError(`Leaf index ${index} is out of bounds (0..${this.leaves.length - 1})`);
    }

    const proof = [];
    let cursor = index;
    for (let levelIdx = 0; levelIdx < this.levels.length - 1; levelIdx++) {
      const level = this.levels[levelIdx];
      const isRightNode = cursor % 2 === 1;
      const siblingIdx = isRightNode ? cursor - 1 : Math.min(cursor + 1, level.length - 1);
      proof.push({
        hash: level[siblingIdx],
        position: isRightNode ? 'left' : 'right',
      });
      cursor = Math.floor(cursor / 2);
    }
    return proof;
  }

  /**
   * Verify that `leaf` hashes along `proof` to match `root`.
   * @param {*} leaf
   * @param {Array<{ hash: string, position: 'left'|'right' }>} proof
   * @param {string} root
   * @returns {boolean}
   */
  verifyProof(leaf, proof, root) {
    if (!Array.isArray(proof) || typeof root !== 'string' || !HEX_HASH_RE.test(root)) {
      return false;
    }

    try {
      let current = hashLeafBytes(leaf);
      for (const step of proof) {
        if (!step || (step.position !== 'left' && step.position !== 'right')) {
          return false;
        }
        if (typeof step.hash !== 'string' || !HEX_HASH_RE.test(step.hash)) {
          return false;
        }
        const siblingBytes = hexToBytes(step.hash);
        current = step.position === 'left'
          ? hashParentBytes(siblingBytes, current)
          : hashParentBytes(current, siblingBytes);
      }
      return bytesToHex(current) === root.toLowerCase();
    } catch {
      return false;
    }
  }
}

const DEFAULT_TELEMETRY_DATASET = [
  'PKT-001 | APOGEE_ALT_KM=418.42 | VEL_KMS=7.661 | THRUSTER=NOMINAL',
  'PKT-002 | ATTITUDE_PITCH_DEG=+0.14 | ATTITUDE_YAW_DEG=-0.03 | GYRO=LOCKED',
  'PKT-003 | SOLAR_ARRAY_KW=14.85 | BUS_VOLT=28.4 | THERMAL_C=21.7',
  'PKT-004 | RCS_FUEL_KG=184.20 | OXIDIZER_BAR=214.6 | VALVE=SEALED',
  'PKT-005 | COMM_DOWNLINK_MBPS=42.8 | SNR_DB=19.4 | CRYPTO_SYNC=OK',
  'PKT-006 | STAR_TRACKER_CONF=0.9994 | EPHEMERIS_EPOCH=2026.332',
];

function computeAuditHighlightCoords(leafCount, levelCount, leafIndex) {
  const coords = new Set();
  if (leafCount === 0 || leafIndex < 0 || leafIndex >= leafCount) return coords;

  let cursor = leafIndex;
  for (let lvl = 0; lvl < levelCount; lvl++) {
    coords.add(`active:${lvl}:${cursor}`);
    if (lvl < levelCount - 1) {
      const levelWidth = Math.ceil(leafCount / (2 ** lvl));
      const isRight = cursor % 2 === 1;
      const sibling = isRight ? cursor - 1 : Math.min(cursor + 1, levelWidth - 1);
      coords.add(`sibling:${lvl}:${sibling}`);
      cursor = Math.floor(cursor / 2);
    }
  }
  return coords;
}

function initMerkleVerifierUI() {
  const datasetInput = document.getElementById('datasetInput');
  const buildTreeBtn = document.getElementById('buildTreeBtn');
  const presetOddBtn = document.getElementById('presetOddBtn');
  const resetDatasetBtn = document.getElementById('resetDatasetBtn');
  const leafSelector = document.getElementById('leafSelector');
  const candidateLeafInput = document.getElementById('candidateLeafInput');
  const verifyProofBtn = document.getElementById('verifyProofBtn');
  const tamperBtn = document.getElementById('tamperBtn');
  const restoreLeafBtn = document.getElementById('restoreLeafBtn');

  const rootStatusPill = document.getElementById('rootStatusPill');
  const rootHashOutput = document.getElementById('rootHashOutput');
  const treeDepthStat = document.getElementById('treeDepthStat');
  const leafCountStat = document.getElementById('leafCountStat');
  const execTimeStat = document.getElementById('execTimeStat');
  const treeVisualizer = document.getElementById('treeVisualizer');
  const proofPathOutput = document.getElementById('proofPathOutput');
  const verificationCard = document.getElementById('verificationCard');
  const verificationHeadline = document.getElementById('verificationHeadline');
  const verificationDetail = document.getElementById('verificationDetail');

  if (!datasetInput || !buildTreeBtn || !treeVisualizer) return;

  const engine = new AerospaceOrbiterMerkleEngine();
  let selectedIndex = 0;
  let activeProof = [];

  datasetInput.value = DEFAULT_TELEMETRY_DATASET.join('\n');

  function parseInputLines() {
    return datasetInput.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function renderTreeVisualizer(tampered) {
    treeVisualizer.replaceChildren();
    const totalLevels = engine.levels.length;
    if (totalLevels === 0) return;

    const highlights = computeAuditHighlightCoords(engine.leaves.length, totalLevels, selectedIndex);

    for (let lvl = totalLevels - 1; lvl >= 0; lvl--) {
      const levelHashes = engine.levels[lvl];
      const depthFromRoot = totalLevels - 1 - lvl;

      const rowWrap = document.createElement('div');
      rowWrap.className = 'tree-level-group';

      const levelMeta = document.createElement('div');
      levelMeta.className = 'tree-level-label';
      if (lvl === totalLevels - 1) {
        levelMeta.textContent = `Depth ${depthFromRoot} · Root`;
      } else if (lvl === 0) {
        levelMeta.textContent = `Depth ${depthFromRoot} · Leaves (${levelHashes.length})`;
      } else {
        levelMeta.textContent = `Depth ${depthFromRoot} · Branch (${levelHashes.length})`;
      }

      const nodesRow = document.createElement('div');
      nodesRow.className = 'tree-nodes-row';

      levelHashes.forEach((hash, idx) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'tree-node';
        if (lvl === totalLevels - 1) {
          node.classList.add('node-root');
        }
        if (lvl === 0) {
          node.classList.add('node-leaf');
        }
        if (highlights.has(`active:${lvl}:${idx}`)) {
          node.classList.add(tampered ? 'node-tampered' : 'node-active');
        } else if (highlights.has(`sibling:${lvl}:${idx}`)) {
          node.classList.add('node-proof-sibling');
        }

        const tag = document.createElement('span');
        tag.className = 'node-tag';
        tag.textContent = lvl === totalLevels - 1
          ? 'ROOT'
          : lvl === 0
            ? `L${idx}`
            : `N${lvl}.${idx}`;

        const digest = document.createElement('code');
        digest.className = 'node-hash';
        digest.textContent = `${hash.slice(0, 10)}…${hash.slice(-4)}`;

        node.title = hash;
        node.append(tag, digest);

        if (lvl === 0) {
          node.addEventListener('click', () => {
            selectedIndex = idx;
            leafSelector.value = String(idx);
            syncSelectedLeaf(true);
          });
        } else {
          node.disabled = true;
        }

        nodesRow.appendChild(node);
      });

      rowWrap.append(levelMeta, nodesRow);
      treeVisualizer.appendChild(rowWrap);
    }
  }

  function runVerification() {
    const root = engine.getRootHash();
    if (!root) return;

    const candidate = candidateLeafInput.value;
    const t0 = performance.now();
    const isValid = engine.verifyProof(candidate, activeProof, root);
    const verifyMs = performance.now() - t0;

    execTimeStat.textContent = `${(engine.lastBuildMs + verifyMs).toFixed(3)} ms`;

    if (isValid) {
      verificationCard.dataset.state = 'verified';
      rootStatusPill.dataset.state = 'verified';
      rootStatusPill.textContent = 'INTEGRITY VERIFIED';
      verificationHeadline.textContent = `Leaf #${selectedIndex} Inclusion Confirmed`;
      verificationDetail.textContent = `SHA-256 audit path (${activeProof.length} steps) matches Merkle root in ${verifyMs.toFixed(3)} ms.`;
    } else {
      verificationCard.dataset.state = 'tampered';
      rootStatusPill.dataset.state = 'tampered';
      rootStatusPill.textContent = 'TAMPER DETECTED';
      verificationHeadline.textContent = `Leaf #${selectedIndex} Verification Failed`;
      verificationDetail.textContent = `Computed hash diverges from expected Merkle root (${verifyMs.toFixed(3)} ms). Data tampering detected.`;
    }

    renderTreeVisualizer(!isValid);
  }

  function syncSelectedLeaf(autoVerify) {
    if (engine.leaves.length === 0) return;
    if (selectedIndex >= engine.leaves.length) selectedIndex = 0;

    candidateLeafInput.value = String(engine.leaves[selectedIndex]);
    const t0 = performance.now();
    activeProof = engine.generateProof(selectedIndex);
    const proofMs = performance.now() - t0;

    proofPathOutput.textContent = JSON.stringify(activeProof, null, 2);
    if (autoVerify) {
      runVerification();
    } else {
      execTimeStat.textContent = `${(engine.lastBuildMs + proofMs).toFixed(3)} ms`;
      renderTreeVisualizer(false);
    }
  }

  function rebuildTreeFromInput() {
    const records = parseInputLines();
    if (records.length === 0) {
      rootStatusPill.dataset.state = 'tampered';
      rootStatusPill.textContent = 'EMPTY DATASET';
      verificationCard.dataset.state = 'tampered';
      verificationHeadline.textContent = 'Dataset Required';
      verificationDetail.textContent = 'Provide at least one telemetry record line to construct a Merkle tree.';
      return;
    }

    const root = engine.buildTree(records);
    rootHashOutput.textContent = root;
    treeDepthStat.textContent = String(engine.getTreeDepth());
    leafCountStat.textContent = String(engine.leaves.length);

    leafSelector.replaceChildren();
    engine.leaves.forEach((leaf, idx) => {
      const option = document.createElement('option');
      option.value = String(idx);
      const preview = String(leaf).slice(0, 44);
      option.textContent = `#${idx} — ${preview}${String(leaf).length > 44 ? '…' : ''}`;
      leafSelector.appendChild(option);
    });

    if (selectedIndex >= engine.leaves.length) selectedIndex = 0;
    leafSelector.value = String(selectedIndex);
    syncSelectedLeaf(true);
  }

  buildTreeBtn.addEventListener('click', rebuildTreeFromInput);

  presetOddBtn?.addEventListener('click', () => {
    datasetInput.value = DEFAULT_TELEMETRY_DATASET.slice(0, 5).join('\n');
    selectedIndex = 2;
    rebuildTreeFromInput();
  });

  resetDatasetBtn?.addEventListener('click', () => {
    datasetInput.value = DEFAULT_TELEMETRY_DATASET.join('\n');
    selectedIndex = 0;
    rebuildTreeFromInput();
  });

  leafSelector.addEventListener('change', () => {
    selectedIndex = Number.parseInt(leafSelector.value, 10) || 0;
    syncSelectedLeaf(true);
  });

  verifyProofBtn.addEventListener('click', runVerification);

  tamperBtn.addEventListener('click', () => {
    const current = candidateLeafInput.value;
    if (!current.includes('[TAMPERED]')) {
      candidateLeafInput.value = `${current} [TAMPERED]`;
    } else {
      candidateLeafInput.value = `${current}!`;
    }
    runVerification();
  });

  restoreLeafBtn?.addEventListener('click', () => {
    if (engine.leaves[selectedIndex] !== undefined) {
      candidateLeafInput.value = String(engine.leaves[selectedIndex]);
      runVerification();
    }
  });

  // Expose live state hook when inspected cleanly
  if (typeof window !== 'undefined') {
    window.aerospaceMerkleEngine = engine;
  }

  rebuildTreeFromInput();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMerkleVerifierUI);
  } else {
    initMerkleVerifierUI();
  }
}
