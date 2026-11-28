import test from 'node:test';
import assert from 'node:assert/strict';
import { TravelOdysseyTimeTravelStore } from './snapshot-time-travel.js';

test('TravelOdysseyTimeTravelStore - enforces immutability of stored snapshots', () => {
  const store = new TravelOdysseyTimeTravelStore();
  const sourceState = {
    expeditionId: 'ODYSSEY-ICE-01',
    destination: 'Iceland',
    budgetRemainingUSD: 4200,
    gear: ['Merino Base Layer', 'InReach Satellite']
  };

  const committed = store.commitSnapshot(sourceState, 'Basecamp Check');

  // Mutating original source object & nested array must not affect stored snapshot
  sourceState.destination = 'Mutated Location';
  sourceState.budgetRemainingUSD = 0;
  sourceState.gear.push('Unauthorized Item');

  // Mutating returned snapshot copy must not affect stored snapshot
  committed.state.budgetRemainingUSD = 99999;
  committed.state.gear.push('External Mutation');

  const current = store.getCurrentSnapshot();
  assert.equal(current.state.destination, 'Iceland');
  assert.equal(current.state.budgetRemainingUSD, 4200);
  assert.deepEqual(current.state.gear, ['Merino Base Layer', 'InReach Satellite']);

  // Direct mutation attempt on internal history entry must fail / throw in strict mode
  assert.throws(() => {
    store.history[0].state.budgetRemainingUSD = 1;
  }, TypeError);

  // Mutating getCurrentSnapshot() output must also not affect subsequent reads
  current.state.destination = 'Tampered';
  assert.equal(store.getCurrentSnapshot().state.destination, 'Iceland');
});

test('TravelOdysseyTimeTravelStore - supports stepTo index jumping, undo, redo, and branch truncation', () => {
  const store = new TravelOdysseyTimeTravelStore({ phase: 'INIT', waypoint: 0 });
  store.commitSnapshot({ phase: 'GEAR_LOCKED', waypoint: 1 }, 'Gear Locked');
  store.commitSnapshot({ phase: 'TRANSIT', waypoint: 2 }, 'Shinkansen Departure');
  store.commitSnapshot({ phase: 'ARRIVED', waypoint: 3 }, 'Kyoto Arrival');

  assert.equal(store.history.length, 4);
  assert.equal(store.currentIndex, 3);

  // Undo moves backward one step at a time
  const backOne = store.undo();
  assert.equal(store.currentIndex, 2);
  assert.equal(backOne.state.phase, 'TRANSIT');

  const backTwo = store.undo();
  assert.equal(store.currentIndex, 1);
  assert.equal(backTwo.state.phase, 'GEAR_LOCKED');

  // Redo advances forward one step
  const forwardOne = store.redo();
  assert.equal(store.currentIndex, 2);
  assert.equal(forwardOne.state.phase, 'TRANSIT');

  // stepTo jumps directly and clamps out-of-range indices
  store.stepTo(0);
  assert.equal(store.currentIndex, 0);
  assert.equal(store.getCurrentSnapshot().state.phase, 'INIT');

  store.undo(); // Clamped at 0
  assert.equal(store.currentIndex, 0);

  store.stepTo(999); // Clamped at 3
  assert.equal(store.currentIndex, 3);
  assert.equal(store.getCurrentSnapshot().state.phase, 'ARRIVED');

  store.stepTo(-10); // Clamped at 0
  assert.equal(store.currentIndex, 0);

  // Committing after scrubbing backward truncates forward branch
  store.stepTo(1);
  store.commitSnapshot({ phase: 'REROUTED', waypoint: 5 }, 'Patagonia Reroute');
  assert.equal(store.history.length, 3);
  assert.equal(store.currentIndex, 2);
  assert.equal(store.getCurrentSnapshot().state.phase, 'REROUTED');
});

test('TravelOdysseyTimeTravelStore - maintains JSON export and import parity', () => {
  const storeA = new TravelOdysseyTimeTravelStore({ city: 'Tokyo', budgetUSD: 3500 });
  storeA.commitSnapshot({ city: 'Hakone', budgetUSD: 3100 }, 'Mountain Ryokan');
  storeA.commitSnapshot({ city: 'Kyoto', budgetUSD: 2650 }, 'Fushimi Inari');
  storeA.toggleBreakpoint(1);
  storeA.stepTo(1);

  const exportedJson = storeA.exportHistory();
  assert.equal(typeof exportedJson, 'string');

  const storeB = new TravelOdysseyTimeTravelStore();
  const imported = storeB.importHistory(exportedJson);

  assert.equal(imported, true);
  assert.equal(storeB.history.length, 3);
  assert.equal(storeB.currentIndex, 1);
  assert.deepEqual(storeB.getBreakpoints(), [1]);

  const snapB = storeB.getCurrentSnapshot();
  assert.equal(snapB.label, 'Mountain Ryokan');
  assert.equal(snapB.state.city, 'Hakone');
  assert.equal(snapB.state.budgetUSD, 3100);

  // Invalid payloads are rejected cleanly
  assert.equal(storeB.importHistory('not-valid-json'), false);
  assert.equal(storeB.importHistory(JSON.stringify({ nope: true })), false);
});

test('TravelOdysseyTimeTravelStore - computes accurate property diffs and breakpoint playback', async () => {
  const store = new TravelOdysseyTimeTravelStore({
    city: 'Reykjavik',
    budgetUSD: 5000,
    satelliteOnline: true
  });

  store.commitSnapshot({
    city: 'Vik',
    budgetUSD: 4400,
    weatherAlert: 'Gale'
  }, 'South Coast');

  const diffs = store.getDiffAgainstPrevious();
  assert.equal(diffs.length, 4);

  const cityDiff = diffs.find((d) => d.key === 'city');
  assert.equal(cityDiff.type, 'modified');
  assert.equal(cityDiff.oldVal, 'Reykjavik');
  assert.equal(cityDiff.newVal, 'Vik');

  const removedDiff = diffs.find((d) => d.key === 'satelliteOnline');
  assert.equal(removedDiff.type, 'removed');
  assert.equal(removedDiff.oldVal, true);

  const addedDiff = diffs.find((d) => d.key === 'weatherAlert');
  assert.equal(addedDiff.type, 'added');
  assert.equal(addedDiff.newVal, 'Gale');

  // Verify reverse playback pauses on breakpoint
  store.commitSnapshot({ city: 'Hofn', budgetUSD: 3900 }, 'Glacier Lagoon');
  store.toggleBreakpoint(1);

  await new Promise((resolve) => {
    store.startReplay(50, (_snap, meta) => {
      if (meta.hitBreakpoint || meta.reason === 'completed') {
        resolve();
      }
    }, 'backward');
  });

  assert.equal(store.isPlaying, false);
  assert.equal(store.currentIndex, 1);
});
