export const DEFAULT_COLUMNS = ['backlog', 'in-progress', 'review', 'done'];
export const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];

const COLUMN_LABELS = {
  backlog: 'Backlog',
  'in-progress': 'In Progress',
  review: 'Review',
  done: 'Done'
};

const DEFAULT_SEED_TASKS = [
  {
    id: 'task-seed-1',
    title: 'Calibrate Olympic Barbell Collars & Rack Pins',
    priority: 'high',
    column: 'backlog',
    createdAt: 1700000001000
  },
  {
    id: 'task-seed-2',
    title: 'Configure Tabata 20/10 Timer Audio Thresholds',
    priority: 'critical',
    column: 'in-progress',
    createdAt: 1700000002000
  },
  {
    id: 'task-seed-3',
    title: 'Verify Zone-4 Heart Rate MET Calorie Curve',
    priority: 'medium',
    column: 'review',
    createdAt: 1700000003000
  },
  {
    id: 'task-seed-4',
    title: 'Publish Morning EMOM Benchmark WOD',
    priority: 'low',
    column: 'done',
    createdAt: 1700000004000
  }
];

let taskSequence = 0;

function normalizeColumnOrder(candidateOrder) {
  if (!Array.isArray(candidateOrder)) {
    return [...DEFAULT_COLUMNS];
  }
  const seen = new Set();
  const normalized = [];
  for (const col of candidateOrder) {
    if (DEFAULT_COLUMNS.includes(col) && !seen.has(col)) {
      seen.add(col);
      normalized.push(col);
    }
  }
  for (const col of DEFAULT_COLUMNS) {
    if (!seen.has(col)) {
      normalized.push(col);
    }
  }
  return normalized;
}

function sanitizeTasks(candidateTasks) {
  return candidateTasks
    .filter(
      (task) =>
        task &&
        typeof task.id === 'string' &&
        task.id.trim() &&
        typeof task.title === 'string' &&
        task.title.trim()
    )
    .map((task) => ({
      id: task.id.trim(),
      title: task.title.trim(),
      priority: VALID_PRIORITIES.includes(task.priority) ? task.priority : 'medium',
      column: DEFAULT_COLUMNS.includes(task.column) ? task.column : 'backlog',
      createdAt: typeof task.createdAt === 'number' && Number.isFinite(task.createdAt)
        ? task.createdAt
        : Date.now()
    }));
}

function resolveStorage() {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (desc && 'value' in desc && desc.value) {
    return desc.value;
  }
  return null;
}

/**
 * Autonomous client-side Kanban task board state manager for Fitness Crossfit Pro.
 * Supports task creation, cross-column and positional card movement, column reordering,
 * and automatic localStorage synchronization.
 */
export class FitnessCrossfitProKanbanBoard {
  #tasks = [];
  #columnOrder = [...DEFAULT_COLUMNS];
  #storageKey;
  #customStorage;

  constructor(storageKey = 'fitness-crossfit-pro-kanban', storage = null) {
    this.#storageKey = storageKey;
    this.#customStorage = storage;
    this.#loadBoardState();
  }

  #getStorage() {
    return this.#customStorage ?? resolveStorage();
  }

  #loadBoardState() {
    const storage = this.#getStorage();
    if (storage) {
      try {
        const raw = storage.getItem(this.#storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this.#tasks = sanitizeTasks(parsed);
            this.#columnOrder = [...DEFAULT_COLUMNS];
            return;
          }
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
            this.#tasks = sanitizeTasks(parsed.tasks);
            this.#columnOrder = normalizeColumnOrder(parsed.columnOrder);
            return;
          }
        }
      } catch {
        // Fall back to default Fitness Crossfit Pro seed tasks if stored JSON is invalid.
      }
    }

    this.#columnOrder = [...DEFAULT_COLUMNS];
    this.#tasks = structuredClone(DEFAULT_SEED_TASKS);
  }

  addTask(title, priority = 'medium', column = 'backlog') {
    if (typeof title !== 'string' || !title.trim()) {
      throw new Error('Task title cannot be empty');
    }

    const cleanPriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';
    const cleanColumn = DEFAULT_COLUMNS.includes(column) ? column : 'backlog';
    taskSequence += 1;

    const newTask = {
      id: `task-${Date.now()}-${taskSequence}`,
      title: title.trim(),
      priority: cleanPriority,
      column: cleanColumn,
      createdAt: Date.now()
    };

    this.#tasks.push(newTask);
    this.saveBoardState();
    return structuredClone(newTask);
  }

  moveTask(taskId, targetColumn, targetIndex = null) {
    if (!DEFAULT_COLUMNS.includes(targetColumn)) {
      throw new Error(`Invalid target column: ${targetColumn}`);
    }

    const currentIndex = this.#tasks.findIndex((task) => task.id === taskId);
    if (currentIndex === -1) {
      throw new Error(`Task not found with ID: ${taskId}`);
    }

    const [task] = this.#tasks.splice(currentIndex, 1);
    task.column = targetColumn;

    if (Number.isInteger(targetIndex) && targetIndex >= 0) {
      const targetColumnIndices = [];
      for (let i = 0; i < this.#tasks.length; i += 1) {
        if (this.#tasks[i].column === targetColumn) {
          targetColumnIndices.push(i);
        }
      }

      if (targetIndex >= targetColumnIndices.length) {
        this.#tasks.push(task);
      } else {
        this.#tasks.splice(targetColumnIndices[targetIndex], 0, task);
      }
    } else {
      this.#tasks.push(task);
    }

    this.saveBoardState();
    return structuredClone(task);
  }

  removeTask(taskId) {
    const idx = this.#tasks.findIndex((task) => task.id === taskId);
    if (idx === -1) {
      return null;
    }
    const [removed] = this.#tasks.splice(idx, 1);
    this.saveBoardState();
    return structuredClone(removed);
  }

  reorderColumns(sourceColumn, targetColumn) {
    if (!DEFAULT_COLUMNS.includes(sourceColumn) || !DEFAULT_COLUMNS.includes(targetColumn)) {
      throw new Error(`Invalid column reorder request: ${sourceColumn} -> ${targetColumn}`);
    }

    const fromIndex = this.#columnOrder.indexOf(sourceColumn);
    const toIndex = this.#columnOrder.indexOf(targetColumn);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      return [...this.#columnOrder];
    }

    const [moved] = this.#columnOrder.splice(fromIndex, 1);
    this.#columnOrder.splice(toIndex, 0, moved);
    this.saveBoardState();
    return [...this.#columnOrder];
  }

  moveColumnByOffset(columnId, offset) {
    if (!DEFAULT_COLUMNS.includes(columnId)) {
      throw new Error(`Invalid column: ${columnId}`);
    }
    if (!Number.isInteger(offset)) {
      throw new Error(`Invalid column offset: ${offset}`);
    }
    const currentIdx = this.#columnOrder.indexOf(columnId);
    const nextIdx = Math.max(0, Math.min(this.#columnOrder.length - 1, currentIdx + offset));
    if (nextIdx === currentIdx) {
      return [...this.#columnOrder];
    }
    return this.reorderColumns(columnId, this.#columnOrder[nextIdx]);
  }

  saveBoardState() {
    const storage = this.#getStorage();
    if (storage) {
      try {
        storage.setItem(
          this.#storageKey,
          JSON.stringify({
            columnOrder: this.#columnOrder,
            tasks: this.#tasks
          })
        );
      } catch {
        // Ignore storage quota or sandboxed browser errors.
      }
    }
    return this.getBoardState();
  }

  getBoardState() {
    return structuredClone(this.#tasks);
  }

  getColumnOrder() {
    return [...this.#columnOrder];
  }

  getTasksByColumn(column) {
    return this.#tasks
      .filter((task) => task.column === column)
      .map((task) => structuredClone(task));
  }

  clearBoard() {
    this.#tasks = [];
    this.saveBoardState();
    return [];
  }

  resetBoard() {
    this.#columnOrder = [...DEFAULT_COLUMNS];
    this.#tasks = structuredClone(DEFAULT_SEED_TASKS);
    this.saveBoardState();
    return this.getBoardState();
  }
}

function getDropCardIndex(columnBody, pointerY) {
  const cards = Array.from(columnBody.querySelectorAll('.kanban-card:not(.dragging)'));
  for (let i = 0; i < cards.length; i += 1) {
    const rect = cards[i].getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (pointerY < midpoint) {
      return i;
    }
  }
  return cards.length;
}

function createMoveButton(direction, task, targetColumnId, onMove) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = direction === 'prev' ? 'btn-prev' : 'btn-next';
  const targetLabel = COLUMN_LABELS[targetColumnId] ?? targetColumnId;
  button.setAttribute('aria-label', `Move ${task.title} to ${targetLabel}`);
  button.textContent = direction === 'prev' ? '←' : '→';
  button.addEventListener('click', () => onMove(task.id, targetColumnId));
  return button;
}

function createTaskCardElement(task, colIndex, columnOrder, handlers) {
  const card = document.createElement('article');
  card.className = `kanban-card prio-card-${task.priority}`;
  card.draggable = true;
  card.dataset.id = task.id;
  card.setAttribute('role', 'listitem');

  const topRow = document.createElement('div');
  topRow.className = 'card-top';

  const prioTag = document.createElement('span');
  prioTag.className = `prio-tag prio-${task.priority}`;
  prioTag.textContent = task.priority;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-delete-card';
  deleteBtn.setAttribute('aria-label', `Delete ${task.title}`);
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('click', () => handlers.onDelete(task.id));

  topRow.append(prioTag, deleteBtn);

  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = task.title;

  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const idLabel = document.createElement('span');
  idLabel.className = 'card-id';
  idLabel.textContent = task.id.slice(0, 14);

  const moveActions = document.createElement('div');
  moveActions.className = 'move-actions';

  if (colIndex > 0) {
    moveActions.appendChild(
      createMoveButton('prev', task, columnOrder[colIndex - 1], handlers.onMove)
    );
  }
  if (colIndex < columnOrder.length - 1) {
    moveActions.appendChild(
      createMoveButton('next', task, columnOrder[colIndex + 1], handlers.onMove)
    );
  }

  footer.append(idLabel, moveActions);
  card.append(topRow, titleEl, footer);

  card.addEventListener('dragstart', (event) => {
    event.stopPropagation();
    handlers.onDragStart(task.id, card, event);
  });

  card.addEventListener('dragend', () => {
    handlers.onDragEnd(card);
  });

  return card;
}

function mount() {
  const root = document.querySelector('[data-kanban-lab]');
  if (!root) return;

  const board = new FitnessCrossfitProKanbanBoard();
  const grid = root.querySelector('#kanban-grid');
  const summaryEl = document.querySelector('#board-summary');
  const resetBtn = root.querySelector('#reset-board-btn');
  const clearBtn = root.querySelector('#clear-board-btn');

  const modal = document.querySelector('#task-modal');
  const openModalBtn = root.querySelector('#open-task-modal-btn');
  const closeModalBtn = document.querySelector('#close-modal-btn');
  const cancelModalBtn = document.querySelector('#cancel-modal-btn');
  const addTaskForm = document.querySelector('#add-task-form');
  const titleInput = document.querySelector('#new-task-title');
  const prioritySelect = document.querySelector('#new-task-priority');
  const columnSelect = document.querySelector('#new-task-column');
  const formErrorEl = document.querySelector('#task-form-error');

  let dragState = null;

  function clearDragHighlights() {
    root.querySelectorAll('.kanban-column').forEach((col) => {
      col.classList.remove('drag-over', 'column-drag-over', 'column-dragging');
    });
  }

  function openModal() {
    if (!modal) return;
    if (formErrorEl) {
      formErrorEl.textContent = '';
      formErrorEl.hidden = true;
    }
    modal.hidden = false;
    titleInput?.focus();
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    addTaskForm?.reset();
    if (formErrorEl) {
      formErrorEl.textContent = '';
      formErrorEl.hidden = true;
    }
    openModalBtn?.focus();
  }

  function render() {
    const columnOrder = board.getColumnOrder();
    const totalTasks = board.getBoardState().length;

    if (summaryEl) {
      summaryEl.textContent = `${totalTasks} ${totalTasks === 1 ? 'task' : 'tasks'} synced`;
    }

    columnOrder.forEach((colId, colIdx) => {
      const colSection = root.querySelector(`.kanban-column[data-column="${colId}"]`);
      if (!colSection) return;

      grid?.appendChild(colSection);

      const prevColBtn = colSection.querySelector('[data-col-move="prev"]');
      const nextColBtn = colSection.querySelector('[data-col-move="next"]');
      if (prevColBtn) prevColBtn.disabled = colIdx === 0;
      if (nextColBtn) nextColBtn.disabled = colIdx === columnOrder.length - 1;

      const tasks = board.getTasksByColumn(colId);
      const countEl = colSection.querySelector(`#count-${colId}`);
      if (countEl) {
        countEl.textContent = String(tasks.length);
      }

      const bodyEl = colSection.querySelector(`[data-col="${colId}"]`);
      if (!bodyEl) return;

      bodyEl.replaceChildren();
      if (tasks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-lane';
        empty.textContent = 'Drop a task card here';
        bodyEl.appendChild(empty);
        return;
      }

      tasks.forEach((task) => {
        const card = createTaskCardElement(task, colIdx, columnOrder, {
          onMove(taskId, targetColumn) {
            board.moveTask(taskId, targetColumn);
            render();
          },
          onDelete(taskId) {
            board.removeTask(taskId);
            render();
          },
          onDragStart(taskId, cardEl, event) {
            dragState = { type: 'card', id: taskId };
            cardEl.classList.add('dragging');
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', taskId);
            }
          },
          onDragEnd(cardEl) {
            cardEl.classList.remove('dragging');
            dragState = null;
            clearDragHighlights();
          }
        });
        bodyEl.appendChild(card);
      });
    });
  }

  root.querySelectorAll('.kanban-column').forEach((colEl) => {
    const colName = colEl.dataset.column;
    const headerHandle = colEl.querySelector('[data-column-handle]');
    const colBody = colEl.querySelector('.kanban-column-body');

    if (headerHandle) {
      headerHandle.addEventListener('dragstart', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button')) {
          event.preventDefault();
          return;
        }
        dragState = { type: 'column', id: colName };
        colEl.classList.add('column-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', `col:${colName}`);
        }
      });

      headerHandle.addEventListener('dragend', () => {
        dragState = null;
        clearDragHighlights();
      });
    }

    colEl.querySelector('[data-col-move="prev"]')?.addEventListener('click', () => {
      board.moveColumnByOffset(colName, -1);
      render();
    });

    colEl.querySelector('[data-col-move="next"]')?.addEventListener('click', () => {
      board.moveColumnByOffset(colName, 1);
      render();
    });

    colEl.addEventListener('dragover', (event) => {
      if (!dragState) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      if (dragState.type === 'column' && dragState.id !== colName) {
        colEl.classList.add('column-drag-over');
      } else if (dragState.type === 'card') {
        colEl.classList.add('drag-over');
      }
    });

    colEl.addEventListener('dragleave', (event) => {
      if (!colEl.contains(event.relatedTarget)) {
        colEl.classList.remove('drag-over', 'column-drag-over');
      }
    });

    colEl.addEventListener('drop', (event) => {
      event.preventDefault();
      const activeDrag = dragState;
      clearDragHighlights();
      dragState = null;

      const rawData = event.dataTransfer?.getData('text/plain') || '';
      if (activeDrag?.type === 'column' || rawData.startsWith('col:')) {
        const sourceCol = activeDrag?.id || rawData.slice(4);
        if (sourceCol && colName && sourceCol !== colName) {
          board.reorderColumns(sourceCol, colName);
          render();
        }
        return;
      }

      const taskId = activeDrag?.id || rawData;
      if (taskId && colName && colBody) {
        const targetIndex = getDropCardIndex(colBody, event.clientY);
        board.moveTask(taskId, colName, targetIndex);
        render();
      }
    });
  });

  openModalBtn?.addEventListener('click', openModal);
  closeModalBtn?.addEventListener('click', closeModal);
  cancelModalBtn?.addEventListener('click', closeModal);

  modal?.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && !modal.hidden) {
      closeModal();
    }
  });

  addTaskForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = titleInput?.value ?? '';
    const priority = prioritySelect?.value ?? 'medium';
    const column = columnSelect?.value ?? 'backlog';

    try {
      board.addTask(title, priority, column);
      closeModal();
      render();
    } catch (error) {
      if (formErrorEl) {
        formErrorEl.textContent = error.message;
        formErrorEl.hidden = false;
      }
      titleInput?.focus();
    }
  });

  resetBtn?.addEventListener('click', () => {
    board.resetBoard();
    render();
  });

  clearBtn?.addEventListener('click', () => {
    board.clearBoard();
    render();
  });

  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}
