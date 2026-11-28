import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PodcastAudioStreamTimeTravelStore } from './snapshot-time-travel.js';

describe('PodcastAudioStreamTimeTravelStore (Issue #4115)', () => {
  it('enforces strict immutability on stored snapshots and returned copies', () => {
    const store = new PodcastAudioStreamTimeTravelStore();
    const mutableState = {
      episodeId: 'ep-142',
      isPlaying: true,
      playbackSpeed: 1.25,
      chapter: { index: 1, title: 'Intro' },
      bookmarks: [{ timeSec: 45, note: 'Key insight' }]
    };

    const committed = store.commitSnapshot(mutableState, 'Start Stream');

    // Mutate original source object after commit
    mutableState.isPlaying = false;
    mutableState.playbackSpeed = 3;
    mutableState.chapter.title = 'Tampered';
    mutableState.bookmarks.push({ timeSec: 999, note: 'Injected' });

    // Mutate returned snapshot object from commitSnapshot & getters
    committed.state.playbackSpeed = 0.5;
    const readSnapshot = store.getCurrentSnapshot();
    readSnapshot.state.chapter.title = 'Mutated Copy';
    readSnapshot.state.bookmarks.pop();

    const verified = store.getCurrentSnapshot();
    assert.equal(verified.label, 'Start Stream');
    assert.equal(verified.state.isPlaying, true);
    assert.equal(verified.state.playbackSpeed, 1.25);
    assert.equal(verified.state.chapter.title, 'Intro');
    assert.deepEqual(verified.state.bookmarks, [{ timeSec: 45, note: 'Key insight' }]);

    // Internal stored snapshot graph is deeply frozen
    assert.ok(Object.isFrozen(store.history[0]));
    assert.ok(Object.isFrozen(store.history[0].state));
    assert.throws(() => {
      store.history[0].state.playbackSpeed = 2.0;
    }, TypeError);
  });

  it('rejects non-serializable or invalid snapshot states', () => {
    const store = new PodcastAudioStreamTimeTravelStore();
    assert.throws(() => store.commitSnapshot(null, 'Bad Null'), TypeError);
    assert.throws(() => store.commitSnapshot(undefined, 'Bad Undefined'), TypeError);

    const circular = { name: 'loop' };
    circular.self = circular;
    assert.throws(() => store.commitSnapshot(circular, 'Circular'), TypeError);
  });

  it('jumps cleanly with stepTo, undo, redo, and truncates diverged future branches', () => {
    const store = new PodcastAudioStreamTimeTravelStore();

    assert.equal(store.stepTo(0), null);
    assert.equal(store.undo(), null);
    assert.equal(store.redo(), null);

    store.commitSnapshot({ step: 0, speed: 1 }, 'Frame 0');
    store.commitSnapshot({ step: 1, speed: 1.25 }, 'Frame 1');
    store.commitSnapshot({ step: 2, speed: 1.5 }, 'Frame 2');
    store.commitSnapshot({ step: 3, speed: 2 }, 'Frame 3');

    assert.equal(store.currentIndex, 3);

    // Undo steps backward
    const u1 = store.undo();
    assert.equal(store.currentIndex, 2);
    assert.equal(u1.state.step, 2);

    const u2 = store.undo();
    assert.equal(store.currentIndex, 1);
    assert.equal(u2.state.step, 1);

    // Redo steps forward
    const r1 = store.redo();
    assert.equal(store.currentIndex, 2);
    assert.equal(r1.state.step, 2);

    // stepTo jumps and clamps at boundaries
    const jumped = store.stepTo(0);
    assert.equal(store.currentIndex, 0);
    assert.equal(jumped.state.step, 0);

    store.undo(); // Should clamp at 0
    assert.equal(store.currentIndex, 0);

    store.stepTo(999);
    assert.equal(store.currentIndex, 3);
    store.redo(); // Should clamp at 3
    assert.equal(store.currentIndex, 3);

    store.stepTo(-10);
    assert.equal(store.currentIndex, 0);

    // Committing at index 1 discards frames 2 and 3
    store.stepTo(1);
    store.commitSnapshot({ step: 10, speed: 1.75 }, 'Branched Frame');
    assert.equal(store.history.length, 3);
    assert.equal(store.currentIndex, 2);
    assert.equal(store.getCurrentState().step, 10);
  });

  it('supports bidirectional scrub playback and breakpoint pausing', () => {
    const store = new PodcastAudioStreamTimeTravelStore();
    store.commitSnapshot({ pos: 0 }, 'S0');
    store.commitSnapshot({ pos: 1 }, 'S1');
    store.commitSnapshot({ pos: 2 }, 'S2');
    store.commitSnapshot({ pos: 3 }, 'S3');

    store.toggleBreakpoint(1);
    assert.equal(store.hasBreakpoint(1), true);
    assert.deepEqual(store.getBreakpoints(), [1]);

    // Backward scrub from index 3 stops upon hitting breakpoint at index 1
    store.setDirection('backward');
    const step1 = store.stepPlaybackOnce();
    assert.equal(step1.moved, true);
    assert.equal(step1.hitBreakpoint, false);
    assert.equal(store.currentIndex, 2);

    const step2 = store.stepPlaybackOnce();
    assert.equal(step2.moved, true);
    assert.equal(step2.hitBreakpoint, true);
    assert.equal(store.currentIndex, 1);
    assert.equal(store.isPlaying, false);

    // Forward scrub from index 1 to 3 hits boundary and pauses
    store.setDirection('forward');
    const fwd1 = store.stepPlaybackOnce();
    assert.equal(fwd1.moved, true);
    assert.equal(store.currentIndex, 2);
    const fwd2 = store.stepPlaybackOnce();
    assert.equal(fwd2.moved, true);
    assert.equal(fwd2.reachedBoundary, true);
    assert.equal(store.currentIndex, 3);
  });

  it('computes accurate nested and top-level property diffs', () => {
    const store = new PodcastAudioStreamTimeTravelStore();
    const prev = {
      isPlaying: false,
      volume: 100,
      legacyFlag: true,
      eq: { bass: 0, treble: 0 }
    };
    const next = {
      isPlaying: true,
      volume: 100,
      eqPreset: 'Vocal Boost',
      eq: { bass: 3, treble: 0 }
    };

    const diffs = store.computeDiff(prev, next);
    assert.equal(diffs.length, 4);

    assert.deepEqual(
      diffs.find((d) => d.key === 'isPlaying'),
      { key: 'isPlaying', path: 'isPlaying', type: 'modified', oldVal: false, newVal: true }
    );
    assert.deepEqual(
      diffs.find((d) => d.key === 'legacyFlag'),
      { key: 'legacyFlag', path: 'legacyFlag', type: 'removed', oldVal: true, newVal: undefined }
    );
    assert.deepEqual(
      diffs.find((d) => d.key === 'eqPreset'),
      { key: 'eqPreset', path: 'eqPreset', type: 'added', oldVal: undefined, newVal: 'Vocal Boost' }
    );
    assert.deepEqual(
      diffs.find((d) => d.key === 'eq.bass'),
      { key: 'eq.bass', path: 'eq.bass', type: 'modified', oldVal: 0, newVal: 3 }
    );
  });

  it('maintains lossless JSON export and import parity', () => {
    const storeA = new PodcastAudioStreamTimeTravelStore();
    storeA.commitSnapshot({ episode: 'ep-141', currentTimeSec: 0, muted: false }, 'Init');
    storeA.commitSnapshot({ episode: 'ep-141', currentTimeSec: 120, muted: false }, 'Seek 2m');
    storeA.commitSnapshot({ episode: 'ep-141', currentTimeSec: 240, muted: true }, 'Mute');
    storeA.toggleBreakpoint(1);
    storeA.setDirection('backward');
    storeA.stepTo(1);

    const exportedJson = storeA.exportHistory();
    assert.equal(typeof exportedJson, 'string');

    const storeB = new PodcastAudioStreamTimeTravelStore();
    const ok = storeB.importHistory(exportedJson);

    assert.equal(ok, true);
    assert.equal(storeB.history.length, 3);
    assert.equal(storeB.currentIndex, 1);
    assert.equal(storeB.direction, 'backward');
    assert.deepEqual(storeB.getBreakpoints(), [1]);
    assert.deepEqual(storeB.getHistory(), storeA.getHistory());
    assert.deepEqual(storeB.getCurrentState(), {
      episode: 'ep-141',
      currentTimeSec: 120,
      muted: false
    });

    assert.throws(() => storeB.importHistory('{"invalid":true}'), /missing "history" array/);
  });
});
