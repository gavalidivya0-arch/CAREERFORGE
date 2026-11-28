/**
 * AgritechPrecisionFarmingTimeTravelStore
 * Immutable State Snapshot & Bidirectional Time-Travel Debugger.
 * Manages serializable state histories with deep immutability guarantees,
 * index scrubbing, object property diffing, undo/redo, and JSON import/export.
 */

export class AgritechPrecisionFarmingTimeTravelStore {
  constructor(initialState = null) {
    this.name = 'AgritechPrecisionFarmingTimeTravelStore';
    this.history = [];
    this.currentIndex = -1;
    this.playbackTimer = null;
    this.isPlaying = false;
    this.listeners = [];

    if (initialState !== null) {
      this.commitSnapshot(initialState, 'Initial Baseline');
    }
  }

  /**
   * Deep clones any serializable object to guarantee absolute immutability.
   * @param {*} obj
   * @returns {*}
   */
  #deepClone(obj) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(obj);
      } catch {
        // Fallback to JSON serialize
      }
    }
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Commits a new immutable snapshot to the timeline.
   * If scrubbing in the past, future history is truncated (standard branch commit).
   * @param {object} state - State object
   * @param {string} [label='Snapshot']
   * @returns {object} The committed snapshot
   */
  commitSnapshot(state, label = 'Snapshot') {
    const clonedState = this.#deepClone(state);

    // Truncate forward history if scrubbing behind head
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    const snapshot = {
      id: `snapshot-${this.history.length}`,
      index: this.history.length,
      label: String(label || 'Snapshot'),
      timestamp: Date.now(),
      state: clonedState
    };

    this.history.push(snapshot);
    this.currentIndex = this.history.length - 1;

    this.notify('snapshot_committed', { snapshot, currentIndex: this.currentIndex });
    return this.#deepClone(snapshot);
  }

  /**
   * Returns a deep clone of the snapshot at the current time-travel position.
   * @returns {object|null}
   */
  getCurrentSnapshot() {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return this.#deepClone(this.history[this.currentIndex]);
  }

  /**
   * Steps the timeline cursor to a specific frame index.
   * @param {number} targetIndex
   * @returns {object|null}
   */
  stepTo(targetIndex) {
    if (this.history.length === 0) return null;

    const clampedIndex = Math.max(0, Math.min(this.history.length - 1, Number(targetIndex)));
    this.currentIndex = clampedIndex;

    const snapshot = this.getCurrentSnapshot();
    const diff = this.getDiffAgainstPrevious();

    this.notify('stepped', { snapshot, currentIndex: this.currentIndex, diff });
    return snapshot;
  }

  /**
   * Steps one frame backward in time (Undo).
   * @returns {object|null}
   */
  undo() {
    if (this.currentIndex > 0) {
      return this.stepTo(this.currentIndex - 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Steps one frame forward in time (Redo).
   * @returns {object|null}
   */
  redo() {
    if (this.currentIndex < this.history.length - 1) {
      return this.stepTo(this.currentIndex + 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Computes granular property diff between two states.
   * @param {object} oldState
   * @param {object} newState
   * @returns {Array<{ key: string, type: string, oldVal: *, newVal: * }>}
   */
  computeDiff(oldState, newState) {
    const diffs = [];
    if (!oldState || !newState) return diffs;

    const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);

    for (const key of allKeys) {
      const hasOld = Object.prototype.hasOwnProperty.call(oldState, key);
      const hasNew = Object.prototype.hasOwnProperty.call(newState, key);

      if (!hasOld && hasNew) {
        diffs.push({ key, type: 'added', oldVal: undefined, newVal: newState[key] });
      } else if (hasOld && !hasNew) {
        diffs.push({ key, type: 'removed', oldVal: oldState[key], newVal: undefined });
      } else {
        const oldValStr = JSON.stringify(oldState[key]);
        const newValStr = JSON.stringify(newState[key]);
        if (oldValStr !== newValStr) {
          diffs.push({ key, type: 'modified', oldVal: oldState[key], newVal: newState[key] });
        }
      }
    }

    return diffs;
  }

  /**
   * Gets diff of current snapshot relative to the immediately preceding frame.
   * @returns {Array<object>}
   */
  getDiffAgainstPrevious() {
    if (this.currentIndex <= 0) return [];
    const prev = this.history[this.currentIndex - 1].state;
    const curr = this.history[this.currentIndex].state;
    return this.computeDiff(prev, curr);
  }

  /**
   * Exports full timeline history into a serializable JSON string.
   * @returns {string}
   */
  exportHistory() {
    return JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      currentIndex: this.currentIndex,
      history: this.history
    }, null, 2);
  }

  /**
   * Imports and validates an exported timeline JSON string.
   * @param {string} jsonStr
   * @returns {boolean}
   */
  importHistory(jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !Array.isArray(parsed.history)) return false;

      this.history = parsed.history.map((s, idx) => ({
        id: s.id || `snapshot-${idx}`,
        index: idx,
        label: s.label || `Frame #${idx}`,
        timestamp: s.timestamp || Date.now(),
        state: this.#deepClone(s.state || {})
      }));

      const targetIdx = typeof parsed.currentIndex === 'number' ? parsed.currentIndex : this.history.length - 1;
      this.stepTo(targetIdx);
      this.notify('imported', { historyLength: this.history.length, currentIndex: this.currentIndex });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts automatic animated time-travel replay scrub.
   * @param {number} [intervalMs=800]
   * @param {Function} [onStep=null]
   */
  startReplay(intervalMs = 800, onStep = null) {
    this.stopReplay();
    this.isPlaying = true;

    // Loop back to start if at the end
    if (this.currentIndex >= this.history.length - 1) {
      this.stepTo(0);
    }

    this.playbackTimer = setInterval(() => {
      if (this.currentIndex < this.history.length - 1) {
        const snap = this.redo();
        if (typeof onStep === 'function') onStep(snap);
      } else {
        this.stopReplay();
      }
    }, intervalMs);

    this.notify('playback_start', {});
  }

  /**
   * Stops active replay scrub.
   */
  stopReplay() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.isPlaying = false;
    this.notify('playback_stop', {});
  }

  /**
   * Subscribes a listener to timeline updates.
   * @param {Function} callback
   */
  subscribe(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }

  notify(event, data) {
    this.listeners.forEach((fn) => fn(event, data));
  }
}

// Browser DOM controller
if (typeof document !== 'undefined') {
  const initTimeTravelLab = () => {
    const root = document.querySelector('[data-time-travel-lab]');
    if (!root) return;

    const initialFarmState = {
      soilMoisture: 42,
      greenhouseTemp: 23.5,
      irrigationValve: 'CLOSED',
      pestAlert: 'NOMINAL',
      irrigationCyclesRun: 3,
      telemetryNodesOnline: 24
    };

    const store = new AgritechPrecisionFarmingTimeTravelStore(initialFarmState);

    const currentFrameVal = root.querySelector('#current-frame-val');
    const currentLabelVal = root.querySelector('#current-label-val');
    const playbackStatusVal = root.querySelector('#playback-status-val');
    const historyCountVal = root.querySelector('#history-count-val');
    const timelineSlider = root.querySelector('#timeline-slider');
    const tickMarksContainer = root.querySelector('#tick-marks');
    const currentFrameIndicator = root.querySelector('#current-frame-indicator');
    const endFrameLabel = root.querySelector('#end-frame-label');
    const stepBackBtn = root.querySelector('#step-back-btn');
    const playBtn = root.querySelector('#play-btn');
    const stepFwdBtn = root.querySelector('#step-fwd-btn');
    const exportBtn = root.querySelector('#export-btn');
    const stateForm = root.querySelector('#state-form');
    const soilMoistureInput = root.querySelector('#soil-moisture');
    const greenhouseTempInput = root.querySelector('#greenhouse-temp');
    const irrigationValveSelect = root.querySelector('#irrigation-valve');
    const pestAlertSelect = root.querySelector('#pest-alert');
    const commitLabelInput = root.querySelector('#commit-label');
    const snapshotIdTag = root.querySelector('#snapshot-id-tag');
    const stateViewer = root.querySelector('#state-viewer');
    const diffInspector = root.querySelector('#diff-inspector');
    const historyFramesList = root.querySelector('#history-frames-list');
    const timelineCountBadge = root.querySelector('#timeline-count-badge');

    function renderUI() {
      const snap = store.getCurrentSnapshot();
      const count = store.history.length;
      const idx = store.currentIndex;

      currentFrameVal.textContent = count > 0 ? `${idx} / ${count - 1}` : '0 / 0';
      currentLabelVal.textContent = snap ? snap.label : 'None';
      historyCountVal.textContent = `${count} Snapshots`;
      timelineCountBadge.textContent = `${count} Frames`;
      snapshotIdTag.textContent = snap ? snap.id : 'N/A';

      // Scrubber slider bounds
      timelineSlider.max = Math.max(0, count - 1);
      timelineSlider.value = idx;
      currentFrameIndicator.textContent = `Frame #${idx}`;
      endFrameLabel.textContent = `Frame #${Math.max(0, count - 1)}`;

      // Render tick marks
      tickMarksContainer.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const tick = document.createElement('div');
        tick.className = `tick ${i === idx ? 'active' : ''}`;
        tickMarksContainer.appendChild(tick);
      }

      // JSON viewer
      stateViewer.textContent = snap ? JSON.stringify(snap.state, null, 2) : '{}';

      // Render Diffs
      const diffs = store.getDiffAgainstPrevious();
      if (idx <= 0 || diffs.length === 0) {
        diffInspector.innerHTML = `<p class="empty-diff-hint">${idx === 0 ? 'Initial baseline frame: No earlier snapshot to diff against.' : 'No property mutations detected in this frame.'}</p>`;
      } else {
        diffInspector.innerHTML = '';
        diffs.forEach((d) => {
          const item = document.createElement('div');
          item.className = 'diff-item-card';
          item.innerHTML = `
            <span class="diff-prop-key">${d.key}</span>
            <div class="diff-value-transition">
              <span class="diff-old-val">${JSON.stringify(d.oldVal)}</span>
              <span>➔</span>
              <span class="diff-new-val">${JSON.stringify(d.newVal)}</span>
              <span class="diff-badge ${d.type}">${d.type}</span>
            </div>
          `;
          diffInspector.appendChild(item);
        });
      }

      // Render History Frames List
      historyFramesList.innerHTML = '';
      store.history.forEach((frame, i) => {
        const row = document.createElement('div');
        row.className = `frame-row ${i === idx ? 'active' : ''}`;
        row.innerHTML = `
          <span class="frame-label">#${i}: ${frame.label}</span>
          <span class="frame-time">${new Date(frame.timestamp).toLocaleTimeString()}</span>
        `;
        row.addEventListener('click', () => {
          store.stepTo(i);
          renderUI();
        });
        historyFramesList.appendChild(row);
      });
    }

    // Event listeners
    timelineSlider.addEventListener('input', (e) => {
      store.stepTo(Number(e.target.value));
      renderUI();
    });

    stepBackBtn.addEventListener('click', () => {
      store.undo();
      renderUI();
    });

    stepFwdBtn.addEventListener('click', () => {
      store.redo();
      renderUI();
    });

    playBtn.addEventListener('click', () => {
      if (store.isPlaying) {
        store.stopReplay();
        playBtn.textContent = '▶ Play Replay';
        playbackStatusVal.textContent = 'Paused';
      } else {
        store.startReplay(800, () => renderUI());
        playBtn.textContent = '⏸ Pause Replay';
        playbackStatusVal.textContent = 'Playing...';
      }
    });

    exportBtn.addEventListener('click', () => {
      const json = store.exportHistory();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agritech-telemetry-timeline-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    stateForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const newState = {
        soilMoisture: Number(soilMoistureInput.value),
        greenhouseTemp: Number(greenhouseTempInput.value),
        irrigationValve: irrigationValveSelect.value,
        pestAlert: pestAlertSelect.value,
        irrigationCyclesRun: store.history.length + 3,
        telemetryNodesOnline: 24
      };
      const label = commitLabelInput.value.trim() || 'Telemetry Mutation';
      store.commitSnapshot(newState, label);
      renderUI();
    });

    // Seed preset snapshots for immediate inspection
    store.commitSnapshot({
      ...initialFarmState,
      soilMoisture: 36,
      irrigationValve: 'OPEN',
      irrigationCyclesRun: 4
    }, 'Initiated Drip Irrigation');

    store.commitSnapshot({
      ...initialFarmState,
      soilMoisture: 58,
      greenhouseTemp: 25.0,
      irrigationValve: 'CLOSED',
      irrigationCyclesRun: 4
    }, 'Post-Irrigation Moisture Peak');

    store.commitSnapshot({
      ...initialFarmState,
      soilMoisture: 55,
      greenhouseTemp: 18.2,
      pestAlert: 'CRITICAL'
    }, 'Frost Warning Alarm Triggered');

    renderUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTimeTravelLab);
  } else {
    initTimeTravelLab();
  }
}
