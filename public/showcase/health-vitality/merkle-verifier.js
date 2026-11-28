/**
 * Health Vitality — Merkle Tree Data Integrity & Cryptographic Proof Verification Engine
 * Isolated modular engine calculating SHA-256 leaf hashes, balanced binary trees,
 * cryptographic audit paths, and sub-millisecond inclusion proof verification.
 */

const TEXT_ENCODER = new TextEncoder();

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
const HEX64_REGEX = /^[0-9a-f]{64}$/i;

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Pure-JS FIPS 180-4 SHA-256 returning a 64-character lowercase hex digest.
 * Runs synchronously in both browser and Node.js in sub-millisecond time.
 */
export function sha256Hex(message) {
  const inputBytes = TEXT_ENCODER.encode(message);
  const bitLen = inputBytes.length * 8;
  const paddedLength = Math.ceil((inputBytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(inputBytes);
  padded[inputBytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLen >>> 0, false);

  let h0 = SHA256_INIT[0];
  let h1 = SHA256_INIT[1];
  let h2 = SHA256_INIT[2];
  let h3 = SHA256_INIT[3];
  let h4 = SHA256_INIT[4];
  let h5 = SHA256_INIT[5];
  let h6 = SHA256_INIT[6];
  let h7 = SHA256_INIT[7];

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W_BUFFER[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
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

  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  let hex = '';
  for (let i = 0; i < words.length; i++) {
    hex += words[i].toString(16).padStart(8, '0');
  }
  return hex;
}

function serializeLeaf(item) {
  if (item === null || item === undefined) {
    throw new TypeError('Leaf data cannot be null or undefined.');
  }
  return typeof item === 'string' ? item : JSON.stringify(item);
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Cryptographic SHA-256 Merkle Tree Engine for Health Vitality.
 * Calculates SHA-256 leaf hashes, builds balanced binary hash trees,
 * generates audit paths, and verifies inclusion proofs in sub-millisecond time.
 */
export class HealthVitalityMerkleEngine {
  constructor(dataArray = null) {
    this.rawLeaves = [];
    this.leaves = [];
    this.levels = [];
    this.root = null;
    this.lastBuildTimeMs = 0;
    this.lastVerifyTimeMs = 0;

    if (dataArray !== null) {
      if (!Array.isArray(dataArray)) {
        throw new TypeError('Initial dataset must be an array.');
      }
      if (dataArray.length > 0) {
        this.buildTree(dataArray);
      }
    }
  }

  static sha256(value) {
    return sha256Hex(serializeLeaf(value));
  }

  hashLeaf(data) {
    return sha256Hex(serializeLeaf(data));
  }

  hashPair(leftHash, rightHash) {
    return sha256Hex(`${leftHash}${rightHash}`);
  }

  /**
   * Hashes every element in dataArray with SHA-256 and builds a balanced
   * binary Merkle tree bottom-up, duplicating the trailing node on odd levels.
   */
  buildTree(dataArray) {
    if (!Array.isArray(dataArray)) {
      throw new TypeError('Dataset must be an array.');
    }
    if (dataArray.length === 0) {
      throw new RangeError('Dataset must contain at least one leaf record.');
    }

    const start = nowMs();
    const serialized = dataArray.map(serializeLeaf);
    const leafHashes = serialized.map((entry) => sha256Hex(entry));
    const levels = [leafHashes];

    let currentLevel = leafHashes;
    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : currentLevel[i];
        nextLevel.push(sha256Hex(`${left}${right}`));
      }
      levels.push(nextLevel);
      currentLevel = nextLevel;
    }

    this.rawLeaves = serialized;
    this.leaves = leafHashes;
    this.levels = levels;
    this.root = currentLevel[0];
    this.lastBuildTimeMs = Math.max(0, nowMs() - start);

    return this.root;
  }

  getRootHash() {
    return this.root;
  }

  getDepth() {
    return this.levels.length > 0 ? this.levels.length - 1 : 0;
  }

  getLevels() {
    return this.levels.map((level) => [...level]);
  }

  /**
   * Generates the ordered sibling audit path from leaf level up to the Merkle root.
   */
  generateProof(index) {
    if (!this.root || this.levels.length === 0) {
      throw new Error('Cannot generate proof before building a Merkle tree.');
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new RangeError(`Leaf index must be an integer between 0 and ${this.leaves.length - 1}.`);
    }

    const proof = [];
    let currentIndex = index;

    for (let levelIndex = 0; levelIndex < this.levels.length - 1; levelIndex++) {
      const level = this.levels[levelIndex];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode
        ? currentIndex - 1
        : (currentIndex + 1 < level.length ? currentIndex + 1 : currentIndex);
      const position = isRightNode ? 'left' : 'right';

      proof.push({
        hash: level[siblingIndex],
        position,
        level: levelIndex,
        index: siblingIndex
      });

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Computes the inclusion trace and verifies whether leaf + proof reconstructs root.
   */
  verifyProofDetailed(leaf, proof, root = this.root) {
    const serialized = serializeLeaf(leaf);
    if (!Array.isArray(proof)) {
      throw new TypeError('Merkle proof must be an array.');
    }

    const start = nowMs();
    let currentHash = sha256Hex(serialized);
    const steps = [{ level: 0, hash: currentHash, input: serialized }];

    if (typeof root !== 'string' || !HEX64_REGEX.test(root)) {
      const durationMs = Math.max(0, nowMs() - start);
      this.lastVerifyTimeMs = durationMs;
      return {
        valid: false,
        leafHash: steps[0].hash,
        computedRoot: currentHash,
        expectedRoot: root ?? null,
        steps,
        durationMs
      };
    }

    const expectedRoot = root.toLowerCase();

    for (let i = 0; i < proof.length; i++) {
      const step = proof[i];
      if (
        !step ||
        typeof step.hash !== 'string' ||
        !HEX64_REGEX.test(step.hash) ||
        (step.position !== 'left' && step.position !== 'right')
      ) {
        const durationMs = Math.max(0, nowMs() - start);
        this.lastVerifyTimeMs = durationMs;
        return {
          valid: false,
          leafHash: steps[0].hash,
          computedRoot: currentHash,
          expectedRoot,
          steps,
          durationMs
        };
      }

      const siblingHash = step.hash.toLowerCase();
      currentHash = step.position === 'left'
        ? sha256Hex(`${siblingHash}${currentHash}`)
        : sha256Hex(`${currentHash}${siblingHash}`);

      steps.push({
        level: i + 1,
        hash: currentHash,
        siblingHash,
        position: step.position
      });
    }

    const durationMs = Math.max(0, nowMs() - start);
    this.lastVerifyTimeMs = durationMs;

    return {
      valid: currentHash === expectedRoot,
      leafHash: steps[0].hash,
      computedRoot: currentHash,
      expectedRoot,
      steps,
      durationMs
    };
  }

  /**
   * Verifies whether a leaf record is cryptographically included under root via proof.
   */
  verifyProof(leaf, proof, root = this.root) {
    return this.verifyProofDetailed(leaf, proof, root).valid;
  }
}

const PRESET_DATASETS = {
  4: [
    'HV-101 | RestingHR:58bpm | HRV:74ms | SpO2:99%',
    'HV-102 | Glucose:88mg/dL | Ketones:0.4mmol | Fast:14h',
    'HV-103 | DeepSleep:1h52m | REM:2h10m | Recovery:92%',
    'HV-104 | VO2Max:51.4 | LactateThresh:168bpm | Zone2:45m'
  ],
  7: [
    'HV-201 | RestingHR:56bpm | HRV:78ms | SpO2:99%',
    'HV-202 | Glucose:84mg/dL | InsulinSens:Optimal',
    'HV-203 | DeepSleep:2h05m | REM:1h58m | Score:94',
    'HV-204 | BloodPressure:114/72 | PulseWave:6.1m/s',
    'HV-205 | CortisolAM:14.2ug/dL | MelatoninOnset:21:40',
    'HV-206 | VO2Max:52.1 | GripStrength:49kg | Mobility:91%',
    'HV-207 | BioAgeDelta:-4.6yrs | CellularVitality:96%'
  ]
};

function mountMerkleVerifier() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  window.HealthVitalityMerkleEngine = HealthVitalityMerkleEngine;

  const rootContainer = document.querySelector('[data-merkle-verifier]');
  if (!rootContainer) {
    return;
  }

  const datasetInput = document.getElementById('dataset-input');
  const buildBtn = document.getElementById('build-tree-btn');
  const preset4Btn = document.getElementById('preset-4-btn');
  const preset7Btn = document.getElementById('preset-7-btn');
  const leafSelect = document.getElementById('leaf-select');
  const verifyBtn = document.getElementById('verify-proof-btn');
  const tamperBtn = document.getElementById('tamper-btn');
  const restoreBtn = document.getElementById('restore-btn');

  const statusPill = document.getElementById('root-status-pill');
  const leafCountBadge = document.getElementById('leaf-count-badge');
  const execTimeBadge = document.getElementById('exec-time-badge');
  const treeDepthStat = document.getElementById('tree-depth-stat');
  const expectedRootEl = document.getElementById('expected-root-hash');
  const computedRootEl = document.getElementById('computed-root-hash');
  const selectedLeafPayloadEl = document.getElementById('selected-leaf-payload');
  const verificationDetailEl = document.getElementById('verification-detail');
  const proofPathList = document.getElementById('proof-path-list');
  const treeVisualizer = document.getElementById('tree-visualizer');

  const engine = new HealthVitalityMerkleEngine();
  let selectedIndex = 0;
  let simulatedTamperPayload = null;
  let activeProof = [];
  let lastVerification = null;

  function parseInputLines() {
    return datasetInput.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function populateLeafSelector() {
    leafSelect.replaceChildren();
    engine.rawLeaves.forEach((leaf, idx) => {
      const option = document.createElement('option');
      option.value = String(idx);
      const preview = leaf.length > 48 ? `${leaf.slice(0, 48)}…` : leaf;
      option.textContent = `Leaf #${idx}: ${preview}`;
      leafSelect.appendChild(option);
    });
    leafSelect.value = String(selectedIndex);
  }

  function computePathIndices() {
    const pathSet = new Set();
    const siblingSet = new Set();
    let idx = selectedIndex;

    for (let level = 0; level < engine.levels.length; level++) {
      pathSet.add(`${level}:${idx}`);
      if (level < activeProof.length) {
        siblingSet.add(`${level}:${activeProof[level].index}`);
      }
      idx = Math.floor(idx / 2);
    }

    return { pathSet, siblingSet };
  }

  function renderTreeVisualizer() {
    treeVisualizer.replaceChildren();
    if (!engine.levels.length) return;

    const { pathSet, siblingSet } = computePathIndices();
    const isTampered = Boolean(lastVerification && !lastVerification.valid);
    const totalLevels = engine.levels.length;

    for (let levelIndex = totalLevels - 1; levelIndex >= 0; levelIndex--) {
      const levelHashes = engine.levels[levelIndex];
      const isRootLevel = levelIndex === totalLevels - 1;
      const isLeafLevel = levelIndex === 0;

      const row = document.createElement('div');
      row.className = 'tree-level-row';

      const levelMeta = document.createElement('div');
      levelMeta.className = 'tree-level-meta';
      levelMeta.textContent = isRootLevel
        ? `Level ${levelIndex} · Merkle Root`
        : isLeafLevel
          ? `Level ${levelIndex} · Biometric Leaf Hashes (${levelHashes.length})`
          : `Level ${levelIndex} · Internal Nodes (${levelHashes.length})`;
      row.appendChild(levelMeta);

      const nodesTrack = document.createElement('div');
      nodesTrack.className = 'tree-nodes-track';

      for (let i = 0; i < levelHashes.length; i += 2) {
        const group = document.createElement('div');
        const hasPair = i + 1 < levelHashes.length;
        group.className = `tree-pair-group${isRootLevel ? ' is-root-group' : ''}${hasPair ? ' has-pair' : ''}`;

        for (let offset = 0; offset < 2 && i + offset < levelHashes.length; offset++) {
          const nodeIdx = i + offset;
          const nodeKey = `${levelIndex}:${nodeIdx}`;
          const hash = levelHashes[nodeIdx];

          const nodeEl = document.createElement(isLeafLevel ? 'button' : 'div');
          if (isLeafLevel) {
            nodeEl.type = 'button';
            nodeEl.addEventListener('click', () => {
              selectedIndex = nodeIdx;
              leafSelect.value = String(nodeIdx);
              simulatedTamperPayload = null;
              evaluateSelectedLeaf();
            });
          }

          let highlightClass = '';
          if (pathSet.has(nodeKey)) {
            highlightClass = isTampered ? 'node-tampered' : 'node-verified';
          } else if (siblingSet.has(nodeKey)) {
            highlightClass = 'node-proof-sibling';
          }

          nodeEl.className = `tree-node${isLeafLevel ? ' is-leaf' : ''}${highlightClass ? ` ${highlightClass}` : ''}`;
          nodeEl.title = hash;

          const indexBadge = document.createElement('span');
          indexBadge.className = 'node-index-badge';
          indexBadge.textContent = isRootLevel ? 'ROOT' : isLeafLevel ? `LEAF #${nodeIdx}` : `L${levelIndex}[${nodeIdx}]`;

          const hashCode = document.createElement('code');
          hashCode.className = 'node-hash-code';
          hashCode.textContent = `${hash.slice(0, 12)}…${hash.slice(-6)}`;

          nodeEl.append(indexBadge, hashCode);

          if (isLeafLevel) {
            const label = document.createElement('span');
            label.className = 'node-leaf-preview';
            const rawText = engine.rawLeaves[nodeIdx];
            label.textContent = rawText.length > 22 ? `${rawText.slice(0, 22)}…` : rawText;
            nodeEl.appendChild(label);
          }

          group.appendChild(nodeEl);
        }

        nodesTrack.appendChild(group);
      }

      row.appendChild(nodesTrack);
      treeVisualizer.appendChild(row);
    }
  }

  function renderProofPath() {
    proofPathList.replaceChildren();
    if (activeProof.length === 0) {
      const item = document.createElement('li');
      item.className = 'proof-step-item is-empty';
      item.textContent = 'Single-leaf tree: Merkle root equals leaf hash (0 sibling steps needed).';
      proofPathList.appendChild(item);
      return;
    }

    const isTampered = Boolean(lastVerification && !lastVerification.valid);
    activeProof.forEach((step, idx) => {
      const li = document.createElement('li');
      li.className = `proof-step-item ${isTampered ? 'step-tampered' : 'step-verified'}`;

      const dirBadge = document.createElement('span');
      dirBadge.className = `dir-pill dir-${step.position}`;
      dirBadge.textContent = step.position.toUpperCase();

      const meta = document.createElement('span');
      meta.className = 'step-meta';
      meta.textContent = `Step ${idx + 1} · L${step.level}[${step.index}]`;

      const hashEl = document.createElement('code');
      hashEl.className = 'step-hash';
      hashEl.textContent = step.hash;

      li.append(dirBadge, meta, hashEl);
      proofPathList.appendChild(li);
    });
  }

  function evaluateSelectedLeaf() {
    if (!engine.getRootHash()) return;

    activeProof = engine.generateProof(selectedIndex);
    const leafPayload = simulatedTamperPayload !== null
      ? simulatedTamperPayload
      : engine.rawLeaves[selectedIndex];

    lastVerification = engine.verifyProofDetailed(leafPayload, activeProof, engine.getRootHash());

    const isVerified = lastVerification.valid;
    statusPill.className = `status-pill ${isVerified ? 'pill-verified' : 'pill-tampered'}`;
    statusPill.textContent = isVerified ? 'VERIFIED' : 'TAMPERED';

    const verifyMs = lastVerification.durationMs;
    execTimeBadge.textContent = `${verifyMs < 0.01 ? '< 0.01' : verifyMs.toFixed(3)} ms`;
    treeDepthStat.textContent = `Depth ${engine.getDepth()} (${engine.levels.length} levels)`;

    expectedRootEl.textContent = lastVerification.expectedRoot;
    computedRootEl.textContent = lastVerification.computedRoot;
    computedRootEl.className = `hash-readout ${isVerified ? 'hash-match' : 'hash-mismatch'}`;

    selectedLeafPayloadEl.textContent = leafPayload;
    selectedLeafPayloadEl.className = `payload-readout ${isVerified ? 'payload-clean' : 'payload-tampered'}`;

    verificationDetailEl.textContent = isVerified
      ? `Inclusion proof verified for Leaf #${selectedIndex} across ${activeProof.length} audit step(s) in ${execTimeBadge.textContent}.`
      : `Integrity violation detected! Modified Leaf #${selectedIndex} produced a mismatched Merkle root.`;

    restoreBtn.disabled = simulatedTamperPayload === null;
    tamperBtn.disabled = simulatedTamperPayload !== null;

    renderProofPath();
    renderTreeVisualizer();
  }

  function rebuildFromInput() {
    const lines = parseInputLines();
    if (lines.length === 0) {
      statusPill.className = 'status-pill pill-tampered';
      statusPill.textContent = 'EMPTY INPUT';
      verificationDetailEl.textContent = 'Provide at least one non-empty health record to construct a Merkle tree.';
      return;
    }

    simulatedTamperPayload = null;
    selectedIndex = 0;
    engine.buildTree(lines);
    leafCountBadge.textContent = `${engine.leaves.length} leaf record${engine.leaves.length === 1 ? '' : 's'}`;
    populateLeafSelector();
    evaluateSelectedLeaf();
  }

  buildBtn?.addEventListener('click', rebuildFromInput);

  preset4Btn?.addEventListener('click', () => {
    datasetInput.value = PRESET_DATASETS[4].join('\n');
    rebuildFromInput();
  });

  preset7Btn?.addEventListener('click', () => {
    datasetInput.value = PRESET_DATASETS[7].join('\n');
    rebuildFromInput();
  });

  leafSelect?.addEventListener('change', (event) => {
    selectedIndex = Number(event.target.value);
    simulatedTamperPayload = null;
    evaluateSelectedLeaf();
  });

  verifyBtn?.addEventListener('click', () => {
    evaluateSelectedLeaf();
  });

  tamperBtn?.addEventListener('click', () => {
    if (!engine.getRootHash()) return;
    const original = engine.rawLeaves[selectedIndex];
    simulatedTamperPayload = `${original} [TAMPERED: BIOMARKER_ALTERED]`;
    evaluateSelectedLeaf();
  });

  restoreBtn?.addEventListener('click', () => {
    simulatedTamperPayload = null;
    evaluateSelectedLeaf();
  });

  datasetInput.value = PRESET_DATASETS[4].join('\n');
  rebuildFromInput();
}

mountMerkleVerifier();
