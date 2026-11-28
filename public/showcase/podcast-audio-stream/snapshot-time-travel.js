/**
 * PodcastAudioStreamTimeTravelStore
 * Isolated immutable state snapshot & bidirectional time-travel debugger engine
 * for Podcast Audio Stream.
 *
 * Captures serializable state snapshots, computes recursive property diffs,
 * supports bidirectional scrub playback with breakpoint inspection, and
 * provides lossless JSON history export/import.
 */

const VALID_DIRECTIONS = new Set(['forward', 'backward']);

/**
 * Checks whether a value is a plain non-null, non-array object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively freezes an object graph in place.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    deepFreeze(value[keys[i]]);
  }
  return value;
}

/**
 * Produces a deep, JSON-serializable clone of a state value.
 * Throws if the value is undefined, a function, symbol, or contains circular references.
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneSerializable(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('Snapshot state must be JSON-serializable (cannot be undefined, function, or symbol).');
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Snapshot state could not be serialized to JSON.');
  }
  return JSON.parse(serialized);
}

/**
 * Compares two JSON-serializable values for deep structural equality.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    const key = keysA[i];
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export class PodcastAudioStreamTimeTravelStore {
  /**
   * @param {object|null} [initialState=null]
   * @param {object} [options={}]
   * @param {number} [options.maxSnapshots=200]
   * @param {number} [options.playbackIntervalMs=850]
   * @param {string} [options.initialLabel='Initial Stream State']
   */
  constructor(initialState = null, options = {}) {
    this.history = [];
    this.currentIndex = -1;
    this.breakpoints = new Set();
    this.isPlaying = false;
    this.direction = 'forward';
    this.maxSnapshots = Number.isInteger(options.maxSnapshots) && options.maxSnapshots > 0
      ? options.maxSnapshots
      : 200;
    this.playbackIntervalMs = typeof options.playbackIntervalMs === 'number' && options.playbackIntervalMs >= 50
      ? options.playbackIntervalMs
      : 850;
    this._playbackTimer = null;
    this._listeners = new Set();
    this._sequenceCounter = 0;

    if (initialState !== null && initialState !== undefined) {
      this.commitSnapshot(initialState, options.initialLabel || 'Initial Stream State');
    }
  }

  /**
   * Subscribes to store state changes.
   * @param {(event: string, payload: object) => void} listener
   * @returns {() => void} Unsubscribe callback
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function.');
    }
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * @param {string} event
   * @param {object} [payload={}]
   */
  _notify(event, payload = {}) {
    for (const listener of this._listeners) {
      listener(event, {
        currentIndex: this.currentIndex,
        totalSnapshots: this.history.length,
        isPlaying: this.isPlaying,
        direction: this.direction,
        ...payload
      });
    }
  }

  /**
   * Commits a new immutable snapshot onto the timeline.
   * If currently scrubbed in the past, truncates forward timeline branches.
   * @param {unknown} state
   * @param {string} [label='Snapshot']
   * @returns {object} Cloned copy of the committed snapshot
   */
  commitSnapshot(state, label = 'Snapshot') {
    if (state === null || typeof state !== 'object') {
      throw new TypeError('Snapshot state must be a non-null serializable object or array.');
    }

    const clonedState = cloneSerializable(state);

    // Discard diverged future snapshots when committing from an earlier point
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
      for (const bp of Array.from(this.breakpoints)) {
        if (bp >= this.history.length) {
          this.breakpoints.delete(bp);
        }
      }
    }

    this._sequenceCounter += 1;
    const index = this.history.length;
    const snapshot = deepFreeze({
      id: `snap-${this._sequenceCounter}`,
      index,
      label: String(label || 'Snapshot'),
      timestamp: Date.now(),
      state: clonedState
    });

    this.history.push(snapshot);

    if (this.history.length > this.maxSnapshots) {
      this.history.shift();
      const reindexedHistory = this.history.map((item, idx) =>
        deepFreeze({
          ...cloneSerializable(item),
          index: idx
        })
      );
      this.history = reindexedHistory;

      const shiftedBreakpoints = new Set();
      for (const bp of this.breakpoints) {
        if (bp > 0) shiftedBreakpoints.add(bp - 1);
      }
      this.breakpoints = shiftedBreakpoints;
    }

    this.currentIndex = this.history.length - 1;
    const result = cloneSerializable(this.history[this.currentIndex]);
    this._notify('snapshot_committed', { snapshot: result });
    return result;
  }

  /**
   * Jumps directly to a snapshot index (clamped within [0, history.length - 1]).
   * @param {number} index
   * @returns {object|null} Cloned snapshot at the target index, or null if empty
   */
  stepTo(index) {
    if (this.history.length === 0) {
      return null;
    }
    const numericIndex = Number(index);
    if (!Number.isFinite(numericIndex)) {
      throw new RangeError('Target index must be a finite number.');
    }
    const clamped = Math.max(0, Math.min(Math.trunc(numericIndex), this.history.length - 1));
    this.currentIndex = clamped;
    const snapshot = cloneSerializable(this.history[this.currentIndex]);
    this._notify('step', { snapshot });
    return snapshot;
  }

  /**
   * Steps one snapshot backward in history.
   * @returns {object|null}
   */
  undo() {
    if (this.history.length === 0) {
      return null;
    }
    if (this.currentIndex > 0) {
      return this.stepTo(this.currentIndex - 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Steps one snapshot forward in history.
   * @returns {object|null}
   */
  redo() {
    if (this.history.length === 0) {
      return null;
    }
    if (this.currentIndex < this.history.length - 1) {
      return this.stepTo(this.currentIndex + 1);
    }
    return this.getCurrentSnapshot();
  }

  /**
   * Returns a deep-cloned copy of the active snapshot record.
   * @returns {object|null}
   */
  getCurrentSnapshot() {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return cloneSerializable(this.history[this.currentIndex]);
  }

  /**
   * Returns a deep-cloned copy of the active state object.
   * @returns {unknown|null}
   */
  getCurrentState() {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return cloneSerializable(this.history[this.currentIndex].state);
  }

  /**
   * Returns a deep-cloned copy of the snapshot at a given index.
   * @param {number} index
   * @returns {object|null}
   */
  getSnapshot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return null;
    }
    return cloneSerializable(this.history[index]);
  }

  /**
   * Returns a deep-cloned array of all recorded snapshots.
   * @returns {Array<object>}
   */
  getHistory() {
    return cloneSerializable(this.history);
  }

  /**
   * Toggles a breakpoint at the specified snapshot index.
   * @param {number} index
   * @returns {boolean} True if breakpoint is now enabled, false if removed
   */
  toggleBreakpoint(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return false;
    }
    let active;
    if (this.breakpoints.has(index)) {
      this.breakpoints.delete(index);
      active = false;
    } else {
      this.breakpoints.add(index);
      active = true;
    }
    this._notify('breakpoint_toggled', { index, active });
    return active;
  }

  /**
   * Checks whether a breakpoint exists at the given index.
   * @param {number} index
   * @returns {boolean}
   */
  hasBreakpoint(index) {
    return this.breakpoints.has(index);
  }

  /**
   * Returns sorted array of active breakpoint indices.
   * @returns {number[]}
   */
  getBreakpoints() {
    return Array.from(this.breakpoints).sort((a, b) => a - b);
  }

  /**
   * Clears all registered breakpoints.
   */
  clearBreakpoints() {
    this.breakpoints.clear();
    this._notify('breakpoints_cleared');
  }

  /**
   * Sets scrub playback direction ('forward' or 'backward').
   * @param {'forward'|'backward'} direction
   */
  setDirection(direction) {
    if (!VALID_DIRECTIONS.has(direction)) {
      throw new RangeError('Playback direction must be "forward" or "backward".');
    }
    this.direction = direction;
    this._notify('direction_changed');
  }

  /**
   * Updates scrub playback interval in milliseconds.
   * @param {number} intervalMs
   */
  setPlaybackInterval(intervalMs) {
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < 50) {
      throw new RangeError('Playback interval must be a finite number >= 50ms.');
    }
    this.playbackIntervalMs = intervalMs;
    if (this.isPlaying) {
      this.pause();
      this.play(this.direction, this.playbackIntervalMs);
    }
  }

  /**
   * Advances one scrub frame in the active direction, pausing if a boundary or breakpoint is reached.
   * @returns {{ moved: boolean, hitBreakpoint: boolean, reachedBoundary: boolean, snapshot: object|null }}
   */
  stepPlaybackOnce() {
    if (this.history.length === 0) {
      this.pause();
      return { moved: false, hitBreakpoint: false, reachedBoundary: true, snapshot: null };
    }

    const atEnd = this.direction === 'forward' && this.currentIndex >= this.history.length - 1;
    const atStart = this.direction === 'backward' && this.currentIndex <= 0;

    if (atEnd || atStart) {
      this.pause();
      return {
        moved: false,
        hitBreakpoint: false,
        reachedBoundary: true,
        snapshot: this.getCurrentSnapshot()
      };
    }

    const nextSnapshot = this.direction === 'forward' ? this.redo() : this.undo();
    const hitBreakpoint = this.breakpoints.has(this.currentIndex);
    const reachedBoundary =
      (this.direction === 'forward' && this.currentIndex >= this.history.length - 1) ||
      (this.direction === 'backward' && this.currentIndex <= 0);

    if (hitBreakpoint) {
      this.pause();
      this._notify('breakpoint_hit', { index: this.currentIndex, snapshot: nextSnapshot });
    } else if (reachedBoundary) {
      this.pause();
    }

    return {
      moved: true,
      hitBreakpoint,
      reachedBoundary,
      snapshot: nextSnapshot
    };
  }

  /**
   * Starts automatic bidirectional scrub playback.
   * @param {'forward'|'backward'} [direction=this.direction]
   * @param {number} [intervalMs=this.playbackIntervalMs]
   * @returns {boolean} True if playback started
   */
  play(direction = this.direction, intervalMs = this.playbackIntervalMs) {
    this.setDirection(direction);
    if (typeof intervalMs === 'number' && intervalMs >= 50) {
      this.playbackIntervalMs = intervalMs;
    }
    if (this.history.length <= 1) {
      return false;
    }

    // Auto-wrap if already at the boundary in the requested direction
    if (this.direction === 'forward' && this.currentIndex >= this.history.length - 1) {
      this.stepTo(0);
    } else if (this.direction === 'backward' && this.currentIndex <= 0) {
      this.stepTo(this.history.length - 1);
    }

    this._stopTimer();
    this.isPlaying = true;
    this._notify('playback_started');

    this._playbackTimer = setInterval(() => {
      this.stepPlaybackOnce();
    }, this.playbackIntervalMs);

    return true;
  }

  /**
   * Pauses automatic scrub playback.
   */
  pause() {
    const wasPlaying = this.isPlaying;
    this._stopTimer();
    this.isPlaying = false;
    if (wasPlaying) {
      this._notify('playback_paused');
    }
  }

  _stopTimer() {
    if (this._playbackTimer !== null) {
      clearInterval(this._playbackTimer);
      this._playbackTimer = null;
    }
  }

  /**
   * Recursively computes property-level diffs between two state objects.
   * Returns entries with `{ key, path, type: 'added' | 'removed' | 'modified', oldVal, newVal }`.
   * @param {object} [oldState={}]
   * @param {object} [newState={}]
   * @param {string} [prefix='']
   * @returns {Array<{ key: string, path: string, type: 'added'|'removed'|'modified', oldVal: unknown, newVal: unknown }>}
   */
  computeDiff(oldState = {}, newState = {}, prefix = '') {
    const prev = oldState && typeof oldState === 'object' ? oldState : {};
    const next = newState && typeof newState === 'object' ? newState : {};
    const diffs = [];

    const keys = Array.from(new Set([...Object.keys(prev), ...Object.keys(next)]));
    for (let i = 0; i < keys.length; i += 1) {
      const prop = keys[i];
      const fullPath = prefix ? `${prefix}.${prop}` : prop;
      const inPrev = Object.prototype.hasOwnProperty.call(prev, prop);
      const inNext = Object.prototype.hasOwnProperty.call(next, prop);

      if (!inPrev && inNext) {
        diffs.push({
          key: fullPath,
          path: fullPath,
          type: 'added',
          oldVal: undefined,
          newVal: cloneSerializable(next[prop])
        });
      } else if (inPrev && !inNext) {
        diffs.push({
          key: fullPath,
          path: fullPath,
          type: 'removed',
          oldVal: cloneSerializable(prev[prop]),
          newVal: undefined
        });
      } else {
        const valA = prev[prop];
        const valB = next[prop];
        if (isPlainObject(valA) && isPlainObject(valB)) {
          diffs.push(...this.computeDiff(valA, valB, fullPath));
        } else if (!deepEqual(valA, valB)) {
          diffs.push({
            key: fullPath,
            path: fullPath,
            type: 'modified',
            oldVal: cloneSerializable(valA),
            newVal: cloneSerializable(valB)
          });
        }
      }
    }

    return diffs;
  }

  /**
   * Computes the diff for a given snapshot index against its predecessor.
   * @param {number} [index=this.currentIndex]
   * @returns {{ index: number, isInitial: boolean, diffs: Array<object> }}
   */
  getDiffAt(index = this.currentIndex) {
    if (this.history.length === 0 || index < 0 || index >= this.history.length) {
      return { index: -1, isInitial: false, diffs: [] };
    }
    if (index === 0) {
      return {
        index: 0,
        isInitial: true,
        diffs: this.computeDiff({}, this.history[0].state)
      };
    }
    return {
      index,
      isInitial: false,
      diffs: this.computeDiff(this.history[index - 1].state, this.history[index].state)
    };
  }

  /**
   * Serializes the entire timeline, active cursor, and breakpoints to JSON.
   * @returns {string}
   */
  exportHistory() {
    return JSON.stringify(
      {
        schema: 'podcast-audio-stream-time-travel-v1',
        module: 'podcast-audio-stream',
        exportedAt: Date.now(),
        currentIndex: this.currentIndex,
        direction: this.direction,
        breakpoints: this.getBreakpoints(),
        history: cloneSerializable(this.history)
      },
      null,
      2
    );
  }

  /**
   * Restores timeline history, active index, and breakpoints from exported JSON.
   * @param {string} jsonString
   * @returns {boolean}
   */
  importHistory(jsonString) {
    if (typeof jsonString !== 'string') {
      throw new TypeError('History payload must be a JSON string.');
    }

    const parsed = JSON.parse(jsonString);
    const rawEntries = Array.isArray(parsed?.history)
      ? parsed.history
      : Array.isArray(parsed?.snapshots)
        ? parsed.snapshots
        : null;

    if (!rawEntries) {
      throw new Error('Malformed history payload: missing "history" array.');
    }

    this.pause();

    const restoredHistory = rawEntries.map((entry, idx) => {
      if (!entry || typeof entry !== 'object' || entry.state === undefined) {
        throw new Error(`Invalid snapshot entry at index ${idx}.`);
      }
      this._sequenceCounter += 1;
      return deepFreeze({
        id: typeof entry.id === 'string' && entry.id ? entry.id : `snap-${this._sequenceCounter}`,
        index: idx,
        label: String(entry.label || `Snapshot ${idx + 1}`),
        timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
        state: cloneSerializable(entry.state)
      });
    });

    this.history = restoredHistory;

    if (this.history.length === 0) {
      this.currentIndex = -1;
    } else if (Number.isInteger(parsed.currentIndex)) {
      this.currentIndex = Math.max(0, Math.min(parsed.currentIndex, this.history.length - 1));
    } else {
      this.currentIndex = this.history.length - 1;
    }

    this.breakpoints = new Set();
    if (Array.isArray(parsed.breakpoints)) {
      for (const bp of parsed.breakpoints) {
        if (Number.isInteger(bp) && bp >= 0 && bp < this.history.length) {
          this.breakpoints.add(bp);
        }
      }
    }

    if (VALID_DIRECTIONS.has(parsed.direction)) {
      this.direction = parsed.direction;
    }

    this._notify('history_imported');
    return true;
  }

  /**
   * Resets history, breakpoints, and stops playback.
   */
  clear() {
    this.pause();
    this.history = [];
    this.currentIndex = -1;
    this.breakpoints.clear();
    this._notify('cleared');
  }
}
