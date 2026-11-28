const textEncoder = new TextEncoder();
const HEX_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_LEAVES = 10000;
const MAX_DEPTH = 16;

// Standard FIPS 180-4 SHA-256 initial hash values and round constants.
const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

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

const W_BUFFER = new Uint32Array(64);

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Bytes(input) {
  const bytes = typeof input === 'string'
    ? textEncoder.encode(input)
    : input instanceof Uint8Array
      ? input
      : null;
  if (!bytes) throw new TypeError('SHA-256 input must be a string or Uint8Array.');

  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  let h0 = SHA256_INIT[0];
  let h1 = SHA256_INIT[1];
  let h2 = SHA256_INIT[2];
  let h3 = SHA256_INIT[3];
  let h4 = SHA256_INIT[4];
  let h5 = SHA256_INIT[5];
  let h6 = SHA256_INIT[6];
  let h7 = SHA256_INIT[7];

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      W_BUFFER[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(W_BUFFER[i - 15], 7) ^ rotr(W_BUFFER[i - 15], 18) ^ (W_BUFFER[i - 15] >>> 3);
      const s1 = rotr(W_BUFFER[i - 2], 17) ^ rotr(W_BUFFER[i - 2], 19) ^ (W_BUFFER[i - 2] >>> 10);
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

    for (let i = 0; i < 64; i += 1) {
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

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

export function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !HEX_HASH_PATTERN.test(hex)) {
    throw new TypeError('Hash must be a 64-character hexadecimal SHA-256 digest.');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function sha256Hex(input) {
  return bytesToHex(sha256Bytes(input));
}

function isSha256Hex(value) {
  return typeof value === 'string' && HEX_HASH_PATTERN.test(value);
}

function timingSafeEqualHex(leftHex, rightHex) {
  if (!isSha256Hex(leftHex) || !isSha256Hex(rightHex)) return false;
  const a = leftHex.toLowerCase();
  const b = rightHex.toLowerCase();
  let diff = 0;
  for (let i = 0; i < 64; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function canonicalize(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) throw new TypeError('Leaf payload exceeds maximum nesting depth.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Leaf numeric fields must be finite.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Leaf values must be JSON-compatible primitives, arrays, or plain objects.');
  }
  if (seen.has(value)) throw new TypeError('Leaf payload cannot contain cyclic references.');

  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new TypeError('Leaf objects must be plain objects or arrays.');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalize(item, depth + 1, seen));
    }
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && !['__proto__', 'constructor', 'prototype'].includes(key))
      .sort();
    const sorted = {};
    for (const key of keys) {
      sorted[key] = canonicalize(value[key], depth + 1, seen);
    }
    return sorted;
  } finally {
    seen.delete(value);
  }
}

function serializeLeafBytes(leaf) {
  return textEncoder.encode(JSON.stringify(canonicalize(leaf)));
}

/**
 * Cryptographic Merkle tree engine for Nonprofit Impact ledger integrity.
 * Uses RFC 6962-style domain separation (0x00 leaf prefix, 0x01 internal node prefix)
 * over SHA-256 to prevent second-preimage attacks.
 */
export class NonprofitImpactMerkleEngine {
  constructor() {
    this.leaves = [];
    this.leafHashes = [];
    this.levels = [];
    this.root = null;
    this.lastBuildTimeMs = 0;
    this.lastProofTimeMs = 0;
    this.lastVerifyTimeMs = 0;
  }

  hashLeaf(leaf) {
    const payload = serializeLeafBytes(leaf);
    const prefixed = new Uint8Array(1 + payload.length);
    prefixed[0] = 0x00;
    prefixed.set(payload, 1);
    return sha256Hex(prefixed);
  }

  hashPair(leftHash, rightHash) {
    const leftBytes = hexToBytes(leftHash);
    const rightBytes = hexToBytes(rightHash);
    const prefixed = new Uint8Array(65);
    prefixed[0] = 0x01;
    prefixed.set(leftBytes, 1);
    prefixed.set(rightBytes, 33);
    return sha256Hex(prefixed);
  }

  buildTree(dataArray) {
    if (!Array.isArray(dataArray)) {
      throw new TypeError('Dataset must be an array of leaf records.');
    }
    if (dataArray.length === 0) {
      throw new RangeError('Dataset must contain at least one leaf record.');
    }
    if (dataArray.length > MAX_LEAVES) {
      throw new RangeError(`Dataset exceeds maximum supported size of ${MAX_LEAVES} records.`);
    }

    const startTime = performance.now();
    const leaves = dataArray.map((item) => canonicalize(item));
    const leafHashes = leaves.map((item) => this.hashLeaf(item));

    const levels = [leafHashes];
    let currentLevel = leafHashes;

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

    this.leaves = leaves;
    this.leafHashes = leafHashes;
    this.levels = levels;
    this.root = currentLevel[0];
    this.lastBuildTimeMs = performance.now() - startTime;
    return this.root;
  }

  getRootHash() {
    return this.root;
  }

  getDepth() {
    return this.levels.length;
  }

  getTreeLevels() {
    return this.levels.map((level) => [...level]);
  }

  generateProof(index) {
    if (this.levels.length === 0) {
      throw new Error('Merkle tree has not been built yet.');
    }
    if (!Number.isInteger(index)) {
      throw new TypeError('Leaf index must be an integer.');
    }
    if (index < 0 || index >= this.leaves.length) {
      throw new RangeError(`Leaf index ${index} is out of bounds (0..${this.leaves.length - 1}).`);
    }

    const startTime = performance.now();
    const proof = [];
    let currentIndex = index;

    for (let levelIndex = 0; levelIndex < this.levels.length - 1; levelIndex += 1) {
      const level = this.levels[levelIndex];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      const siblingHash = siblingIndex < level.length ? level[siblingIndex] : level[currentIndex];

      proof.push({
        hash: siblingHash,
        position: isRightNode ? 'left' : 'right'
      });

      currentIndex = Math.floor(currentIndex / 2);
    }

    this.lastProofTimeMs = performance.now() - startTime;
    return proof;
  }

  verifyProof(leaf, proof, root) {
    const trace = this.traceProof(leaf, proof, root);
    return trace.valid;
  }

  traceProof(leaf, proof, root) {
    const startTime = performance.now();
    let valid = false;
    let leafHash = null;
    let computedRoot = null;
    const steps = [];

    const finish = () => {
      const durationMs = performance.now() - startTime;
      this.lastVerifyTimeMs = durationMs;
      return { valid, leafHash, computedRoot, steps, durationMs };
    };

    try {
      if (!Array.isArray(proof) || !isSha256Hex(root)) {
        return finish();
      }

      leafHash = this.hashLeaf(leaf);
      let currentHash = leafHash;

      for (let i = 0; i < proof.length; i += 1) {
        const step = proof[i];
        if (
          !step ||
          typeof step !== 'object' ||
          !isSha256Hex(step.hash) ||
          (step.position !== 'left' && step.position !== 'right')
        ) {
          return finish();
        }

        const leftHash = step.position === 'left' ? step.hash : currentHash;
        const rightHash = step.position === 'left' ? currentHash : step.hash;
        const nextHash = this.hashPair(leftHash, rightHash);

        steps.push({
          step: i + 1,
          inputHash: currentHash,
          siblingHash: step.hash,
          siblingPosition: step.position,
          outputHash: nextHash
        });

        currentHash = nextHash;
      }

      computedRoot = currentHash;
      valid = timingSafeEqualHex(computedRoot, root);
      return finish();
    } catch {
      computedRoot = null;
      return finish();
    }
  }
}

const PRESET_DATASETS = Object.freeze({
  balanced8: [
    'Grant #TI-401 | Amazon Canopy Parcel A | 12,400 saplings | $18,600',
    'Grant #TI-402 | Sundarbans Mangrove Belt | 8,900 saplings | $13,350',
    'Grant #TI-403 | Borneo Peatland Buffer | 15,200 saplings | $22,800',
    'Grant #TI-404 | Congo Basin Corridor | 10,500 saplings | $15,750',
    'Grant #TI-405 | Andes Cloud Forest | 6,800 saplings | $10,200',
    'Grant #TI-406 | Coral Reef Nursery West | 4,200 fragments | $14,700',
    'Grant #TI-407 | Sahel Agroforestry Grid | 11,100 saplings | $16,650',
    'Grant #TI-408 | Boreal Watershed Reserve | 9,600 saplings | $14,400'
  ],
  odd5: [
    'Grant #TI-501 | Mesoamerican Biological Corridor | 7,400 saplings | $11,100',
    'Grant #TI-502 | Madagascar Spiny Forest | 5,100 saplings | $7,650',
    'Grant #TI-503 | Mekong Delta Mangroves | 13,000 saplings | $19,500',
    'Grant #TI-504 | Great Green Wall Senegal | 18,200 saplings | $27,300',
    'Grant #TI-505 | Tasmanian Kelp Sanctuary | 3,900 spores | $12,480'
  ],
  compact4: [
    'Grant #TI-201 | Atlantic Rainforest Strip | 4,000 saplings | $6,000',
    'Grant #TI-202 | Kenyan Highland Watershed | 6,250 saplings | $9,375',
    'Grant #TI-203 | Pacific Seagrass Meadow | 2,800 plots | $8,400',
    'Grant #TI-204 | Himalayan Oak Terrace | 5,400 saplings | $8,100'
  ]
});

function shortHash(hash, head = 8, tail = 6) {
  if (!hash) return '—';
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

function parseDatasetLines(rawText) {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function createTamperedValue(original) {
  if (typeof original !== 'string') return `${String(original)} [TAMPERED]`;
  const dollarMatch = original.match(/\$(\d[\d,]*)/);
  if (dollarMatch) {
    const rawNum = Number.parseInt(dollarMatch[1].replace(/,/g, ''), 10);
    const inflated = (rawNum + 50000).toLocaleString('en-US');
    return original.replace(dollarMatch[0], `$${inflated}`);
  }
  const numberMatch = original.match(/\d+/);
  if (numberMatch) {
    const bumped = String(Number.parseInt(numberMatch[0], 10) + 999);
    return original.replace(numberMatch[0], bumped);
  }
  return `${original} [ALTERED]`;
}

export function mountMerkleVerifier(doc = document) {
  const datasetInput = doc.getElementById('dataset-input');
  const buildButton = doc.getElementById('build-tree-btn');
  const datasetError = doc.getElementById('dataset-error');
  const leafList = doc.getElementById('leaf-list');
  const treeVisualizer = doc.getElementById('tree-visualizer');
  const treeLinesSvg = doc.getElementById('tree-connectors');
  const rootHashPill = doc.getElementById('root-hash-pill');
  const rootStatusPill = doc.getElementById('root-status-pill');
  const depthPill = doc.getElementById('depth-pill');
  const leafCountPill = doc.getElementById('leaf-count-pill');
  const latencyPill = doc.getElementById('latency-pill');
  const claimedLeafInput = doc.getElementById('claimed-leaf-input');
  const tamperButton = doc.getElementById('tamper-btn');
  const restoreButton = doc.getElementById('restore-btn');
  const verificationCard = doc.getElementById('verification-card');
  const verificationBadge = doc.getElementById('verification-badge');
  const verificationTitle = doc.getElementById('verification-title');
  const verificationSummary = doc.getElementById('verification-summary');
  const proofStepsContainer = doc.getElementById('proof-steps');
  const computedRootValue = doc.getElementById('computed-root-value');
  const anchoredRootValue = doc.getElementById('anchored-root-value');
  const leafHashValue = doc.getElementById('leaf-hash-value');
  const presetButtons = doc.querySelectorAll('[data-preset]');

  if (!datasetInput || !treeVisualizer || !verificationCard) return null;

  const engine = new NonprofitImpactMerkleEngine();
  let selectedIndex = 0;
  let currentProof = [];
  let anchoredRoot = null;
  let isTampered = false;

  datasetInput.value = PRESET_DATASETS.balanced8.join('\n');

  const computeActivePathCoordinates = () => {
    const coordinates = new Set();
    const siblingCoordinates = new Set();
    let idx = selectedIndex;
    for (let lvl = 0; lvl < engine.levels.length; lvl += 1) {
      coordinates.add(`${lvl}:${idx}`);
      if (lvl < engine.levels.length - 1) {
        const levelLen = engine.levels[lvl].length;
        const isRight = idx % 2 === 1;
        const sibIdx = isRight ? idx - 1 : idx + 1;
        siblingCoordinates.add(`${lvl}:${sibIdx < levelLen ? sibIdx : idx}`);
        idx = Math.floor(idx / 2);
      }
    }
    return { coordinates, siblingCoordinates };
  };

  const drawConnectorLines = (activeCoords, traceValid) => {
    if (!treeLinesSvg) return;
    const containerRect = treeVisualizer.getBoundingClientRect();
    const svgWidth = Math.max(1, treeVisualizer.scrollWidth, containerRect.width);
    const svgHeight = Math.max(1, treeVisualizer.scrollHeight, containerRect.height);
    const offsetLeft = containerRect.left - treeVisualizer.scrollLeft;
    const offsetTop = containerRect.top - treeVisualizer.scrollTop;

    treeLinesSvg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
    treeLinesSvg.setAttribute('width', String(svgWidth));
    treeLinesSvg.setAttribute('height', String(svgHeight));
    treeLinesSvg.replaceChildren();

    const levelsCount = engine.levels.length;
    for (let lvl = 0; lvl < levelsCount - 1; lvl += 1) {
      const levelLen = engine.levels[lvl].length;
      const parentLen = engine.levels[lvl + 1].length;
      for (let parentIdx = 0; parentIdx < parentLen; parentIdx += 1) {
        const parentEl = treeVisualizer.querySelector(`[data-node-id="${lvl + 1}:${parentIdx}"]`);
        const leftChildIdx = parentIdx * 2;
        const rightChildIdx = Math.min(parentIdx * 2 + 1, levelLen - 1);
        const childIndices = leftChildIdx === rightChildIdx ? [leftChildIdx] : [leftChildIdx, rightChildIdx];

        if (!parentEl) continue;
        const pRect = parentEl.getBoundingClientRect();
        const px = pRect.left + pRect.width / 2 - offsetLeft;
        const py = pRect.bottom - offsetTop;

        for (const childIdx of childIndices) {
          const childEl = treeVisualizer.querySelector(`[data-node-id="${lvl}:${childIdx}"]`);
          if (!childEl) continue;
          const cRect = childEl.getBoundingClientRect();
          const cx = cRect.left + cRect.width / 2 - offsetLeft;
          const cy = cRect.top - offsetTop;

          const midY = (py + cy) / 2;
          const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M ${px} ${py} C ${px} ${midY}, ${cx} ${midY}, ${cx} ${cy}`);

          const onActiveBranch =
            activeCoords.has(`${lvl}:${childIdx}`) && activeCoords.has(`${lvl + 1}:${parentIdx}`);
          let cls = 'connector-line';
          if (onActiveBranch) {
            cls += traceValid ? ' is-verified' : ' is-tampered';
          }
          path.setAttribute('class', cls);
          treeLinesSvg.appendChild(path);
        }
      }
    }
  };

  const renderTree = (traceValid) => {
    const existingLevels = treeVisualizer.querySelector('.tree-levels');
    if (existingLevels) existingLevels.remove();

    const levelsWrap = doc.createElement('div');
    levelsWrap.className = 'tree-levels';

    const { coordinates, siblingCoordinates } = computeActivePathCoordinates();

    for (let lvl = engine.levels.length - 1; lvl >= 0; lvl -= 1) {
      const row = doc.createElement('div');
      row.className = 'tree-level-row';

      const levelLabel = doc.createElement('span');
      levelLabel.className = 'level-label';
      if (lvl === engine.levels.length - 1) {
        levelLabel.textContent = `Root (L${lvl})`;
      } else if (lvl === 0) {
        levelLabel.textContent = `Leaves (L0)`;
      } else {
        levelLabel.textContent = `Branch (L${lvl})`;
      }

      const nodesGroup = doc.createElement('div');
      nodesGroup.className = 'level-nodes';

      engine.levels[lvl].forEach((hash, idx) => {
        const node = doc.createElement(lvl === 0 ? 'button' : 'div');
        if (lvl === 0) node.type = 'button';
        node.className = 'merkle-node';
        node.dataset.nodeId = `${lvl}:${idx}`;
        node.title = hash;

        const isSelected = lvl === 0 && idx === selectedIndex;
        const isActive = coordinates.has(`${lvl}:${idx}`);
        const isSibling = siblingCoordinates.has(`${lvl}:${idx}`);

        if (isSelected) node.classList.add('is-selected');
        if (isActive) node.classList.add(traceValid ? 'is-verified' : 'is-tampered');
        else if (isSibling) node.classList.add('is-sibling');

        const tag = doc.createElement('span');
        tag.className = 'node-index';
        tag.textContent = lvl === 0 ? `#${idx}` : lvl === engine.levels.length - 1 ? 'ROOT' : `N${lvl}.${idx}`;

        const digest = doc.createElement('code');
        digest.className = 'node-hash';
        digest.textContent = shortHash(hash, 6, 4);

        node.append(tag, digest);

        if (lvl === 0) {
          node.addEventListener('click', () => {
            selectLeaf(idx);
          });
        }
        nodesGroup.appendChild(node);
      });

      row.append(levelLabel, nodesGroup);
      levelsWrap.appendChild(row);
    }

    treeVisualizer.appendChild(levelsWrap);
    requestAnimationFrame(() => drawConnectorLines(coordinates, traceValid));
  };

  const renderLeafList = () => {
    if (!leafList) return;
    leafList.replaceChildren();

    engine.leaves.forEach((leaf, idx) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `leaf-pill${idx === selectedIndex ? ' is-active' : ''}`;

      const indexBadge = doc.createElement('span');
      indexBadge.className = 'leaf-pill-index';
      indexBadge.textContent = `#${idx}`;

      const labelSpan = doc.createElement('span');
      labelSpan.className = 'leaf-pill-text';
      labelSpan.textContent = String(leaf);

      btn.append(indexBadge, labelSpan);
      btn.addEventListener('click', () => selectLeaf(idx));
      leafList.appendChild(btn);
    });
  };

  const runVerification = () => {
    if (!anchoredRoot) return;
    const claimedValue = claimedLeafInput ? claimedLeafInput.value : engine.leaves[selectedIndex];
    const trace = engine.traceProof(claimedValue, currentProof, anchoredRoot);
    const verifyMs = engine.lastVerifyTimeMs;
    const valid = trace.valid;

    verificationCard.classList.toggle('state-verified', valid);
    verificationCard.classList.toggle('state-tampered', !valid);

    if (verificationBadge) {
      verificationBadge.textContent = valid ? 'VERIFIED' : 'TAMPERED';
    }
    if (verificationTitle) {
      verificationTitle.textContent = valid
        ? `Leaf #${selectedIndex} Inclusion Confirmed`
        : `Integrity Mismatch on Leaf #${selectedIndex}`;
    }
    if (verificationSummary) {
      verificationSummary.textContent = valid
        ? `Recomputed root matches anchored SHA-256 Merkle root in ${verifyMs.toFixed(3)} ms.`
        : `Claimed payload produces a different SHA-256 root hash — data tampering detected in ${verifyMs.toFixed(3)} ms.`;
    }

    if (rootStatusPill) {
      rootStatusPill.textContent = valid ? 'Integrity Verified' : 'Tamper Detected';
      rootStatusPill.classList.toggle('is-verified', valid);
      rootStatusPill.classList.toggle('is-tampered', !valid);
    }
    if (latencyPill) {
      latencyPill.textContent = `${verifyMs.toFixed(3)} ms verify`;
    }
    if (leafHashValue) {
      leafHashValue.textContent = trace.leafHash || 'Invalid input';
    }
    if (computedRootValue) {
      computedRootValue.textContent = trace.computedRoot || 'Invalid proof';
    }
    if (anchoredRootValue) {
      anchoredRootValue.textContent = anchoredRoot;
    }

    if (proofStepsContainer) {
      proofStepsContainer.replaceChildren();
      if (trace.steps.length === 0) {
        const single = doc.createElement('li');
        single.className = 'proof-step';
        single.textContent = 'Single-leaf tree: leaf hash equals Merkle root directly (0 sibling steps).';
        proofStepsContainer.appendChild(single);
      } else {
        for (const step of trace.steps) {
          const item = doc.createElement('li');
          item.className = `proof-step ${valid ? 'is-verified' : 'is-tampered'}`;

          const header = doc.createElement('div');
          header.className = 'proof-step-head';
          header.textContent = `Step ${step.step} · Combine with ${step.siblingPosition.toUpperCase()} sibling`;

          const hashes = doc.createElement('div');
          hashes.className = 'proof-step-hashes';
          hashes.textContent = `sib ${shortHash(step.siblingHash, 8, 6)} → ${shortHash(step.outputHash, 8, 6)}`;

          item.append(header, hashes);
          proofStepsContainer.appendChild(item);
        }
      }
    }

    if (restoreButton) {
      restoreButton.disabled = !isTampered && claimedValue === String(engine.leaves[selectedIndex]);
    }

    renderTree(valid);
  };

  const selectLeaf = (index) => {
    selectedIndex = Math.max(0, Math.min(index, engine.leaves.length - 1));
    currentProof = engine.generateProof(selectedIndex);
    isTampered = false;
    if (claimedLeafInput) {
      claimedLeafInput.value = String(engine.leaves[selectedIndex]);
    }
    renderLeafList();
    runVerification();
  };

  const rebuildFromInput = () => {
    const records = parseDatasetLines(datasetInput.value);
    if (records.length === 0) {
      if (datasetError) {
        datasetError.textContent = 'Enter at least one ledger record (one per line) to build the Merkle tree.';
      }
      return;
    }

    try {
      anchoredRoot = engine.buildTree(records);
      if (datasetError) datasetError.textContent = '';

      if (rootHashPill) {
        rootHashPill.textContent = shortHash(anchoredRoot, 10, 8);
        rootHashPill.title = anchoredRoot;
      }
      if (depthPill) {
        depthPill.textContent = `Depth ${engine.getDepth()} levels`;
      }
      if (leafCountPill) {
        leafCountPill.textContent = `${records.length} record${records.length === 1 ? '' : 's'}`;
      }

      selectLeaf(Math.min(selectedIndex, records.length - 1));
    } catch (error) {
      if (datasetError) datasetError.textContent = error.message;
    }
  };

  buildButton?.addEventListener('click', rebuildFromInput);

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-preset');
      if (key && PRESET_DATASETS[key]) {
        datasetInput.value = PRESET_DATASETS[key].join('\n');
        selectedIndex = 0;
        rebuildFromInput();
      }
    });
  });

  claimedLeafInput?.addEventListener('input', () => {
    isTampered = claimedLeafInput.value !== String(engine.leaves[selectedIndex]);
    runVerification();
  });

  tamperButton?.addEventListener('click', () => {
    if (!claimedLeafInput) return;
    claimedLeafInput.value = createTamperedValue(String(engine.leaves[selectedIndex]));
    isTampered = true;
    runVerification();
  });

  restoreButton?.addEventListener('click', () => {
    if (!claimedLeafInput) return;
    claimedLeafInput.value = String(engine.leaves[selectedIndex]);
    isTampered = false;
    runVerification();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      const { coordinates } = computeActivePathCoordinates();
      const claimedValue = claimedLeafInput ? claimedLeafInput.value : engine.leaves[selectedIndex];
      const trace = engine.traceProof(claimedValue, currentProof, anchoredRoot);
      drawConnectorLines(coordinates, trace.valid);
    });
  }

  rebuildFromInput();
  return { engine, rebuildFromInput, selectLeaf, runVerification };
}

if (typeof document !== 'undefined') {
  mountMerkleVerifier(document);
}
