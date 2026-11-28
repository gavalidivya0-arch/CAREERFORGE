import test from 'node:test';
import assert from 'node:assert/strict';
import { RenewableMicrogridKanbanBoard } from './kanban-board.js';

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

test('initializes with default microgrid tasks and workflow column order', () => {
  const board = new RenewableMicrogridKanbanBoard('test-rm-init-' + Date.now());
  const tasks = board.getBoardState();

  assert.equal(tasks.length, 4);
  assert.deepEqual(board.getColumnOrder(), ['backlog', 'in-progress', 'review', 'done']);
  assert.ok(tasks.some((t) => t.column === 'backlog'));
  assert.ok(tasks.some((t) => t.column === 'done'));
});

test('addTask creates unique tasks, trims title, validates empty input, and normalizes defaults', () => {
  const board = new RenewableMicrogridKanbanBoard('test-rm-add-' + Date.now());
  board.clearBoard();

  assert.throws(() => board.addTask(''), /Task title cannot be empty/);
  assert.throws(() => board.addTask('   '), /Task title cannot be empty/);

  const t1 = board.addTask('  Inspect Microgrid Switchgear  ', 'critical');
  const t2 = board.addTask('Check Battery SOC', 'unknown-priority', 'invalid-col');

  assert.notEqual(t1.id, t2.id);
  assert.equal(t1.title, 'Inspect Microgrid Switchgear');
  assert.equal(t1.priority, 'critical');
  assert.equal(t1.column, 'backlog');

  assert.equal(t2.priority, 'medium');
  assert.equal(t2.column, 'backlog');
});

test('moveTask moves tasks across columns, supports positional ordering, and throws on invalid targets', () => {
  const board = new RenewableMicrogridKanbanBoard('test-rm-move-' + Date.now());
  board.clearBoard();

  const first = board.addTask('Task One', 'low', 'backlog');
  const second = board.addTask('Task Two', 'high', 'backlog');
  const third = board.addTask('Task Three', 'medium', 'in-progress');

  const moved = board.moveTask(first.id, 'in-progress', 0);
  assert.equal(moved.column, 'in-progress');
  assert.deepEqual(
    board.getTasksByColumn('in-progress').map((t) => t.id),
    [first.id, third.id]
  );

  board.moveTask(second.id, 'done');
  assert.equal(board.getTasksByColumn('backlog').length, 0);
  assert.equal(board.getTasksByColumn('done').length, 1);

  assert.throws(() => board.moveTask(first.id, 'archived'), /Invalid target column/);
  assert.throws(() => board.moveTask('missing-id', 'done'), /Task not found/);
});

test('reorderColumns and moveColumnByOffset reorder columns and reject unknown columns', () => {
  const board = new RenewableMicrogridKanbanBoard('test-rm-cols-' + Date.now());

  const order1 = board.reorderColumns('done', 'backlog');
  assert.deepEqual(order1, ['done', 'backlog', 'in-progress', 'review']);

  const order2 = board.moveColumnByOffset('done', 1);
  assert.deepEqual(order2, ['backlog', 'done', 'in-progress', 'review']);

  const clamped = board.moveColumnByOffset('backlog', -2);
  assert.deepEqual(clamped, ['backlog', 'done', 'in-progress', 'review']);

  assert.throws(() => board.reorderColumns('backlog', 'staging'), /Invalid column/);
  assert.throws(() => board.moveColumnByOffset('unknown', 1), /Invalid column/);
});

test('saveBoardState synchronizes tasks and column order via localStorage and preserves cleared state', () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true
  });
  const key = 'test-rm-persist';

  try {
    const boardA = new RenewableMicrogridKanbanBoard(key);
    boardA.clearBoard();
    const added = boardA.addTask('Sync SCADA Telemetry', 'high', 'review');
    boardA.reorderColumns('review', 'backlog');

    const boardB = new RenewableMicrogridKanbanBoard(key);
    assert.deepEqual(boardB.getColumnOrder(), ['review', 'backlog', 'in-progress', 'done']);
    assert.equal(boardB.getBoardState().length, 1);
    assert.equal(boardB.getBoardState()[0].id, added.id);

    boardB.clearBoard();
    const boardC = new RenewableMicrogridKanbanBoard(key);
    assert.equal(boardC.getBoardState().length, 0);

    boardC.resetBoard();
    assert.equal(boardC.getBoardState().length, 4);
    assert.deepEqual(boardC.getColumnOrder(), ['backlog', 'in-progress', 'review', 'done']);
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});
