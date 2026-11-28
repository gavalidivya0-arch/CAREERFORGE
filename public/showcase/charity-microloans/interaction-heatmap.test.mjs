import test from 'node:test';
import assert from 'node:assert/strict';
import { CharityMicroloansHeatmapTracker, densityGrid, heatColor } from './interaction-heatmap.js';

test('recordPoint rejects unplottable input and keeps only the newest points', () => {
  const tracker = new CharityMicroloansHeatmapTracker(2);
  assert.equal(tracker.recordPoint(NaN, 1), false);
  assert.equal(tracker.recordPoint(-1, 1), false);
  assert.equal(tracker.recordPoint(1, 1, 0), false);
  [1, 2, 3].forEach((x) => assert.equal(tracker.recordPoint(x, x), true));
  assert.deepEqual(tracker.points.map((point) => point.x), [2, 3]);
  tracker.resetData();
  assert.equal(tracker.points.length, 0);
});

test('densityGrid peaks where points cluster and stays within the canvas', () => {
  const points = [
    { x: 20, y: 20, weight: 1 },
    { x: 20, y: 20, weight: 1 },
    { x: 150, y: 80, weight: 0.5 },
    { x: 900, y: 900, weight: 1 },
  ];
  const grid = densityGrid(points, 200, 100, 8, 24);
  const at = (x, y) => grid.values[Math.floor(y / 8) * grid.columns + Math.floor(x / 8)];

  assert.equal(grid.values.length, 25 * 13);
  assert.equal(Math.max(...grid.values), 1);
  assert.ok(at(20, 20) > at(150, 80));
  assert.ok(at(150, 80) > 0);
  assert.equal(at(100, 20), 0);
});

test('heatColor runs from blue to red and clamps', () => {
  assert.deepEqual(heatColor(0), [37, 99, 235]);
  assert.deepEqual(heatColor(1), [220, 38, 38]);
  assert.deepEqual(heatColor(-4), heatColor(0));
  assert.deepEqual(heatColor(9), heatColor(1));
});

test('renderHeatmap clears the canvas and paints only warm cells', () => {
  const calls = { clear: 0, fill: 0 };
  const context = { clearRect: () => { calls.clear += 1; }, fillRect: () => { calls.fill += 1; } };
  const canvas = { width: 100, height: 100, getContext: () => context };
  const tracker = new CharityMicroloansHeatmapTracker();

  tracker.renderHeatmap(canvas);
  assert.deepEqual(calls, { clear: 1, fill: 0 });
  tracker.recordPoint(50, 50);
  tracker.renderHeatmap(canvas);
  assert.equal(calls.clear, 2);
  assert.ok(calls.fill > 0 && calls.fill < 169);
});
