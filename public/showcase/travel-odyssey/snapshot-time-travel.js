/**
 * Travel Odyssey - Immutable State Snapshot & Bidirectional Time-Travel Debugger
 * Captures serializable expedition state snapshots, computes structural property diffs,
 * supports bidirectional scrub playback with breakpoint inspection, and JSON export/import.
 */

export class TravelOdysseyTimeTravelStore {
  /**
   * @param {object|null} [initialState=null]
   */
  constructor(initialState = null) {
    this.name = 'TravelOdysseyTimeTravelStore';
    this.history = [];
    this.currentIndex = -1;
    this.breakpoints = new Set();
    this.playbackTimer = null;
    this.isPlaying = false;
    this.playbackDirection = 'forward';
    this.listeners = [];

    if (initialState !== null && initialState !== undefined) {
      this.commitSnapshot(initialState, 'Expedition Initialized');
    }
  }

  /**
   * Deep clones any JSON-serializable JavaScript value to isolate snapshots from external mutations.
   * @param {*} value
   * @returns {*}
   */
  #deepClone(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch {
        // Fallback to JSON roundtrip for plain serializable data
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * Recursively freezes a snapshot state object to enforce internal immutability.
   * @param {*} value
   * @returns {*}
   */
  #deepFreeze(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      this.#deepFreeze(value[key]);
    }
    return value;
  }

  /**
   * Commits a new immutable snapshot to the timeline.
   * If currently scrubbed in the past, forward branch history is truncated.
   * @param {object} state
   * @param {string} [label='Snapshot']
   * @returns {object}
   */
  commitSnapshot(state, label = 'Snapshot') {
    if (state === undefined) {
      throw new Error('Snapshot state cannot be undefined.');
    }

    const clonedState = this.#deepClone(state);
    this.#deepFreeze(clonedState);

    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
      for (const bp of Array.from(this.breakpoints)) {
        if (bp >= this.history.length) {
          this.breakpoints.delete(bp);
        }
      }
    }

    const index = this.history.length;
    const snapshot = {
      id: `odyssey-snap-${index}`,
      index,
      label: String(label || `Snapshot #${index}`),
      timestamp: Date.now(),
      state: clonedState
    };

    Object.freeze(snapshot);
    this.history.push(snapshot);
    this.currentIndex = this.history.length - 1;

    const publicSnapshot = this.#deepClone(snapshot);
    this.notify('snapshot_committed', {
      snapshot: publicSnapshot,
      currentIndex: this.currentIndex
    });

    return publicSnapshot;
  }

  /**
   * Returns an isolated deep clone of the snapshot at the active cursor.
   * @returns {object|null}
   */
  getCurrentSnapshot() {
    return this.getSnapshotAt(this.currentIndex);
  }

  /**
   * Returns an isolated deep clone of the snapshot at a specific index.
   * @param {number} index
   * @returns {object|null}
   */
  getSnapshotAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return null;
    }
    return this.#deepClone(this.history[index]);
  }

  /**
   * Returns an isolated deep clone of the entire snapshot history.
   * @returns {Array<object>}
   */
  getHistory() {
    return this.#deepClone(this.history);
  }

  /**
   * Jumps the active timeline cursor directly to the given frame index (clamped to valid bounds).
   * @param {number} index
   * @returns {object|null}
   */
  stepTo(index) {
    if (this.history.length === 0) {
      this.currentIndex = -1;
      return null;
    }

    const numericIndex = Number(index);
    const safeIndex = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : 0;
    const clampedIndex = Math.max(0, Math.min(this.history.length - 1, safeIndex));
    this.currentIndex = clampedIndex;

    const snapshot = this.getCurrentSnapshot();
    const diff = this.getDiffAgainstPrevious();

    this.notify('stepped', {
      snapshot,
      currentIndex: this.currentIndex,
      diff,
      hasBreakpoint: this.hasBreakpoint(this.currentIndex)
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
   * Toggles a debugger breakpoint on the specified snapshot frame index.
   * @param {number} [index=this.currentIndex]
   * @returns {boolean} True if breakpoint is now enabled, false if removed or invalid index.
   */
  toggleBreakpoint(index = this.currentIndex) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return false;
    }

    let enabled;
    if (this.breakpoints.has(index)) {
      this.breakpoints.delete(index);
      enabled = false;
    } else {
      this.breakpoints.add(index);
      enabled = true;
    }

    this.notify('breakpoint_toggled', {
      index,
      enabled,
      breakpoints: this.getBreakpoints()
    });
    return enabled;
  }

  /**
   * Checks whether a breakpoint is active on a given frame index.
   * @param {number} index
   * @returns {boolean}
   */
  hasBreakpoint(index) {
    return this.breakpoints.has(index);
  }

  /**
   * Returns sorted breakpoint indices.
   * @returns {Array<number>}
   */
  getBreakpoints() {
    return Array.from(this.breakpoints).sort((a, b) => a - b);
  }

  /**
   * Computes property-level diffs between two serializable state objects.
   * @param {object} oldState
   * @param {object} newState
   * @returns {Array<{ key: string, type: 'added'|'removed'|'modified', oldVal: *, newVal: * }>}
   */
  computeDiff(oldState, newState) {
    const diffs = [];
    if (!oldState || typeof oldState !== 'object' || !newState || typeof newState !== 'object') {
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
      } else {
        const oldSerialized = JSON.stringify(oldState[key]);
        const newSerialized = JSON.stringify(newState[key]);
        if (oldSerialized !== newSerialized) {
          diffs.push({
            key,
            type: 'modified',
            oldVal: this.#deepClone(oldState[key]),
            newVal: this.#deepClone(newState[key])
          });
        }
      }
    }

    return diffs;
  }

  /**
   * Returns property diffs between the current frame and its immediately preceding frame.
   * @returns {Array<{ key: string, type: string, oldVal: *, newVal: * }>}
   */
  getDiffAgainstPrevious() {
    if (this.currentIndex <= 0 || this.currentIndex >= this.history.length) {
      return [];
    }
    const prevState = this.history[this.currentIndex - 1].state;
    const currState = this.history[this.currentIndex].state;
    return this.computeDiff(prevState, currState);
  }

  /**
   * Exports the complete timeline, cursor position, and breakpoints as a JSON string.
   * @returns {string}
   */
  exportHistory() {
    return JSON.stringify({
      version: 1,
      store: this.name,
      exportedAt: Date.now(),
      currentIndex: this.currentIndex,
      breakpoints: this.getBreakpoints(),
      history: this.history
    }, null, 2);
  }

  /**
   * Imports and validates an exported JSON timeline string, restoring history, cursor, and breakpoints.
   * @param {string} jsonStr
   * @returns {boolean}
   */
  importHistory(jsonStr) {
    try {
      if (typeof jsonStr !== 'string') return false;
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !Array.isArray(parsed.history)) return false;

      this.stopReplay('import');

      const restoredHistory = parsed.history.map((snap, idx) => {
        if (!snap || typeof snap !== 'object') {
          throw new Error('Invalid snapshot entry.');
        }
        const stateClone = this.#deepClone(snap.state !== undefined ? snap.state : {});
        this.#deepFreeze(stateClone);

        const normalized = {
          id: typeof snap.id === 'string' && snap.id ? snap.id : `odyssey-snap-${idx}`,
          index: idx,
          label: typeof snap.label === 'string' && snap.label ? snap.label : `Frame #${idx}`,
          timestamp: typeof snap.timestamp === 'number' ? snap.timestamp : Date.now(),
          state: stateClone
        };
        return Object.freeze(normalized);
      });

      this.history = restoredHistory;
      this.breakpoints = new Set();

      if (Array.isArray(parsed.breakpoints)) {
        for (const bp of parsed.breakpoints) {
          if (Number.isInteger(bp) && bp >= 0 && bp < this.history.length) {
            this.breakpoints.add(bp);
          }
        }
      }

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
        currentIndex: this.currentIndex,
        breakpoints: this.getBreakpoints()
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts automatic bidirectional scrub playback, pausing automatically on breakpoint frames.
   * @param {number} [intervalMs=750]
   * @param {Function|null} [onStep=null]
   * @param {'forward'|'backward'} [direction='forward']
   */
  startReplay(intervalMs = 750, onStep = null, direction = 'forward') {
    this.stopReplay('restart');
    if (this.history.length <= 1) {
      return;
    }

    const dir = direction === 'backward' ? 'backward' : 'forward';
    this.playbackDirection = dir;
    this.isPlaying = true;

    if (dir === 'forward' && this.currentIndex >= this.history.length - 1) {
      this.stepTo(0);
    } else if (dir === 'backward' && this.currentIndex <= 0) {
      this.stepTo(this.history.length - 1);
    }

    this.playbackTimer = setInterval(() => {
      const canAdvance = dir === 'forward'
        ? this.currentIndex < this.history.length - 1
        : this.currentIndex > 0;

      if (!canAdvance) {
        this.stopReplay('completed');
        if (typeof onStep === 'function') {
          onStep(this.getCurrentSnapshot(), { hitBreakpoint: false, reason: 'completed' });
        }
        return;
      }

      const snap = dir === 'forward' ? this.redo() : this.undo();
      const hitBreakpoint = this.hasBreakpoint(this.currentIndex);

      if (hitBreakpoint) {
        this.stopReplay('breakpoint');
        this.notify('breakpoint_hit', {
          snapshot: snap,
          currentIndex: this.currentIndex
        });
      }

      if (typeof onStep === 'function') {
        onStep(snap, {
          hitBreakpoint,
          reason: hitBreakpoint ? 'breakpoint' : 'step'
        });
      }
    }, Math.max(50, Number(intervalMs) || 750));

    this.notify('playback_start', { direction: this.playbackDirection });
  }

  /**
   * Stops active scrub playback.
   * @param {string} [reason='manual']
   */
  stopReplay(reason = 'manual') {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    const wasPlaying = this.isPlaying;
    this.isPlaying = false;
    if (wasPlaying) {
      this.notify('playback_stop', { reason });
    }
  }

  /**
   * Subscribes a listener to store events.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    if (typeof callback !== 'function') {
      return () => {};
    }
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== callback);
    };
  }

  /**
   * Dispatches an event to all subscribers.
   * @param {string} event
   * @param {object} data
   */
  notify(event, data) {
    for (const fn of this.listeners) {
      fn(event, data);
    }
  }
}

// Browser UI Controller
if (typeof document !== 'undefined') {
  const initOdysseyTimeTravelUI = () => {
    const root = document.querySelector('[data-odyssey-time-travel]');
    if (!root) return;

    const initialExpeditionState = {
      expeditionId: 'ODYSSEY-ARC-2026',
      destination: 'Iceland — Vatnajökull Ice Cap',
      phase: 'PREPARATION',
      packedItems: 6,
      totalItems: 16,
      readinessPercent: 38,
      budgetRemainingUSD: 4800,
      satelliteLinkOnline: true
    };

    const store = new TravelOdysseyTimeTravelStore(initialExpeditionState);

    const frameBadge = root.querySelector('#current-frame-val');
    const labelBadge = root.querySelector('#current-label-val');
    const statusBadge = root.querySelector('#playback-status-val');
    const countBadge = root.querySelector('#history-count-val');
    const breakpointStatusBadge = root.querySelector('#breakpoint-status-val');

    const slider = root.querySelector('#timeline-slider');
    const tickMarks = root.querySelector('#tick-marks');
    const startLabel = root.querySelector('#start-frame-label');
    const activeFrameLabel = root.querySelector('#current-frame-indicator');
    const endLabel = root.querySelector('#end-frame-label');

    const firstBtn = root.querySelector('#step-first-btn');
    const stepBackBtn = root.querySelector('#step-back-btn');
    const playRevBtn = root.querySelector('#play-reverse-btn');
    const playFwdBtn = root.querySelector('#play-forward-btn');
    const stepFwdBtn = root.querySelector('#step-fwd-btn');
    const lastBtn = root.querySelector('#step-last-btn');
    const toggleBpBtn = root.querySelector('#toggle-breakpoint-btn');
    const exportBtn = root.querySelector('#export-btn');
    const importBtn = root.querySelector('#import-btn');
    const importInput = root.querySelector('#import-file-input');

    const stateForm = root.querySelector('#state-form');
    const destInput = root.querySelector('#exp-destination');
    const phaseSelect = root.querySelector('#exp-phase');
    const packedInput = root.querySelector('#exp-packed-items');
    const budgetInput = root.querySelector('#exp-budget');
    const satSelect = root.querySelector('#exp-satellite');
    const commitLabelInput = root.querySelector('#commit-label');

    const snapshotIdTag = root.querySelector('#snapshot-id-tag');
    const stateViewer = root.querySelector('#state-viewer');
    const diffInspector = root.querySelector('#diff-inspector');
    const diffStatusBadge = root.querySelector('#diff-status-badge');
    const historyList = root.querySelector('#history-frames-list');
    const timelineCountBadge = root.querySelector('#timeline-count-badge');

    const syncPlaybackButtons = (overrideStatus = null) => {
      if (store.isPlaying) {
        if (store.playbackDirection === 'backward') {
          playRevBtn.textContent = '⏸ Pause';
          playFwdBtn.textContent = '▶ Play Forward';
          statusBadge.textContent = 'Reversing...';
        } else {
          playFwdBtn.textContent = '⏸ Pause';
          playRevBtn.textContent = '◀ Play Reverse';
          statusBadge.textContent = 'Playing...';
        }
      } else {
        playFwdBtn.textContent = '▶ Play Forward';
        playRevBtn.textContent = '◀ Play Reverse';
        statusBadge.textContent = overrideStatus || 'Paused';
      }
    };

    const populateFormFromSnapshot = (snap) => {
      if (!snap || !snap.state) return;
      if (typeof snap.state.destination === 'string') destInput.value = snap.state.destination;
      if (typeof snap.state.phase === 'string') phaseSelect.value = snap.state.phase;
      if (typeof snap.state.packedItems === 'number') packedInput.value = String(snap.state.packedItems);
      if (typeof snap.state.budgetRemainingUSD === 'number') budgetInput.value = String(snap.state.budgetRemainingUSD);
      satSelect.value = String(Boolean(snap.state.satelliteLinkOnline));
    };

    const renderDiffPanel = (idx) => {
      const diffs = store.getDiffAgainstPrevious();
      diffInspector.replaceChildren();

      if (idx <= 0) {
        diffStatusBadge.textContent = 'Initial Frame';
        const hint = document.createElement('p');
        hint.className = 'empty-diff-hint';
        hint.textContent = 'Expedition genesis frame: no earlier snapshot to compare against.';
        diffInspector.appendChild(hint);
        return;
      }

      if (diffs.length === 0) {
        diffStatusBadge.textContent = '0 Changes';
        const hint = document.createElement('p');
        hint.className = 'empty-diff-hint';
        hint.textContent = 'No property mutations detected relative to the previous snapshot.';
        diffInspector.appendChild(hint);
        return;
      }

      diffStatusBadge.textContent = `${diffs.length} Change${diffs.length === 1 ? '' : 's'}`;

      for (const entry of diffs) {
        const card = document.createElement('div');
        card.className = `diff-item-card diff-card-${entry.type}`;

        const header = document.createElement('div');
        header.className = 'diff-item-header';

        const keyEl = document.createElement('span');
        keyEl.className = 'diff-prop-key';
        keyEl.textContent = entry.key;

        const badge = document.createElement('span');
        badge.className = `diff-badge ${entry.type}`;
        badge.textContent = entry.type.toUpperCase();

        header.append(keyEl, badge);

        const transition = document.createElement('div');
        transition.className = 'diff-value-transition';

        if (entry.type === 'added') {
          const newEl = document.createElement('span');
          newEl.className = 'diff-new-val';
          newEl.textContent = `+ ${JSON.stringify(entry.newVal)}`;
          transition.appendChild(newEl);
        } else if (entry.type === 'removed') {
          const oldEl = document.createElement('span');
          oldEl.className = 'diff-old-val';
          oldEl.textContent = `- ${JSON.stringify(entry.oldVal)}`;
          transition.appendChild(oldEl);
        } else {
          const oldEl = document.createElement('span');
          oldEl.className = 'diff-old-val';
          oldEl.textContent = JSON.stringify(entry.oldVal);

          const arrow = document.createElement('span');
          arrow.className = 'diff-arrow';
          arrow.textContent = '→';

          const newEl = document.createElement('span');
          newEl.className = 'diff-new-val';
          newEl.textContent = JSON.stringify(entry.newVal);

          transition.append(oldEl, arrow, newEl);
        }

        card.append(header, transition);
        diffInspector.appendChild(card);
      }
    };

    const renderUI = (statusOverride = null) => {
      const snap = store.getCurrentSnapshot();
      const count = store.history.length;
      const idx = store.currentIndex;
      const isBreakpoint = store.hasBreakpoint(idx);

      frameBadge.textContent = count > 0 ? `${idx} / ${count - 1}` : '0 / 0';
      labelBadge.textContent = snap ? snap.label : 'None';
      countBadge.textContent = `${count} Snapshots`;
      timelineCountBadge.textContent = `${count} Frames`;
      snapshotIdTag.textContent = snap ? snap.id : 'N/A';

      breakpointStatusBadge.textContent = `${store.getBreakpoints().length} Active`;
      toggleBpBtn.classList.toggle('is-active', isBreakpoint);
      toggleBpBtn.textContent = isBreakpoint ? '● Breakpoint Set' : '○ Set Breakpoint';

      slider.max = String(Math.max(0, count - 1));
      slider.value = String(Math.max(0, idx));
      startLabel.textContent = 'Frame #0';
      activeFrameLabel.textContent = `Frame #${Math.max(0, idx)}`;
      endLabel.textContent = `Frame #${Math.max(0, count - 1)}`;

      // Render scrubber tick marks
      tickMarks.replaceChildren();
      for (let i = 0; i < count; i++) {
        const tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'tick';
        if (i === idx) tick.classList.add('active');
        if (store.hasBreakpoint(i)) tick.classList.add('has-breakpoint');
        tick.title = `Jump to Frame #${i}: ${store.history[i].label}`;
        tick.setAttribute('aria-label', `Jump to frame ${i}`);
        tick.addEventListener('click', () => {
          store.stopReplay('scrub');
          store.stepTo(i);
          renderUI();
        });
        tickMarks.appendChild(tick);
      }

      stateViewer.textContent = snap ? JSON.stringify(snap.state, null, 2) : '{}';
      renderDiffPanel(idx);

      // Render timeline log
      historyList.replaceChildren();
      store.history.forEach((frame, i) => {
        const row = document.createElement('div');
        row.className = 'frame-row';
        if (i === idx) row.classList.add('active');
        if (store.hasBreakpoint(i)) row.classList.add('has-breakpoint');

        const left = document.createElement('div');
        left.className = 'frame-row-left';

        const bpDot = document.createElement('button');
        bpDot.type = 'button';
        bpDot.className = `bp-dot ${store.hasBreakpoint(i) ? 'armed' : ''}`;
        bpDot.title = store.hasBreakpoint(i) ? 'Remove breakpoint' : 'Add breakpoint';
        bpDot.setAttribute('aria-label', `Toggle breakpoint on frame ${i}`);
        bpDot.textContent = store.hasBreakpoint(i) ? '●' : '○';
        bpDot.addEventListener('click', (e) => {
          e.stopPropagation();
          store.toggleBreakpoint(i);
          renderUI();
        });

        const labelEl = document.createElement('span');
        labelEl.className = 'frame-label';
        labelEl.textContent = `#${i}: ${frame.label}`;

        left.append(bpDot, labelEl);

        const timeEl = document.createElement('span');
        timeEl.className = 'frame-time';
        timeEl.textContent = new Date(frame.timestamp).toLocaleTimeString();

        row.append(left, timeEl);
        row.addEventListener('click', () => {
          store.stopReplay('select');
          store.stepTo(i);
          populateFormFromSnapshot(store.getCurrentSnapshot());
          renderUI();
        });
        historyList.appendChild(row);
      });

      syncPlaybackButtons(statusOverride);
    };

    // Controls
    slider.addEventListener('input', (e) => {
      store.stopReplay('scrub');
      store.stepTo(Number(e.target.value));
      renderUI();
    });

    firstBtn.addEventListener('click', () => {
      store.stopReplay('step');
      store.stepTo(0);
      renderUI();
    });

    stepBackBtn.addEventListener('click', () => {
      store.stopReplay('step');
      store.undo();
      renderUI();
    });

    stepFwdBtn.addEventListener('click', () => {
      store.stopReplay('step');
      store.redo();
      renderUI();
    });

    lastBtn.addEventListener('click', () => {
      store.stopReplay('step');
      store.stepTo(store.history.length - 1);
      renderUI();
    });

    playFwdBtn.addEventListener('click', () => {
      if (store.isPlaying && store.playbackDirection === 'forward') {
        store.stopReplay('manual');
        renderUI();
      } else {
        store.startReplay(750, (_snap, meta) => {
          renderUI(meta && meta.hitBreakpoint ? 'Paused at Breakpoint' : null);
        }, 'forward');
        renderUI();
      }
    });

    playRevBtn.addEventListener('click', () => {
      if (store.isPlaying && store.playbackDirection === 'backward') {
        store.stopReplay('manual');
        renderUI();
      } else {
        store.startReplay(750, (_snap, meta) => {
          renderUI(meta && meta.hitBreakpoint ? 'Paused at Breakpoint' : null);
        }, 'backward');
        renderUI();
      }
    });

    toggleBpBtn.addEventListener('click', () => {
      store.toggleBreakpoint(store.currentIndex);
      renderUI();
    });

    exportBtn.addEventListener('click', () => {
      const json = store.exportHistory();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `travel-odyssey-timeline-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', () => {
      importInput.click();
    });

    importInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const ok = store.importHistory(String(reader.result || ''));
        renderUI(ok ? 'Imported Timeline' : 'Invalid JSON');
      };
      reader.readAsText(file);
      importInput.value = '';
    });

    stateForm.addEventListener('submit', (e) => {
      e.preventDefault();
      store.stopReplay('commit');
      const packed = Math.max(0, Math.min(16, Number(packedInput.value) || 0));
      const newState = {
        expeditionId: 'ODYSSEY-ARC-2026',
        destination: destInput.value.trim() || 'Iceland — Vatnajökull Ice Cap',
        phase: phaseSelect.value,
        packedItems: packed,
        totalItems: 16,
        readinessPercent: Math.round((packed / 16) * 100),
        budgetRemainingUSD: Math.max(0, Number(budgetInput.value) || 0),
        satelliteLinkOnline: satSelect.value === 'true'
      };
      const label = commitLabelInput.value.trim() || 'Expedition Checkpoint';
      store.commitSnapshot(newState, label);
      renderUI();
    });

    // Seed sample expedition timeline
    store.commitSnapshot({
      ...initialExpeditionState,
      phase: 'GEAR_LOCKED',
      packedItems: 12,
      readinessPercent: 75,
      budgetRemainingUSD: 4150,
      weatherAlert: 'Sub-Zero Katabatic Wind'
    }, 'Glacier Gear Inspection Passed');

    store.commitSnapshot({
      ...initialExpeditionState,
      destination: 'Patagonia — Torres del Paine Circuit',
      phase: 'TRANSIT',
      packedItems: 16,
      readinessPercent: 100,
      budgetRemainingUSD: 3420,
      weatherAlert: 'Clear Alpine Window',
      activeWaypoint: 'Basecamp Grey'
    }, 'Patagonia Transfer & Waypoint Lock');

    store.commitSnapshot({
      ...initialExpeditionState,
      destination: 'Kyoto — Kumano Kodo Ridge',
      phase: 'ACTIVE_EXPEDITION',
      packedItems: 16,
      readinessPercent: 100,
      budgetRemainingUSD: 2890,
      satelliteLinkOnline: false,
      activeWaypoint: 'Nachi Falls Sanctuary'
    }, 'High-Ridge Satellite Blackout');

    // Set a breakpoint on frame 2 for immediate breakpoint inspection demo
    store.toggleBreakpoint(2);
    populateFormFromSnapshot(store.getCurrentSnapshot());
    renderUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOdysseyTimeTravelUI);
  } else {
    initOdysseyTimeTravelUI();
  }
}
