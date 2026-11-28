/**
 * SmartIotNexusKanbanBoard
 * Autonomous client-side Kanban task board for Smart IoT Nexus.
 * Features multi-column workflow stages, HTML5 drag-and-drop mechanics,
 * card elevation drop-shadows, and localStorage board persistence.
 */

export const COLUMNS = ['Backlog', 'In Progress', 'Review', 'Done'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const STORAGE_KEY = 'smart_iot_nexus_kanban_tasks';

const isTask = (task) => (
  task !== null &&
  typeof task === 'object' &&
  typeof task.id === 'string' &&
  typeof task.title === 'string' &&
  PRIORITIES.includes(task.priority) &&
  COLUMNS.includes(task.column)
);

const browserStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export class SmartIotNexusKanbanBoard {
  constructor({ storage = browserStorage(), seed = [] } = {}) {
    this.storage = storage;
    const loaded = this.loadBoardState();
    this.tasks = loaded ?? (seed.length > 0 ? seed.map((t) => ({ ...t })) : this.getDefaultSeed());
    this.nextId = this.tasks.reduce((max, t) => {
      const num = Number(t.id.replace('task-', '')) || 0;
      return Math.max(max, num);
    }, 0) + 1;
  }

  getDefaultSeed() {
    return [
      { id: 'task-1', title: 'Calibrate LoRaWAN humidity sensor array', priority: 'high', column: 'Backlog' },
      { id: 'task-2', title: 'Deploy OTA firmware v3.4.2 to Gateway-Alpha', priority: 'medium', column: 'In Progress' },
      { id: 'task-3', title: 'Verify MQTT broker TLS 1.3 certificate rotation', priority: 'critical', column: 'Review' },
      { id: 'task-4', title: 'Provision Prometheus edge telemetry exporter', priority: 'low', column: 'Done' }
    ];
  }

  loadBoardState() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isTask) : null;
    } catch {
      return null;
    }
  }

  addTask(title, priority = 'medium') {
    const name = String(title ?? '').trim();
    if (!name || !PRIORITIES.includes(priority)) return null;

    const task = {
      id: `task-${this.nextId++}`,
      title: name,
      priority,
      column: COLUMNS[0]
    };
    this.tasks.push(task);
    this.saveBoardState();
    return { ...task };
  }

  moveTask(taskId, targetColumn) {
    const index = this.tasks.findIndex((t) => t.id === taskId);
    if (index === -1 || !COLUMNS.includes(targetColumn)) return false;
    if (this.tasks[index].column === targetColumn) return true;

    // Move card to the bottom of the target column
    const [task] = this.tasks.splice(index, 1);
    this.tasks.push({ ...task, column: targetColumn });
    this.saveBoardState();
    return true;
  }

  saveBoardState() {
    try {
      if (!this.storage) return false;
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.tasks));
      return true;
    } catch {
      return false;
    }
  }

  getTasksByColumn(column) {
    return this.tasks.filter((t) => t.column === column);
  }
}

// Browser DOM controller
if (typeof document !== 'undefined') {
  const initBoard = () => {
    const boardEl = document.getElementById('board');
    const openBtn = document.getElementById('open');
    const dialog = document.getElementById('dialog');
    const titleInput = document.getElementById('title');
    const prioritySelect = document.getElementById('priority');
    const savedIndicator = document.getElementById('saved');

    if (!boardEl) return;

    const board = new SmartIotNexusKanbanBoard();

    const reportSaved = () => {
      if (savedIndicator) {
        const ok = board.saveBoardState();
        savedIndicator.textContent = ok ? '✓ State saved' : '⚠ In-memory session';
        setTimeout(() => {
          if (savedIndicator) savedIndicator.textContent = '';
        }, 2500);
      }
    };

    const move = (id, targetCol) => {
      if (!board.moveTask(id, targetCol)) return;
      render();
      reportSaved();
    };

    const createCardNode = (task) => {
      const card = document.createElement('article');
      card.className = `task-card ${task.priority}`;
      card.draggable = true;
      card.dataset.id = task.id;

      const titleNode = document.createElement('h3');
      titleNode.className = 'task-card-title';
      titleNode.textContent = task.title;

      const footer = document.createElement('div');
      footer.className = 'task-card-footer';

      const tag = document.createElement('span');
      tag.className = 'priority-tag';
      tag.textContent = task.priority;

      const select = document.createElement('select');
      select.className = 'column-select';
      select.ariaLabel = `Column lane for ${task.title}`;
      COLUMNS.forEach((col) => {
        const opt = document.createElement('option');
        opt.value = col;
        opt.textContent = col;
        if (col === task.column) opt.selected = true;
        select.appendChild(opt);
      });

      select.addEventListener('change', () => {
        move(task.id, select.value);
      });

      footer.appendChild(tag);
      footer.appendChild(select);

      card.appendChild(titleNode);
      card.appendChild(footer);

      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', task.id);
        card.style.opacity = '0.5';
      });

      card.addEventListener('dragend', () => {
        card.style.opacity = '1';
      });

      return card;
    };

    function render() {
      boardEl.innerHTML = '';

      COLUMNS.forEach((colName) => {
        const laneTasks = board.getTasksByColumn(colName);

        const lane = document.createElement('section');
        lane.className = 'kanban-lane';
        lane.ariaLabel = colName;

        const laneTitle = document.createElement('div');
        laneTitle.className = 'lane-title';
        laneTitle.innerHTML = `
          <span>${colName}</span>
          <span class="lane-count">${laneTasks.length}</span>
        `;
        lane.appendChild(laneTitle);

        laneTasks.forEach((task) => {
          lane.appendChild(createCardNode(task));
        });

        // HTML5 Drag-and-drop mechanics
        lane.addEventListener('dragover', (e) => {
          e.preventDefault();
          lane.classList.add('over');
        });

        lane.addEventListener('dragleave', (e) => {
          if (!lane.contains(e.relatedTarget)) {
            lane.classList.remove('over');
          }
        });

        lane.addEventListener('drop', (e) => {
          e.preventDefault();
          lane.classList.remove('over');
          const taskId = e.dataTransfer.getData('text/plain');
          move(taskId, colName);
        });

        boardEl.appendChild(lane);
      });
    }

    if (openBtn && dialog) {
      openBtn.addEventListener('click', () => {
        dialog.returnValue = '';
        if (titleInput) titleInput.value = '';
        if (prioritySelect) prioritySelect.value = 'medium';
        dialog.showModal();
      });

      dialog.addEventListener('close', () => {
        if (dialog.returnValue === 'add' && titleInput) {
          const added = board.addTask(titleInput.value, prioritySelect?.value || 'medium');
          if (added) {
            render();
            reportSaved();
          }
        }
      });
    }

    render();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBoard);
  } else {
    initBoard();
  }
}
