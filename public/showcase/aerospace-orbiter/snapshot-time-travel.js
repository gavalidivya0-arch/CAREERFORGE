/**
 * AerospaceOrbiterTimeTravelStore
 * Immutable State Snapshot & Bidirectional Time-Travel Debugger for Aerospace Orbiter.
 * Captures serializable telemetry state snapshots with deep immutability guarantees,
 * bidirectional index scrubbing, object property diffing, breakpoint inspection,
 * and JSON timeline export/import.
 */

export class AerospaceOrbiterTimeTravelStore {
  constructor(initialState = null) {
    this.name = 'AerospaceOrbiterTimeTravelStore';
    this.history = [];
    this.currentIndex = -1;
    this.playbackTimer = null;
    this.isPlaying = false;
    this.playbackDirection = 'forward';
    this.breakpoints = new Set();
    this.watchBreakpoints = [];
    this.lastHitBreakpoint = null;
    this.listeners = [];

    if (initialState !== null) {
      this.commitSnapshot(initialState, 'Initial Telemetry Baseline');
    }
  }

  /**
   * Deep clones any serializable value to guarantee snapshot immutability.
   * @param {*} obj
   * @returns {*}
   */
  #deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(obj);
      } catch {
        // Fallback to JSON round-trip
      }
    }
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Commits a new immutable snapshot to the timeline.
   * Truncates any forward branch if committed while scrubbed in the past.
   * @param {object} state
   * @param {string} [label='Snapshot']
   * @returns {object}
   */
  commitSnapshot(state, label = 'Snapshot') {
    if (state === undefined) {
      throw new TypeError('Snapshot state cannot be undefined.');
    }

    const clonedState = this.#deepClone(state);

    // Truncate forward timeline when branching from a past frame
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
      for (const bpIndex of Array.from(this.breakpoints)) {
        if (bpIndex >= this.history.length) {
          this.breakpoints.delete(bpIndex);
        }
      }
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
    this.lastHitBreakpoint = null;

    this.notify('snapshot_committed', {
      snapshot: this.#deepClone(snapshot),
      currentIndex: this.currentIndex
    });

    return this.#deepClone(snapshot);
  }

  /**
   * Returns a deep clone of the snapshot at the active cursor index.
   * @returns {object|null}
   */
  getCurrentSnapshot() {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return this.#deepClone(this.history[this.currentIndex]);
  }

  /**
   * Returns a deep-cloned copy of the full snapshot history array.
   * @returns {Array<object>}
   */
  getHistory() {
    return this.#deepClone(this.history);
  }

  /**
   * Jumps the timeline cursor directly to the specified snapshot index (clamped).
   * @param {number} index
   * @returns {object|null}
   */
  stepTo(index) {
    if (this.history.length === 0) return null;

    const numericIndex = Number(index);
    if (!Number.isFinite(numericIndex)) {
      return this.getCurrentSnapshot();
    }

    const clampedIndex = Math.max(
      0,
      Math.min(this.history.length - 1, Math.trunc(numericIndex))
    );
    this.currentIndex = clampedIndex;

    const snapshot = this.getCurrentSnapshot();
    const diff = this.getDiffAgainstPrevious();

    this.notify('stepped', {
      snapshot,
      currentIndex: this.currentIndex,
      diff
    });

    return snapshot;
  }

  /**
   * Steps one frame backward in the timeline.
   * @returns {object|null}
   */
  undo() {
    if (this.currentIndex > 0) {
      return this.stepTo(this.currentIndex - 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Steps one frame forward in the timeline.
   * @returns {object|null}
   */
  redo() {
    if (this.currentIndex < this.history.length - 1) {
      return this.stepTo(this.currentIndex + 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Deep structural equality check for JSON-serializable values.
   * @param {*} a
   * @param {*} b
   * @returns {boolean}
   */
  #deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this.#deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !this.#deepEqual(a[k], b[k])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Computes property-level diff between two state objects.
   * @param {object} oldState
   * @param {object} newState
   * @returns {Array<{ key: string, type: 'added'|'removed'|'modified', oldVal: *, newVal: * }>}
   */
  computeDiff(oldState, newState) {
    const diffs = [];
    if (!oldState || !newState || typeof oldState !== 'object' || typeof newState !== 'object') {
      return diffs;
    }

    const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);

    for (const key of allKeys) {
      const hasOld = Object.prototype.hasOwnProperty.call(oldState, key);
      const hasNew = Object.prototype.hasOwnProperty.call(newState, key);

      if (!hasOld && hasNew) {
        diffs.push({
          key,
          type: 'added',
          oldVal: undefined,
          newVal: this.#deepClone(newState[key])
        });
      } else if (hasOld && !hasNew) {
        diffs.push({
          key,
          type: 'removed',
          oldVal: this.#deepClone(oldState[key]),
          newVal: undefined
        });
      } else if (!this.#deepEqual(oldState[key], newState[key])) {
        diffs.push({
          key,
          type: 'modified',
          oldVal: this.#deepClone(oldState[key]),
          newVal: this.#deepClone(newState[key])
        });
      }
    }

    return diffs;
  }

  /**
   * Computes property diff of the active frame against its immediate predecessor.
   * @returns {Array<object>}
   */
  getDiffAgainstPrevious() {
    if (this.currentIndex <= 0) return [];
    const prev = this.history[this.currentIndex - 1].state;
    const curr = this.history[this.currentIndex].state;
    return this.computeDiff(prev, curr);
  }

  /**
   * Toggles a frame breakpoint at the given snapshot index.
   * @param {number} index
   * @returns {boolean} True if breakpoint is now enabled on that index
   */
  toggleBreakpoint(index) {
    const idx = Math.trunc(Number(index));
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.history.length) {
      return false;
    }
    if (this.breakpoints.has(idx)) {
      this.breakpoints.delete(idx);
      this.notify('breakpoint_updated', { index: idx, active: false });
      return false;
    }
    this.breakpoints.add(idx);
    this.notify('breakpoint_updated', { index: idx, active: true });
    return true;
  }

  /**
   * Checks whether a frame breakpoint is set on the given index.
   * @param {number} index
   * @returns {boolean}
   */
  hasBreakpoint(index) {
    return this.breakpoints.has(index);
  }

  /**
   * Registers a conditional property watchpoint inspected during playback.
   * @param {string} key
   * @param {'==='|'!=='|'<'|'<='|'>'|'>='|'changed'} operator
   * @param {*} [value]
   * @returns {object}
   */
  addWatchBreakpoint(key, operator = 'changed', value = undefined) {
    const bp = {
      id: `bp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      key: String(key),
      operator,
      value: this.#deepClone(value),
      enabled: true
    };
    this.watchBreakpoints.push(bp);
    this.notify('watchpoint_added', { breakpoint: this.#deepClone(bp) });
    return this.#deepClone(bp);
  }

  /**
   * Removes a conditional property watchpoint by ID.
   * @param {string} id
   * @returns {boolean}
   */
  removeWatchBreakpoint(id) {
    const before = this.watchBreakpoints.length;
    this.watchBreakpoints = this.watchBreakpoints.filter((bp) => bp.id !== id);
    const removed = this.watchBreakpoints.length < before;
    if (removed) {
      this.notify('watchpoint_removed', { id });
    }
    return removed;
  }

  /**
   * Evaluates frame and property watch breakpoints at a given index.
   * @param {number} index
   * @returns {object|null}
   */
  evaluateBreakpoints(index) {
    if (index < 0 || index >= this.history.length) return null;

    if (this.breakpoints.has(index)) {
      return { kind: 'frame', index, reason: `Frame #${index} breakpoint` };
    }

    const current = this.history[index].state || {};
    const prev = index > 0 ? (this.history[index - 1].state || {}) : null;

    for (const bp of this.watchBreakpoints) {
      if (!bp.enabled) continue;
      const hasCurr = Object.prototype.hasOwnProperty.call(current, bp.key);
      const hasPrev = prev !== null && Object.prototype.hasOwnProperty.call(prev, bp.key);

      if (bp.operator === 'changed') {
        if (prev !== null && (hasCurr !== hasPrev || (hasCurr && !this.#deepEqual(prev[bp.key], current[bp.key])))) {
          return {
            kind: 'watch',
            index,
            key: bp.key,
            operator: bp.operator,
            expected: this.#deepClone(bp.value),
            actual: hasCurr ? this.#deepClone(current[bp.key]) : undefined,
            reason: `${bp.key} changed`
          };
        }
        continue;
      }

      if (!hasCurr) continue;

      const val = current[bp.key];
      let matched = false;

      if (bp.operator === '===') {
        matched = val === bp.value;
      } else if (bp.operator === '!==') {
        matched = val !== bp.value;
      } else if (bp.operator === '<') {
        matched = Number(val) < Number(bp.value);
      } else if (bp.operator === '<=') {
        matched = Number(val) <= Number(bp.value);
      } else if (bp.operator === '>') {
        matched = Number(val) > Number(bp.value);
      } else if (bp.operator === '>=') {
        matched = Number(val) >= Number(bp.value);
      }

      if (matched) {
        return {
          kind: 'watch',
          index,
          key: bp.key,
          operator: bp.operator,
          expected: this.#deepClone(bp.value),
          actual: this.#deepClone(val),
          reason: `${bp.key} ${bp.operator} ${JSON.stringify(bp.value)}`
        };
      }
    }

    return null;
  }

  /**
   * Exports the full timeline history and metadata as formatted JSON.
   * @returns {string}
   */
  exportHistory() {
    return JSON.stringify({
      version: 1,
      module: 'aerospace-orbiter',
      exportedAt: Date.now(),
      currentIndex: this.currentIndex,
      breakpoints: Array.from(this.breakpoints),
      watchBreakpoints: this.watchBreakpoints,
      history: this.history
    }, null, 2);
  }

  /**
   * Imports and restores timeline history from an exported JSON string.
   * @param {string} jsonStr
   * @returns {boolean}
   */
  importHistory(jsonStr) {
    if (typeof jsonStr !== 'string') return false;
    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !Array.isArray(parsed.history)) return false;

      this.stopReplay();
      this.history = parsed.history.map((s, idx) => ({
        id: s.id || `snapshot-${idx}`,
        index: idx,
        label: String(s.label || `Frame #${idx}`),
        timestamp: typeof s.timestamp === 'number' ? s.timestamp : Date.now(),
        state: this.#deepClone(s.state ?? {})
      }));

      this.breakpoints = new Set(
        Array.isArray(parsed.breakpoints)
          ? parsed.breakpoints.filter((i) => Number.isInteger(i) && i >= 0 && i < this.history.length)
          : []
      );
      this.watchBreakpoints = Array.isArray(parsed.watchBreakpoints)
        ? this.#deepClone(parsed.watchBreakpoints)
        : [];
      this.lastHitBreakpoint = null;

      if (this.history.length === 0) {
        this.currentIndex = -1;
      } else {
        const targetIdx = typeof parsed.currentIndex === 'number'
          ? parsed.currentIndex
          : this.history.length - 1;
        this.stepTo(targetIdx);
      }

      this.notify('imported', {
        historyLength: this.history.length,
        currentIndex: this.currentIndex
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts bidirectional animated time-travel playback with breakpoint inspection.
   * @param {number} [intervalMs=800]
   * @param {Function|null} [onStep=null]
   * @param {'forward'|'backward'} [direction='forward']
   */
  startReplay(intervalMs = 800, onStep = null, direction = 'forward') {
    this.stopReplay();
    if (this.history.length === 0) return;

    this.playbackDirection = direction === 'backward' ? 'backward' : 'forward';
    this.isPlaying = true;
    this.lastHitBreakpoint = null;

    if (this.playbackDirection === 'forward' && this.currentIndex >= this.history.length - 1) {
      this.stepTo(0);
    } else if (this.playbackDirection === 'backward' && this.currentIndex <= 0) {
      this.stepTo(this.history.length - 1);
    }

    this.playbackTimer = setInterval(() => {
      const canAdvance = this.playbackDirection === 'forward'
        ? this.currentIndex < this.history.length - 1
        : this.currentIndex > 0;

      if (!canAdvance) {
        this.stopReplay();
        if (typeof onStep === 'function') onStep(this.getCurrentSnapshot(), null);
        return;
      }

      const snap = this.playbackDirection === 'forward' ? this.redo() : this.undo();
      const hitBp = this.evaluateBreakpoints(this.currentIndex);

      if (hitBp) {
        this.lastHitBreakpoint = hitBp;
        this.stopReplay();
        this.notify('breakpoint_hit', hitBp);
      }

      if (typeof onStep === 'function') {
        onStep(snap, hitBp);
      }
    }, intervalMs);

    this.notify('playback_start', { direction: this.playbackDirection });
  }

  /**
   * Stops active playback scrub.
   */
  stopReplay() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.isPlaying) {
      this.isPlaying = false;
      this.notify('playback_stop', {});
    }
  }

  /**
   * Subscribes a listener to timeline store events.
   * @param {Function} callback
   * @returns {Function} Unsubscribe callback
   */
  subscribe(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
      return () => {
        this.listeners = this.listeners.filter((fn) => fn !== callback);
      };
    }
    return () => {};
  }

  notify(event, data) {
    this.listeners.forEach((fn) => fn(event, data));
  }
}

// Browser DOM controller
if (typeof document !== 'undefined') {
  const initOrbiterTimeTravel = () => {
    const root = document.querySelector('[data-time-travel-lab]');
    if (!root) return;

    const initialOrbiterState = {
      missionId: 'ORBITER-X7',
      altitudeKm: 408.2,
      velocityKps: 7.66,
      inclinationDeg: 51.6,
      fuelRemainingPct: 92.4,
      stage: 'LEO_CRUISE',
      rcsThrusters: 'STANDBY'
    };

    const store = new AerospaceOrbiterTimeTravelStore(initialOrbiterState);

    const currentFrameVal = root.querySelector('#current-frame-val');
    const currentLabelVal = root.querySelector('#current-label-val');
    const playbackStatusVal = root.querySelector('#playback-status-val');
    const historyCountVal = root.querySelector('#history-count-val');
    const timelineSlider = root.querySelector('#timeline-slider');
    const tickMarksContainer = root.querySelector('#tick-marks');
    const currentFrameIndicator = root.querySelector('#current-frame-indicator');
    const endFrameLabel = root.querySelector('#end-frame-label');
    const stepBackBtn = root.querySelector('#step-back-btn');
    const playBackBtn = root.querySelector('#play-back-btn');
    const playBtn = root.querySelector('#play-btn');
    const stepFwdBtn = root.querySelector('#step-fwd-btn');
    const exportBtn = root.querySelector('#export-btn');
    const importBtn = root.querySelector('#import-btn');
    const importFileInput = root.querySelector('#import-file-input');
    const stateForm = root.querySelector('#state-form');
    const altitudeInput = root.querySelector('#altitude-km');
    const velocityInput = root.querySelector('#velocity-kps');
    const fuelInput = root.querySelector('#fuel-pct');
    const stageSelect = root.querySelector('#mission-stage');
    const rcsSelect = root.querySelector('#rcs-thrusters');
    const commitLabelInput = root.querySelector('#commit-label');
    const snapshotIdTag = root.querySelector('#snapshot-id-tag');
    const stateViewer = root.querySelector('#state-viewer');
    const diffInspector = root.querySelector('#diff-inspector');
    const historyFramesList = root.querySelector('#history-frames-list');
    const timelineCountBadge = root.querySelector('#timeline-count-badge');
    const breakpointAlert = root.querySelector('#breakpoint-alert');
    const watchForm = root.querySelector('#watchpoint-form');
    const watchKeySelect = root.querySelector('#watch-key');
    const watchOpSelect = root.querySelector('#watch-operator');
    const watchValueInput = root.querySelector('#watch-value');
    const watchListEl = root.querySelector('#watchpoints-list');

    function syncPlaybackButtons() {
      if (store.isPlaying) {
        if (store.playbackDirection === 'backward') {
          playBackBtn.textContent = '⏸ Pause Rev';
          playBtn.textContent = '▶ Play Fwd';
          playbackStatusVal.textContent = 'Replaying Backward';
        } else {
          playBtn.textContent = '⏸ Pause';
          playBackBtn.textContent = '◀ Play Rev';
          playbackStatusVal.textContent = 'Replaying Forward';
        }
      } else {
        playBtn.textContent = '▶ Play Fwd';
        playBackBtn.textContent = '◀ Play Rev';
        playbackStatusVal.textContent = store.lastHitBreakpoint ? 'Breakpoint Hit' : 'Paused';
      }
    }

    function renderUI() {
      const snap = store.getCurrentSnapshot();
      const count = store.history.length;
      const idx = store.currentIndex;

      currentFrameVal.textContent = count > 0 ? `${idx} / ${count - 1}` : '0 / 0';
      currentLabelVal.textContent = snap ? snap.label : 'None';
      historyCountVal.textContent = `${count} Snapshots`;
      timelineCountBadge.textContent = `${count} Frames`;
      snapshotIdTag.textContent = snap ? snap.id : 'N/A';
      syncPlaybackButtons();

      if (store.lastHitBreakpoint) {
        breakpointAlert.hidden = false;
        breakpointAlert.textContent = `⏸ Breakpoint Triggered at Frame #${store.lastHitBreakpoint.index}: ${store.lastHitBreakpoint.reason}`;
      } else {
        breakpointAlert.hidden = true;
        breakpointAlert.textContent = '';
      }

      // Scrubber bounds and current frame cursor
      timelineSlider.max = Math.max(0, count - 1);
      timelineSlider.value = Math.max(0, idx);
      currentFrameIndicator.textContent = `Frame #${Math.max(0, idx)}`;
      endFrameLabel.textContent = `Frame #${Math.max(0, count - 1)}`;

      // Render tick marks along track
      tickMarksContainer.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const tick = document.createElement('div');
        tick.className = 'tick';
        if (i === idx) tick.classList.add('active');
        if (store.hasBreakpoint(i)) tick.classList.add('has-breakpoint');
        tickMarksContainer.appendChild(tick);
      }

      // Render current snapshot JSON
      stateViewer.textContent = snap ? JSON.stringify(snap.state, null, 2) : '{}';

      // Render property diff inspector
      const diffs = store.getDiffAgainstPrevious();
      diffInspector.innerHTML = '';
      if (idx <= 0 || diffs.length === 0) {
        const hint = document.createElement('p');
        hint.className = 'empty-diff-hint';
        hint.textContent = idx === 0
          ? 'Initial baseline frame: No prior snapshot to diff against.'
          : 'No property mutations detected in this frame.';
        diffInspector.appendChild(hint);
      } else {
        diffs.forEach((d) => {
          const item = document.createElement('div');
          item.className = 'diff-item-card';

          const keyEl = document.createElement('span');
          keyEl.className = 'diff-prop-key';
          keyEl.textContent = d.key;

          const transitionEl = document.createElement('div');
          transitionEl.className = 'diff-value-transition';

          if (d.type !== 'added') {
            const oldEl = document.createElement('span');
            oldEl.className = 'diff-old-val';
            oldEl.textContent = JSON.stringify(d.oldVal);
            transitionEl.appendChild(oldEl);
          }

          if (d.type === 'modified') {
            const arrow = document.createElement('span');
            arrow.className = 'diff-arrow';
            arrow.textContent = '→';
            transitionEl.appendChild(arrow);
          }

          if (d.type !== 'removed') {
            const newEl = document.createElement('span');
            newEl.className = 'diff-new-val';
            newEl.textContent = JSON.stringify(d.newVal);
            transitionEl.appendChild(newEl);
          }

          const badgeEl = document.createElement('span');
          badgeEl.className = `diff-badge ${d.type}`;
          badgeEl.textContent = d.type.toUpperCase();
          transitionEl.appendChild(badgeEl);

          item.appendChild(keyEl);
          item.appendChild(transitionEl);
          diffInspector.appendChild(item);
        });
      }

      // Render timeline frames list with breakpoint toggles
      historyFramesList.innerHTML = '';
      store.history.forEach((frame, i) => {
        const row = document.createElement('div');
        row.className = 'frame-row';
        if (i === idx) row.classList.add('active');
        if (store.hasBreakpoint(i)) row.classList.add('breakpointed');

        const leftGroup = document.createElement('div');
        leftGroup.className = 'frame-left';

        const bpBtn = document.createElement('button');
        bpBtn.type = 'button';
        bpBtn.className = `bp-toggle-btn ${store.hasBreakpoint(i) ? 'active' : ''}`;
        bpBtn.title = `Toggle Breakpoint on Frame #${i}`;
        bpBtn.textContent = store.hasBreakpoint(i) ? '●' : '○';
        bpBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          store.toggleBreakpoint(i);
          renderUI();
        });

        const labelEl = document.createElement('span');
        labelEl.className = 'frame-label';
        labelEl.textContent = `#${i}: ${frame.label}`;

        leftGroup.appendChild(bpBtn);
        leftGroup.appendChild(labelEl);

        const timeEl = document.createElement('span');
        timeEl.className = 'frame-time';
        timeEl.textContent = new Date(frame.timestamp).toLocaleTimeString();

        row.appendChild(leftGroup);
        row.appendChild(timeEl);
        row.addEventListener('click', () => {
          store.stopReplay();
          store.lastHitBreakpoint = null;
          store.stepTo(i);
          renderUI();
        });

        historyFramesList.appendChild(row);
      });

      // Render active watchpoints
      watchListEl.innerHTML = '';
      if (store.watchBreakpoints.length === 0) {
        const emptyWatch = document.createElement('span');
        emptyWatch.className = 'empty-watch-hint';
        emptyWatch.textContent = 'No property watchpoints configured.';
        watchListEl.appendChild(emptyWatch);
      } else {
        store.watchBreakpoints.forEach((bp) => {
          const chip = document.createElement('div');
          chip.className = 'watch-chip';

          const text = document.createElement('span');
          text.textContent = bp.operator === 'changed'
            ? `${bp.key} changed`
            : `${bp.key} ${bp.operator} ${JSON.stringify(bp.value)}`;

          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'watch-remove-btn';
          rmBtn.textContent = '×';
          rmBtn.title = 'Remove watchpoint';
          rmBtn.addEventListener('click', () => {
            store.removeWatchBreakpoint(bp.id);
            renderUI();
          });

          chip.appendChild(text);
          chip.appendChild(rmBtn);
          watchListEl.appendChild(chip);
        });
      }
    }

    timelineSlider.addEventListener('input', (e) => {
      store.stopReplay();
      store.lastHitBreakpoint = null;
      store.stepTo(Number(e.target.value));
      renderUI();
    });

    stepBackBtn.addEventListener('click', () => {
      store.stopReplay();
      store.lastHitBreakpoint = null;
      store.undo();
      renderUI();
    });

    stepFwdBtn.addEventListener('click', () => {
      store.stopReplay();
      store.lastHitBreakpoint = null;
      store.redo();
      renderUI();
    });

    playBtn.addEventListener('click', () => {
      if (store.isPlaying && store.playbackDirection === 'forward') {
        store.stopReplay();
        renderUI();
      } else {
        store.startReplay(750, () => renderUI(), 'forward');
        renderUI();
      }
    });

    playBackBtn.addEventListener('click', () => {
      if (store.isPlaying && store.playbackDirection === 'backward') {
        store.stopReplay();
        renderUI();
      } else {
        store.startReplay(750, () => renderUI(), 'backward');
        renderUI();
      }
    });

    exportBtn.addEventListener('click', () => {
      const json = store.exportHistory();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aerospace-orbiter-timeline-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', () => {
      importFileInput.click();
    });

    importFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          store.importHistory(reader.result);
          renderUI();
        }
      };
      reader.readAsText(file);
      importFileInput.value = '';
    });

    stateForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const current = store.getCurrentSnapshot()?.state || initialOrbiterState;
      const nextState = {
        ...current,
        altitudeKm: Number(altitudeInput.value),
        velocityKps: Number(velocityInput.value),
        fuelRemainingPct: Number(fuelInput.value),
        stage: stageSelect.value,
        rcsThrusters: rcsSelect.value
      };
      const label = commitLabelInput.value.trim() || 'Orbital Telemetry Update';
      store.commitSnapshot(nextState, label);
      renderUI();
    });

    watchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const key = watchKeySelect.value;
      const operator = watchOpSelect.value;
      const rawVal = watchValueInput.value.trim();
      let parsedVal = rawVal;
      if (operator !== 'changed' && rawVal !== '' && !Number.isNaN(Number(rawVal))) {
        parsedVal = Number(rawVal);
      }
      store.addWatchBreakpoint(key, operator, parsedVal);
      watchValueInput.value = '';
      renderUI();
    });

    // Seed initial orbital telemetry sequence
    store.commitSnapshot({
      ...initialOrbiterState,
      altitudeKm: 414.6,
      velocityKps: 7.68,
      fuelRemainingPct: 90.8,
      stage: 'PERIGEE_BURN',
      rcsThrusters: 'FIRING'
    }, 'Perigee Burn Ignition');

    store.commitSnapshot({
      ...initialOrbiterState,
      altitudeKm: 426.0,
      velocityKps: 7.72,
      fuelRemainingPct: 88.1,
      stage: 'APOGEE_COAST',
      rcsThrusters: 'STANDBY',
      dockingBeacon: 'LOCKED'
    }, 'Apogee Transfer & Beacon Lock');

    store.commitSnapshot({
      ...initialOrbiterState,
      altitudeKm: 426.0,
      velocityKps: 7.72,
      fuelRemainingPct: 87.9,
      stage: 'DOCKED_HARD_MATE',
      rcsThrusters: 'DISABLED',
      dockingBeacon: 'LOCKED'
    }, 'Station Hard Mate Complete');

    // Set an example breakpoint on Frame #2 for immediate demonstration
    store.toggleBreakpoint(2);

    renderUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOrbiterTimeTravel);
  } else {
    initOrbiterTimeTravel();
  }
}
