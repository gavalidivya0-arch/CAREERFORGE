import test from 'node:test';
import assert from 'node:assert/strict';
import { LegalSmartContractsRaftCluster } from './raft-consensus.js';

test('LegalSmartContractsRaftCluster - majority quorum calculation for 3-node and 5-node clusters', () => {
  const cluster5 = new LegalSmartContractsRaftCluster(5);
  assert.equal(cluster5.nodes.length, 5);
  assert.equal(cluster5.getQuorumSize(), 3); // floor(5 / 2) + 1 = 3

  const cluster3 = new LegalSmartContractsRaftCluster(3);
  assert.equal(cluster3.nodes.length, 3);
  assert.equal(cluster3.getQuorumSize(), 2); // floor(3 / 2) + 1 = 2
});

test('LegalSmartContractsRaftCluster - leader election and term increment with majority quorum', () => {
  const cluster = new LegalSmartContractsRaftCluster(5);
  const initialTerm = cluster.currentTerm;

  const result = cluster.startElection('node-1');
  assert.equal(result.success, true);
  assert.equal(result.leaderId, 'node-1');
  assert.equal(result.term, initialTerm + 1);
  assert.equal(result.votes, 5); // All 5 reachable nodes voted

  const leaderNode = cluster.nodes.find((n) => n.id === 'node-1');
  assert.equal(leaderNode.state, 'Leader');

  // Other nodes become followers
  const followerNode = cluster.nodes.find((n) => n.id === 'node-2');
  assert.equal(followerNode.state, 'Follower');
  assert.equal(followerNode.currentTerm, result.term);
});

test('LegalSmartContractsRaftCluster - split vote / quorum failure when majority is partitioned or dead', () => {
  const cluster = new LegalSmartContractsRaftCluster(5);

  // Kill 3 out of 5 nodes so only 2 remain reachable (quorum requires 3)
  cluster.handleNodeFailure('node-3', false);
  cluster.handleNodeFailure('node-4', false);
  cluster.handleNodeFailure('node-5', false);

  const result = cluster.startElection('node-1');
  assert.equal(result.success, false);
  assert.equal(result.votes, 2); // Only node-1 and node-2 reachable
  assert.equal(result.quorum, 3);
  assert.equal(cluster.leaderId, null);

  const candidate = cluster.nodes.find((n) => n.id === 'node-1');
  assert.notEqual(candidate.state, 'Leader');
});

test('LegalSmartContractsRaftCluster - leader replacement when active leader drops', () => {
  const cluster = new LegalSmartContractsRaftCluster(5);

  // Elect node-1 as initial leader
  const initialElection = cluster.startElection('node-1');
  assert.equal(initialElection.success, true);
  assert.equal(cluster.leaderId, 'node-1');

  // Kill active leader (node-1)
  const failureResult = cluster.handleNodeFailure('node-1', false);
  assert.equal(failureResult.isAlive, false);
  assert.equal(cluster.leaderId, null); // Leader drops

  // Node-2 starts an election
  const newElection = cluster.startElection('node-2');
  assert.equal(newElection.success, true);
  assert.equal(newElection.leaderId, 'node-2');
  assert.equal(cluster.leaderId, 'node-2');
  assert.equal(newElection.votes, 4); // Remaining 4 live nodes vote
  assert.ok(newElection.term > initialElection.term);
});

test('LegalSmartContractsRaftCluster - log replication commits on quorum and rejects on quorum loss', () => {
  const cluster = new LegalSmartContractsRaftCluster(5);
  cluster.startElection('node-1');

  // Normal replication with full cluster alive
  const command1 = 'APPROVE_ESCROW_RELEASE: contract_id=0x9f4a milestone=1 payout=10.0ETH';
  const res1 = cluster.replicateLog(command1);
  assert.equal(res1.success, true);
  assert.equal(res1.committed, true);
  assert.equal(res1.acks, 5);
  assert.equal(cluster.logs.length, 1);
  assert.equal(cluster.logs[0].command, command1);

  // Partition minority (nodes 4, 5) - quorum (3 nodes) is still maintained
  cluster.togglePartition(['node-4', 'node-5']);
  const command2 = 'SIGN_AMENDMENT: contract_id=0x9f4a terms_hash=0xbeef42';
  const res2 = cluster.replicateLog(command2);
  assert.equal(res2.success, true);
  assert.equal(res2.committed, true);
  assert.equal(res2.acks, 3); // node-1, node-2, node-3

  // Kill node-2 and node-3 so leader node-1 is alone
  cluster.handleNodeFailure('node-2', false);
  cluster.handleNodeFailure('node-3', false);

  const command3 = 'EXECUTE_FINAL_SETTLEMENT: contract_id=0x9f4a';
  const res3 = cluster.replicateLog(command3);
  assert.equal(res3.success, false);
  assert.equal(res3.committed, false);
  assert.equal(res3.acks, 1);
  assert.equal(res3.quorum, 3);
});
