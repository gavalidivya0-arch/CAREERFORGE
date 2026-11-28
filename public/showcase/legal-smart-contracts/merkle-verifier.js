/**
 * LegalSmartContractsMerkleEngine
 * Isolated Cryptographic Merkle Tree Engine for Legal Smart Contracts.
 * Calculates domain-separated SHA-256 leaf and branch hashes, builds balanced binary trees,
 * generates cryptographic audit paths, and verifies inclusion proofs.
 */

const encoder = new TextEncoder();
const subtle = globalThis.crypto?.subtle;

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Expected a 32-byte SHA-256 hash');
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
}

export class LegalSmartContractsMerkleEngine {
  constructor() {
    this.name = 'LegalSmartContractsMerkleEngine';
    this.leaves = [];
    this.levels = []; // levels[0] = leaves hashes, levels[levels.length - 1] = [root]
  }

  /**
   * Computes SHA-256 digest of input Uint8Array bytes using Web Crypto subtle digest.
   * @param {Uint8Array} bytes
   * @returns {Promise<Uint8Array>}
   */
  async sha256(bytes) {
    if (!subtle) {
      throw new Error('Web Crypto SHA-256 is unavailable');
    }
    const buffer = await subtle.digest('SHA-256', bytes);
    return new Uint8Array(buffer);
  }

  /**
   * Hashes a contract leaf item with 0x00 domain separator to avoid second-preimage attacks.
   * @param {*} leaf
   * @returns {Promise<string>} Hex string of SHA-256 hash
   */
  async hashLeaf(leaf) {
    const serialized = typeof leaf === 'string' ? leaf.trim() : JSON.stringify(leaf);
    const data = encoder.encode(serialized);
    const input = new Uint8Array(data.length + 1);
    input[0] = 0; // Domain separation for leaf
    input.set(data, 1);
    const hashBytes = await this.sha256(input);
    return bytesToHex(hashBytes);
  }

  /**
   * Hashes two sibling nodes with 0x01 domain separator.
   * @param {string} leftHex
   * @param {string} rightHex
   * @returns {Promise<string>}
   */
  async hashPair(leftHex, rightHex) {
    const leftBytes = hexToBytes(leftHex);
    const rightBytes = hexToBytes(rightHex);
    const input = new Uint8Array(65);
    input[0] = 1; // Domain separation for internal node
    input.set(leftBytes, 1);
    input.set(rightBytes, 33);
    const hashBytes = await this.sha256(input);
    return bytesToHex(hashBytes);
  }

  /**
   * Builds the balanced binary Merkle tree from an array of contract data items.
   * @param {Array<*>} dataArray
   * @returns {Promise<string>} Root hash
   */
  async buildTree(dataArray) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
      throw new TypeError('Provide at least one contract clause or data item');
    }

    const leafHashes = await Promise.all(dataArray.map((item) => this.hashLeaf(item)));
    const levels = [leafHashes];

    while (levels[levels.length - 1].length > 1) {
      const current = levels[levels.length - 1];
      const parents = [];
      for (let i = 0; i < current.length; i += 2) {
        // Balanced tree: if odd node, duplicate sibling
        const left = current[i];
        const right = current[i + 1] ?? current[i];
        parents.push(await this.hashPair(left, right));
      }
      levels.push(parents);
    }

    this.leaves = dataArray;
    this.levels = levels;
    return this.getRootHash();
  }

  /**
   * Returns the root hash of the Merkle tree.
   * @returns {string|null}
   */
  getRootHash() {
    if (!this.levels.length || !this.levels[this.levels.length - 1].length) {
      return null;
    }
    return this.levels[this.levels.length - 1][0];
  }

  /**
   * Generates cryptographic inclusion audit proof for the leaf at `index`.
   * @param {number} leafIndex
   * @returns {Array<{ hash: string, position: 'left'|'right' }>}
   */
  generateProof(leafIndex) {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new RangeError('Leaf index is outside tree bounds');
    }

    const proof = [];
    let index = leafIndex;

    for (const level of this.levels.slice(0, -1)) {
      const isRight = index % 2 === 1;
      const siblingIndex = isRight ? index - 1 : Math.min(index + 1, level.length - 1);
      proof.push({
        hash: level[siblingIndex],
        position: isRight ? 'left' : 'right'
      });
      index = Math.floor(index / 2);
    }

    return proof;
  }

  /**
   * Verifies an inclusion proof against expected Merkle root.
   * @param {*} leaf
   * @param {Array<{ hash: string, position: 'left'|'right' }>} proof
   * @param {string} root
   * @returns {Promise<boolean>}
   */
  async verifyProof(leaf, proof, root) {
    if (!Array.isArray(proof) || !root || typeof root !== 'string') {
      return false;
    }

    try {
      let current = await this.hashLeaf(leaf);

      for (const step of proof) {
        if (!step || !['left', 'right'].includes(step.position)) {
          return false;
        }
        current = step.position === 'left'
          ? await this.hashPair(step.hash, current)
          : await this.hashPair(current, step.hash);
      }

      return current.toLowerCase() === root.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Returns current tree depth.
   * @returns {number}
   */
  getDepth() {
    return this.levels.length;
  }
}

// Browser DOM controller
if (typeof document !== 'undefined') {
  const initMerkleLab = async () => {
    const root = document.querySelector('[data-merkle-lab]');
    if (!root) return;

    const engine = new LegalSmartContractsMerkleEngine();

    const rootChipVal = root.querySelector('#root-chip-val');
    const depthChipVal = root.querySelector('#depth-chip-val');
    const leavesChipVal = root.querySelector('#leaves-chip-val');
    const integrityChip = root.querySelector('#integrity-chip');
    const datasetTextarea = root.querySelector('#dataset-textarea');
    const resetDatasetBtn = root.querySelector('#reset-dataset-btn');
    const rebuildTreeBtn = root.querySelector('#rebuild-tree-btn');
    const tamperBtn = root.querySelector('#tamper-btn');
    const leafSelector = root.querySelector('#leaf-selector');
    const proofStepsCount = root.querySelector('#proof-steps-count');
    const proofPathList = root.querySelector('#proof-path-list');
    const verifyProofBtn = root.querySelector('#verify-proof-btn');
    const verificationResultCard = root.querySelector('#verification-result-card');
    const resultIcon = root.querySelector('#result-icon');
    const resultTitle = root.querySelector('#result-title');
    const resultDesc = root.querySelector('#result-desc');
    const treeDepthBadge = root.querySelector('#tree-depth-badge');
    const treeDepthVisualizer = root.querySelector('#tree-depth-visualizer');

    let currentClauses = [];
    let currentProof = [];
    let isTampered = false;

    const DEFAULT_CLAUSES = [
      'Clause 1: Escrow Deposit 50.0 ETH into Multi-Sig Vault 0x4B3',
      'Clause 2: Arbitrator Dispute Resolution via Decentralized Jury',
      'Clause 3: Milestone 1 Delivery Verification & Inspection Period',
      'Clause 4: Milestone 2 Automated Settlement on Proof-of-Work',
      'Clause 5: Force Majeure Liquidation & Partial Refund Terms'
    ];

    function parseClauses() {
      return datasetTextarea.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    async function buildAndRender() {
      currentClauses = parseClauses();
      if (currentClauses.length === 0) return;

      const rootHash = await engine.buildTree(currentClauses);
      isTampered = false;

      // Update Header Chips
      rootChipVal.textContent = `${rootHash.slice(0, 10)}...${rootHash.slice(-8)}`;
      rootChipVal.title = rootHash;
      depthChipVal.textContent = `${engine.getDepth()} Levels`;
      leavesChipVal.textContent = `${currentClauses.length} Clauses`;
      treeDepthBadge.textContent = `Depth: ${engine.getDepth()} Levels`;

      integrityChip.textContent = 'SECURE';
      integrityChip.className = 'status-pill status-verified';

      // Update Leaf Selector Options
      const prevSelectedIdx = Math.min(Math.max(0, leafSelector.selectedIndex), currentClauses.length - 1);
      leafSelector.innerHTML = '';
      currentClauses.forEach((clause, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `[Leaf #${idx}] ${clause.slice(0, 48)}...`;
        leafSelector.appendChild(opt);
      });
      leafSelector.selectedIndex = prevSelectedIdx >= 0 ? prevSelectedIdx : 0;

      updateProofAndVerification();
      renderTreeVisualizer();
    }

    function updateProofAndVerification() {
      const selectedIdx = Number(leafSelector.value);
      if (Number.isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= currentClauses.length) {
        proofPathList.innerHTML = '<p class="empty-hint">Select a valid leaf.</p>';
        return;
      }

      currentProof = engine.generateProof(selectedIdx);
      proofStepsCount.textContent = `${currentProof.length} steps`;

      proofPathList.innerHTML = '';
      currentProof.forEach((step, idx) => {
        const item = document.createElement('div');
        item.className = 'proof-step-item';
        item.innerHTML = `
          <span>Level ${idx + 1}: ${step.hash.slice(0, 10)}...${step.hash.slice(-6)}</span>
          <span class="step-position-tag pos-${step.position}">${step.position}</span>
        `;
        proofPathList.appendChild(item);
      });

      verifyCurrentProof();
    }

    async function verifyCurrentProof() {
      const selectedIdx = Number(leafSelector.value);
      const targetLeaf = currentClauses[selectedIdx];
      const rootHash = engine.getRootHash();

      const isValid = await engine.verifyProof(targetLeaf, currentProof, rootHash);

      if (isValid) {
        verificationResultCard.className = 'result-card result-verified';
        resultIcon.textContent = '✔';
        resultTitle.textContent = 'Cryptographic Proof Verified (Inclusion Valid)';
        resultDesc.textContent = `Leaf #${selectedIdx} connects accurately to the Merkle root hash through all ${currentProof.length} sibling digest steps.`;
        integrityChip.textContent = 'SECURE';
        integrityChip.className = 'status-pill status-verified';
      } else {
        verificationResultCard.className = 'result-card result-tampered';
        resultIcon.textContent = '✖';
        resultTitle.textContent = 'Tampering Detected! Cryptographic Mismatch';
        resultDesc.textContent = `Leaf #${selectedIdx} has been modified or proof hashes do not match the published contract Merkle root.`;
        integrityChip.textContent = 'TAMPERED';
        integrityChip.className = 'status-pill status-tampered';
      }
    }

    function renderTreeVisualizer() {
      treeDepthVisualizer.innerHTML = '';
      const selectedIdx = Number(leafSelector.value);

      engine.levels.slice().reverse().forEach((level, levelIdxRev) => {
        const levelIdx = engine.levels.length - 1 - levelIdxRev;
        const isRootLevel = levelIdx === engine.levels.length - 1;
        const isLeafLevel = levelIdx === 0;

        const row = document.createElement('div');
        row.className = 'tree-level-row';

        const label = document.createElement('div');
        label.className = 'level-header-tag';
        label.textContent = isRootLevel ? 'Root Level' : isLeafLevel ? 'Leaf Level (Clauses)' : `Intermediate Level ${levelIdx}`;
        row.appendChild(label);

        const container = document.createElement('div');
        container.className = 'level-nodes-container';

        level.forEach((hash, nodeIdx) => {
          const card = document.createElement('div');
          let customClass = 'tree-node-card';
          if (isRootLevel) customClass += ' root-node';
          if (isLeafLevel && nodeIdx === selectedIdx) {
            customClass += isTampered ? ' tampered-node' : ' active-target-leaf';
          }

          card.className = customClass;
          const contentPreview = isLeafLevel ? currentClauses[nodeIdx] ?? '' : '';

          card.innerHTML = `
            <div class="node-title-row">
              <span class="node-label">${isRootLevel ? 'ROOT' : isLeafLevel ? `LEAF #${nodeIdx}` : `NODE ${nodeIdx}`}</span>
              <span class="node-type-tag">SHA-256</span>
            </div>
            <div class="node-hash" title="${hash}">${hash.slice(0, 8)}...${hash.slice(-6)}</div>
            ${contentPreview ? `<div class="node-content-preview" title="${contentPreview}">${contentPreview}</div>` : ''}
          `;
          container.appendChild(card);
        });

        row.appendChild(container);
        treeDepthVisualizer.appendChild(row);
      });
    }

    // Event Listeners
    rebuildTreeBtn.addEventListener('click', buildAndRender);

    resetDatasetBtn.addEventListener('click', () => {
      datasetTextarea.value = DEFAULT_CLAUSES.join('\n');
      buildAndRender();
    });

    leafSelector.addEventListener('change', () => {
      updateProofAndVerification();
      renderTreeVisualizer();
    });

    verifyProofBtn.addEventListener('click', verifyCurrentProof);

    tamperBtn.addEventListener('click', () => {
      const selectedIdx = Number(leafSelector.value);
      if (selectedIdx < 0 || selectedIdx >= currentClauses.length) return;

      // Tamper with clause content without re-building the tree
      currentClauses[selectedIdx] = currentClauses[selectedIdx] + ' [TAMPERED: PAYOUT_MODIFIED=9999ETH]';
      isTampered = true;
      datasetTextarea.value = currentClauses.join('\n');

      updateProofAndVerification();
      renderTreeVisualizer();
    });

    // Initial build
    await buildAndRender();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMerkleLab);
  } else {
    initMerkleLab();
  }
}
