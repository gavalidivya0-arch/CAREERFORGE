// Pointer heatmap for the microloans showcase. Points stay in memory only.

export const MAX_POINTS = 2000;

/** Colour stops from cold to hot, as [position, r, g, b]. */
const STOPS = [
  [0, 37, 99, 235],
  [0.35, 5, 150, 105],
  [0.65, 250, 204, 21],
  [1, 220, 38, 38],
];

export function heatColor(intensity) {
  const value = Math.min(1, Math.max(0, Number(intensity) || 0));
  const upper = STOPS.findIndex((stop) => stop[0] >= value);
  const high = STOPS[Math.max(upper, 1)];
  const low = STOPS[Math.max(upper, 1) - 1];
  const mix = (value - low[0]) / (high[0] - low[0]);
  return [1, 2, 3].map((i) => Math.round(low[i] + (high[i] - low[i]) * mix));
}

/** Gaussian kernel density on a coarse grid; values are scaled so the hottest cell is 1. */
export function densityGrid(points, width, height, cell = 8, radius = 32) {
  const columns = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const values = new Float32Array(columns * rows);
  const sigma = radius / 2;
  let peak = 0;
  for (const point of points) {
    const left = Math.max(0, Math.floor((point.x - radius) / cell));
    const right = Math.min(columns - 1, Math.floor((point.x + radius) / cell));
    const top = Math.max(0, Math.floor((point.y - radius) / cell));
    const bottom = Math.min(rows - 1, Math.floor((point.y + radius) / cell));
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const dx = (column + 0.5) * cell - point.x;
        const dy = (row + 0.5) * cell - point.y;
        const distance = dx * dx + dy * dy;
        if (distance > radius * radius) continue;
        const index = row * columns + column;
        values[index] += point.weight * Math.exp(-distance / (2 * sigma * sigma));
        if (values[index] > peak) peak = values[index];
      }
    }
  }
  if (peak > 0) {
    for (let i = 0; i < values.length; i += 1) values[i] /= peak;
  }
  return { columns, rows, cell, values, peak };
}

export class CharityMicroloansHeatmapTracker {
  constructor(limit = MAX_POINTS) {
    this.limit = limit;
    this.points = [];
  }

  /** Coordinates are viewport pixels. Returns false for input that cannot be plotted. */
  recordPoint(x, y, weight = 1) {
    if (![x, y, weight].every(Number.isFinite) || x < 0 || y < 0 || weight <= 0) return false;
    this.points.push({ x, y, weight });
    if (this.points.length > this.limit) this.points.shift();
    return true;
  }

  renderHeatmap(canvas) {
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const grid = densityGrid(this.points, canvas.width, canvas.height);
    for (let i = 0; i < grid.values.length; i += 1) {
      const value = grid.values[i];
      if (value < 0.02) continue;
      const [r, g, b] = heatColor(value);
      context.fillStyle = `rgba(${r}, ${g}, ${b}, ${(0.2 + value * 0.6).toFixed(3)})`;
      context.fillRect(
        (i % grid.columns) * grid.cell,
        Math.floor(i / grid.columns) * grid.cell,
        grid.cell,
        grid.cell,
      );
    }
    return grid;
  }

  resetData() {
    this.points = [];
  }
}

function start() {
  const canvas = document.getElementById('heat-canvas');
  const toggle = document.getElementById('heat-toggle');
  const opacity = document.getElementById('heat-opacity');
  const clear = document.getElementById('heat-clear');
  const readout = document.getElementById('heat-readout');
  const tracker = new CharityMicroloansHeatmapTracker();
  let visible = false;
  let queued = false;
  let lastMove = 0;

  const draw = () => {
    if (queued || !visible) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      tracker.renderHeatmap(canvas);
    });
  };
  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    draw();
  };
  const record = (event, weight) => {
    // The controls dock is not part of what is being measured.
    if (event.target.closest('.heat-dock')) return;
    tracker.recordPoint(event.clientX, event.clientY, weight);
    readout.textContent = `x ${Math.round(event.clientX)}, y ${Math.round(event.clientY)} · ${tracker.points.length} points`;
    draw();
  };

  document.addEventListener('pointermove', (event) => {
    if (event.timeStamp - lastMove < 80) return;
    lastMove = event.timeStamp;
    record(event, 0.25);
  });
  document.addEventListener('pointerdown', (event) => record(event, 1));
  toggle.addEventListener('click', () => {
    visible = !visible;
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.textContent = visible ? 'Hide heatmap' : 'Show heatmap';
    canvas.hidden = !visible;
    draw();
  });
  opacity.addEventListener('input', () => {
    canvas.style.opacity = String(opacity.value / 100);
  });
  clear.addEventListener('click', () => {
    tracker.resetData();
    readout.textContent = '0 points';
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  });
  window.addEventListener('resize', resize);
  canvas.style.opacity = String(opacity.value / 100);
  resize();
}

if (typeof document !== 'undefined') start();
