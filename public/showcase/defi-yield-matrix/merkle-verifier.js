import { createHash } from 'crypto';

const LEAF_HASH_PREFIX = '0x';

class DefiYieldMatrixMerkleEngine {
  constructor() {
    this.tree = [];
    this.rootHash = null;
    this.proofIndex = null;
  }

hashLeaf(data) {
    const dataBuf = typeof data === 'string' ? new TextEncoder().encode(data) : Buffer.from(data);
    const hashBuf = createHash('sha256').update(dataBuf).digest('hex');
    return hashBuf;
  }

  hashNodes(left, right) {
    const combined = Buffer.concat([Buffer.from(left, 'hex'), Buffer.from(right, 'hex')]);
    return createHash('sha256').update(combined).digest('hex');
  }

  buildTree(dataArray) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
      this.tree = [];
      this.rootHash = null;
      return null;
    }

    const leaves = dataArray.map(data => this.hashLeaf(data));
    this.tree = [leaves];
    let currentLevel = leaves;

    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        let left = currentLevel[i];
        let right = currentLevel[i + 1];
        if (right === undefined) {
          right = left;
        }
        const parent = this.hashNodes(left, right);
        nextLevel.push(parent);
      }
      this.tree.push(nextLevel);
      currentLevel = nextLevel;
    }

    this.rootHash = currentLevel[0];
    return this.rootHash;
  }

  getRootHash() {
    return this.rootHash;
  }

  generateProof(index) {
    if (this.tree.length === 0 || this.rootHash === null) {
      return null;
    }

    this.proofIndex = index;

    const proof = [];
    let levelIndex = index;

    for (let level = 0; level < this.tree.length - 1; level++) {
      const siblings = this.tree[level];
      if (levelIndex % 2 === 0) {
        if (levelIndex + 1 < siblings.length) {
          proof.push(siblings[levelIndex + 1]);
        } else {
          proof.push(siblings[levelIndex]);
        }
      } else {
        proof.push(siblings[levelIndex - 1]);
      }
      levelIndex = Math.floor(levelIndex / 2);
    }

    return proof;
  }

  verifyProof(leaf, proof, root) {
    if (!Array.isArray(proof)) {
      return false;
    }

    if (proof.length === 0) {
      // Empty proof: the leaf must be the root
      let current = typeof leaf === 'string' ? leaf : leaf.toString('hex');
      return current === root.toString('hex');
    }

    let current = typeof leaf === 'string' ? leaf : leaf.toString('hex');
    const index = this.proofIndex;

    for (let level = 0; level < proof.length; level++) {
      const sibling = proof[level];

      if (current.length !== sibling.length) {
        return false;
      }

      const levelIndex = Math.floor(index / Math.pow(2, level));
      if (levelIndex % 2 === 0) {
        // Current node is left child: hash(current || sibling)
        const combined = Buffer.concat([Buffer.from(current, 'hex'), Buffer.from(sibling, 'hex')]);
        current = createHash('sha256').update(combined).digest('hex');
      } else {
        // Current node is right child: hash(sibling || current)
        const combined = Buffer.concat([Buffer.from(sibling, 'hex'), Buffer.from(current, 'hex')]);
        current = createHash('sha256').update(combined).digest('hex');
      }
    }

    return current === root.toString('hex');
  }
}

export { DefiYieldMatrixMerkleEngine };

function mountMerkleVerifier() {
  const container = document.querySelector('[data-merkle-verifier]');
  if (!container) return;

  const engine = new DefiYieldMatrixMerkleEngine();

  const dataInput = container.querySelector('#data-values');
  const buildBtn = container.querySelector('#build-tree');
  const treeContainer = container.querySelector('#tree-container');
  const treeDepthEl = container.querySelector('#tree-depth');
  const leafCountEl = container.querySelector('#leaf-count');
  const rootHashEl = container.querySelector('#root-hash');

  const proofIndexEl = container.querySelector('#proof-index');
  const generateProofBtn = container.querySelector('#generate-proof');
  const proofResult = container.querySelector('#proof-result');
  const proofStatus = container.querySelector('#proof-status');
  const proofRoot = container.querySelector('#proof-root');
  const proofList = container.querySelector('#proof-list');

  const tamperIndexEl = container.querySelector('#tamper-index');
  const tamperBtn = container.querySelector('#tamper-leaf');
  const tamperResult = container.querySelector('#tamper-result');
  const tamperRoot = container.querySelector('#tamper-root');
  const tamperStatus = container.querySelector('#tamper-status');

  function renderTree(dataArray) {
    treeContainer.innerHTML = '';
    if (!dataArray || dataArray.length === 0) {
      treeContainer.innerHTML = '<em>Build a tree to visualize</em>';
      treeDepthEl.textContent = '—';
      leafCountEl.textContent = '—';
      rootHashEl.textContent = '—';
      return;
    }

    engine.buildTree(dataArray);

    const totalLevels = engine.tree.length;
    const root = engine.getRootHash();
    treeDepthEl.textContent = totalLevels - 1;
    leafCountEl.textContent = dataArray.length;
    rootHashEl.textContent = root ? root.slice(0, 16) + '…' + root.slice(-16) : '—';

    const leafCount = dataArray.length;
    const width = Math.max(500, leafCount * 60);
    const height = Math.max(300, totalLevels * 80 + 100);
    treeContainer.style.width = `${width}px`;
    treeContainer.style.height = `${height}px`;

    function placeNodes(nodes, y, xStart, isRootTag) {
      if (nodes.length === 0) return;

      const nodeSpacing = width / Math.max(1, nodes.length - 1);

      nodes.forEach((hash, i) => {
        const x = xStart + i * nodeSpacing;
        const node = document.createElement('div');
        const nodeClasses = ['node'];
        if (i === 0) nodeClasses.push('root-left');
        if (i === nodes.length - 1) nodeClasses.push('root-right');
        node.className = nodeClasses.join(' ');
        node.textContent = hash.slice(0, 8) + '…';
        node.style.left = `${x}px`;
        node.style.top = `${y}px`;
        treeContainer.appendChild(node);

        if (nodes.length > 1) {
          const parentCount = Math.ceil(nodes.length / 2);
          for (let j = 0; j < parentCount; j++) {
            const siblingIdx = i % 2 === 0 ? i + 1 : i - 1;
            if (siblingIdx < nodes.length) {
              const connHoriz = document.createElement('div');
              connHoriz.className = 'connector horizontal';
              connHoriz.style.left = `${x + 16}px`;
              treeContainer.appendChild(connHoriz);

              const connVert = document.createElement('div');
              connVert.className = 'connector vertical';
              connVert.style.top = `${y + 16}px`;
              treeContainer.appendChild(connVert);

              if (i < nodes.length - 1) {
                const connBottom = document.createElement('div');
                connBottom.className = 'connector bottom-vertical';
                connBottom.style.left = `${x + 16}px`;
                treeContainer.appendChild(connBottom);
              }
            }
          }
        }
      });

      const nextY = y + 32;
      const nextXStart = xStart;
      placeNodes(nodes, nextY, nextXStart, false);
    }

    placeNodes(engine.tree[0], 50, 0, true);
  }

  function renderProof(proof, index, rootHash) {
    proofList.innerHTML = '';
    proofStatus.textContent = '—';
    proofRoot.textContent = rootHash ? rootHash.slice(0, 16) + '…' + rootHash.slice(-16) : '—';

    if (!proof || proof.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'no path';
      li.className = '';
      proofList.appendChild(li);
      proofResult.hidden = false;
      return;
    }

    proof.forEach((sibling, i) => {
      const li = document.createElement('li');
      li.textContent = sibling.slice(0, 8) + '…';
      li.className = 'success';
      proofList.appendChild(li);
    });

    proofResult.hidden = false;
  }

  function renderTamper(originalRoot, tamperedRoot, index) {
    tamperRoot.textContent = tamperedRoot ? tamperedRoot.slice(0, 16) + '…' + tamperedRoot.slice(-16) : '—';
    const leaf = engine.tree[0][index];
    const proof = engine.generateProof(index);
    const isValid = engine.verifyProof(leaf, proof, tamperedRoot || originalRoot);
    tamperStatus.textContent = isValid ? 'verified' : 'tampered';
    tamperResult.hidden = false;
  }

  buildBtn.addEventListener('click', () => {
    const raw = dataInput.value.trim();
    if (!raw) {
      container.querySelector('#tree-error').hidden = false;
      container.querySelector('#tree-error').textContent = 'Enter at least one value.';
      return;
    }
    container.querySelector('#tree-error').hidden = true;
    const values = raw.split(',').map(v => v.trim()).filter(v => v.length > 0);
    const root = engine.buildTree(values);
    renderTree(values);
    proofIndexEl.disabled = false;
    generateProofBtn.disabled = false;
  });

  generateProofBtn.addEventListener('click', () => {
    const index = parseInt(proofIndexEl.value, 10);
    if (isNaN(index) || index < 0) {
      container.querySelector('#proof-error').hidden = false;
      container.querySelector('#proof-error').textContent = 'Enter a valid index.';
      return;
    }
    container.querySelector('#proof-error').hidden = true;
    const proof = engine.generateProof(index);
    if (!proof) {
      proofStatus.textContent = 'no tree';
      proofResult.hidden = false;
      return;
    }
    const root = engine.getRootHash();
    const valid = engine.verifyProof(engine.tree[0][index], proof, root);
    proofStatus.textContent = valid ? 'verified' : 'invalid';
    renderProof(proof, index, root);
  });

  tamperBtn.addEventListener('click', () => {
    const index = parseInt(tamperIndexEl.value, 10);
    if (isNaN(index) || index < 0) {
      container.querySelector('#proof-error').hidden = false;
      container.querySelector('#proof-error').textContent = 'Enter a valid index.';
      return;
    }
    container.querySelector('#proof-error').hidden = true;

    const originalRoot = engine.getRootHash();
    const originalLeaves = engine.tree[0].map(l => l);
    const tamperedValue = 'tampered_' + index;
    const tamperedLeaves = [...originalLeaves];
    tamperedLeaves[index] = engine.hashLeaf(tamperedValue);

    const newTree = [tamperedLeaves];
    let currentLevel = tamperedLeaves;
    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        let left = currentLevel[i];
        let right = currentLevel[i + 1];
        if (right === undefined) right = left;
        nextLevel.push(engine.hashNodes(left, right));
      }
      newTree.push(nextLevel);
      currentLevel = nextLevel;
    }

    engine.tree = newTree;
    engine.rootHash = currentLevel[0];

    const tamperedRoot = engine.getRootHash();
    renderTamper(originalRoot, tamperedRoot, index);
  });

  update();
}

function update() {
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      mountMerkleVerifier();
    });
  }
}

update();