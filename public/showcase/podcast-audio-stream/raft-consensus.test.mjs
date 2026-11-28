import test from 'node:test';
import assert from 'node:assert/strict';
import { PodcastAudioStreamRaftCluster } from './raft-consensus.js';

test('PodcastAudioStreamRaftCluster - majority quorum calculation for 3-node and 5-node clusters', () => {
  const cluster5 = new PodcastAudioStreamRaftCluster(5);
  assert.equal(cluster5.nodes.length, 5);
  assert.equal(cluster5.getQuorumSize(), 3);

  const cluster3 = new PodcastAudioStreamRaftCluster(3);
  assert.equal(cluster3.nodes.length, 3);
  assert.equal(cluster3.getQuorumSize(), 2);
});

test('PodcastAudioStreamRaftCluster - term increments and RequestVote RPC exchange elect Leader', () => {
  const cluster = new PodcastAudioStreamRaftCluster(5);
  const initialTerm = cluster.currentTerm;

  const election = cluster.startElection('node-1');
  assert.equal(election.success, true);
  assert.equal(election.leaderId, 'node-1');
  assert.equal(election.term, initialTerm + 1);
  assert.equal(election.votes, 5);
  assert.equal(election.rpcs.length, 4);
  assert.ok(election.rpcs.every((rpc) => rpc.type === 'RequestVote' && rpc.granted === true));

  const leaderNode = cluster.nodes.find((n) => n.id === 'node-1');
  assert.equal(leaderNode.state, 'Leader');
  assert.equal(leaderNode.currentTerm, election.term);

  const followerNode = cluster.nodes.find((n) => n.id === 'node-2');
  assert.equal(followerNode.state, 'Follower');
  assert.equal(followerNode.currentTerm, election.term);
});

test('PodcastAudioStreamRaftCluster - randomized election timeouts and heartbeat reset cycle', () => {
  const cluster = new PodcastAudioStreamRaftCluster(5, {
    minElectionTimeoutMs: 150,
    maxElectionTimeoutMs: 300
  });

  for (const node of cluster.nodes) {
    assert.ok(node.electionTimeoutMs >= 150 && node.electionTimeoutMs <= 300);
    assert.equal(node.electionElapsedMs, 0);
  }

  // Advance clock until at least one follower times out and starts an election
  let triggered = [];
  for (let i = 0; i < 10 && triggered.length === 0; i++) {
    const tickResult = cluster.tick(50);
    triggered = tickResult.electionsTriggered;
  }
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].result.success, true);
  assert.ok(cluster.leaderId !== null);

  // Advance follower elapsed timers slightly, then verify sendHeartbeats resets them
  const follower = cluster.nodes.find((n) => n.id !== cluster.leaderId);
  follower.electionElapsedMs = 80;
  const hb = cluster.sendHeartbeats();
  assert.equal(hb.success, true);
  assert.equal(hb.acknowledgedNodes, 5);
  assert.equal(follower.electionElapsedMs, 0);
});

test('PodcastAudioStreamRaftCluster - split vote handling on quorum loss and concurrent candidates', () => {
  // Case 1: Majority unreachable (3 of 5 nodes dead)
  const cluster = new PodcastAudioStreamRaftCluster(5);
  cluster.handleNodeFailure('node-3', false);
  cluster.handleNodeFailure('node-4', false);
  cluster.handleNodeFailure('node-5', false);

  const failedElection = cluster.startElection('node-1');
  assert.equal(failedElection.success, false);
  assert.equal(failedElection.votes, 2);
  assert.equal(failedElection.quorum, 3);
  assert.equal(cluster.leaderId, null);

  // Case 2: Concurrent candidates splitting votes across 5 live nodes (3 candidates split 2-2-1)
  const splitCluster = new PodcastAudioStreamRaftCluster(5);
  const splitResult = splitCluster.simulateSplitVote(['node-1', 'node-2', 'node-3']);
  assert.equal(splitResult.success, false);
  assert.equal(splitResult.splitVote, true);
  assert.equal(splitCluster.leaderId, null);
  assert.ok(Object.values(splitResult.tallies).every((votes) => votes < splitResult.quorum));
  assert.ok(splitCluster.nodes.every((n) => n.state === 'Follower'));
});

test('PodcastAudioStreamRaftCluster - leader replacement when active leader drops', () => {
  const cluster = new PodcastAudioStreamRaftCluster(5);
  const firstElection = cluster.startElection('node-1');
  assert.equal(firstElection.success, true);
  assert.equal(cluster.leaderId, 'node-1');

  const dropResult = cluster.handleNodeFailure('node-1', false);
  assert.equal(dropResult.isAlive, false);
  assert.equal(dropResult.state, 'Dead');
  assert.equal(cluster.leaderId, null);

  const secondElection = cluster.startElection('node-2');
  assert.equal(secondElection.success, true);
  assert.equal(secondElection.leaderId, 'node-2');
  assert.equal(cluster.leaderId, 'node-2');
  assert.equal(secondElection.votes, 4);
  assert.ok(secondElection.term > firstElection.term);
});

test('PodcastAudioStreamRaftCluster - log replication commit cycle respects quorum and partitions', () => {
  const cluster = new PodcastAudioStreamRaftCluster(5);
  cluster.startElection('node-1');

  const res1 = cluster.replicateLog('SYNC_EPISODE_CHUNK: ep=142 seg=084 bitrate=320kbps');
  assert.equal(res1.success, true);
  assert.equal(res1.committed, true);
  assert.equal(res1.acks, 5);
  assert.equal(cluster.logs.length, 1);

  // Partition minority (2 nodes); remaining 3 still meet quorum (3)
  cluster.togglePartition(['node-4', 'node-5']);
  const res2 = cluster.replicateLog('PUBLISH_HLS_MANIFEST: feed=waveform-main seq=4092');
  assert.equal(res2.success, true);
  assert.equal(res2.committed, true);
  assert.equal(res2.acks, 3);
  assert.equal(cluster.logs.length, 2);

  // Kill another node so only 2 reachable remain (< quorum 3)
  cluster.handleNodeFailure('node-2', false);
  const res3 = cluster.replicateLog('COMMIT_CHAPTER_MARKER: ep=142 ts=18m40s');
  assert.equal(res3.success, false);
  assert.equal(res3.committed, false);
  assert.equal(res3.acks, 2);
  assert.equal(res3.quorum, 3);
  assert.equal(cluster.logs.length, 2);
});
