import test from 'node:test';
import assert from 'node:assert/strict';
import { AerospaceOrbiterTimeTravelStore } from './snapshot-time-travel.js';

test('AerospaceOrbiterTimeTravelStore - guarantees deep immutability of stored snapshots', () => {
  const store = new AerospaceOrbiterTimeTravelStore();
  const sourceState = {
    missionId: 'ORBITER-X7',
    altitudeKm: 410.5,
    thrusters: ['RCS-A', 'RCS-B'],
    attitude: { pitch: 0.2, yaw: -0.1 }
  };

  const committed = store.commitSnapshot(sourceState, 'LEO Baseline');

  // Mutate original source object and committed return object
  sourceState.altitudeKm = 9999;
  sourceState.thrusters.push('TAMPERED');
  sourceState.attitude.pitch = 90;
  committed.state.altitudeKm = -500;

  const snap = store.getCurrentSnapshot();
  assert.equal(snap.state.altitudeKm, 410.5);
  assert.deepEqual(snap.state.thrusters, ['RCS-A', 'RCS-B']);
  assert.equal(snap.state.attitude.pitch, 0.2);

  // Mutating object returned from getCurrentSnapshot() must not alter store history
  snap.state.altitudeKm = 123;
  snap.state.thrusters.push('EXTRA');
  const reRead = store.getCurrentSnapshot();
  assert.equal(reRead.state.altitudeKm, 410.5);
  assert.deepEqual(reRead.state.thrusters, ['RCS-A', 'RCS-B']);
});

test('AerospaceOrbiterTimeTravelStore - stepTo, undo, redo, and branch truncation', () => {
  const store = new AerospaceOrbiterTimeTravelStore();

  store.commitSnapshot({ altitudeKm: 400 }, 'Frame 0');
  store.commitSnapshot({ altitudeKm: 410 }, 'Frame 1');
  store.commitSnapshot({ altitudeKm: 420 }, 'Frame 2');

  assert.equal(store.history.length, 3);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.altitudeKm, 420);

  // Bidirectional undo / redo
  const prev = store.undo();
  assert.equal(store.currentIndex, 1);
  assert.equal(prev.state.altitudeKm, 410);

  const earliest = store.undo();
  assert.equal(store.currentIndex, 0);
  assert.equal(earliest.state.altitudeKm, 400);

  // Clamp at index 0
  store.undo();
  assert.equal(store.currentIndex, 0);

  const next = store.redo();
  assert.equal(store.currentIndex, 1);
  assert.equal(next.state.altitudeKm, 410);

  // Direct jump and out-of-bounds clamping
  store.stepTo(2);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.altitudeKm, 420);

  store.stepTo(999);
  assert.equal(store.currentIndex, 2);

  store.stepTo(-5);
  assert.equal(store.currentIndex, 0);

  // Committing from a past frame truncates future frames
  store.commitSnapshot({ altitudeKm: 415 }, 'Branched Burn');
  assert.equal(store.history.length, 2);
  assert.equal(store.currentIndex, 1);
  assert.equal(store.getCurrentSnapshot().state.altitudeKm, 415);
});

test('AerospaceOrbiterTimeTravelStore - JSON exportHistory and importHistory parity', () => {
  const store1 = new AerospaceOrbiterTimeTravelStore();
  store1.commitSnapshot({ stage: 'LEO_CRUISE', fuelRemainingPct: 92 }, 'Baseline');
  store1.commitSnapshot({ stage: 'PERIGEE_BURN', fuelRemainingPct: 88 }, 'Ignition');
  store1.commitSnapshot({ stage: 'APOGEE_COAST', fuelRemainingPct: 85 }, 'Coast');
  store1.toggleBreakpoint(1);
  store1.addWatchBreakpoint('fuelRemainingPct', '<', 86);
  store1.stepTo(1);

  const jsonPayload = store1.exportHistory();
  assert.equal(typeof jsonPayload, 'string');

  const store2 = new AerospaceOrbiterTimeTravelStore();
  const ok = store2.importHistory(jsonPayload);
  assert.equal(ok, true);
  assert.equal(store2.history.length, 3);
  assert.equal(store2.currentIndex, 1);
  assert.equal(store2.hasBreakpoint(1), true);
  assert.equal(store2.watchBreakpoints.length, 1);

  const restoredSnap = store2.getCurrentSnapshot();
  assert.equal(restoredSnap.label, 'Ignition');
  assert.equal(restoredSnap.state.stage, 'PERIGEE_BURN');
  assert.equal(restoredSnap.state.fuelRemainingPct, 88);

  // Reject malformed import payloads cleanly
  assert.equal(store2.importHistory('{not-json'), false);
  assert.equal(store2.importHistory(JSON.stringify({ wrong: [] })), false);
});

test('AerospaceOrbiterTimeTravelStore - computes diffs and evaluates breakpoints', () => {
  const store = new AerospaceOrbiterTimeTravelStore();
  store.commitSnapshot({ altitudeKm: 400, stage: 'LEO', legacyFlag: true }, 'Init');
  store.commitSnapshot({ altitudeKm: 425, stage: 'LEO', dockingBeacon: 'LOCKED' }, 'Burn');

  const diffs = store.getDiffAgainstPrevious();
  assert.equal(diffs.length, 3);

  const modified = diffs.find((d) => d.key === 'altitudeKm');
  assert.equal(modified.type, 'modified');
  assert.equal(modified.oldVal, 400);
  assert.equal(modified.newVal, 425);

  const removed = diffs.find((d) => d.key === 'legacyFlag');
  assert.equal(removed.type, 'removed');
  assert.equal(removed.oldVal, true);

  const added = diffs.find((d) => d.key === 'dockingBeacon');
  assert.equal(added.type, 'added');
  assert.equal(added.newVal, 'LOCKED');

  store.addWatchBreakpoint('altitudeKm', '>=', 420);
  const hit = store.evaluateBreakpoints(1);
  assert.equal(hit.kind, 'watch');
  assert.equal(hit.key, 'altitudeKm');
});

test('AerospaceOrbiterTimeTravelStore - bidirectional playback pauses on breakpoint', async () => {
  const store = new AerospaceOrbiterTimeTravelStore();
  store.commitSnapshot({ step: 0, stage: 'INIT' }, 'F0');
  store.commitSnapshot({ step: 1, stage: 'BURN' }, 'F1');
  store.commitSnapshot({ step: 2, stage: 'COAST' }, 'F2');
  store.commitSnapshot({ step: 3, stage: 'DOCK' }, 'F3');

  // Backward playback from end should pause at frame 1 breakpoint
  store.toggleBreakpoint(1);
  await new Promise((resolve) => {
    store.startReplay(15, (_snap, hitBp) => {
      if (hitBp || !store.isPlaying) {
        resolve();
      }
    }, 'backward');
  });

  assert.equal(store.isPlaying, false);
  assert.equal(store.currentIndex, 1);
  assert.equal(store.lastHitBreakpoint.kind, 'frame');
  assert.equal(store.lastHitBreakpoint.index, 1);
});
