/**
 * DeFi Yield Matrix - Immutable State Snapshot & Time-Travel Debugger Module
 * Issue #4171 - NSoC '26 Level 3 Feature
 */

export class DefiYieldMatrixTimeTravelStore {
  constructor(initialState = {}) {
    this.history = [];
    this.currentIndex = -1;
    this.maxHistory = 200;
    this.listeners = new Set();

    if (initialState) {
      this.commitSnapshot('@@INIT', initialState);
    }
  }

  // Deep clone helper to guarantee immutability across time-travel snapshots
  static cloneState(state) {
    if (state === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(state));
    } catch {
      return Object.assign({}, state);
    }
  }

  // Computes granular key-level differences between two state snapshots
  static computeDiff(s1 = {}, s2 = {}) {
    const stateA = s1 || {};
    const stateB = s2 || {};

    const added = [];
    const modified = [];
    const deleted = [];

    const allKeys = new Set([...Object.keys(stateA), ...Object.keys(stateB)]);

    for (const key of allKeys) {
      const hasA = Object.prototype.hasOwnProperty.call(stateA, key);
      const hasB = Object.prototype.hasOwnProperty.call(stateB, key);

      if (!hasA && hasB) {
        added.push({ key, value: stateB[key] });
      } else if (hasA && !hasB) {
        deleted.push({ key, oldValue: stateA[key] });
      } else if (JSON.stringify(stateA[key]) !== JSON.stringify(stateB[key])) {
        modified.push({ key, oldValue: stateA[key], newValue: stateB[key] });
      }
    }

    return { added, modified, deleted };
  }

  commitSnapshot(action = 'ACTION', state = {}) {
    const cleanAction = String(action || 'UNSPECIFIED_ACTION').trim();
    const immutableState = DefiYieldMatrixTimeTravelStore.cloneState(state);

    // If scrubbed backwards, drop forward timeline on new action branch
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    const snapshot = {
      index: this.history.length,
      action: cleanAction,
      timestamp: Date.now(),
      timeFormatted: new Date().toLocaleTimeString(),
      state: immutableState
    };

    this.history.push(snapshot);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
      // Re-index remaining snapshots
      this.history.forEach((s, idx) => { s.index = idx; });
    }

    this.currentIndex = this.history.length - 1;

    this._emit();
    return snapshot;
  }

  stepTo(index) {
    if (this.history.length === 0) return null;
    const clampedIndex = Math.min(this.history.length - 1, Math.max(0, Math.floor(Number(index) || 0)));
    const previousIndex = this.currentIndex;
    this.currentIndex = clampedIndex;

    const currentSnapshot = this.history[this.currentIndex];
    const prevSnapshot = this.history[previousIndex >= 0 ? previousIndex : 0];
    const diff = DefiYieldMatrixTimeTravelStore.computeDiff(prevSnapshot?.state, currentSnapshot?.state);

    this._emit();
    return {
      snapshot: currentSnapshot,
      diff
    };
  }

  undo() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      const currentSnapshot = this.history[this.currentIndex];
      const prevSnapshot = this.history[this.currentIndex - 1];
      const diff = DefiYieldMatrixTimeTravelStore.computeDiff(prevSnapshot?.state, currentSnapshot?.state);

      this._emit();
      return {
        snapshot: currentSnapshot,
        diff
      };
    }
    return null;
  }

  redo() {
    if (this.currentIndex < this.history.length - 1) {
      this.currentIndex++;
      const currentSnapshot = this.history[this.currentIndex];
      const prevSnapshot = this.history[this.currentIndex - 1];
      const diff = DefiYieldMatrixTimeTravelStore.computeDiff(prevSnapshot?.state, currentSnapshot?.state);

      this._emit();
      return {
        snapshot: currentSnapshot,
        diff
      };
    }
    return null;
  }

  getCurrentState() {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) return null;
    return DefiYieldMatrixTimeTravelStore.cloneState(this.history[this.currentIndex].state);
  }

  getHistory() {
    return this.history.map(s => ({
      index: s.index,
      action: s.action,
      timestamp: s.timestamp,
      timeFormatted: s.timeFormatted,
      state: DefiYieldMatrixTimeTravelStore.cloneState(s.state)
    }));
  }

  exportHistory() {
    return JSON.stringify({
      version: '1.0.0',
      system: 'DefiYieldMatrix-TimeTravelStore',
      exportedAt: new Date().toISOString(),
      history: this.history,
      currentIndex: this.currentIndex
    }, null, 2);
  }

  importHistory(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      if (!Array.isArray(data.history) || data.history.length === 0) return false;

      this.history = data.history.map((s, idx) => ({
        index: idx,
        action: String(s.action || 'REPLAY_ACTION'),
        timestamp: s.timestamp || Date.now(),
        timeFormatted: s.timeFormatted || new Date().toLocaleTimeString(),
        state: DefiYieldMatrixTimeTravelStore.cloneState(s.state || {})
      }));

      this.currentIndex = Math.min(this.history.length - 1, Math.max(0, data.currentIndex || 0));
      this._emit();
      return true;
    } catch {
      return false;
    }
  }

  subscribe(fn) {
    if (typeof fn === 'function') {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    return () => {};
  }

  _emit() {
    const current = this.history[this.currentIndex] || null;
    for (const fn of this.listeners) {
      try {
        fn({ current, history: this.history, index: this.currentIndex });
      } catch (err) {
        console.error('Time-travel store listener error:', err);
      }
    }
  }
}

// Browser UI Driver
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const store = new DefiYieldMatrixTimeTravelStore();

    const slider = document.getElementById('timelineSlider');
    const frameCursor = document.getElementById('frameCursor');
    const stepBadge = document.getElementById('currentStepBadge');
    const actionListEl = document.getElementById('actionHistoryList');
    const jsonStateEl = document.getElementById('stateJsonView');
    const diffContainer = document.getElementById('diffViewContainer');
    const btnUndo = document.getElementById('btnUndo');
    const btnRedo = document.getElementById('btnRedo');
    const btnStepBack = document.getElementById('btnStepBack');
    const btnStepForward = document.getElementById('btnStepForward');
    const btnPlay = document.getElementById('btnPlay');
    const btnExport = document.getElementById('btnExport');

    let playInterval = null;
    let isPlaying = false;

    function renderUI() {
      const hist = store.getHistory();
      const curr = hist[store.currentIndex];

      if (slider) {
        slider.max = String(Math.max(0, hist.length - 1));
        slider.value = String(store.currentIndex);
      }

      if (frameCursor) {
        frameCursor.textContent = `Frame: ${store.currentIndex}`;
      }

      if (stepBadge) {
        stepBadge.textContent = `Step ${store.currentIndex + 1} / ${hist.length}`;
      }

      if (jsonStateEl && curr) {
        jsonStateEl.textContent = JSON.stringify(curr.state, null, 2);
      }

      // Render action items
      if (actionListEl) {
        actionListEl.replaceChildren();
        hist.forEach(s => {
          const item = document.createElement('div');
          item.className = `action-item ${s.index === store.currentIndex ? 'active' : ''}`;
          item.innerHTML = `
            <span class="action-name">${s.action}</span>
            <span class="action-time">${s.timeFormatted}</span>
          `;
          item.onclick = () => store.jumpToStep ? store.jumpToStep(s.index) : store.stepTo(s.index);
          actionListEl.appendChild(item);
        });
      }

      // Render diff from previous step
      if (diffContainer) {
        diffContainer.replaceChildren();
        const prev = store.currentIndex > 0 ? hist[store.currentIndex - 1] : null;
        const diff = DefiYieldMatrixTimeTravelStore.computeDiff(prev?.state, curr?.state);

        if (diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0) {
          const clean = document.createElement('div');
          clean.className = 'diff-empty';
          clean.textContent = 'No state mutations at this snapshot step.';
          diffContainer.appendChild(clean);
        } else {
          diff.modified.forEach(m => {
            const row = document.createElement('div');
            row.className = 'diff-row diff-mod';
            row.textContent = `~ ${m.key}: ${JSON.stringify(m.oldValue)} -> ${JSON.stringify(m.newValue)}`;
            diffContainer.appendChild(row);
          });
          diff.added.forEach(a => {
            const row = document.createElement('div');
            row.className = 'diff-row diff-add';
            row.textContent = `+ ${a.key}: ${JSON.stringify(a.value)}`;
            diffContainer.appendChild(row);
          });
          diff.deleted.forEach(d => {
            const row = document.createElement('div');
            row.className = 'diff-row diff-del';
            row.textContent = `- ${d.key}: ${JSON.stringify(d.oldValue)}`;
            diffContainer.appendChild(row);
          });
        }
      }

      // Update control button states
      if (btnUndo) btnUndo.disabled = store.currentIndex <= 0;
      if (btnRedo) btnRedo.disabled = store.currentIndex >= hist.length - 1;
      if (btnStepBack) btnStepBack.disabled = store.currentIndex <= 0;
      if (btnStepForward) btnStepForward.disabled = store.currentIndex >= hist.length - 1;
    }

    // Slider input
    slider?.addEventListener('input', (e) => {
      store.stepTo(Number(e.target.value));
    });

    // Undo
    btnUndo?.addEventListener('click', () => {
      const result = store.undo();
      if (result) renderUI();
    });

    // Redo
    btnRedo?.addEventListener('click', () => {
      const result = store.redo();
      if (result) renderUI();
    });

    // Step Back
    btnStepBack?.addEventListener('click', () => {
      store.undo();
      renderUI();
    });

    // Step Forward
    btnStepForward?.addEventListener('click', () => {
      store.redo();
      renderUI();
    });

    // Play/Pause toggle
    btnPlay?.addEventListener('click', () => {
      isPlaying = !isPlaying;
      btnPlay.textContent = isPlaying ? 'Pause' : 'Play';

      if (isPlaying) {
        playInterval = setInterval(() => {
          if (store.currentIndex < store.getHistory().length - 1) {
            store.redo();
          } else {
            store.stepTo(0);
          }
          renderUI();
        }, 800);
      } else {
        if (playInterval) {
          clearInterval(playInterval);
          playInterval = null;
        }
      }
    });

    // Export JSON
    btnExport?.addEventListener('click', () => {
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(store.exportHistory());
      const dlAnchor = document.createElement('a');
      dlAnchor.setAttribute('href', dataStr);
      dlAnchor.setAttribute('download', `defi-state-snapshot-${Date.now()}.json`);
      dlAnchor.click();
    });

    renderUI();
  });
}

// Alias for compatibility - jumpToStep
DefiYieldMatrixTimeTravelStore.prototype.jumpToStep = DefiYieldMatrixTimeTravelStore.prototype.stepTo;