import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CybersecuritySentinelTimeTravelStore, computeStateDiff } from './snapshot-time-travel.js';

describe('CybersecuritySentinelTimeTravelStore (Issue #4135)', () => {
  it('enforces deep immutability of stored snapshots against input and output mutations', () => {
    const initial = {
      threatLevel: 'NOMINAL',
      blockedIps: ['192.0.2.10'],
      firewall: { mode: 'ENFORCE', rules: [{ id: 1, action: 'DROP' }] }
    };

    const store = new CybersecuritySentinelTimeTravelStore(initial, { initialLabel: 'Init' });

    // 1. Mutating original input object after commit must not affect stored snapshot
    initial.threatLevel = 'COMPROMISED';
    initial.blockedIps.push('198.51.100.250');
    initial.firewall.rules[0].action = 'ALLOW';

    const snap = store.getCurrentSnapshot();
    assert.equal(snap.state.threatLevel, 'NOMINAL');
    assert.deepEqual(snap.state.blockedIps, ['192.0.2.10']);
    assert.equal(snap.state.firewall.rules[0].action, 'DROP');

    // 2. Internal stored snapshots and nested properties are deeply frozen
    assert.equal(Object.isFrozen(store.history[0]), true);
    assert.equal(Object.isFrozen(store.history[0].state), true);
    assert.equal(Object.isFrozen(store.history[0].state.blockedIps), true);
    assert.equal(Object.isFrozen(store.history[0].state.firewall.rules[0]), true);
    assert.throws(() => {
      store.history[0].state.threatLevel = 'MUTATED';
    }, TypeError);

    // 3. Mutating returned snapshot copy must not leak back into store
    snap.state.firewall.mode = 'DISABLED';
    snap.state.blockedIps.push('203.0.113.5');
    assert.equal(store.getCurrentState().firewall.mode, 'ENFORCE');
    assert.deepEqual(store.getCurrentState().blockedIps, ['192.0.2.10']);
  });

  it('rejects non-serializable or circular state snapshots', () => {
    const store = new CybersecuritySentinelTimeTravelStore();
    const circular = { name: 'loop' };
    circular.self = circular;

    assert.throws(() => store.commitSnapshot(circular, 'Circular'), TypeError);
    assert.throws(() => store.commitSnapshot({ fn: () => {} }, 'Fn'), TypeError);
    assert.throws(() => store.commitSnapshot(undefined, 'Undef'), TypeError);
  });

  it('supports bidirectional undo/redo, stepTo index jumping, clamping, and branch truncation', () => {
    const store = new CybersecuritySentinelTimeTravelStore();

    assert.equal(store.stepTo(0), null);
    assert.equal(store.undo(), null);
    assert.equal(store.redo(), null);

    store.commitSnapshot({ step: 0, threatLevel: 'NOMINAL' }, 'Frame 0');
    store.commitSnapshot({ step: 1, threatLevel: 'ELEVATED' }, 'Frame 1');
    store.commitSnapshot({ step: 2, threatLevel: 'CRITICAL' }, 'Frame 2');
    store.commitSnapshot({ step: 3, threatLevel: 'GUARDED' }, 'Frame 3');

    assert.equal(store.currentIndex, 3);
    assert.equal(store.getLength(), 4);

    // Undo / Redo traversal
    const u1 = store.undo();
    assert.equal(u1.state.step, 2);
    assert.equal(store.currentIndex, 2);

    const u2 = store.undo();
    assert.equal(u2.state.step, 1);
    assert.equal(store.currentIndex, 1);

    const r1 = store.redo();
    assert.equal(r1.state.step, 2);
    assert.equal(store.currentIndex, 2);

    // Index jumping and clamping
    assert.equal(store.stepTo(0).state.step, 0);
    assert.equal(store.undo(), null);
    assert.equal(store.currentIndex, 0);

    assert.equal(store.stepTo(999).state.step, 3);
    assert.equal(store.redo(), null);
    assert.equal(store.currentIndex, 3);

    assert.equal(store.stepTo(-10).state.step, 0);
    assert.throws(() => store.stepTo('invalid-index'), TypeError);

    // Committing after stepping back truncates future history
    store.stepTo(1);
    store.addBreakpoint(3);
    store.commitSnapshot({ step: 99, threatLevel: 'BRANCHED' }, 'Branch Frame');

    assert.equal(store.getLength(), 3);
    assert.equal(store.currentIndex, 2);
    assert.equal(store.getCurrentState().step, 99);
    assert.deepEqual(store.getBreakpoints(), []);
  });

  it('computes recursive added, removed, and modified property diffs', () => {
    const prev = {
      threatLevel: 'ELEVATED',
      staleFlag: true,
      firewall: { mode: 'ENFORCE', rulesCount: 10 },
      blockedIps: ['192.0.2.1']
    };
    const next = {
      threatLevel: 'CRITICAL',
      quarantineActive: true,
      firewall: { mode: 'LOCKDOWN', rulesCount: 10 },
      blockedIps: ['192.0.2.1', '198.51.100.9']
    };

    const diff = computeStateDiff(prev, next);
    assert.equal(diff.added, 2); // quarantineActive, blockedIps[1]
    assert.equal(diff.removed, 1); // staleFlag
    assert.equal(diff.modified, 2); // threatLevel, firewall.mode
    assert.equal(diff.total, 5);

    const addedProp = diff.changes.find((c) => c.path === 'quarantineActive');
    assert.equal(addedProp.kind, 'added');
    assert.equal(addedProp.newValue, true);

    const removedProp = diff.changes.find((c) => c.path === 'staleFlag');
    assert.equal(removedProp.kind, 'removed');
    assert.equal(removedProp.oldValue, true);

    const modifiedNested = diff.changes.find((c) => c.path === 'firewall.mode');
    assert.equal(modifiedNested.kind, 'modified');
    assert.equal(modifiedNested.oldValue, 'ENFORCE');
    assert.equal(modifiedNested.newValue, 'LOCKDOWN');
  });

  it('evaluates frame breakpoints and watch expression breakpoints', () => {
    const store = new CybersecuritySentinelTimeTravelStore(
      { threatLevel: 'NOMINAL', firewall: { mode: 'ENFORCE' } },
      { initialLabel: 'Init' }
    );
    store.commitSnapshot({ threatLevel: 'CRITICAL', firewall: { mode: 'LOCKDOWN' } }, 'Breach');

    store.addBreakpoint(0);
    store.addWatchRule('threatLevel', 'CRITICAL');

    const bp0 = store.evaluateBreakpoint(0);
    assert.equal(bp0.hit, true);
    assert.ok(bp0.reasons.some((r) => r.includes('Frame #0 breakpoint')));

    const bp1 = store.evaluateBreakpoint(1);
    assert.equal(bp1.hit, true);
    assert.ok(bp1.reasons.some((r) => r.includes('threatLevel === "CRITICAL"')));

    assert.equal(store.toggleBreakpoint(0), false);
    assert.equal(store.evaluateBreakpoint(0).hit, false);
  });

  it('preserves full JSON export/import parity including cursor, breakpoints, watch rules, and immutability', () => {
    const source = new CybersecuritySentinelTimeTravelStore(
      { threatLevel: 'NOMINAL', alerts: 0 },
      { initialLabel: 'Baseline' }
    );
    source.commitSnapshot({ threatLevel: 'ELEVATED', alerts: 3 }, 'Probe Detected');
    source.commitSnapshot({ threatLevel: 'CRITICAL', alerts: 7 }, 'Active Containment');
    source.stepTo(1);
    source.addBreakpoint(2);
    source.addWatchRule('threatLevel', 'CRITICAL');

    const exportedJson = source.exportHistory();
    assert.equal(typeof exportedJson, 'string');

    const target = new CybersecuritySentinelTimeTravelStore();
    const summary = target.importHistory(exportedJson);

    assert.equal(summary.count, 3);
    assert.equal(summary.currentIndex, 1);
    assert.equal(target.currentIndex, 1);
    assert.deepEqual(target.getHistory(), source.getHistory());
    assert.deepEqual(target.getCurrentState(), { threatLevel: 'ELEVATED', alerts: 3 });
    assert.deepEqual(target.getBreakpoints(), [2]);
    assert.deepEqual(target.getWatchRules(), [{ path: 'threatLevel', expectedValue: 'CRITICAL' }]);

    // Imported snapshots must also remain deeply frozen
    assert.equal(Object.isFrozen(target.history[2].state), true);
    assert.throws(() => {
      target.history[2].state.alerts = 999;
    }, TypeError);

    // Reject malformed payloads
    assert.throws(() => target.importHistory('{"invalid":true}'), /snapshots/);
  });
});
