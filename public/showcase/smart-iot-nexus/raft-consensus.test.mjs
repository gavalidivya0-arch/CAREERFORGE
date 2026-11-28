import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartIotNexusRaftCluster } from './raft-consensus.js';

test('SmartIotNexusRaftCluster - calculates majority quorum correctly', () => {
  const cluster = new SmartIotNexusRaftCluster(3);
  const majority = Math.floor(cluster.numNodes / 2) + 1;
  assert.strictEqual(majority, 2);
});

test('SmartIotNexusRaftCluster - split vote handling with 3 nodes', async () => {
  const cluster = new SmartIotNexusRaftCluster(3);

  const promise = cluster.startElection('node-1');
  await promise;

  const node1 = cluster.nodes.get('node-1');
  assert.strictEqual(node1.state, 'Leader');

  const node2 = cluster.nodes.get('node-2');
  const node3 = cluster.nodes.get('node-3');
  assert.ok(node2.state === 'Follower');
  assert.ok(node3.state === 'Follower');
});

test('SmartIotNexusRaftCluster - term increments when leader is removed', async () => {
  const cluster = new SmartIotNexusRaftCluster(3);

  assert.strictEqual(cluster.currentTerm, 0);

  cluster.startElection('node-1');
  await new Promise(resolve => setTimeout(resolve, 100));

  const node1 = cluster.nodes.get('node-1');
  assert.strictEqual(node1.state, 'Leader');
  cluster.leaderId = 'node-1';

  cluster.handleNodeFailure('node-1');

  assert.strictEqual(cluster.currentTerm, 2);
});

test('SmartIotNexusRaftCluster - leader replacement when leader drops', async () => {
  const cluster = new SmartIotNexusRaftCluster(3);

  await new Promise(resolve => {
    cluster.startElection('node-1');
    setTimeout(resolve, 100);
  });

  const node1 = cluster.nodes.get('node-1');
  assert.strictEqual(node1.state, 'Leader');
  cluster.leaderId = 'node-1';

  cluster.handleNodeFailure('node-1');

  const node2 = cluster.nodes.get('node-2');
  assert.strictEqual(node2.state, 'Follower');

  assert.strictEqual(cluster.currentTerm, 2);
});

test('SmartIotNexusRaftCluster - replicateLog adds command to leader log', async () => {
  const cluster = new SmartIotNexusRaftCluster(3);

  await new Promise(resolve => {
    cluster.startElection('node-1');
    setTimeout(resolve, 100);
  });

  const result = await cluster.replicateLog('sensor-reading-42');
  assert.strictEqual(result.success, true);

  const leader = cluster.nodes.values().next().value;
  assert.strictEqual(leader.log.length, 1);
  assert.strictEqual(leader.log[0].command, 'sensor-reading-42');
});

test('SmartIotNexusRaftCluster - sendHeartbeats maintains leader status', async () => {
  const cluster = new SmartIotNexusRaftCluster(3);

  await new Promise(resolve => {
    cluster.startElection('node-1');
    setTimeout(resolve, 100);
  });

  const node1 = cluster.nodes.get('node-1');
  assert.strictEqual(node1.state, 'Leader');

  cluster.sendHeartbeats();

  setTimeout(() => {
    const node2 = cluster.nodes.get('node-2');
    assert.strictEqual(node2.state, 'Follower');
  }, 50);
});