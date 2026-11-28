/**
 * Cybersecurity Sentinel - Immutable State Snapshot & Bidirectional Time-Travel Debugger
 *
 * Captures deeply frozen, serializable SOC state snapshots, computes recursive property diffs,
 * supports bidirectional scrub playback, breakpoint inspection, and JSON history import/export.
 */

const EXPORT_SCHEMA = 'cybersecurity-sentinel-time-travel-v1';

/**
 * Checks whether a value is a plain object (not null, array, Date, etc.).
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates and deep-clones a JSON-serializable state value.
 * Rejects circular references, functions, symbols, undefined, and non-finite numbers.
 * @param {*} value
 * @returns {*}
 */
function cloneSerializable(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('Snapshot state must be JSON-serializable (cannot contain undefined, functions, or symbols at root).');
  }

  // Validate circular references and non-serializable nested primitives via JSON round-trip
  let serialized;
  try {
    serialized = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function' || typeof val === 'symbol' || typeof val === 'bigint') {
        throw new TypeError(`Unsupported non-serializable value of type "${typeof val}" in state snapshot.`);
      }
      if (typeof val === 'number' && !Number.isFinite(val)) {
        throw new TypeError('State snapshot cannot contain NaN or Infinity.');
      }
      return val;
    });
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('circular')) {
      throw new TypeError('State snapshot cannot contain circular references.');
    }
    throw err;
  }

  if (serialized === undefined) {
    throw new TypeError('Snapshot state must be JSON-serializable.');
  }

  return JSON.parse(serialized);
}

/**
 * Recursively freezes an object/array graph in place to guarantee strict immutability.
 * @param {*} obj
 * @returns {*}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  const keys = Object.keys(obj);
  for (const key of keys) {
    const child = obj[key];
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return obj;
}

/**
 * Resolves a dot/bracket property path (e.g. "firewall.rules.0.action" or "threatLevel") on an object.
 * @param {*} obj
 * @param {string} path
 * @returns {{ found: boolean, value: * }}
 */
function resolvePath(obj, path) {
  if (obj === null || typeof obj !== 'object' || !path) {
    return { found: false, value: undefined };
  }
  const segments = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let current = obj;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

/**
 * Computes a recursive property-level diff between two serializable states.
 * @param {*} prevState
 * @param {*} nextState
 * @param {string} [prefix='']
 * @returns {{ added: number, removed: number, modified: number, total: number, changes: Array<object> }}
 */
export function computeStateDiff(prevState, nextState, prefix = '') {
  const changes = [];

  function walk(a, b, path) {
    if (Object.is(a, b)) {
      return;
    }

    const bothObjects = isPlainObject(a) && isPlainObject(b);
    const bothArrays = Array.isArray(a) && Array.isArray(b);

    if (bothObjects) {
      const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
      for (const key of keys) {
        const nextPath = path ? `${path}.${key}` : key;
        const inA = Object.prototype.hasOwnProperty.call(a, key);
        const inB = Object.prototype.hasOwnProperty.call(b, key);

        if (!inA && inB) {
          changes.push({
            path: nextPath,
            key,
            kind: 'added',
            oldValue: undefined,
            newValue: cloneSerializable(b[key])
          });
        } else if (inA && !inB) {
          changes.push({
            path: nextPath,
            key,
            kind: 'removed',
            oldValue: cloneSerializable(a[key]),
            newValue: undefined
          });
        } else {
          walk(a[key], b[key], nextPath);
        }
      }
      return;
    }

    if (bothArrays) {
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        const nextPath = `${path}[${i}]`;
        if (i >= a.length) {
          changes.push({
            path: nextPath,
            key: String(i),
            kind: 'added',
            oldValue: undefined,
            newValue: cloneSerializable(b[i])
          });
        } else if (i >= b.length) {
          changes.push({
            path: nextPath,
            key: String(i),
            kind: 'removed',
            oldValue: cloneSerializable(a[i]),
            newValue: undefined
          });
        } else {
          walk(a[i], b[i], nextPath);
        }
      }
      return;
    }

    if (a === undefined && b !== undefined) {
      changes.push({
        path: path || '(root)',
        key: path || '(root)',
        kind: 'added',
        oldValue: undefined,
        newValue: cloneSerializable(b)
      });
      return;
    }

    if (a !== undefined && b === undefined) {
      changes.push({
        path: path || '(root)',
        key: path || '(root)',
        kind: 'removed',
        oldValue: cloneSerializable(a),
        newValue: undefined
      });
      return;
    }

    changes.push({
      path: path || '(root)',
      key: path || '(root)',
      kind: 'modified',
      oldValue: cloneSerializable(a),
      newValue: cloneSerializable(b)
    });
  }

  walk(prevState, nextState, prefix);

  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const change of changes) {
    if (change.kind === 'added') added++;
    else if (change.kind === 'removed') removed++;
    else if (change.kind === 'modified') modified++;
  }

  return {
    added,
    removed,
    modified,
    total: changes.length,
    changes
  };
}

/**
 * Immutable state snapshot store with bidirectional time-travel, diffs, breakpoints, and JSON export/import.
 */
export class CybersecuritySentinelTimeTravelStore {
  /**
   * @param {*|null} [initialState=null]
   * @param {{ maxSnapshots?: number, initialLabel?: string }} [options={}]
   */
  constructor(initialState = null, options = {}) {
    this.history = [];
    this.currentIndex = -1;
    this.maxSnapshots = Number.isInteger(options.maxSnapshots) && options.maxSnapshots > 0
      ? options.maxSnapshots
      : 250;
    this.breakpoints = new Set();
    this.watchRules = [];
    this.listeners = new Set();
    this._sequence = 0;

    if (initialState !== null && initialState !== undefined) {
      this.commitSnapshot(initialState, options.initialLabel || 'Baseline Posture');
    }
  }

  /**
   * Subscribes to store mutations/navigation events.
   * @param {(event: string, payload: object) => void} listener
   * @returns {() => void} Unsubscribe callback
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Subscriber must be a function.');
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  #notify(event, payload = {}) {
    for (const listener of this.listeners) {
      listener(event, {
        currentIndex: this.currentIndex,
        length: this.history.length,
        ...payload
      });
    }
  }

  /**
   * Re-indexes stored frozen snapshots sequentially after truncation or capacity eviction.
   */
  #reindexSnapshots() {
    this.history = this.history.map((snap, idx) => {
      if (snap.index === idx) return snap;
      return deepFreeze({
        id: snap.id,
        index: idx,
        label: snap.label,
        timestamp: snap.timestamp,
        state: cloneSerializable(snap.state)
      });
    });
  }

  /**
   * Commits a new immutable snapshot at the current timeline cursor.
   * If cursor is behind head, forward branch snapshots are truncated.
   * @param {*} state - Serializable state payload
   * @param {string} [label='Snapshot']
   * @returns {object} Cloned copy of the committed snapshot
   */
  commitSnapshot(state, label = 'Snapshot') {
    const clonedState = cloneSerializable(state);

    // Branch from past position: discard invalidated forward timeline and stale breakpoints
    if (this.currentIndex >= 0 && this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
      for (const bp of Array.from(this.breakpoints)) {
        if (bp >= this.history.length) {
          this.breakpoints.delete(bp);
        }
      }
    }

    this._sequence += 1;
    const index = this.history.length;
    const snapshot = deepFreeze({
      id: `snap_${this._sequence}_${index}`,
      index,
      label: String(label ?? 'Snapshot').trim() || 'Snapshot',
      timestamp: Date.now(),
      state: clonedState
    });

    this.history.push(snapshot);

    if (this.history.length > this.maxSnapshots) {
      this.history.shift();
      const shiftedBreakpoints = new Set();
      for (const bp of this.breakpoints) {
        if (bp > 0) shiftedBreakpoints.add(bp - 1);
      }
      this.breakpoints = shiftedBreakpoints;
      this.#reindexSnapshots();
    }

    this.currentIndex = this.history.length - 1;
    const publicCopy = cloneSerializable(this.history[this.currentIndex]);
    this.#notify('commit', { snapshot: publicCopy });
    return publicCopy;
  }

  /**
   * Jumps the timeline cursor directly to the specified snapshot index (clamped to valid range).
   * @param {number} index
   * @returns {object|null} Cloned snapshot at target index, or null if timeline is empty
   */
  stepTo(index) {
    if (this.history.length === 0) {
      return null;
    }
    const numericIndex = Number(index);
    if (!Number.isFinite(numericIndex)) {
      throw new TypeError('Target snapshot index must be a finite number.');
    }

    const clamped = Math.max(0, Math.min(this.history.length - 1, Math.trunc(numericIndex)));
    this.currentIndex = clamped;
    const snapshot = this.getCurrentSnapshot();
    const breakpointHit = this.evaluateBreakpoint(clamped);
    this.#notify('step', { snapshot, breakpointHit });
    return snapshot;
  }

  /**
   * Moves backward one snapshot in history.
   * @returns {object|null} Cloned snapshot at previous index, or null if already at start/empty
   */
  undo() {
    if (!this.canUndo()) {
      return null;
    }
    return this.stepTo(this.currentIndex - 1);
  }

  /**
   * Moves forward one snapshot in history.
   * @returns {object|null} Cloned snapshot at next index, or null if already at head/empty
   */
  redo() {
    if (!this.canRedo()) {
      return null;
    }
    return this.stepTo(this.currentIndex + 1);
  }

  /**
   * @returns {boolean}
   */
  canUndo() {
    return this.currentIndex > 0;
  }

  /**
   * @returns {boolean}
   */
  canRedo() {
    return this.currentIndex >= 0 && this.currentIndex < this.history.length - 1;
  }

  /**
   * @returns {number}
   */
  getLength() {
    return this.history.length;
  }

  /**
   * Returns a cloned copy of the snapshot at the active cursor.
   * @returns {object|null}
   */
  getCurrentSnapshot() {
    return this.getSnapshotAt(this.currentIndex);
  }

  /**
   * Returns a cloned copy of the state object at the active cursor.
   * @returns {*}
   */
  getCurrentState() {
    const snap = this.getCurrentSnapshot();
    return snap ? snap.state : null;
  }

  /**
   * Returns a cloned copy of the snapshot at a given index.
   * @param {number} index
   * @returns {object|null}
   */
  getSnapshotAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return null;
    }
    return cloneSerializable(this.history[index]);
  }

  /**
   * Returns a deep-cloned array of all stored snapshots.
   * @returns {Array<object>}
   */
  getHistory() {
    return cloneSerializable(this.history);
  }

  /**
   * Computes a property diff between two arbitrary states.
   * @param {*} prevState
   * @param {*} nextState
   */
  computeDiff(prevState, nextState) {
    return computeStateDiff(prevState, nextState);
  }

  /**
   * Computes the diff for a snapshot against its predecessor (or empty baseline for index 0).
   * @param {number} [index=this.currentIndex]
   */
  getDiffAt(index = this.currentIndex) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return { added: 0, removed: 0, modified: 0, total: 0, changes: [] };
    }
    const prevState = index > 0 ? this.history[index - 1].state : {};
    const currState = this.history[index].state;
    return computeStateDiff(prevState, currState);
  }

  /**
   * Breakpoint management for timeline inspection & auto-pause playback.
   */
  addBreakpoint(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return false;
    }
    this.breakpoints.add(index);
    this.#notify('breakpoint', { breakpoints: this.getBreakpoints() });
    return true;
  }

  removeBreakpoint(index) {
    const deleted = this.breakpoints.delete(index);
    if (deleted) {
      this.#notify('breakpoint', { breakpoints: this.getBreakpoints() });
    }
    return deleted;
  }

  toggleBreakpoint(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return false;
    }
    if (this.breakpoints.has(index)) {
      this.breakpoints.delete(index);
    } else {
      this.breakpoints.add(index);
    }
    this.#notify('breakpoint', { breakpoints: this.getBreakpoints() });
    return this.breakpoints.has(index);
  }

  hasBreakpoint(index) {
    return this.breakpoints.has(index);
  }

  getBreakpoints() {
    return Array.from(this.breakpoints).sort((a, b) => a - b);
  }

  clearBreakpoints() {
    this.breakpoints.clear();
    this.#notify('breakpoint', { breakpoints: [] });
  }

  /**
   * Adds a property watch breakpoint rule (e.g. path "threatLevel", expectedValue "CRITICAL").
   * @param {string} path
   * @param {*} expectedValue
   */
  addWatchRule(path, expectedValue) {
    const cleanPath = String(path || '').trim();
    if (!cleanPath) {
      throw new TypeError('Watch rule path must be a non-empty string.');
    }
    const clonedValue = cloneSerializable(expectedValue);
    const exists = this.watchRules.some(
      (rule) => rule.path === cleanPath && JSON.stringify(rule.expectedValue) === JSON.stringify(clonedValue)
    );
    if (!exists) {
      this.watchRules.push({ path: cleanPath, expectedValue: clonedValue });
      this.#notify('watch', { watchRules: this.getWatchRules() });
    }
    return this.getWatchRules();
  }

  removeWatchRule(index) {
    if (index >= 0 && index < this.watchRules.length) {
      this.watchRules.splice(index, 1);
      this.#notify('watch', { watchRules: this.getWatchRules() });
      return true;
    }
    return false;
  }

  getWatchRules() {
    return cloneSerializable(this.watchRules);
  }

  clearWatchRules() {
    this.watchRules = [];
    this.#notify('watch', { watchRules: [] });
  }

  /**
   * Evaluates whether a snapshot triggers an explicit breakpoint or watch rule.
   * @param {number} [index=this.currentIndex]
   * @returns {{ hit: boolean, reasons: Array<string> }}
   */
  evaluateBreakpoint(index = this.currentIndex) {
    const reasons = [];
    if (!Number.isInteger(index) || index < 0 || index >= this.history.length) {
      return { hit: false, reasons };
    }

    if (this.breakpoints.has(index)) {
      reasons.push(`Frame #${index} breakpoint`);
    }

    const state = this.history[index].state;
    for (const rule of this.watchRules) {
      const resolved = resolvePath(state, rule.path);
      if (resolved.found && JSON.stringify(resolved.value) === JSON.stringify(rule.expectedValue)) {
        reasons.push(`Watch hit: ${rule.path} === ${JSON.stringify(rule.expectedValue)}`);
      }
    }

    return {
      hit: reasons.length > 0,
      reasons
    };
  }

  /**
   * Serializes the entire immutable timeline, cursor position, breakpoints, and watch rules into JSON.
   * @returns {string}
   */
  exportHistory() {
    return JSON.stringify(
      {
        schema: EXPORT_SCHEMA,
        module: 'cybersecurity-sentinel',
        exportedAt: Date.now(),
        currentIndex: this.currentIndex,
        breakpoints: this.getBreakpoints(),
        watchRules: this.watchRules,
        snapshots: this.history
      },
      null,
      2
    );
  }

  /**
   * Imports and restores timeline history from an exported JSON string or parsed object.
   * Guarantees imported snapshots are deeply cloned and frozen.
   * @param {string|object} jsonPayload
   * @returns {{ count: number, currentIndex: number }}
   */
  importHistory(jsonPayload) {
    const parsed = typeof jsonPayload === 'string' ? JSON.parse(jsonPayload) : jsonPayload;

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.snapshots)) {
      throw new Error('Invalid timeline payload: expected an object with a "snapshots" array.');
    }

    const importedHistory = parsed.snapshots.map((item, idx) => {
      if (!item || typeof item !== 'object' || !('state' in item)) {
        throw new Error(`Invalid snapshot entry at index ${idx}: missing "state" property.`);
      }
      const clonedState = cloneSerializable(item.state);
      return deepFreeze({
        id: typeof item.id === 'string' && item.id ? item.id : `snap_import_${idx}`,
        index: idx,
        label: String(item.label ?? `Snapshot ${idx}`),
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
        state: clonedState
      });
    });

    this.history = importedHistory;
    this._sequence = importedHistory.length;

    if (importedHistory.length === 0) {
      this.currentIndex = -1;
    } else if (Number.isInteger(parsed.currentIndex)) {
      this.currentIndex = Math.max(0, Math.min(importedHistory.length - 1, parsed.currentIndex));
    } else {
      this.currentIndex = importedHistory.length - 1;
    }

    this.breakpoints = new Set(
      Array.isArray(parsed.breakpoints)
        ? parsed.breakpoints.filter((bp) => Number.isInteger(bp) && bp >= 0 && bp < importedHistory.length)
        : []
    );

    this.watchRules = Array.isArray(parsed.watchRules)
      ? parsed.watchRules
          .filter((r) => r && typeof r.path === 'string' && r.path.trim() !== '')
          .map((r) => ({
            path: r.path.trim(),
            expectedValue: cloneSerializable(r.expectedValue)
          }))
      : [];

    this.#notify('import', { count: this.history.length });
    return {
      count: this.history.length,
      currentIndex: this.currentIndex
    };
  }

  /**
   * Clears all snapshots, breakpoints, and resets cursor to -1.
   */
  clear() {
    this.history = [];
    this.currentIndex = -1;
    this.breakpoints.clear();
    this._sequence = 0;
    this.#notify('clear', {});
  }
}
