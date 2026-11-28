import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CryptoExchangeProRaftCluster, RAFT_ROLES } from './raft-consensus.js';

describe('CryptoExchangeProRaftCluster', () => {
  it('computes majority quorum accurately for 3-node and 5-node clusters', () => {
    const cluster3 = new CryptoExchangeProRaftCluster(3);
    assert.equal(cluster3.nodes.length, 3);
    assert.equal(cluster3.getQuorumSize(), 2);

    const cluster5 = new CryptoExchangeProRaftCluster(5);
    assert.equal(cluster5.nodes.length, 5);
    assert.equal(cluster5.getQuorumSize(), 3);

    // Isolating 2 nodes in a 5-node cluster leaves them below quorum (2 < 3)
    cluster5.setNetworkPartition(true, ['node-1', 'node-2']);
    const minorityElection = cluster5.startElection('node-1');
    assert.equal(minorityElection.elected, false);
    assert.equal(minorityElection.votesReceived.length, 2);
    assert.equal(cluster5.getLeader(), null);

    // Majority side (3 nodes) can still reach quorum and elect a leader
    const majorityElection = cluster5.startElection('node-3');
    assert.equal(majorityElection.elected, true);
    assert.equal(majorityElection.leaderId, 'node-3');
    assert.equal(majorityElection.votesReceived.length, 3);
  });

  it('handles split votes without electing a leader and recovers in a higher term', () => {
    const cluster = new CryptoExchangeProRaftCluster(5);
    const split = cluster.simulateSplitVote(['node-1', 'node-2']);

    assert.equal(split.splitVote, true);
    assert.equal(split.term, 1);
    assert.equal(split.leaderId, null);
    assert.equal(cluster.getLeader(), null);

    for (const tally of split.tallies) {
      assert.ok(tally.votes < cluster.getQuorumSize());
    }

    // Subsequent election in Term 2 resolves the split vote
    const recovery = cluster.startElection('node-3');
    assert.equal(recovery.elected, true);
    assert.equal(recovery.term, 2);
    assert.equal(cluster.getLeader().id, 'node-3');
  });

  it('increments terms on elections and synchronizes follower terms via heartbeats', () => {
    const cluster = new CryptoExchangeProRaftCluster(3);
    assert.equal(cluster.getCurrentTerm(), 0);

    const first = cluster.startElection('node-1');
    assert.equal(first.elected, true);
    assert.equal(first.term, 1);
    assert.equal(cluster.getCurrentTerm(), 1);

    // All reachable followers adopt Term 1 and Follower state
    for (const node of cluster.nodes) {
      assert.equal(node.currentTerm, 1);
    }

    // A second election from another node increments to Term 2 and replaces leadership
    const second = cluster.startElection('node-2');
    assert.equal(second.elected, true);
    assert.equal(second.term, 2);
    assert.equal(cluster.getCurrentTerm(), 2);
    assert.equal(cluster.getNode('node-1').state, RAFT_ROLES.FOLLOWER);
    assert.equal(cluster.getLeader().id, 'node-2');

    const hb = cluster.sendHeartbeats();
    assert.equal(hb.sent, true);
    assert.equal(hb.term, 2);
    assert.equal(hb.acks, 3);
  });

  it('replaces the leader when the active leader fails', () => {
    const cluster = new CryptoExchangeProRaftCluster(5);
    const initial = cluster.startElection('node-1');
    assert.equal(initial.elected, true);
    assert.equal(cluster.getLeader().id, 'node-1');

    const failure = cluster.handleNodeFailure('node-1');
    assert.equal(failure.handled, true);
    assert.equal(failure.wasLeader, true);
    assert.equal(failure.alive, false);
    assert.equal(cluster.getLeader(), null);

    // Offline node cannot win an election
    const failedAttempt = cluster.startElection('node-1');
    assert.equal(failedAttempt.elected, false);

    // Surviving node wins election in higher term
    const replacement = cluster.startElection('node-4');
    assert.equal(replacement.elected, true);
    assert.equal(replacement.term, 2);
    assert.equal(replacement.leaderId, 'node-4');
    assert.equal(cluster.getLeader().id, 'node-4');
  });

  it('commits replicated logs only when a majority quorum acknowledges', () => {
    const cluster = new CryptoExchangeProRaftCluster(5);
    cluster.startElection('node-1');

    // Healthy cluster commits command to majority
    const committedRes = cluster.replicateLog('MATCH BTC-USD 2.0 @ 91500');
    assert.equal(committedRes.committed, true);
    assert.equal(committedRes.commitIndex, 1);
    assert.equal(committedRes.acks, 5);
    assert.equal(cluster.getNode('node-2').log[0].committed, true);

    // Drop 3 followers -> only 2 nodes alive (< quorum 3), entry stays uncommitted
    cluster.handleNodeFailure('node-3');
    cluster.handleNodeFailure('node-4');
    cluster.handleNodeFailure('node-5');

    const uncommittedRes = cluster.replicateLog('MATCH ETH-USD 10 @ 3400');
    assert.equal(uncommittedRes.committed, false);
    assert.equal(uncommittedRes.acks, 2);
    assert.equal(uncommittedRes.commitIndex, 1);
    assert.equal(cluster.getNode('node-1').log[1].committed, false);
  });
});
