import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuantumForgeRaftCluster, NODE_STATES } from './raft-consensus.js';

describe('QuantumForgeRaftCluster', () => {
  it('calculates strict majority quorum for 3-node and 5-node clusters', () => {
    const cluster3 = new QuantumForgeRaftCluster({ nodeCount: 3 });
    assert.equal(cluster3.getQuorumSize(), 2);

    const cluster5 = new QuantumForgeRaftCluster({ nodeCount: 5 });
    assert.equal(cluster5.getQuorumSize(), 3);

    // Kill 3 of 5 nodes so only 2 remain alive (< quorum 3) -> election cannot succeed
    cluster5.handleNodeFailure('node-3');
    cluster5.handleNodeFailure('node-4');
    cluster5.handleNodeFailure('node-5');

    const res = cluster5.startElection('node-1');
    assert.equal(res.elected, false);
    assert.equal(res.votes, 2);
    assert.equal(res.quorum, 3);
    assert.equal(cluster5.getLeader(), null);
  });

  it('increments terms on each election and steps down stale leaders on higher term', () => {
    const cluster = new QuantumForgeRaftCluster({ nodeCount: 5 });
    assert.equal(cluster.getCurrentTerm(), 0);

    const election1 = cluster.startElection('node-1');
    assert.equal(election1.elected, true);
    assert.equal(election1.term, 1);
    assert.equal(cluster.getCurrentTerm(), 1);
    assert.equal(cluster.getLeader().id, 'node-1');

    // Isolate node-1 into minority partition; majority elects node-3 in term 2
    cluster.setPartition(true, ['node-1', 'node-2']);
    const election2 = cluster.startElection('node-3');
    assert.equal(election2.elected, true);
    assert.equal(election2.term, 2);
    assert.equal(cluster.getNode('node-3').state, NODE_STATES.LEADER);

    // Heal partition and send heartbeats -> node-1 sees higher term 2 and steps down
    cluster.setPartition(false);
    cluster.sendHeartbeats();
    assert.equal(cluster.getNode('node-1').state, NODE_STATES.FOLLOWER);
    assert.equal(cluster.getNode('node-1').currentTerm, 2);
    assert.equal(cluster.getLeader().id, 'node-3');
  });

  it('handles split votes without electing a leader and resolves in the next term', () => {
    const cluster = new QuantumForgeRaftCluster({ nodeCount: 5 });

    // 3 simultaneous candidates in term 1 split the 5 votes (2, 2, 1) -> no quorum of 3
    const split = cluster.triggerSimultaneousElections(['node-1', 'node-2', 'node-3']);
    assert.equal(split.elected, false);
    assert.equal(split.splitVote, true);
    assert.equal(split.leaderId, null);
    assert.equal(cluster.getLeader(), null);
    assert.equal(cluster.getCurrentTerm(), 1);

    // Next randomized timeout triggers single candidate in term 2 -> wins majority
    const resolved = cluster.startElection('node-2');
    assert.equal(resolved.elected, true);
    assert.equal(resolved.term, 2);
    assert.equal(resolved.votes >= 3, true);
    assert.equal(cluster.getLeader().id, 'node-2');
  });

  it('elects a replacement leader when the current leader fails', () => {
    const cluster = new QuantumForgeRaftCluster({ nodeCount: 5 });

    const first = cluster.startElection('node-1');
    assert.equal(first.elected, true);
    assert.equal(cluster.getLeader().id, 'node-1');

    const failure = cluster.handleNodeFailure('node-1');
    assert.equal(failure.wasLeader, true);
    assert.equal(failure.alive, false);
    assert.equal(cluster.getLeader(), null);

    // Surviving follower starts election in term 2 and replaces the dropped leader
    const replacement = cluster.startElection('node-4');
    assert.equal(replacement.elected, true);
    assert.equal(replacement.term, 2);
    assert.equal(replacement.leaderId, 'node-4');
    assert.equal(cluster.getLeader().id, 'node-4');
  });

  it('replicates and commits logs only when a majority quorum acknowledges', () => {
    const cluster = new QuantumForgeRaftCluster({ nodeCount: 5 });
    cluster.startElection('node-1');

    const rep1 = cluster.replicateLog('SET x=42');
    assert.equal(rep1.success, true);
    assert.equal(rep1.committed, true);
    assert.equal(rep1.commitIndex, 1);
    assert.equal(rep1.replicatedCount, 5);

    for (const node of cluster.nodes) {
      assert.equal(node.commitIndex, 1);
      assert.equal(node.log.length, 1);
      assert.equal(node.log[0].command, 'SET x=42');
      assert.equal(node.log[0].committed, true);
    }

    // Partition leader node-1 into minority ['node-1', 'node-2'] -> cannot commit new entry
    cluster.setPartition(true, ['node-1', 'node-2']);
    const repMinority = cluster.replicateLog('SET y=99');
    assert.equal(repMinority.success, true);
    assert.equal(repMinority.committed, false);
    assert.equal(repMinority.replicatedCount, 2);
    assert.equal(cluster.getNode('node-1').commitIndex, 1);

    // Heal partition and send heartbeats -> entry replicates to majority and commits
    cluster.setPartition(false);
    cluster.sendHeartbeats();
    assert.equal(cluster.getNode('node-1').commitIndex, 2);
    assert.equal(cluster.getNode('node-5').commitIndex, 2);
    assert.equal(cluster.getNode('node-5').log[1].command, 'SET y=99');
  });

  it('triggers randomized election timeouts via tick() when leader stops sending heartbeats', () => {
    const cluster = new QuantumForgeRaftCluster({
      nodeCount: 3,
      minElectionTimeout: 100,
      maxElectionTimeout: 150,
      randomFn: () => 0.5
    });

    // Advance past 125ms deterministic timeout -> triggers election and elects a leader
    const tickRes = cluster.tick(130);
    assert.ok(tickRes.electionsTriggered.length >= 1);
    assert.ok(cluster.getLeader() !== null);
    assert.ok(cluster.getCurrentTerm() >= 1);
  });

  it('reconciles conflicting uncommitted logs and catches up recovered nodes', () => {
    const cluster = new QuantumForgeRaftCluster({ nodeCount: 5 });
    cluster.startElection('node-1');

    // Isolate node-1 in minority and append an uncommitted term-1 command
    cluster.setPartition(true, ['node-1']);
    const uncommitted = cluster.replicateLog('OLD_TERM_CMD');
    assert.equal(uncommitted.committed, false);

    // Majority (node-2, node-3, node-4) elects node-3 in term 2 and commits while node-5 is down
    cluster.handleNodeFailure('node-5');
    const newElection = cluster.startElection('node-3');
    assert.equal(newElection.elected, true);
    const committed = cluster.replicateLog('NEW_TERM_CMD');
    assert.equal(committed.committed, true);

    // Heal partition and recover node-5 -> all logs reconcile to the committed term-2 entry
    cluster.setPartition(false);
    cluster.recoverNode('node-5');
    cluster.sendHeartbeats();

    assert.equal(cluster.getNode('node-1').state, NODE_STATES.FOLLOWER);
    assert.equal(cluster.getNode('node-1').log.length, 1);
    assert.equal(cluster.getNode('node-1').log[0].command, 'NEW_TERM_CMD');
    assert.equal(cluster.getNode('node-5').log.length, 1);
    assert.equal(cluster.getNode('node-5').commitIndex, 1);
  });
});
