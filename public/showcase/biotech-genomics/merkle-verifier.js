/**
 * Biotech Genomics — Merkle Tree Data Integrity & Cryptographic Proof Verification
 * Issue #4161 — NSoC '26 Level 3 Feature
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];

function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

export function sha256(input) {
  const msg = new TextEncoder().encode(String(input));
  const len = msg.length;
  const bitLen = len * 8;
  const padLen = ((56 - ((len + 1) % 64)) + 64) % 64;
  const totalLen = len + 1 + padLen + 8;

  const bytes = new Uint8Array(totalLen);
  bytes.set(msg);
  bytes[len] = 0x80;

  const view = new DataView(bytes.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(totalLen - 4, bitLen >>> 0);

  const h = SHA256_INIT.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

export class BiotechGenomicsMerkleEngine {
  constructor() {
    this.tree = [];
    this.rootHash = '';
    this.proofCache = new Map();
  }

  buildTree(dataArray) {
    if (!Array.isArray(dataArray) || dataArray.length === 0) {
      this.tree = [];
      this.rootHash = '';
      return;
    }

    const leaves = dataArray.map(item => sha256(item));
    this.tree = [leaves];
    let currentLevel = leaves;

    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        nextLevel.push(sha256(left + right));
      }
      this.tree.push(nextLevel);
      currentLevel = nextLevel;
    }

    this.rootHash = currentLevel[0];
  }

  getRootHash() {
    return this.rootHash;
  }

  generateProof(index) {
    const proof = [];
    let currentLevelIndex = index;

    for (let level = 0; level < this.tree.length - 1; level++) {
      const currentLevel = this.tree[level];
      if (currentLevelIndex >= currentLevel.length) break;

      const siblingIndex = currentLevelIndex ^ 1;
      const siblingExists = siblingIndex < currentLevel.length;
      const isLeftChild = currentLevelIndex % 2 === 0;

      if (siblingExists) {
        proof.push({
          hash: currentLevel[siblingIndex],
          position: isLeftChild ? 'right' : 'left'
        });
      } else {
        proof.push({
          hash: currentLevel[currentLevelIndex],
          position: 'right'
        });
      }

      currentLevelIndex = Math.floor(currentLevelIndex / 2);
    }

    this.proofCache.set(index, proof);
    return proof;
  }

  verifyProof(leafHash, proof, rootHash) {
    let currentHash = leafHash;

    for (const step of proof) {
      const siblingHash = typeof step === 'string' ? step : step.hash;
      const position = typeof step === 'string' ? 'right' : step.position;

      currentHash = position === 'left'
        ? sha256(siblingHash + currentHash)
        : sha256(currentHash + siblingHash);
    }

    return currentHash === rootHash;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const engine = new BiotechGenomicsMerkleEngine();
    const DEFAULT_DATA = ['ATGCTG', 'GGTAAC', 'TTAGGC', 'ATCGAT'];

    const els = {
      dataInput: document.getElementById('dataInput'),
      buildBtn: document.getElementById('buildBtn'),
      tamperBtn: document.getElementById('tamperBtn'),
      treeVisualizer: document.getElementById('treeVisualizer'),
      proofIndex: document.getElementById('proofIndex'),
      verifyProofBtn: document.getElementById('verifyProofBtn'),
      proofStatus: document.getElementById('proofStatus'),
      proofPath: document.getElementById('proofPath'),
      rootHash: document.getElementById('rootHash'),
      rootStatus: document.getElementById('rootStatus')
    };

    let currentData = [...DEFAULT_DATA];

    function shortHash(hash, n = 6) {
      return hash.slice(0, n);
    }

    function setProofStatus(kind, text) {
      els.proofStatus.replaceChildren();
      const pill = document.createElement('span');
      pill.className = `status-pill status-${kind}`;
      pill.textContent = text;
      els.proofStatus.appendChild(pill);
    }

    function clearHighlights() {
      els.treeVisualizer
        .querySelectorAll('.node.verified, .node.tampered')
        .forEach((node) => node.classList.remove('verified', 'tampered'));
      els.treeVisualizer
        .querySelectorAll('path.highlight, path.tampered')
        .forEach((path) => path.classList.remove('highlight', 'tampered'));
    }

    function markNode(level, index, cls) {
      const node = els.treeVisualizer.querySelector(
        `.node[data-level="${level}"][data-index="${index}"]`
      );
      if (node) node.classList.add(cls);
    }

    function center(node, cRect, container) {
      const r = node.getBoundingClientRect();
      return {
        x: r.left - cRect.left + container.scrollLeft + r.width / 2,
        y: r.top - cRect.top + container.scrollTop + r.height / 2
      };
    }

    function drawConnectors(svg, container) {
      const cRect = container.getBoundingClientRect();
      const byLevel = new Map();
      container.querySelectorAll('.node').forEach((node) => {
        const lvl = Number(node.dataset.level);
        if (!byLevel.has(lvl)) byLevel.set(lvl, new Map());
        byLevel.get(lvl).set(Number(node.dataset.index), node);
      });

      svg.setAttribute('width', container.scrollWidth);
      svg.setAttribute('height', container.scrollHeight);

      const parts = [];
      for (const [lvl, map] of byLevel) {
        if (lvl === 0) continue;
        const childLevel = byLevel.get(lvl - 1);
        if (!childLevel) continue;
        for (const [idx, parent] of map) {
          for (const childIdx of [idx * 2, idx * 2 + 1]) {
            const child = childLevel.get(childIdx);
            if (!child) continue;
            const p = center(parent, cRect, container);
            const c = center(child, cRect, container);
            const midY = (p.y + c.y) / 2;
            parts.push(
              `<path d="M ${p.x} ${p.y} C ${p.x} ${midY}, ${c.x} ${midY}, ${c.x} ${c.y}" />`
            );
          }
        }
      }
      svg.innerHTML = parts.join('');
    }

    function renderTree() {
      const viz = els.treeVisualizer;
      viz.replaceChildren();

      if (engine.tree.length === 0) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = 'Build a tree to visualize hierarchical SHA-256 hashing.';
        viz.appendChild(hint);
        return;
      }

      const wrap = document.createElement('div');
      wrap.className = 'tree-levels';
      const rootLevel = engine.tree.length - 1;

      for (let lvl = rootLevel; lvl >= 0; lvl--) {
        const levelEl = document.createElement('div');
        levelEl.className = 'tree-level';

        engine.tree[lvl].forEach((hash, idx) => {
          const node = document.createElement('div');
          node.className = 'node';
          if (lvl === 0) node.classList.add('leaf');
          if (lvl === rootLevel) node.classList.add('root');
          node.dataset.level = String(lvl);
          node.dataset.index = String(idx);
          node.title = hash;
          node.textContent = shortHash(hash);

          const tag = document.createElement('span');
          tag.className = 'node-tag';
          if (lvl === 0) tag.textContent = `L${idx}`;
          else if (lvl === rootLevel) tag.textContent = 'ROOT';
          else tag.textContent = `H${lvl}`;
          node.appendChild(tag);

          levelEl.appendChild(node);
        });

        wrap.appendChild(levelEl);
      }

      viz.appendChild(wrap);

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('tree-connectors');
      viz.appendChild(svg);

      requestAnimationFrame(() => drawConnectors(svg, viz));
    }

    function updateRootDisplay() {
      const root = engine.getRootHash();
      els.rootHash.textContent = root || '—';
      if (root) {
        els.rootStatus.className = 'status-pill status-valid';
        els.rootStatus.textContent = `Verified root · ${currentData.length} leaves`;
      } else {
        els.rootStatus.className = 'status-pill status-neutral';
        els.rootStatus.textContent = 'Not built';
      }
    }

    function build() {
      const raw = els.dataInput.value.trim();
      currentData = raw
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      engine.buildTree(currentData);
      updateRootDisplay();
      setProofStatus('neutral', 'Awaiting proof');
      els.proofPath.replaceChildren();
      renderTree();
    }

    function verifyProofAt(index) {
      if (engine.tree.length === 0) {
        setProofStatus('neutral', 'Build a tree first');
        return;
      }

      const leaves = engine.tree[0];
      if (index < 0 || index >= leaves.length) {
        setProofStatus('neutral', 'Leaf index out of range');
        return;
      }

      const proof = engine.generateProof(index);
      const isValid = engine.verifyProof(leaves[index], proof, engine.getRootHash());

      els.proofPath.replaceChildren();
      proof.forEach((step, i) => {
        const span = document.createElement('span');
        span.className = 'step';
        const dir = step.position === 'left' ? '◀ left' : 'right ▶';
        span.textContent = `H${i} · sibling ${dir} · ${step.hash.slice(0, 10)}…`;
        els.proofPath.appendChild(span);
      });

      clearHighlights();
      markNode(0, index, isValid ? 'verified' : 'tampered');
      markNode(engine.tree.length - 1, 0, isValid ? 'verified' : 'tampered');

      if (isValid) {
        setProofStatus('valid', `Proof VALID — leaf L${index} is included in the root`);
      } else {
        setProofStatus('tampered', `Proof REJECTED — leaf L${index} is not in the root`);
      }
    }

    function tamperSimulation() {
      if (engine.tree.length === 0) {
        setProofStatus('neutral', 'Build a tree first');
        return;
      }

      const leaves = engine.tree[0];
      const idx = Math.floor(Math.random() * leaves.length);
      const original = currentData[idx];
      const modified = `${original}-MUT`;

      const tamperedLeafHash = sha256(modified);
      const proof = engine.generateProof(idx);
      const stillValid = engine.verifyProof(tamperedLeafHash, proof, engine.getRootHash());

      clearHighlights();
      markNode(0, idx, 'tampered');
      markNode(engine.tree.length - 1, 0, 'tampered');

      els.rootStatus.className = 'status-pill status-tampered';
      els.rootStatus.textContent = 'Tamper detected';

      setProofStatus(
        'tampered',
        `Tamper simulation — L${idx} "${original}" → "${modified}" · proof ${
          stillValid ? 'unexpectedly accepted' : 'correctly rejected'
        }`
      );
    }

    els.buildBtn?.addEventListener('click', build);
    els.tamperBtn?.addEventListener('click', tamperSimulation);
    els.verifyProofBtn?.addEventListener('click', () => {
      verifyProofAt(parseInt(els.proofIndex.value, 10) || 0);
    });
    els.proofIndex?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        verifyProofAt(parseInt(els.proofIndex.value, 10) || 0);
      }
    });

    window.addEventListener('resize', () => {
      const svg = els.treeVisualizer.querySelector('.tree-connectors');
      if (svg) drawConnectors(svg, els.treeVisualizer);
    });

    if (els.dataInput) els.dataInput.value = DEFAULT_DATA.join(',');
    build();
  });
}