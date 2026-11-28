import test from 'node:test';
import assert from 'node:assert/strict';
import { BiotechGenomicsRaftCluster, RAFT_NODE_STATES } from './raft-consensus.js';

test('computes majority quorum for 3-node, 5-node, and 7-node clusters', () => {
  const cluster3 = new BiotechGenomicsRaftCluster(3);
  assert.equal(cluster3.nodes.length, 3);
  assert.equal(cluster3.getQuorumSize(), 2);

  const cluster5 = new BiotechGenomicsRaftCluster(5);
  assert.equal(cluster5.nodes.length, 5);
  assert.equal(cluster5.getQuorumSize(), 3);

  const cluster7 = new BiotechGenomicsRaftCluster(7);
  assert.equal(cluster7.nodes.length, 7);
  assert.equal(cluster7.getQuorumSize(), 4);
});

test('startElection increments the term and elects a leader with full quorum', () => {
  const cluster = new BiotechGenomicsRaftCluster(5);
  const initialTerm = cluster.currentTerm;

  const result = cluster.startElection('node-1');

  assert.equal(result.success, true);
  assert.equal(result.leaderId, 'node-1');
  assert.equal(result.term, initialTerm + 1);
  assert.equal(result.votes, 5);
  assert.equal(result.quorum, 3);
  assert.equal(cluster.currentTerm, initialTerm + 1);
  assert.equal(cluster.leaderId, 'node-1');

  const leader = cluster.getNode('node-1');
  assert.equal(leader.state, RAFT_NODE_STATES.LEADER);

  for (const id of ['node-2', 'node-3', 'node-4', 'node-5']) {
    const follower = cluster.getNode(id);
    assert.equal(follower.state, RAFT_NODE_STATES.FOLLOWER);
    assert.equal(follower.currentTerm, result.term);
    assert.equal(follower.votedFor, 'node-1');
  }
});

test('split vote handling returns the candidate to follower and leaves no leader', () => {
  const cluster = new BiotechGenomicsRaftCluster(5);

  const result = cluster.startElection('node-1', {
    denyVoters: ['node-3', 'node-4', 'node-5']
  });

  assert.equal(result.success, false);
  assert.match(result.reason, /Split vote|quorum/);
  assert.equal(result.votes, 2);
  assert.equal(result.quorum, 3);
  assert.equal(cluster.leaderId, null);
  assert.equal(cluster.getNode('node-1').state, RAFT_NODE_STATES.FOLLOWER);
  assert.deepEqual(result.deniedVoters.sort(), ['node-3', 'node-4', 'node-5']);

  // A later election in a fresh term can still succeed.
  const retry = cluster.startElection('node-1');
  assert.equal(retry.success, true);
  assert.equal(retry.term, result.term + 1);
  assert.equal(cluster.leaderId, 'node-1');
});

test('leader replacement occurs when the active leader drops', () => {
  const cluster = new BiotechGenomicsRaftCluster(5);

  const firstElection = cluster.startElection('node-1');
  assert.equal(firstElection.success, true);
  assert.equal(cluster.leaderId, 'node-1');

  const failure = cluster.handleNodeFailure('node-1', false);
  assert.equal(failure.success, true);
  assert.equal(failure.isAlive, false);
  assert.equal(failure.state, RAFT_NODE_STATES.DEAD);
  assert.equal(cluster.leaderId, null);

  const replacement = cluster.startElection('node-2');
  assert.equal(replacement.success, true);
  assert.equal(replacement.leaderId, 'node-2');
  assert.equal(replacement.votes, 4);
  assert.ok(replacement.term > firstElection.term);
  assert.equal(cluster.leaderId, 'node-2');
  assert.equal(cluster.getNode('node-2').state, RAFT_NODE_STATES.LEADER);
});

test('election fails when the candidate cannot reach a majority', () => {
  const cluster = new BiotechGenomicsRaftCluster(5);
  cluster.handleNodeFailure('node-3', false);
  cluster.handleNodeFailure('node-4', false);
  cluster.handleNodeFailure('node-5', false);

  const result = cluster.startElection('node-1');

  assert.equal(result.success, false);
  assert.equal(result.votes, 2);
  assert.equal(result.quorum, 3);
  assert.equal(cluster.leaderId, null);
});

test('log replication commits on quorum and rejects on quorum loss', () => {
  const cluster = new BiotechGenomicsRaftCluster(5);
  cluster.startElection('node-1');

  const command1 = 'RECORD_VARIANT: gene=BRCA1 chr=17 pos=43094464 ref=C alt=T';
  const result1 = cluster.replicateLog(command1);
  assert.equal(result1.success, true);
  assert.equal(result1.committed, true);
  assert.equal(result1.acks, 5);
  assert.equal(cluster.logs.length, 1);
  assert.equal(cluster.logs[0].command, command1);
  assert.equal(cluster.getNode('node-1').commitIndex, 1);

  cluster.togglePartition(['node-4', 'node-5']);
  const command2 = 'ANNOTATE_PATHOGENICITY: variant=BRCA1.43094464C>T classification=PATHOGENIC';
  const result2 = cluster.replicateLog(command2);
  assert.equal(result2.success, true);
  assert.equal(result2.committed, true);
  assert.equal(result2.acks, 3);
  assert.equal(cluster.logs.length, 2);

  cluster.handleNodeFailure('node-2', false);
  cluster.handleNodeFailure('node-3', false);

  const command3 = 'ARCHIVE_SAMPLE: sample=GS-204 consent=verified';
  const result3 = cluster.replicateLog(command3);
  assert.equal(result3.success, false);
  assert.equal(result3.committed, false);
  assert.equal(result3.acks, 1);
  assert.equal(result3.quorum, 3);
  assert.equal(cluster.logs.length, 2);
  assert.equal(cluster.getNode('node-1').log.length, 2);
});

test('rejects commands without an active leader or with an empty payload', () => {
  const cluster = new BiotechGenomicsRaftCluster(3);

  const noLeader = cluster.replicateLog('RECORD_VARIANT: gene=TP53');
  assert.equal(noLeader.success, false);
  assert.match(noLeader.reason, /No active leader/);

  cluster.startElection('node-1');
  const empty = cluster.replicateLog('   ');
  assert.equal(empty.success, false);
  assert.match(empty.reason, /empty/);
});

test('heartbeats reset follower election timeouts and preserve leadership', () => {
  const cluster = new BiotechGenomicsRaftCluster(5, {
    random: () => 0.5,
    electionTimeoutMin: 150,
    electionTimeoutMax: 300
  });
  cluster.startElection('node-1');

  const follower = cluster.getNode('node-2');
  follower.electionTimeout = 0;

  const result = cluster.sendHeartbeats();
  assert.equal(result.success, true);
  assert.equal(result.leaderId, 'node-1');
  assert.equal(result.acknowledgedNodes, 5);
  assert.equal(result.quorumReached, true);
  assert.equal(cluster.getNode('node-2').electionTimeout, 225);
  assert.equal(cluster.getNode('node-2').state, RAFT_NODE_STATES.FOLLOWER);
  assert.equal(cluster.leaderId, 'node-1');
});

test('randomized election timeouts stay within configured bounds', () => {
  const cluster = new BiotechGenomicsRaftCluster(5, {
    random: () => 0.5,
    electionTimeoutMin: 150,
    electionTimeoutMax: 300
  });

  for (const node of cluster.nodes) {
    assert.ok(node.electionTimeout >= 150);
    assert.ok(node.electionTimeout <= 300);
    assert.equal(node.electionTimeout, 225);
  }

  const timeouts = cluster.getElectionTimeouts();
  assert.equal(timeouts.length, 5);
  assert.deepEqual(timeouts[0], { id: 'node-1', electionTimeout: 225, lastHeartbeatAt: 0 });
});

test('partitioning the leader clears leadership and toggling heals the network', () => {
  const cluster = new BiotechGenomicsRaftCluster(5);
  cluster.startElection('node-1');

  const partition = cluster.togglePartition(['node-1', 'node-4', 'node-5']);
  assert.equal(partition.success, true);
  assert.equal(cluster.leaderId, null);
  assert.deepEqual(partition.partitioned.sort(), ['node-1', 'node-4', 'node-5']);
  assert.equal(cluster.getStateSummary().partitioned, 3);

  const heal = cluster.togglePartition(['node-1', 'node-4', 'node-5']);
  assert.deepEqual(heal.partitioned, []);
  assert.equal(cluster.getNode('node-1').isPartitioned, false);
});

test('reviving a failed node restores it as a follower', () => {
  const cluster = new BiotechGenomicsRaftCluster(3);
  cluster.handleNodeFailure('node-2', false);
  assert.equal(cluster.getNode('node-2').isAlive, false);

  const revived = cluster.handleNodeFailure('node-2', true);
  assert.equal(revived.success, true);
  assert.equal(revived.isAlive, true);
  assert.equal(revived.state, RAFT_NODE_STATES.FOLLOWER);
  assert.equal(cluster.getReachableNodes().length, 3);
});

test('reset clears the term, leader, and committed log', () => {
  const cluster = new BiotechGenomicsRaftCluster(3);
  cluster.startElection('node-1');
  cluster.replicateLog('RECORD_VARIANT: gene=EGFR');

  const summary = cluster.reset();
  assert.equal(cluster.currentTerm, 1);
  assert.equal(cluster.leaderId, null);
  assert.equal(cluster.logs.length, 0);
  assert.equal(cluster.getNode('node-1').log.length, 0);
  assert.deepEqual(summary, { leaders: 0, followers: 3, candidates: 0, dead: 0, partitioned: 0 });
});
