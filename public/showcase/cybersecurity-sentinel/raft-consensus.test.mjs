import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CybersecuritySentinelRaftCluster, NODE_STATES } from './raft-consensus.js';

describe('CybersecuritySentinelRaftCluster - Quorum & Topology', () => {
  test('calculates majority quorum accurately for 3-node and 5-node clusters', () => {
    const cluster3 = new CybersecuritySentinelRaftCluster(3);
    assert.strictEqual(cluster3.nodes.length, 3);
    assert.strictEqual(cluster3.getQuorumSize(), 2);

    const cluster5 = new CybersecuritySentinelRaftCluster(5);
    assert.strictEqual(cluster5.nodes.length, 5);
    assert.strictEqual(cluster5.getQuorumSize(), 3);

    cluster5.setClusterSize(3);
    assert.strictEqual(cluster5.nodes.length, 3);
    assert.strictEqual(cluster5.getQuorumSize(), 2);
  });

  test('assigns randomized election timeouts within configured bounds', () => {
    const cluster = new CybersecuritySentinelRaftCluster(5, {
      minTimeoutMs: 150,
      maxTimeoutMs: 300
    });

    for (const node of cluster.nodes) {
      assert.ok(node.electionTimeoutMs >= 150 && node.electionTimeoutMs <= 300);
      assert.strictEqual(node.state, NODE_STATES.FOLLOWER);
    }
  });
});

describe('CybersecuritySentinelRaftCluster - Elections, Term Increments & Split Votes', () => {
  test('increments term, exchanges RequestVote RPCs, and elects Leader on majority quorum', () => {
    const cluster = new CybersecuritySentinelRaftCluster(5);
    assert.strictEqual(cluster.currentTerm, 0);

    const res = cluster.startElection('node-1');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.leaderId, 'node-1');
    assert.strictEqual(res.term, 1);
    assert.strictEqual(res.votes, 5);
    assert.strictEqual(res.quorum, 3);
    assert.ok(res.rpcs.some((rpc) => rpc.type === 'RequestVote' && rpc.from === 'node-1'));
    assert.ok(res.rpcs.some((rpc) => rpc.type === 'VoteResponse' && rpc.voteGranted === true));

    assert.strictEqual(cluster.getNode('node-1').state, NODE_STATES.LEADER);
    assert.strictEqual(cluster.getNode('node-2').state, NODE_STATES.FOLLOWER);
    assert.strictEqual(cluster.getNode('node-2').currentTerm, 1);

    // Subsequent election increments term again
    const res2 = cluster.startElection('node-3');
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.term, 2);
    assert.strictEqual(cluster.leaderId, 'node-3');
    assert.strictEqual(cluster.getNode('node-1').state, NODE_STATES.FOLLOWER);
  });

  test('handles split vote / quorum failure when majority of nodes are unreachable', () => {
    const cluster = new CybersecuritySentinelRaftCluster(5);

    // Kill 3 of 5 nodes so only 2 nodes remain (quorum is 3)
    cluster.handleNodeFailure('node-3', false);
    cluster.handleNodeFailure('node-4', false);
    cluster.handleNodeFailure('node-5', false);

    const res = cluster.startElection('node-1');
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.leaderId, null);
    assert.strictEqual(res.votes, 2);
    assert.strictEqual(res.quorum, 3);
    assert.strictEqual(res.term, 1);
    assert.strictEqual(cluster.leaderId, null);
    assert.strictEqual(cluster.getNode('node-1').state, NODE_STATES.CANDIDATE);
  });

  test('handles concurrent split vote in same term and recovers on next election term', () => {
    const cluster = new CybersecuritySentinelRaftCluster(5);

    // 3 candidates split the 5-node cluster: node-1 gets 2, node-2 gets 2, node-3 gets 1
    const splitRes = cluster.simulateSplitVote(['node-1', 'node-2', 'node-3']);
    assert.strictEqual(splitRes.success, false);
    assert.strictEqual(splitRes.splitVote, true);
    assert.strictEqual(splitRes.term, 1);
    assert.strictEqual(cluster.leaderId, null);
    assert.ok(splitRes.results.every((r) => r.votes < splitRes.quorum));

    // Next election increments to term 2 and resolves with a single Leader
    const recoveryRes = cluster.startElection('node-2');
    assert.strictEqual(recoveryRes.success, true);
    assert.strictEqual(recoveryRes.term, 2);
    assert.strictEqual(recoveryRes.leaderId, 'node-2');
    assert.strictEqual(cluster.leaderId, 'node-2');
  });
});

describe('CybersecuritySentinelRaftCluster - Leader Failure, Heartbeats & Log Replication', () => {
  test('replaces active leader cleanly when leader drops', () => {
    const cluster = new CybersecuritySentinelRaftCluster(5);

    const firstElection = cluster.startElection('node-1');
    assert.strictEqual(firstElection.success, true);
    assert.strictEqual(cluster.leaderId, 'node-1');

    // Drop active leader
    const failRes = cluster.handleNodeFailure('node-1', false);
    assert.strictEqual(failRes.success, true);
    assert.strictEqual(failRes.isAlive, false);
    assert.strictEqual(failRes.leaderDropped, true);
    assert.strictEqual(cluster.leaderId, null);
    assert.strictEqual(cluster.getNode('node-1').state, NODE_STATES.DEAD);

    // Another healthy node wins replacement election
    const secondElection = cluster.startElection('node-4');
    assert.strictEqual(secondElection.success, true);
    assert.strictEqual(secondElection.leaderId, 'node-4');
    assert.strictEqual(secondElection.votes, 4);
    assert.ok(secondElection.term > firstElection.term);
    assert.strictEqual(cluster.leaderId, 'node-4');
  });

  test('triggers automatic election via tick() when election timeout expires without leader', () => {
    const cluster = new CybersecuritySentinelRaftCluster(3, {
      minTimeoutMs: 100,
      maxTimeoutMs: 101
    });

    // Advance clock past electionTimeoutMs
    const tickRes = cluster.tick(150);
    assert.ok(tickRes.electionsTriggered.length >= 1);
    assert.ok(cluster.leaderId !== null);
    assert.strictEqual(cluster.currentTerm, 1);

    // Heartbeats keep follower timers reset
    const hb = cluster.sendHeartbeats();
    assert.strictEqual(hb.success, true);
    assert.strictEqual(hb.acks, 3);
    assert.ok(cluster.nodes.every((n) => n.elapsedMs === 0));
  });

  test('replicates and commits logs on majority quorum, rejects commit on quorum loss', () => {
    const cluster = new CybersecuritySentinelRaftCluster(5);
    cluster.startElection('node-1');

    // Commit with full cluster
    const log1 = cluster.replicateLog('ISOLATE_ENDPOINT host=ws-prod-42');
    assert.strictEqual(log1.success, true);
    assert.strictEqual(log1.committed, true);
    assert.strictEqual(log1.acks, 5);
    assert.strictEqual(cluster.logs.length, 1);
    assert.strictEqual(cluster.commitIndex, 1);

    // Partition minority (node-4, node-5): quorum (3) still intact
    cluster.togglePartition(['node-4', 'node-5']);
    const log2 = cluster.replicateLog('PUSH_WAF_RULE signature=CVE-2026-4136');
    assert.strictEqual(log2.success, true);
    assert.strictEqual(log2.committed, true);
    assert.strictEqual(log2.acks, 3);
    assert.strictEqual(cluster.logs.length, 2);

    // Kill node-2 so leader node-1 + node-3 only have 2 nodes (< quorum 3)
    cluster.handleNodeFailure('node-2', false);
    const log3 = cluster.replicateLog('ROTATE_KMS_KEY epoch=9');
    assert.strictEqual(log3.success, false);
    assert.strictEqual(log3.committed, false);
    assert.strictEqual(log3.acks, 2);
    assert.strictEqual(log3.quorum, 3);
    assert.strictEqual(cluster.logs.length, 2);

    // Heal partition and send heartbeats -> partitioned nodes catch up logs
    cluster.togglePartition(['node-4', 'node-5']);
    const hb = cluster.sendHeartbeats();
    assert.strictEqual(hb.success, true);
    assert.strictEqual(hb.acks, 4);
    assert.strictEqual(cluster.getNode('node-4').commitIndex, 2);
  });
});
