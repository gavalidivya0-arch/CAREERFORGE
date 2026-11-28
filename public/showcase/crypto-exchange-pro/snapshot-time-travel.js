/**
 * CryptoExchangeProTimeTravelStore
 * Immutable State Snapshot & Bidirectional Time-Travel Debugger for Crypto Exchange Pro.
 * Captures serializable trading engine state snapshots, computes object property diffs,
 * supports bidirectional scrub playback with breakpoint inspection, and JSON import/export.
 */

export class CryptoExchangeProTimeTravelStore {
  constructor(initialState = null) {
    this.name = 'CryptoExchangeProTimeTravelStore';
    this.history = [];
    this.currentIndex = -1;
    this.breakpoints = new Set();
    this.watchKeys = new Set();
    this.playbackTimer = null;
    this.playbackDirection = 'forward';
    this.isPlaying = false;
    this.listeners = [];

    if (initialState !== null && initialState !== undefined) {
      this.commitSnapshot(initialState, 'Initial Exchange State');
    }
  }

  /**
   * Deep clones any serializable value to guarantee snapshot immutability.
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
        // Fallback to JSON round-trip for plain serializable objects
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * Commits a new immutable snapshot to the timeline.
   * Truncates forward branch history if currently scrubbed behind head.
   * @param {object} state - Serializable state object
   * @param {string} [label='Snapshot'] - Human-readable transition label
   * @returns {object} Deep-cloned committed snapshot record
   */
  commitSnapshot(state, label = 'Snapshot') {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('Snapshot state must be a non-null plain object.');
    }

    const clonedState = this.#deepClone(state);

    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
      for (const bp of [...this.breakpoints]) {
        if (bp >= this.history.length) {
          this.breakpoints.delete(bp);
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

    this.notify('snapshot_committed', {
      snapshot: this.#deepClone(snapshot),
      currentIndex: this.currentIndex
    });

    return this.#deepClone(snapshot);
  }

  /**
   * Returns a deep clone of the snapshot at the active timeline cursor.
   * @returns {object|null}
   */
  getCurrentSnapshot() {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return this.#deepClone(this.history[this.currentIndex]);
  }

  /**
   * Returns a deep clone of the entire recorded snapshot timeline.
   * @returns {Array<object>}
   */
  getHistory() {
    return this.#deepClone(this.history);
  }

  /**
   * Jumps the timeline cursor directly to a specific frame index (clamped to bounds).
   * @param {number} index
   * @returns {object|null}
   */
  stepTo(index) {
    if (this.history.length === 0) return null;

    const numericIndex = Number(index);
    if (Number.isNaN(numericIndex)) {
      return this.getCurrentSnapshot();
    }

    const clampedIndex = Math.max(0, Math.min(this.history.length - 1, Math.trunc(numericIndex)));
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
   * Steps one snapshot backward in time.
   * @returns {object|null}
   */
  undo() {
    if (this.currentIndex > 0) {
      return this.stepTo(this.currentIndex - 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Steps one snapshot forward in time.
   * @returns {object|null}
   */
  redo() {
    if (this.currentIndex < this.history.length - 1) {
      return this.stepTo(this.currentIndex + 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Toggles a debugger breakpoint on a specific snapshot index.
   * @param {number} index
   * @returns {boolean} New breakpoint state for the index
   */
  toggleBreakpoint(index) {
    const idx = Math.trunc(Number(index));
    if (Number.isNaN(idx) || idx < 0 || idx >= this.history.length) {
      return false;
    }
    if (this.breakpoints.has(idx)) {
      this.breakpoints.delete(idx);
      this.notify('breakpoint_changed', { index: idx, active: false });
      return false;
    }
    this.breakpoints.add(idx);
    this.notify('breakpoint_changed', { index: idx, active: true });
    return true;
  }

  /**
   * Adds or removes a watched property key that pauses replay when modified.
   * @param {string} key
   * @returns {boolean} Whether the key is now watched
   */
  toggleWatchKey(key) {
    const normalized = String(key || '').trim();
    if (!normalized) return false;
    if (this.watchKeys.has(normalized)) {
      this.watchKeys.delete(normalized);
      return false;
    }
    this.watchKeys.add(normalized);
    return true;
  }

  /**
   * Checks whether the specified frame index triggers a frame or watched-key breakpoint.
   * @param {number} index
   * @returns {{ hit: boolean, reasons: Array<string> }}
   */
  inspectBreakpointAt(index) {
    const reasons = [];
    if (this.breakpoints.has(index)) {
      reasons.push(`Frame #${index} breakpoint`);
    }
    if (index > 0 && index < this.history.length && this.watchKeys.size > 0) {
      const prevState = this.history[index - 1].state;
      const currState = this.history[index].state;
      const diffs = this.computeDiff(prevState, currState);
      for (const diff of diffs) {
        if (this.watchKeys.has(diff.key)) {
          reasons.push(`Watch key "${diff.key}" ${diff.type}`);
        }
      }
    }
    return { hit: reasons.length > 0, reasons };
  }

  /**
   * Computes property-level diff between two serializable state objects.
   * @param {object} oldState
   * @param {object} newState
   * @returns {Array<{ key: string, type: 'added'|'removed'|'modified', oldVal: *, newVal: * }>}
   */
  computeDiff(oldState, newState) {
    const diffs = [];
    if (!oldState || !newState) return diffs;

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
   * Computes diff of the active snapshot relative to the immediately preceding frame.
   * @returns {Array<object>}
   */
  getDiffAgainstPrevious() {
    if (this.currentIndex <= 0) return [];
    const prev = this.history[this.currentIndex - 1].state;
    const curr = this.history[this.currentIndex].state;
    return this.computeDiff(prev, curr);
  }

  /**
   * Serializes the full timeline history, cursor index, and breakpoints into JSON.
   * @returns {string}
   */
  exportHistory() {
    return JSON.stringify({
      version: 1,
      module: 'crypto-exchange-pro',
      exportedAt: Date.now(),
      currentIndex: this.currentIndex,
      breakpoints: Array.from(this.breakpoints).sort((a, b) => a - b),
      watchKeys: Array.from(this.watchKeys),
      history: this.history
    }, null, 2);
  }

  /**
   * Imports and restores timeline history from an exported JSON payload.
   * @param {string} jsonStr
   * @returns {boolean}
   */
  importHistory(jsonStr) {
    try {
      if (typeof jsonStr !== 'string') return false;
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !Array.isArray(parsed.history)) return false;

      this.stopReplay();
      this.history = parsed.history.map((entry, idx) => ({
        id: entry.id || `snapshot-${idx}`,
        index: idx,
        label: String(entry.label || `Frame #${idx}`),
        timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
        state: this.#deepClone(entry.state || {})
      }));

      this.breakpoints = new Set(
        Array.isArray(parsed.breakpoints)
          ? parsed.breakpoints.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < this.history.length)
          : []
      );
      this.watchKeys = new Set(
        Array.isArray(parsed.watchKeys)
          ? parsed.watchKeys.map((k) => String(k))
          : []
      );

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
   * Advances a single replay step in the configured direction and stops on bounds or breakpoints.
   * @param {object} [options]
   * @returns {{ continued: boolean, breakpointHit: boolean, reasons: Array<string> }}
   */
  #tickReplay(options = {}) {
    const { onStep = null, onBreakpoint = null } = options;
    const isBackward = this.playbackDirection === 'backward';
    const atBoundary = isBackward
      ? this.currentIndex <= 0
      : this.currentIndex >= this.history.length - 1;

    if (atBoundary) {
      this.stopReplay('completed');
      return { continued: false, breakpointHit: false, reasons: [] };
    }

    const snap = isBackward ? this.undo() : this.redo();
    if (typeof onStep === 'function') {
      onStep(snap);
    }

    const bp = this.inspectBreakpointAt(this.currentIndex);
    if (bp.hit) {
      this.stopReplay('breakpoint');
      this.notify('breakpoint_hit', {
        index: this.currentIndex,
        reasons: bp.reasons,
        snapshot: snap
      });
      if (typeof onBreakpoint === 'function') {
        onBreakpoint({ index: this.currentIndex, reasons: bp.reasons, snapshot: snap });
      }
      return { continued: false, breakpointHit: true, reasons: bp.reasons };
    }

    return { continued: true, breakpointHit: false, reasons: [] };
  }

  /**
   * Starts automatic bidirectional time-travel playback.
   * @param {number} [intervalMs=750]
   * @param {Function|object|null} [optionsOrCallback=null]
   */
  startReplay(intervalMs = 750, optionsOrCallback = null) {
    this.stopReplay('restarted');
    if (this.history.length <= 1) return;

    const options = typeof optionsOrCallback === 'function'
      ? { onStep: optionsOrCallback }
      : (optionsOrCallback || {});

    this.playbackDirection = options.direction === 'backward' ? 'backward' : 'forward';
    this.isPlaying = true;

    if (this.playbackDirection === 'forward' && this.currentIndex >= this.history.length - 1) {
      this.stepTo(0);
    } else if (this.playbackDirection === 'backward' && this.currentIndex <= 0) {
      this.stepTo(this.history.length - 1);
    }

    this.playbackTimer = setInterval(() => {
      this.#tickReplay(options);
    }, intervalMs);

    this.notify('playback_start', { direction: this.playbackDirection });
  }

  /**
   * Stops active playback scrub.
   * @param {string} [reason='paused']
   */
  stopReplay(reason = 'paused') {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.isPlaying) {
      this.isPlaying = false;
      this.notify('playback_stop', { reason });
    }
  }

  /**
   * Subscribes a listener callback to timeline events.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
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

  /**
   * Emits an event to all registered listeners.
   * @param {string} event
   * @param {*} data
   */
  notify(event, data) {
    this.listeners.forEach((fn) => fn(event, data));
  }
}

// Browser UI Controller (guarded so Node.js unit tests can import without DOM)
if (typeof document !== 'undefined') {
  const initTimeTravelDebugger = () => {
    const root = document.querySelector('[data-crypto-time-travel]');
    if (!root) return;

    const initialExchangeState = {
      pair: 'BTC-USDT',
      bestBid: 98420.5,
      bestAsk: 98422.0,
      lastPrice: 98421.0,
      spreadBps: 0.15,
      orderBookDepth: 4280,
      positionSide: 'LONG',
      positionSizeBtc: 1.5,
      marginHealthPct: 94.2,
      circuitBreaker: 'ARMED'
    };

    const store = new CryptoExchangeProTimeTravelStore(initialExchangeState);

    const frameCounterVal = root.querySelector('#current-frame-val');
    const frameLabelVal = root.querySelector('#current-label-val');
    const playbackStatusVal = root.querySelector('#playback-status-val');
    const historyCountVal = root.querySelector('#history-count-val');
    const timelineSlider = root.querySelector('#timeline-slider');
    const tickMarks = root.querySelector('#tick-marks');
    const frameCursor = root.querySelector('#frame-cursor');
    const currentFrameTag = root.querySelector('#current-frame-indicator');
    const endFrameTag = root.querySelector('#end-frame-label');
    const playBackBtn = root.querySelector('#play-back-btn');
    const stepBackBtn = root.querySelector('#step-back-btn');
    const playFwdBtn = root.querySelector('#play-fwd-btn');
    const stepFwdBtn = root.querySelector('#step-fwd-btn');
    const toggleBpBtn = root.querySelector('#toggle-bp-btn');
    const exportBtn = root.querySelector('#export-btn');
    const importBtn = root.querySelector('#import-btn');
    const importFileInput = root.querySelector('#import-file-input');
    const stateForm = root.querySelector('#state-form');
    const pairSelect = root.querySelector('#pair-select');
    const bidInput = root.querySelector('#best-bid-input');
    const askInput = root.querySelector('#best-ask-input');
    const positionSizeInput = root.querySelector('#position-size-input');
    const marginHealthInput = root.querySelector('#margin-health-input');
    const circuitSelect = root.querySelector('#circuit-breaker-select');
    const commitLabelInput = root.querySelector('#commit-label-input');
    const watchKeyInput = root.querySelector('#watch-key-input');
    const addWatchBtn = root.querySelector('#add-watch-btn');
    const watchKeysList = root.querySelector('#watch-keys-list');
    const breakpointAlert = root.querySelector('#breakpoint-alert');
    const snapshotIdTag = root.querySelector('#snapshot-id-tag');
    const stateViewer = root.querySelector('#state-viewer');
    const diffInspector = root.querySelector('#diff-inspector');
    const diffCountBadge = root.querySelector('#diff-count-badge');
    const historyList = root.querySelector('#history-frames-list');
    const timelineCountBadge = root.querySelector('#timeline-count-badge');

    let lastBreakpointMessage = '';

    const formatJson = (val) => (val === undefined ? 'undefined' : JSON.stringify(val));

    const updatePlaybackButtons = () => {
      if (!store.isPlaying) {
        playFwdBtn.textContent = '▶ Play Forward';
        playBackBtn.textContent = '◀ Play Reverse';
        playbackStatusVal.textContent = lastBreakpointMessage ? 'Breakpoint Paused' : 'Paused';
      } else if (store.playbackDirection === 'backward') {
        playBackBtn.textContent = '⏸ Pause Reverse';
        playFwdBtn.textContent = '▶ Play Forward';
        playbackStatusVal.textContent = 'Replaying ◀';
      } else {
        playFwdBtn.textContent = '⏸ Pause Forward';
        playBackBtn.textContent = '◀ Play Reverse';
        playbackStatusVal.textContent = 'Replaying ▶';
      }
    };

    const renderWatchKeys = () => {
      watchKeysList.innerHTML = '';
      if (store.watchKeys.size === 0) {
        watchKeysList.innerHTML = '<span class="watch-empty">No watched properties</span>';
        return;
      }
      store.watchKeys.forEach((key) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'watch-chip';
        chip.textContent = `${key} ×`;
        chip.title = `Remove watch on "${key}"`;
        chip.addEventListener('click', () => {
          store.toggleWatchKey(key);
          renderUI();
        });
        watchKeysList.appendChild(chip);
      });
    };

    const renderUI = () => {
      const snap = store.getCurrentSnapshot();
      const count = store.history.length;
      const idx = store.currentIndex;

      frameCounterVal.textContent = count > 0 ? `${idx} / ${count - 1}` : '0 / 0';
      frameLabelVal.textContent = snap ? snap.label : 'None';
      historyCountVal.textContent = `${count} Snapshots`;
      timelineCountBadge.textContent = `${count} Frames`;
      snapshotIdTag.textContent = snap ? snap.id : 'N/A';

      timelineSlider.max = Math.max(0, count - 1);
      timelineSlider.value = Math.max(0, idx);
      currentFrameTag.textContent = `Frame #${Math.max(0, idx)}`;
      endFrameTag.textContent = `Frame #${Math.max(0, count - 1)}`;

      const progressPct = count > 1 ? (idx / (count - 1)) * 100 : 0;
      frameCursor.style.left = `${progressPct}%`;

      toggleBpBtn.textContent = store.breakpoints.has(idx)
        ? '● Remove Breakpoint'
        : '○ Set Breakpoint';
      toggleBpBtn.classList.toggle('is-active', store.breakpoints.has(idx));

      if (lastBreakpointMessage) {
        breakpointAlert.textContent = lastBreakpointMessage;
        breakpointAlert.hidden = false;
      } else {
        breakpointAlert.hidden = true;
      }

      tickMarks.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'tick';
        if (i === idx) tick.classList.add('active');
        if (store.breakpoints.has(i)) tick.classList.add('has-breakpoint');
        tick.title = `Jump to Frame #${i}: ${store.history[i].label}`;
        tick.addEventListener('click', () => {
          lastBreakpointMessage = '';
          store.stopReplay();
          store.stepTo(i);
          renderUI();
        });
        tickMarks.appendChild(tick);
      }

      stateViewer.textContent = snap ? JSON.stringify(snap.state, null, 2) : '{}';

      const diffs = store.getDiffAgainstPrevious();
      diffCountBadge.textContent = idx <= 0 ? 'Baseline' : `${diffs.length} Change${diffs.length === 1 ? '' : 's'}`;

      if (idx <= 0 || diffs.length === 0) {
        diffInspector.innerHTML = `<p class="empty-diff-hint">${
          idx === 0
            ? 'Baseline frame: no prior snapshot to compare against.'
            : 'No property changes detected in this frame.'
        }</p>`;
      } else {
        diffInspector.innerHTML = '';
        diffs.forEach((d) => {
          const card = document.createElement('div');
          card.className = `diff-item-card diff-${d.type}`;
          const badgeLabel = d.type === 'added' ? '+ ADDED' : d.type === 'removed' ? '- REMOVED' : '~ MODIFIED';
          card.innerHTML = `
            <div class="diff-card-top">
              <span class="diff-prop-key"></span>
              <span class="diff-badge ${d.type}">${badgeLabel}</span>
            </div>
            <div class="diff-value-transition">
              <span class="diff-old-val"></span>
              <span class="diff-arrow">→</span>
              <span class="diff-new-val"></span>
            </div>
          `;
          card.querySelector('.diff-prop-key').textContent = d.key;
          card.querySelector('.diff-old-val').textContent = formatJson(d.oldVal);
          card.querySelector('.diff-new-val').textContent = formatJson(d.newVal);
          diffInspector.appendChild(card);
        });
      }

      historyList.innerHTML = '';
      store.history.forEach((frame, i) => {
        const row = document.createElement('div');
        row.className = `frame-row${i === idx ? ' active' : ''}${store.breakpoints.has(i) ? ' has-breakpoint' : ''}`;
        row.innerHTML = `
          <div class="frame-main">
            <span class="bp-dot" title="Toggle Breakpoint">${store.breakpoints.has(i) ? '●' : '○'}</span>
            <span class="frame-label"></span>
          </div>
          <span class="frame-time">${new Date(frame.timestamp).toLocaleTimeString()}</span>
        `;
        row.querySelector('.frame-label').textContent = `#${i}: ${frame.label}`;
        row.querySelector('.bp-dot').addEventListener('click', (e) => {
          e.stopPropagation();
          store.toggleBreakpoint(i);
          renderUI();
        });
        row.addEventListener('click', () => {
          lastBreakpointMessage = '';
          store.stopReplay();
          store.stepTo(i);
          renderUI();
        });
        historyList.appendChild(row);
      });

      renderWatchKeys();
      updatePlaybackButtons();
    };

    store.subscribe((event, payload) => {
      if (event === 'breakpoint_hit') {
        lastBreakpointMessage = `Paused at Breakpoint (Frame #${payload.index}): ${payload.reasons.join(' • ')}`;
      }
      if (event === 'playback_stop') {
        updatePlaybackButtons();
      }
    });

    timelineSlider.addEventListener('input', (e) => {
      lastBreakpointMessage = '';
      store.stopReplay();
      store.stepTo(Number(e.target.value));
      renderUI();
    });

    stepBackBtn.addEventListener('click', () => {
      lastBreakpointMessage = '';
      store.stopReplay();
      store.undo();
      renderUI();
    });

    stepFwdBtn.addEventListener('click', () => {
      lastBreakpointMessage = '';
      store.stopReplay();
      store.redo();
      renderUI();
    });

    playFwdBtn.addEventListener('click', () => {
      if (store.isPlaying && store.playbackDirection === 'forward') {
        store.stopReplay();
      } else {
        lastBreakpointMessage = '';
        store.startReplay(750, {
          direction: 'forward',
          onStep: () => renderUI(),
          onBreakpoint: () => renderUI()
        });
      }
      renderUI();
    });

    playBackBtn.addEventListener('click', () => {
      if (store.isPlaying && store.playbackDirection === 'backward') {
        store.stopReplay();
      } else {
        lastBreakpointMessage = '';
        store.startReplay(750, {
          direction: 'backward',
          onStep: () => renderUI(),
          onBreakpoint: () => renderUI()
        });
      }
      renderUI();
    });

    toggleBpBtn.addEventListener('click', () => {
      store.toggleBreakpoint(store.currentIndex);
      renderUI();
    });

    addWatchBtn.addEventListener('click', () => {
      const key = watchKeyInput.value.trim();
      if (!key) return;
      store.toggleWatchKey(key);
      watchKeyInput.value = '';
      renderUI();
    });

    exportBtn.addEventListener('click', () => {
      const json = store.exportHistory();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `crypto-exchange-pro-timeline-${Date.now()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', () => {
      importFileInput.click();
    });

    importFileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      if (store.importHistory(text)) {
        lastBreakpointMessage = '';
        renderUI();
      }
      importFileInput.value = '';
    });

    stateForm.addEventListener('submit', (e) => {
      e.preventDefault();
      lastBreakpointMessage = '';
      store.stopReplay();

      const bid = Number(bidInput.value);
      const ask = Number(askInput.value);
      const mid = Number(((bid + ask) / 2).toFixed(2));
      const spreadBps = bid > 0 ? Number((((ask - bid) / bid) * 10000).toFixed(2)) : 0;

      const nextState = {
        pair: pairSelect.value,
        bestBid: bid,
        bestAsk: ask,
        lastPrice: mid,
        spreadBps,
        orderBookDepth: 4280 + store.history.length * 35,
        positionSide: Number(positionSizeInput.value) >= 0 ? 'LONG' : 'SHORT',
        positionSizeBtc: Math.abs(Number(positionSizeInput.value)),
        marginHealthPct: Number(marginHealthInput.value),
        circuitBreaker: circuitSelect.value
      };

      const label = commitLabelInput.value.trim() || 'Order Book Tick';
      store.commitSnapshot(nextState, label);
      renderUI();
    });

    // Seed realistic Crypto Exchange Pro state transitions
    store.commitSnapshot({
      ...initialExchangeState,
      bestBid: 98465.0,
      bestAsk: 98466.5,
      lastPrice: 98466.0,
      orderBookDepth: 4410,
      positionSizeBtc: 2.25,
      marginHealthPct: 91.5
    }, 'Limit Buy Filled (+0.75 BTC)');

    store.commitSnapshot({
      ...initialExchangeState,
      bestBid: 98310.0,
      bestAsk: 98345.0,
      lastPrice: 98320.0,
      spreadBps: 3.56,
      orderBookDepth: 3920,
      positionSizeBtc: 2.25,
      marginHealthPct: 78.4,
      liquidationAlert: 'ELEVATED_VOLATILITY'
    }, 'Volatility Spike & Spread Widening');

    store.commitSnapshot({
      ...initialExchangeState,
      bestBid: 98180.0,
      bestAsk: 98195.0,
      lastPrice: 98185.0,
      spreadBps: 1.53,
      orderBookDepth: 4650,
      positionSizeBtc: 1.0,
      marginHealthPct: 89.0,
      circuitBreaker: 'TRIGGERED'
    }, 'Circuit Breaker Triggered & De-risked');

    store.toggleBreakpoint(2);
    store.toggleWatchKey('circuitBreaker');

    renderUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTimeTravelDebugger);
  } else {
    initTimeTravelDebugger();
  }
}
