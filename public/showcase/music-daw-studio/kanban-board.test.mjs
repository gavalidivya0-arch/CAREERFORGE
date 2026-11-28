import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COLUMNS,
  MusicDawStudioKanbanBoard,
  VALID_PRIORITIES
} from './kanban-board.js';

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

test('initializes with default Music DAW Studio seed tasks and four workflow columns', () => {
  const board = new MusicDawStudioKanbanBoard('test-daw-init-' + Date.now());
  const tasks = board.getBoardState();

  assert.deepEqual(DEFAULT_COLUMNS, ['backlog', 'in-progress', 'review', 'done']);
  assert.deepEqual(VALID_PRIORITIES, ['low', 'medium', 'high', 'critical']);
  assert.deepEqual(board.getColumnOrder(), DEFAULT_COLUMNS);
  assert.equal(tasks.length, 4);
  for (const col of DEFAULT_COLUMNS) {
    assert.equal(board.getTasksByColumn(col).length, 1);
  }
});

test('addTask creates unique tasks, trims title, validates empty input, and normalizes options', () => {
  const board = new MusicDawStudioKanbanBoard('test-daw-add-' + Date.now());
  board.clearBoard();

  assert.throws(() => board.addTask(''), /Task title cannot be empty/);
  assert.throws(() => board.addTask('   '), /Task title cannot be empty/);
  assert.throws(() => board.addTask(null), /Task title cannot be empty/);

  const t1 = board.addTask('  Sidechain Bassline to Kick Bus  ', 'high', 'backlog');
  const t2 = board.addTask('Calibrate Stereo Bus Compressor', 'invalid-priority', 'unknown-col');

  assert.ok(t1.id.startsWith('task-'));
  assert.notEqual(t1.id, t2.id);
  assert.equal(t1.title, 'Sidechain Bassline to Kick Bus');
  assert.equal(t1.priority, 'high');
  assert.equal(t1.column, 'backlog');

  assert.equal(t2.priority, 'medium');
  assert.equal(t2.column, 'backlog');
  assert.equal(board.getBoardState().length, 2);
});

test('moveTask supports cross-column moves, positional ordering, and error guards', () => {
  const board = new MusicDawStudioKanbanBoard('test-daw-move-' + Date.now());
  board.clearBoard();

  const first = board.addTask('Program 16-Step Hi-Hat Groove', 'high', 'backlog');
  const second = board.addTask('Record Analog Pad Layer', 'low', 'backlog');
  const third = board.addTask('Automate Delay Send Throw', 'medium', 'in-progress');

  const movedTop = board.moveTask(first.id, 'in-progress', 0);
  assert.equal(movedTop.column, 'in-progress');
  assert.deepEqual(
    board.getTasksByColumn('in-progress').map((t) => t.id),
    [first.id, third.id]
  );

  // Intra-column move of second card above first
  board.moveTask(third.id, 'in-progress', 0);
  assert.deepEqual(
    board.getTasksByColumn('in-progress').map((t) => t.id),
    [third.id, first.id]
  );

  board.moveTask(second.id, 'done', 99);
  assert.equal(board.getTasksByColumn('backlog').length, 0);
  assert.equal(board.getTasksByColumn('done').length, 1);

  assert.throws(() => board.moveTask(first.id, 'archived'), /Invalid target column/);
  assert.throws(() => board.moveTask('missing-task-id', 'done'), /Task not found/);
});

test('removeTask deletes matching task and returns null when missing', () => {
  const board = new MusicDawStudioKanbanBoard('test-daw-remove-' + Date.now());
  const added = board.addTask('Check Phase Correlation Meter', 'medium', 'review');

  const removed = board.removeTask(added.id);
  assert.equal(removed.id, added.id);
  assert.equal(board.removeTask(added.id), null);
});

test('reorderColumns and moveColumnByOffset reorder workflow lanes and guard invalid inputs', () => {
  const board = new MusicDawStudioKanbanBoard('test-daw-cols-' + Date.now());

  const reordered = board.reorderColumns('done', 'backlog');
  assert.deepEqual(reordered, ['done', 'backlog', 'in-progress', 'review']);

  // No-op when source equals target
  assert.deepEqual(board.reorderColumns('done', 'done'), ['done', 'backlog', 'in-progress', 'review']);

  const shiftedRight = board.moveColumnByOffset('done', 1);
  assert.deepEqual(shiftedRight, ['backlog', 'done', 'in-progress', 'review']);

  const clampedLeft = board.moveColumnByOffset('backlog', -3);
  assert.deepEqual(clampedLeft, ['backlog', 'done', 'in-progress', 'review']);

  const clampedRight = board.moveColumnByOffset('review', 5);
  assert.deepEqual(clampedRight, ['backlog', 'done', 'in-progress', 'review']);

  assert.throws(() => board.reorderColumns('backlog', 'staging'), /Invalid column/);
  assert.throws(() => board.moveColumnByOffset('unknown', 1), /Invalid column/);
  assert.throws(() => board.moveColumnByOffset('backlog', 1.5), /Invalid column offset/);
});

test('saveBoardState persists tasks and column order via localStorage and handles legacy, clear, reset, and corrupt JSON', () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const memStorage = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: memStorage,
    configurable: true,
    writable: true
  });
  const key = 'test-daw-persist';

  try {
    const boardA = new MusicDawStudioKanbanBoard(key);
    boardA.clearBoard();
    const added = boardA.addTask('Bounce Final Master WAV', 'high', 'review');
    boardA.reorderColumns('review', 'backlog');

    const boardB = new MusicDawStudioKanbanBoard(key);
    assert.deepEqual(boardB.getColumnOrder(), ['review', 'backlog', 'in-progress', 'done']);
    assert.equal(boardB.getBoardState().length, 1);
    assert.equal(boardB.getBoardState()[0].id, added.id);

    // Explicitly cleared board stays empty across reload
    boardB.clearBoard();
    const boardC = new MusicDawStudioKanbanBoard(key);
    assert.equal(boardC.getBoardState().length, 0);

    // Reset restores default seed tasks and column order
    boardC.resetBoard();
    assert.equal(boardC.getBoardState().length, 4);
    assert.deepEqual(boardC.getColumnOrder(), DEFAULT_COLUMNS);

    // Legacy array storage format loads cleanly
    memStorage.setItem(
      key,
      JSON.stringify([{ id: 'legacy-1', title: 'Legacy Mix Track', priority: 'high', column: 'done' }])
    );
    const boardLegacy = new MusicDawStudioKanbanBoard(key);
    assert.equal(boardLegacy.getBoardState().length, 1);
    assert.equal(boardLegacy.getBoardState()[0].id, 'legacy-1');
    assert.deepEqual(boardLegacy.getColumnOrder(), DEFAULT_COLUMNS);

    // Corrupted JSON falls back cleanly
    memStorage.setItem(key, '{bad-json');
    const boardCorrupt = new MusicDawStudioKanbanBoard(key);
    assert.equal(boardCorrupt.getBoardState().length, 4);
    assert.deepEqual(boardCorrupt.getColumnOrder(), DEFAULT_COLUMNS);
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('handles quota/write errors in custom storage gracefully without crashing', () => {
  const failingStorage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('QuotaExceededError');
    }
  };
  const board = new MusicDawStudioKanbanBoard('test-daw-quota', failingStorage);
  const created = board.addTask('Trim Vocal Takes', 'low', 'backlog');
  assert.equal(created.title, 'Trim Vocal Takes');
  assert.equal(board.getBoardState().length, 5);
});

test('getters return defensive clones so external mutation cannot corrupt board state', () => {
  const board = new MusicDawStudioKanbanBoard('test-daw-clone-' + Date.now());
  const snapshot = board.getBoardState();
  snapshot[0].title = 'Mutated Externally';
  snapshot.push({ id: 'injected', title: 'Injected', priority: 'low', column: 'done' });

  const colTasks = board.getTasksByColumn('backlog');
  colTasks[0].title = 'Mutated Column Task';

  const order = board.getColumnOrder();
  order.reverse();

  assert.notEqual(board.getBoardState()[0].title, 'Mutated Externally');
  assert.notEqual(board.getTasksByColumn('backlog')[0].title, 'Mutated Column Task');
  assert.equal(board.getBoardState().length, 4);
  assert.deepEqual(board.getColumnOrder(), DEFAULT_COLUMNS);
});
