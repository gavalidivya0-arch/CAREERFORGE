import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TravelOdysseyRaftCluster, NODE_STATES } from './raft-consensus.js';

describe('TravelOdysseyRaftCluster (Issue #4106)', () => {
  it('calculates strict majority quorum for 3-node and 5-node clusters even after failures', () => {
    const cluster3 = new TravelOdysseyRaftCluster({ nodeCount: 3 });
    assert.equal(cluster3.getQuorumSize(), 2);

    const cluster5 = new TravelOdysseyRaftCluster({ nodeCount: 5 });
    assert.equal(cluster5.getQuorumSize(), 3);

    // Failing 3 of 5 nodes leaves only 2 alive (< quorum 3); quorum must remain 3
    cluster5.handleNodeFailure('node-1');
    cluster5.handleNodeFailure('node-2');
    const failureInfo = cluster5.handleNodeFailure('node-3');
    assert.equal(failureInfo.aliveCount, 2);
    assert.equal(failureInfo.quorum, 3);
    assert.equal(failureInfo.hasQuorumAvailable, false);
    assert.equal(cluster5.getQuorumSize(), 3);

    const failedElection = cluster5.startElection('node-4');
    assert.equal(failedElection.won, false);
    assert.equal(cluster5.getLeader(), null);
  });

  it('increments terms and elects a single Leader via RequestVote RPCs', () => {
    const cluster = new TravelOdysseyRaftCluster({ nodeCount: 5 });
    assert.equal(cluster.getCurrentTerm(), 0);
    assert.equal(cluster.getLeader(), null);

    const election1 = cluster.startElection('node-1');
    assert.equal(election1.started, true);
    assert.equal(election1.won, true);
    assert.equal(election1.term, 1);
    assert.equal(election1.votes, 5);

    const leader1 = cluster.getLeader();
    assert.ok(leader1);
    assert.equal(leader1.id, 'node-1');
    assert.equal(leader1.state, NODE_STATES.LEADER);
    assert.equal(cluster.getCurrentTerm(), 1);

    // All other nodes must be Followers in term 1
    for (const node of cluster.getNodes()) {
      assert.equal(node.currentTerm, 1);
      if (node.id !== 'node-1') {
        assert.equal(node.state, NODE_STATES.FOLLOWER);
      }
    }

    // Starting a new election increments term to 2
    const election2 = cluster.startElection('node-3');
    assert.equal(election2.won, true);
    assert.equal(election2.term, 2);
    assert.equal(cluster.getLeader().id, 'node-3');
    assert.equal(cluster.getNode('node-1').state, NODE_STATES.FOLLOWER);
  });

  it('handles split votes cleanly and resolves on subsequent term election', () => {
    const cluster = new TravelOdysseyRaftCluster({ nodeCount: 5 });

    // Three concurrent candidates in a 5-node cluster split votes (max 2 < quorum 3)
    const split = cluster.startConcurrentElections(['node-1', 'node-2', 'node-3']);
    assert.equal(split.splitVote, true);
    assert.equal(split.leaderId, null);
    assert.equal(split.term, 1);
    assert.equal(cluster.getLeader(), null);

    // Next-term election resolves the split vote with a strict majority
    const resolved = cluster.startElection('node-2');
    assert.equal(resolved.won, true);
    assert.equal(resolved.term, 2);
    assert.equal(cluster.getLeader().id, 'node-2');
  });

  it('replicates and commits logs only when majority quorum is reachable', () => {
    const cluster = new TravelOdysseyRaftCluster({ nodeCount: 5 });
    cluster.startElection('node-1');

    const commitRes = cluster.replicateLog('BOOK_FLIGHT_TYO');
    assert.equal(commitRes.success, true);
    assert.equal(commitRes.committed, true);
    assert.equal(commitRes.commitIndex, 1);
    assert.equal(commitRes.ackCount, 5);

    for (const node of cluster.getNodes()) {
      assert.equal(node.log.length, 1);
      assert.equal(node.log[0].command, 'BOOK_FLIGHT_TYO');
      assert.equal(node.log[0].committed, true);
      assert.equal(node.commitIndex, 1);
    }

    // Partition leader node-1 into minority [node-1, node-2] vs majority [node-3, node-4, node-5]
    cluster.partitionNetwork([['node-1', 'node-2'], ['node-3', 'node-4', 'node-5']]);
    const minorityWrite = cluster.replicateLog('UNCOMMITTED_MINORITY_OP');
    assert.equal(minorityWrite.success, true);
    assert.equal(minorityWrite.committed, false);
    assert.equal(minorityWrite.ackCount, 2);
    assert.equal(minorityWrite.quorum, 3);
    assert.equal(cluster.getNode('node-1').commitIndex, 1);

    // Majority side elects a new leader in term 2 and commits new entry
    const majorityElection = cluster.startElection('node-3');
    assert.equal(majorityElection.won, true);
    assert.equal(majorityElection.term, 2);

    const majorityWrite = cluster.replicateLog('RESERVE_RYOKAN_KYOTO');
    assert.equal(majorityWrite.committed, true);
    assert.equal(majorityWrite.entry.index, 2);

    // Heal partition and send heartbeats: stale leader node-1 steps down to higher term
    cluster.healPartition();
    cluster.sendHeartbeats('node-3');
    assert.equal(cluster.getNode('node-1').state, NODE_STATES.FOLLOWER);
    assert.equal(cluster.getNode('node-1').currentTerm, 2);
  });

  it('replaces leader automatically via randomized election timeout when leader drops', () => {
    // Deterministic RNG gives distinct timeouts so one survivor times out first without tying
    const seq = [0.8, 0.1, 0.5, 0.9, 0.3];
    let idx = 0;
    const cluster = new TravelOdysseyRaftCluster({
      nodeCount: 5,
      electionTimeoutMin: 100,
      electionTimeoutMax: 250,
      heartbeatInterval: 40,
      rng: () => {
        const val = seq[idx % seq.length];
        idx += 1;
        return val;
      }
    });

    cluster.startElection('node-1');
    assert.equal(cluster.getLeader().id, 'node-1');

    // Kill active leader
    const dropResult = cluster.handleNodeFailure('node-1');
    assert.equal(dropResult.wasLeader, true);
    assert.equal(dropResult.hasQuorumAvailable, true);
    assert.equal(cluster.getLeader(), null);
    assert.equal(cluster.getNode('node-1').state, NODE_STATES.DEAD);

    // Dead node cannot start or win election
    const deadAttempt = cluster.startElection('node-1');
    assert.equal(deadAttempt.started, false);
    assert.equal(deadAttempt.won, false);

    // Advance simulation clock until a surviving follower times out and wins term 2
    for (let step = 0; step < 20 && !cluster.getLeader(); step += 1) {
      cluster.tick(25);
    }

    const replacement = cluster.getLeader();
    assert.ok(replacement, 'Expected a surviving node to replace the failed leader');
    assert.notEqual(replacement.id, 'node-1');
    assert.equal(replacement.state, NODE_STATES.LEADER);
    assert.ok(replacement.currentTerm >= 2);
  });

  it('resets follower timers on sendHeartbeats and catches up recovered nodes', () => {
    const cluster = new TravelOdysseyRaftCluster({
      nodeCount: 3,
      electionTimeoutMin: 200,
      electionTimeoutMax: 300,
      heartbeatInterval: 50
    });

    cluster.startElection('node-1');
    cluster.handleNodeFailure('node-3');

    const rep = cluster.replicateLog('DISPATCH_ICELAND_GEAR');
    assert.equal(rep.committed, true);
    assert.equal(cluster.getNode('node-3').log.length, 0);

    // Advance follower elapsed timer, then verify heartbeat resets it
    cluster.tick(30);
    assert.equal(cluster.getNode('node-2').elapsedSinceHeartbeat, 30);
    cluster.sendHeartbeats();
    assert.equal(cluster.getNode('node-2').elapsedSinceHeartbeat, 0);

    // Recover node-3 and send heartbeat to replicate missed committed log
    cluster.recoverNode('node-3');
    cluster.sendHeartbeats();
    const recovered = cluster.getNode('node-3');
    assert.equal(recovered.alive, true);
    assert.equal(recovered.log.length, 1);
    assert.equal(recovered.log[0].command, 'DISPATCH_ICELAND_GEAR');
    assert.equal(recovered.log[0].committed, true);
  });
});
