import test from 'node:test';
import assert from 'node:assert/strict';
import { GamingEsportsHubRaftCluster, NODE_STATES } from './raft-consensus.js';

test('GamingEsportsHubRaftCluster - calculates majority quorum accurately for 3-node and 5-node clusters', () => {
  const cluster3 = new GamingEsportsHubRaftCluster({ nodeCount: 3 });
  const cluster5 = new GamingEsportsHubRaftCluster({ nodeCount: 5 });

  assert.equal(cluster3.getQuorumSize(), 2);
  assert.equal(cluster5.getQuorumSize(), 3);

  // Quorum remains majority of configured cluster even when nodes fail.
  cluster5.handleNodeFailure('node-5');
  assert.equal(cluster5.getQuorumSize(), 3);
});

test('GamingEsportsHubRaftCluster - assigns randomized election timeouts within configured bounds', () => {
  let step = 0;
  const deterministicSamples = [0.1, 0.5, 0.9, 0.25, 0.75];
  const cluster = new GamingEsportsHubRaftCluster({
    nodeCount: 5,
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    rng: () => deterministicSamples[step++ % deterministicSamples.length]
  });

  const timeouts = cluster.nodes.map((n) => n.electionTimeoutMs);
  assert.deepEqual(timeouts, [165, 225, 285, 188, 263]);
  assert.equal(new Set(timeouts).size, 5);
});

test('GamingEsportsHubRaftCluster - increments term and elects leader with majority votes', () => {
  const cluster = new GamingEsportsHubRaftCluster({ nodeCount: 5 });
  assert.equal(cluster.getCurrentTerm(), 0);
  assert.equal(cluster.getLeader(), null);

  const result = cluster.startElection('node-1');
  assert.equal(result.elected, true);
  assert.equal(result.leaderId, 'node-1');
  assert.equal(result.term, 1);
  assert.equal(result.votes, 5);
  assert.equal(cluster.getCurrentTerm(), 1);
  assert.equal(cluster.getNode('node-1').state, NODE_STATES.LEADER);

  for (const id of ['node-2', 'node-3', 'node-4', 'node-5']) {
    const follower = cluster.getNode(id);
    assert.equal(follower.state, NODE_STATES.FOLLOWER);
    assert.equal(follower.currentTerm, 1);
  }
});

test('GamingEsportsHubRaftCluster - handles split votes without electing a leader and recovers on next term', () => {
  const cluster = new GamingEsportsHubRaftCluster({ nodeCount: 5 });

  // 3 concurrent candidates in a 5-node cluster yield 2, 2, 1 votes (< quorum 3) -> split vote.
  const split = cluster.startConcurrentElections(['node-1', 'node-2', 'node-3']);
  assert.equal(split.elected, false);
  assert.equal(split.reason, 'SPLIT_VOTE');
  assert.equal(split.term, 1);
  assert.equal(cluster.getLeader(), null);
  assert.equal(cluster.getNode('node-1').state, NODE_STATES.CANDIDATE);
  assert.equal(cluster.getNode('node-2').state, NODE_STATES.CANDIDATE);
  assert.equal(cluster.getNode('node-3').state, NODE_STATES.CANDIDATE);

  // Subsequent election increments term to 2 and resolves a single leader.
  const resolved = cluster.startElection('node-2');
  assert.equal(resolved.elected, true);
  assert.equal(resolved.leaderId, 'node-2');
  assert.equal(resolved.term, 2);
  assert.equal(cluster.getCurrentTerm(), 2);
});

test('GamingEsportsHubRaftCluster - replicates and commits log commands when quorum is reachable', () => {
  const cluster = new GamingEsportsHubRaftCluster({ nodeCount: 5 });
  cluster.startElection('node-1');

  const commitRes = cluster.replicateLog('LOCK_BRACKET_BO5');
  assert.equal(commitRes.success, true);
  assert.equal(commitRes.committed, true);
  assert.equal(commitRes.entry.index, 1);
  assert.equal(commitRes.entry.term, 1);
  assert.equal(commitRes.replicatedCount, 5);

  for (const node of cluster.nodes) {
    assert.equal(node.commitIndex, 1);
    assert.deepEqual(node.appliedCommands, ['LOCK_BRACKET_BO5']);
  }

  // Isolate leader + 1 follower into minority (2 < quorum 3); new log stays uncommitted.
  cluster.partitionNodes(['node-1', 'node-2']);
  const minorityRes = cluster.replicateLog('UNSAFE_PAYOUT');
  assert.equal(minorityRes.success, true);
  assert.equal(minorityRes.committed, false);
  assert.equal(minorityRes.reason, 'QUORUM_NOT_REACHED');
  assert.equal(cluster.getNode('node-1').commitIndex, 1);

  // Heal partition and send heartbeats -> entry commits across cluster.
  cluster.healPartition();
  assert.equal(cluster.getNode('node-1').commitIndex, 2);
  assert.equal(cluster.getNode('node-3').commitIndex, 2);
  assert.deepEqual(cluster.getNode('node-5').appliedCommands, ['LOCK_BRACKET_BO5', 'UNSAFE_PAYOUT']);
});

test('GamingEsportsHubRaftCluster - replaces dropped leader and increments term', () => {
  const cluster = new GamingEsportsHubRaftCluster({
    nodeCount: 5,
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatIntervalMs: 50
  });

  // Give node-2 the shortest election timeout deterministically for predictable replacement.
  cluster.startElection('node-1');
  cluster.replicateLog('SYNC_MATCH_SEEDING');
  assert.equal(cluster.getLeader().id, 'node-1');

  const failureInfo = cluster.handleNodeFailure('node-1');
  assert.equal(failureInfo.wasLeader, true);
  assert.equal(failureInfo.state, NODE_STATES.DEAD);
  assert.equal(cluster.getLeader(), null);

  cluster.getNode('node-2').electionTimeoutMs = 100;
  for (const id of ['node-3', 'node-4', 'node-5']) {
    cluster.getNode(id).electionTimeoutMs = 500;
  }

  // Advance ticks past node-2's timeout to trigger automatic leader replacement.
  cluster.tick(60);
  assert.equal(cluster.getLeader(), null);
  cluster.tick(60);

  const newLeader = cluster.getLeader();
  assert.ok(newLeader);
  assert.equal(newLeader.id, 'node-2');
  assert.equal(newLeader.currentTerm, 2);
  assert.equal(cluster.getCurrentTerm(), 2);
  assert.deepEqual(newLeader.appliedCommands, ['SYNC_MATCH_SEEDING']);
});

test('GamingEsportsHubRaftCluster - forces stale partitioned leader to step down on higher-term heartbeat', () => {
  const cluster = new GamingEsportsHubRaftCluster({ nodeCount: 5 });
  cluster.startElection('node-1');
  cluster.partitionNodes(['node-1']);

  // Majority partition elects node-3 in Term 2.
  const res = cluster.startElection('node-3');
  assert.equal(res.elected, true);
  assert.equal(res.leaderId, 'node-3');
  assert.equal(res.term, 2);
  assert.equal(cluster.getNode('node-1').state, NODE_STATES.LEADER);

  // Healing partition runs sendHeartbeats; node-1 discovers Term 2 and steps down.
  cluster.healPartition();
  assert.equal(cluster.getNode('node-1').state, NODE_STATES.FOLLOWER);
  assert.equal(cluster.getNode('node-1').currentTerm, 2);
  assert.equal(cluster.getLeaders().length, 1);
  assert.equal(cluster.getLeader().id, 'node-3');
});
