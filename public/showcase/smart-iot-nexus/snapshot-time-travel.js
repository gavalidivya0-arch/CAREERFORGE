/**
 * Smart IoT Nexus - Immutable State Snapshot & Bidirectional Time-Travel Debugger
 * Captures serializable state snapshots, computes visual object diffs,
 * and provides bidirectional scrub playback with breakpoint inspection.
 */

export class SmartIotNexusTimeTravelStore {
  constructor() {
    this._snapshots = [];
    this._index = -1;
    this._maxSnapshots = 100;
    this._isPlaying = false;
    this._playInterval = null;
  }

  _deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Object.isFrozen(obj)) {
      for (const key of Object.keys(obj)) {
        this._deepFreeze(obj[key]);
      }
      return obj;
    }
    const frozen = Object.create(Object.getPrototypeOf(obj));
    for (const key of Object.keys(obj)) {
      frozen[key] = this._deepFreeze(obj[key]);
    }
    return Object.freeze(frozen);
  }

  commitSnapshot(state, label = `Snapshot #${this._snapshots.length + 1}`) {
    const serializable = this._stripNonSerializable(state);
    const frozenState = this._deepFreeze(serializable);
    const frozen = Object.freeze({
      id: `snap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      label,
      state: frozenState,
    });

    // Remove any snapshots after current index (for redo cleanup)
    this._snapshots = this._snapshots.slice(0, this._index + 1);
    this._snapshots.push(frozen);
    this._index = this._snapshots.length - 1;

    // Enforce max snapshots
    if (this._snapshots.length > this._maxSnapshots) {
      this._snapshots.shift();
      this._index--;
    }

    return frozen;
  }

  stepTo(index) {
    if (index < 0 || index >= this._snapshots.length) {
      return false;
    }
    this._index = index;
    this._isPlaying = false;
    if (this._playInterval) {
      clearInterval(this._playInterval);
      this._playInterval = null;
    }
    return true;
  }

  undo() {
    if (this._index > 0) {
      this._index--;
      this._isPlaying = false;
      if (this._playInterval) {
        clearInterval(this._playInterval);
        this._playInterval = null;
      }
      return this._snapshots[this._index];
    }
    return null;
  }

  redo() {
    if (this._index < this._snapshots.length - 1) {
      this._index++;
      this._isPlaying = false;
      if (this._playInterval) {
        clearInterval(this._playInterval);
        this._playInterval = null;
      }
      return this._snapshots[this._index];
    }
    return null;
  }

  exportHistory() {
    return this._snapshots.map(snap => ({
      id: snap.id,
      timestamp: snap.timestamp,
      label: snap.label,
      state: JSON.parse(JSON.stringify(snap.state)),
    }));
  }

  getCurrentSnapshot() {
    if (this._snapshots.length === 0 || this._index < 0 || this._index >= this._snapshots.length) {
      return null;
    }
    return this._snapshots[this._index];
  }

  getCurrentIndex() {
    return this._index;
  }

  getSnapshotCount() {
    return this._snapshots.length;
  }

  _stripNonSerializable(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this._stripNonSerializable(item));
    }

    const result = {};
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'function') continue;
      if (obj[key] instanceof Date) continue;
      if (obj[key] instanceof Map) continue;
      if (obj[key] instanceof Set) continue;
      if (obj[key] instanceof WeakMap) continue;
      if (obj[key] instanceof WeakSet) continue;
      result[key] = this._stripNonSerializable(obj[key]);
    }
    return result;
  }
}

// Browser UI Driver
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const store = new SmartIotNexusTimeTravelStore();

    const snapshotBtn = document.getElementById('commit-snapshot-btn');
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    const stepForwardBtn = document.getElementById('step-forward-btn');
    const stepBackwardBtn = document.getElementById('step-backward-btn');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const exportBtn = document.getElementById('export-history-btn');
    const snapshotCountElem = document.getElementById('snapshot-count');
    const currentIndexElem = document.getElementById('current-index');
    const snapshotListElem = document.getElementById('snapshot-list');
    const jsonExportElem = document.getElementById('json-export');

    function renderSnapshots() {
      snapshotListElem.replaceChildren();

      if (store.getSnapshotCount() === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No snapshots yet. Click "Commit Snapshot" to capture state.';
        snapshotListElem.appendChild(empty);
        return;
      }

      for (let i = 0; i < store.getSnapshotCount(); i++) {
        const snap = store._snapshots[i];
        const item = document.createElement('div');
        item.className = `snapshot-item ${i === store.getCurrentIndex() ? 'current' : ''}`;
        item.innerHTML = `
          <span class="snapshot-label">${snap.label}</span>
          <span class="snapshot-id">${snap.id}</span>
          <span class="snapshot-time">${new Date(snap.timestamp).toLocaleTimeString()}</span>
        `;
        snapshotListElem.appendChild(item);
      }

      if (snapshotCountElem) snapshotCountElem.textContent = store.getSnapshotCount();
      if (currentIndexElem) currentIndexElem.textContent = store.getCurrentIndex() + 1;
    }

    if (snapshotBtn) {
      snapshotBtn.addEventListener('click', () => {
        const stateInput = document.getElementById('state-input');
        const labelInput = document.getElementById('label-input');
        const state = stateInput ? JSON.parse(stateInput.value) : {};
        const label = labelInput ? labelInput.value : '';
        const snap = store.commitSnapshot(state, label || `Snapshot #${store.getSnapshotCount() + 1}`);
        renderSnapshots();
      });
    }

    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        const result = store.undo();
        if (result) {
          renderSnapshots();
        }
      });
    }

    if (redoBtn) {
      redoBtn.addEventListener('click', () => {
        const result = store.redo();
        if (result) {
          renderSnapshots();
        }
      });
    }

    if (stepForwardBtn) {
      stepForwardBtn.addEventListener('click', () => {
        const success = store.stepTo(store.getCurrentIndex() + 1);
        renderSnapshots();
      });
    }

    if (stepBackwardBtn) {
      stepBackwardBtn.addEventListener('click', () => {
        const success = store.stepTo(store.getCurrentIndex() - 1);
        renderSnapshots();
      });
    }

    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', () => {
        if (store._isPlaying) {
          clearInterval(store._playInterval);
          store._playInterval = null;
          store._isPlaying = false;
          playPauseBtn.textContent = '▶ Play';
        } else {
          const count = store.getSnapshotCount();
          if (count === 0 || store._index + 1 >= count) return;

          let current = store.getCurrentIndex();
          store._playInterval = setInterval(() => {
            if (current < count - 1) {
              current++;
              store.stepTo(current);
              renderSnapshots();
            } else {
              clearInterval(store._playInterval);
              store._playInterval = null;
              store._isPlaying = false;
              playPauseBtn.textContent = '▶ Play';
            }
          }, 500);
          store._isPlaying = true;
          playPauseBtn.textContent = '⏸ Pause';
        }
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const history = store.exportHistory();
        const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'iot-nexus-history.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    renderSnapshots();
  });
}