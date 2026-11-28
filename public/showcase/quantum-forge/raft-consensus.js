/**
 * Quantum Forge - Distributed Raft Consensus & Leader Election State Machine
 * Models Leader, Follower, and Candidate states, randomized election timeouts,
 * RequestVote / AppendEntries RPC exchanges, split votes, network partitions,
 * node failures, and majority-quorum log replication.
 */

export const NODE_STATES = Object.freeze({
  FOLLOWER: 'Follower',
  CANDIDATE: 'Candidate',
  LEADER: 'Leader'
});

export class QuantumForgeRaftCluster {
  /**
   * @param {Object} [options]
   * @param {number} [options.nodeCount=5] - Number of nodes in cluster (typically 3 or 5).
   * @param {number} [options.minElectionTimeout=150] - Minimum election timeout in ms.
   * @param {number} [options.maxElectionTimeout=300] - Maximum election timeout in ms.
   * @param {number} [options.heartbeatInterval=50] - Leader heartbeat interval in ms.
   * @param {() => number} [options.randomFn=Math.random] - RNG for deterministic testing.
   */
  constructor(options = {}) {
    const {
      nodeCount = 5,
      minElectionTimeout = 150,
      maxElectionTimeout = 300,
      heartbeatInterval = 50,
      randomFn = Math.random
    } = options;

    if (!Number.isInteger(nodeCount) || nodeCount < 1) {
      throw new Error('nodeCount must be a positive integer');
    }
    if (minElectionTimeout <= 0 || maxElectionTimeout < minElectionTimeout) {
      throw new Error('Invalid election timeout bounds');
    }

    this.nodeCount = nodeCount;
    this.minElectionTimeout = minElectionTimeout;
    this.maxElectionTimeout = maxElectionTimeout;
    this.heartbeatInterval = heartbeatInterval;
    this.randomFn = randomFn;

    this.partitioned = false;
    this.rpcHistory = [];
    this.elapsedHeartbeatTimer = 0;
    this._packetSeq = 0;

    this.nodes = Array.from({ length: nodeCount }, (_, idx) => ({
      id: `node-${idx + 1}`,
      state: NODE_STATES.FOLLOWER,
      alive: true,
      partitionGroup: 0,
      currentTerm: 0,
      votedFor: null,
      votesReceived: new Set(),
      log: [],
      commitIndex: 0,
      nextIndex: {},
      matchIndex: {},
      electionTimeout: this._randomElectionTimeout(),
      elapsedSinceHeartbeat: 0
    }));
  }

  /**
   * Returns the strict majority quorum threshold for the cluster.
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  /**
   * Returns the highest term across all cluster nodes.
   */
  getCurrentTerm() {
    return this.nodes.reduce((max, node) => Math.max(max, node.currentTerm), 0);
  }

  /**
   * Looks up a node by ID.
   */
  getNode(nodeId) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Unknown node ID: ${nodeId}`);
    }
    return node;
  }

  /**
   * Returns the active alive Leader node, or null if none exists.
   * When partitioned, returns the leader with the highest term if multiple stale leaders exist.
   */
  getLeader() {
    const leaders = this.nodes.filter((n) => n.alive && n.state === NODE_STATES.LEADER);
    if (leaders.length === 0) return null;
    leaders.sort((a, b) => b.currentTerm - a.currentTerm);
    return leaders[0];
  }

  /**
   * Returns all alive leaders (useful during partitions before old leader steps down).
   */
  getLeaders() {
    return this.nodes.filter((n) => n.alive && n.state === NODE_STATES.LEADER);
  }

  _randomElectionTimeout() {
    const span = this.maxElectionTimeout - this.minElectionTimeout;
    return Math.round(this.minElectionTimeout + this.randomFn() * span);
  }

  _canCommunicate(nodeA, nodeB) {
    if (!nodeA.alive || !nodeB.alive) return false;
    if (nodeA.id === nodeB.id) return true;
    return nodeA.partitionGroup === nodeB.partitionGroup;
  }

  _recordRpc(packet) {
    const entry = {
      seq: ++this._packetSeq,
      timestamp: new Date().toISOString(),
      ...packet
    };
    this.rpcHistory.push(entry);
    if (this.rpcHistory.length > 200) {
      this.rpcHistory.shift();
    }
    return entry;
  }

  _stepDownToFollower(node, newTerm) {
    if (newTerm > node.currentTerm) {
      node.currentTerm = newTerm;
      node.votedFor = null;
    }
    node.state = NODE_STATES.FOLLOWER;
    node.votesReceived.clear();
  }

  _isLogUpToDate(candidate, voter) {
    const candLastTerm = candidate.log.length > 0 ? candidate.log[candidate.log.length - 1].term : 0;
    const candLastIndex = candidate.log.length;
    const voterLastTerm = voter.log.length > 0 ? voter.log[voter.log.length - 1].term : 0;
    const voterLastIndex = voter.log.length;

    if (candLastTerm !== voterLastTerm) {
      return candLastTerm > voterLastTerm;
    }
    return candLastIndex >= voterLastIndex;
  }

  _becomeLeader(candidate) {
    candidate.state = NODE_STATES.LEADER;
    candidate.elapsedSinceHeartbeat = 0;
    const nextIdx = candidate.log.length + 1;
    for (const peer of this.nodes) {
      if (peer.id !== candidate.id) {
        candidate.nextIndex[peer.id] = nextIdx;
        candidate.matchIndex[peer.id] = 0;
      }
    }
  }

  /**
   * Starts a leader election from the given node.
   * Increments term, votes for self, dispatches RequestVote RPCs to reachable peers,
   * and transitions to Leader if majority quorum is reached.
   */
  startElection(nodeId) {
    const candidate = this.getNode(nodeId);
    if (!candidate.alive) {
      return {
        elected: false,
        reason: 'NODE_OFFLINE',
        nodeId,
        term: candidate.currentTerm,
        votes: 0,
        quorum: this.getQuorumSize(),
        packets: []
      };
    }

    candidate.currentTerm += 1;
    candidate.state = NODE_STATES.CANDIDATE;
    candidate.votedFor = candidate.id;
    candidate.votesReceived = new Set([candidate.id]);
    candidate.elapsedSinceHeartbeat = 0;
    candidate.electionTimeout = this._randomElectionTimeout();

    const packets = [];
    const quorum = this.getQuorumSize();

    for (const peer of this.nodes) {
      if (peer.id === candidate.id) continue;
      if (!this._canCommunicate(candidate, peer)) {
        packets.push(
          this._recordRpc({
            type: 'RequestVote',
            from: candidate.id,
            to: peer.id,
            term: candidate.currentTerm,
            delivered: false,
            granted: false,
            detail: 'Dropped (offline or partitioned)'
          })
        );
        continue;
      }

      const voteResult = this._handleRequestVote(candidate, peer);
      packets.push(
        this._recordRpc({
          type: 'RequestVote',
          from: candidate.id,
          to: peer.id,
          term: candidate.currentTerm,
          delivered: true,
          granted: voteResult.voteGranted,
          detail: voteResult.voteGranted ? 'VoteGranted' : voteResult.reason
        })
      );

      if (voteResult.term > candidate.currentTerm) {
        this._stepDownToFollower(candidate, voteResult.term);
        return {
          elected: false,
          splitVote: false,
          steppedDown: true,
          nodeId: candidate.id,
          term: candidate.currentTerm,
          votes: candidate.votesReceived.size,
          quorum,
          packets
        };
      }

      if (voteResult.voteGranted) {
        candidate.votesReceived.add(peer.id);
      }
    }

    const elected = candidate.state === NODE_STATES.CANDIDATE && candidate.votesReceived.size >= quorum;
    if (elected) {
      this._becomeLeader(candidate);
      const hb = this._sendHeartbeatsFromLeader(candidate);
      packets.push(...hb.packets);
    }

    return {
      elected,
      splitVote: !elected,
      leaderId: elected ? candidate.id : null,
      nodeId: candidate.id,
      term: candidate.currentTerm,
      votes: candidate.votesReceived.size,
      quorum,
      packets
    };
  }

  /**
   * Simulates simultaneous elections by multiple candidates in the same term,
   * modeling split-vote conditions before RPC delivery.
   * @param {string[]} candidateIds
   */
  triggerSimultaneousElections(candidateIds) {
    const candidates = candidateIds.map((id) => this.getNode(id)).filter((n) => n.alive);
    if (candidates.length === 0) {
      return { elected: false, leaderId: null, splitVote: false, results: [], packets: [] };
    }

    const quorum = this.getQuorumSize();
    const packets = [];

    // Phase 1: all candidates advance term and self-vote before RPCs arrive
    for (const candidate of candidates) {
      candidate.currentTerm += 1;
      candidate.state = NODE_STATES.CANDIDATE;
      candidate.votedFor = candidate.id;
      candidate.votesReceived = new Set([candidate.id]);
      candidate.elapsedSinceHeartbeat = 0;
      candidate.electionTimeout = this._randomElectionTimeout();
    }

    // Phase 2: interleave RequestVote RPCs across candidates to peers
    const nonCandidates = this.nodes.filter((n) => !candidates.some((c) => c.id === n.id));
    const maxPeers = Math.max(this.nodes.length - 1, 0);

    // Build peer order per candidate so non-candidates are distributed round-robin
    const peerQueues = candidates.map((cand, idx) => {
      const others = this.nodes.filter((n) => n.id !== cand.id);
      const rotatedNonCands = nonCandidates.map(
        (_, i) => nonCandidates[(i + idx) % Math.max(nonCandidates.length, 1)]
      );
      const candPeers = others.filter((n) => candidates.some((c) => c.id === n.id));
      return [...rotatedNonCands.filter((n) => n && n.id !== cand.id), ...candPeers];
    });

    for (let round = 0; round < maxPeers; round++) {
      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        const candidate = candidates[cIdx];
        const peer = peerQueues[cIdx][round];
        if (!peer || candidate.state !== NODE_STATES.CANDIDATE) continue;

        if (!this._canCommunicate(candidate, peer)) {
          packets.push(
            this._recordRpc({
              type: 'RequestVote',
              from: candidate.id,
              to: peer.id,
              term: candidate.currentTerm,
              delivered: false,
              granted: false,
              detail: 'Dropped (offline or partitioned)'
            })
          );
          continue;
        }

        const res = this._handleRequestVote(candidate, peer);
        packets.push(
          this._recordRpc({
            type: 'RequestVote',
            from: candidate.id,
            to: peer.id,
            term: candidate.currentTerm,
            delivered: true,
            granted: res.voteGranted,
            detail: res.voteGranted ? 'VoteGranted' : res.reason
          })
        );

        if (res.term > candidate.currentTerm) {
          this._stepDownToFollower(candidate, res.term);
        } else if (res.voteGranted) {
          candidate.votesReceived.add(peer.id);
        }
      }
    }

    let electedLeader = null;
    const results = candidates.map((cand) => {
      const won = cand.state === NODE_STATES.CANDIDATE && cand.votesReceived.size >= quorum;
      if (won && !electedLeader) {
        this._becomeLeader(cand);
        electedLeader = cand;
        const hb = this._sendHeartbeatsFromLeader(cand);
        packets.push(...hb.packets);
      }
      return {
        nodeId: cand.id,
        term: cand.currentTerm,
        votes: cand.votesReceived.size,
        elected: won
      };
    });

    return {
      elected: Boolean(electedLeader),
      splitVote: !electedLeader,
      leaderId: electedLeader ? electedLeader.id : null,
      quorum,
      results,
      packets
    };
  }

  _handleRequestVote(candidate, voter) {
    if (candidate.currentTerm < voter.currentTerm) {
      return { term: voter.currentTerm, voteGranted: false, reason: 'StaleTerm' };
    }

    if (candidate.currentTerm > voter.currentTerm) {
      this._stepDownToFollower(voter, candidate.currentTerm);
    }

    const canVoteForCandidate = voter.votedFor === null || voter.votedFor === candidate.id;
    const logOk = this._isLogUpToDate(candidate, voter);

    if (canVoteForCandidate && logOk) {
      voter.votedFor = candidate.id;
      voter.elapsedSinceHeartbeat = 0;
      voter.electionTimeout = this._randomElectionTimeout();
      return { term: voter.currentTerm, voteGranted: true, reason: 'Granted' };
    }

    return {
      term: voter.currentTerm,
      voteGranted: false,
      reason: canVoteForCandidate ? 'OutdatedLog' : `AlreadyVoted(${voter.votedFor})`
    };
  }

  /**
   * Sends AppendEntries heartbeats (and any uncommitted/missing log entries)
   * from all active leaders to reachable followers.
   */
  sendHeartbeats() {
    const leaders = this.getLeaders();
    if (leaders.length === 0) {
      return { sent: false, reason: 'NO_LEADER', packets: [], committedIndices: [] };
    }

    const allPackets = [];
    const committedIndices = [];

    for (const leader of leaders) {
      if (!leader.alive || leader.state !== NODE_STATES.LEADER) continue;
      const result = this._sendHeartbeatsFromLeader(leader);
      allPackets.push(...result.packets);
      committedIndices.push({ leaderId: leader.id, commitIndex: leader.commitIndex });
    }

    return {
      sent: true,
      packets: allPackets,
      committedIndices
    };
  }

  _sendHeartbeatsFromLeader(leader) {
    const packets = [];
    const quorum = this.getQuorumSize();

    for (const peer of this.nodes) {
      if (peer.id === leader.id) continue;
      if (!this._canCommunicate(leader, peer)) {
        packets.push(
          this._recordRpc({
            type: 'Heartbeat',
            from: leader.id,
            to: peer.id,
            term: leader.currentTerm,
            delivered: false,
            success: false,
            detail: 'Dropped (offline or partitioned)'
          })
        );
        continue;
      }

      const aeResult = this._replicateToPeer(leader, peer);
      packets.push(
        this._recordRpc({
          type: aeResult.entriesSent > 0 ? 'AppendEntries' : 'Heartbeat',
          from: leader.id,
          to: peer.id,
          term: leader.currentTerm,
          delivered: true,
          success: aeResult.success,
          entriesCount: aeResult.entriesSent,
          detail: aeResult.success
            ? aeResult.entriesSent > 0
              ? `Replicated ${aeResult.entriesSent} entry(s)`
              : 'Heartbeat ACK'
            : `Rejected (term ${aeResult.term})`
        })
      );

      if (aeResult.term > leader.currentTerm) {
        this._stepDownToFollower(leader, aeResult.term);
        return { steppedDown: true, packets };
      }
    }

    // Advance leader commitIndex for current-term entries replicated on a majority
    for (let idx = leader.commitIndex + 1; idx <= leader.log.length; idx++) {
      const entry = leader.log[idx - 1];
      if (!entry || entry.term !== leader.currentTerm) continue;

      let ackCount = 1; // leader itself
      for (const peer of this.nodes) {
        if (peer.id !== leader.id && (leader.matchIndex[peer.id] || 0) >= idx) {
          ackCount += 1;
        }
      }

      if (ackCount >= quorum) {
        leader.commitIndex = idx;
        entry.committed = true;
      }
    }

    // Propagate updated commitIndex to reachable peers
    for (const peer of this.nodes) {
      if (peer.id === leader.id || !this._canCommunicate(leader, peer)) continue;
      const newPeerCommit = Math.min(leader.commitIndex, peer.log.length);
      if (newPeerCommit > peer.commitIndex) {
        peer.commitIndex = newPeerCommit;
        for (let i = 0; i < peer.commitIndex; i++) {
          peer.log[i].committed = true;
        }
      }
    }

    return { steppedDown: false, packets };
  }

  _replicateToPeer(leader, peer) {
    if (peer.currentTerm > leader.currentTerm) {
      return { term: peer.currentTerm, success: false, entriesSent: 0 };
    }

    if (peer.currentTerm < leader.currentTerm || peer.state !== NODE_STATES.FOLLOWER) {
      this._stepDownToFollower(peer, leader.currentTerm);
    }

    peer.elapsedSinceHeartbeat = 0;
    peer.electionTimeout = this._randomElectionTimeout();

    let nextIdx = leader.nextIndex[peer.id] ?? leader.log.length + 1;
    let prevLogIndex = nextIdx - 1;

    // Backtrack nextIndex if follower log conflicts with leader log
    while (prevLogIndex > 0) {
      const peerPrevTerm = peer.log[prevLogIndex - 1]?.term ?? 0;
      const leaderPrevTerm = leader.log[prevLogIndex - 1]?.term ?? 0;
      if (peer.log.length >= prevLogIndex && peerPrevTerm === leaderPrevTerm) {
        break;
      }
      nextIdx -= 1;
      prevLogIndex = nextIdx - 1;
    }

    // Truncate conflicting uncommitted entries on peer
    if (peer.log.length > prevLogIndex) {
      peer.log = peer.log.slice(0, prevLogIndex);
    }

    const entriesToSend = leader.log.slice(prevLogIndex).map((e) => ({ ...e, committed: false }));
    for (const entry of entriesToSend) {
      peer.log.push(entry);
    }

    leader.matchIndex[peer.id] = peer.log.length;
    leader.nextIndex[peer.id] = peer.log.length + 1;

    const peerCommit = Math.min(leader.commitIndex, peer.log.length);
    if (peerCommit > peer.commitIndex) {
      peer.commitIndex = peerCommit;
      for (let i = 0; i < peer.commitIndex; i++) {
        peer.log[i].committed = true;
      }
    }

    return {
      term: peer.currentTerm,
      success: true,
      entriesSent: entriesToSend.length
    };
  }

  /**
   * Appends a command to the active leader's log and replicates across the cluster.
   * Commits only if a majority quorum acknowledges the entry.
   */
  replicateLog(command) {
    const trimmed = typeof command === 'string' ? command.trim() : String(command ?? '');
    if (!trimmed) {
      return { success: false, committed: false, error: 'Command must not be empty', packets: [] };
    }

    const leader = this.getLeader();
    if (!leader) {
      return { success: false, committed: false, error: 'No active leader available', packets: [] };
    }

    const entry = {
      index: leader.log.length + 1,
      term: leader.currentTerm,
      command: trimmed,
      committed: false
    };
    leader.log.push(entry);

    const hbResult = this._sendHeartbeatsFromLeader(leader);
    const committed = leader.commitIndex >= entry.index;

    let replicatedCount = 1;
    for (const peer of this.nodes) {
      if (peer.id !== leader.id && (leader.matchIndex[peer.id] || 0) >= entry.index) {
        replicatedCount += 1;
      }
    }

    return {
      success: true,
      committed,
      leaderId: leader.id,
      term: leader.currentTerm,
      entry: { ...entry, committed },
      commitIndex: leader.commitIndex,
      replicatedCount,
      quorum: this.getQuorumSize(),
      packets: hbResult.packets
    };
  }

  /**
   * Simulates sudden crash/failure of a node.
   * If the node was Leader, it steps offline and stops sending heartbeats.
   */
  handleNodeFailure(nodeId) {
    const node = this.getNode(nodeId);
    const wasLeader = node.alive && node.state === NODE_STATES.LEADER;
    node.alive = false;
    node.state = NODE_STATES.FOLLOWER;
    node.votesReceived.clear();

    return {
      success: true,
      nodeId: node.id,
      wasLeader,
      alive: false
    };
  }

  /**
   * Brings a failed node back online as a Follower.
   */
  recoverNode(nodeId) {
    const node = this.getNode(nodeId);
    node.alive = true;
    node.state = NODE_STATES.FOLLOWER;
    node.votesReceived.clear();
    node.elapsedSinceHeartbeat = 0;
    node.electionTimeout = this._randomElectionTimeout();

    return {
      success: true,
      nodeId: node.id,
      alive: true,
      state: node.state
    };
  }

  /**
   * Partitions or heals the cluster network.
   * When enabled without explicit minorityIds, isolates a minority subset (including any active leader)
   * into partitionGroup 1 and the majority into partitionGroup 0.
   */
  setPartition(enabled, minorityIds = null) {
    this.partitioned = Boolean(enabled);
    if (!this.partitioned) {
      for (const node of this.nodes) {
        node.partitionGroup = 0;
      }
      return { partitioned: false, groups: { 0: this.nodes.map((n) => n.id), 1: [] } };
    }

    const minoritySet = new Set();
    const maxMinority = Math.max(1, Math.floor(this.nodes.length / 2));

    if (Array.isArray(minorityIds) && minorityIds.length > 0) {
      for (const id of minorityIds) {
        minoritySet.add(this.getNode(id).id);
      }
    } else {
      const currentLeader = this.getLeader();
      if (currentLeader) {
        minoritySet.add(currentLeader.id);
      }
      for (const node of this.nodes) {
        if (minoritySet.size >= maxMinority) break;
        minoritySet.add(node.id);
      }
    }

    for (const node of this.nodes) {
      node.partitionGroup = minoritySet.has(node.id) ? 1 : 0;
    }

    return {
      partitioned: true,
      groups: {
        0: this.nodes.filter((n) => n.partitionGroup === 0).map((n) => n.id),
        1: this.nodes.filter((n) => n.partitionGroup === 1).map((n) => n.id)
      }
    };
  }

  togglePartition(minorityIds = null) {
    return this.setPartition(!this.partitioned, minorityIds);
  }

  /**
   * Advances simulation clock by deltaMs, triggering leader heartbeats and
   * follower/candidate election timeouts automatically.
   */
  tick(deltaMs = 25) {
    const packets = [];
    const electionsTriggered = [];

    this.elapsedHeartbeatTimer += deltaMs;
    const leaders = this.getLeaders();
    if (leaders.length > 0 && this.elapsedHeartbeatTimer >= this.heartbeatInterval) {
      this.elapsedHeartbeatTimer = 0;
      const hb = this.sendHeartbeats();
      packets.push(...hb.packets);
    }

    for (const node of this.nodes) {
      if (!node.alive || node.state === NODE_STATES.LEADER) continue;
      node.elapsedSinceHeartbeat += deltaMs;
      if (node.elapsedSinceHeartbeat >= node.electionTimeout) {
        const res = this.startElection(node.id);
        electionsTriggered.push(res);
        packets.push(...res.packets);
      }
    }

    return { packets, electionsTriggered };
  }

  /**
   * Returns a serializable snapshot of the cluster state.
   */
  getStateSnapshot() {
    const leader = this.getLeader();
    return {
      nodeCount: this.nodes.length,
      quorumSize: this.getQuorumSize(),
      currentTerm: this.getCurrentTerm(),
      leaderId: leader ? leader.id : null,
      partitioned: this.partitioned,
      nodes: this.nodes.map((n) => ({
        id: n.id,
        state: n.state,
        alive: n.alive,
        partitionGroup: n.partitionGroup,
        currentTerm: n.currentTerm,
        votedFor: n.votedFor,
        votesCount: n.votesReceived.size,
        commitIndex: n.commitIndex,
        electionTimeout: n.electionTimeout,
        elapsedSinceHeartbeat: n.elapsedSinceHeartbeat,
        log: n.log.map((entry) => ({ ...entry }))
      }))
    };
  }
}

// Browser UI Controller (guarded for isolated Node.js unit testing)
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    let cluster = new QuantumForgeRaftCluster({ nodeCount: 5 });
    let autoTimer = null;

    const clusterSizeSelect = document.getElementById('cluster-size-select');
    const termCounterEl = document.getElementById('term-counter');
    const leaderBadgeEl = document.getElementById('leader-badge');
    const quorumBadgeEl = document.getElementById('quorum-badge');
    const partitionStatusEl = document.getElementById('partition-status');
    const clusterGridEl = document.getElementById('cluster-nodes');
    const packetLayerEl = document.getElementById('packet-layer');
    const logViewerEl = document.getElementById('log-replication-viewer');
    const rpcLogEl = document.getElementById('rpc-event-log');

    const autoTickBtn = document.getElementById('toggle-sim-btn');
    const stepTickBtn = document.getElementById('step-tick-btn');
    const heartbeatBtn = document.getElementById('send-heartbeat-btn');
    const partitionBtn = document.getElementById('partition-toggle-btn');
    const splitVoteBtn = document.getElementById('split-vote-btn');
    const resetClusterBtn = document.getElementById('reset-cluster-btn');
    const commandInput = document.getElementById('command-input');
    const replicateBtn = document.getElementById('replicate-cmd-btn');

    function spawnPacketAnimation(packet) {
      if (!packetLayerEl || !clusterGridEl) return;
      const fromCard = clusterGridEl.querySelector(`[data-node-id="${packet.from}"]`);
      const toCard = clusterGridEl.querySelector(`[data-node-id="${packet.to}"]`);
      if (!fromCard || !toCard) return;

      const layerRect = packetLayerEl.getBoundingClientRect();
      const fromRect = fromCard.getBoundingClientRect();
      const toRect = toCard.getBoundingClientRect();

      const startX = fromRect.left - layerRect.left + fromRect.width / 2;
      const startY = fromRect.top - layerRect.top + fromRect.height / 2;
      const endX = toRect.left - layerRect.left + toRect.width / 2;
      const endY = toRect.top - layerRect.top + toRect.height / 2;

      const dot = document.createElement('div');
      const typeClass =
        packet.type === 'RequestVote'
          ? 'packet-vote'
          : packet.type === 'AppendEntries'
            ? 'packet-append'
            : 'packet-heartbeat';
      dot.className = `rpc-packet ${typeClass}${packet.delivered ? '' : ' packet-dropped'}`;
      dot.style.setProperty('--start-x', `${startX}px`);
      dot.style.setProperty('--start-y', `${startY}px`);
      dot.style.setProperty('--end-x', `${endX}px`);
      dot.style.setProperty('--end-y', `${endY}px`);
      dot.title = `${packet.type}: ${packet.from} -> ${packet.to} (T${packet.term})`;

      const label = document.createElement('span');
      label.className = 'packet-label';
      label.textContent = packet.type === 'RequestVote' ? 'RV' : packet.type === 'AppendEntries' ? 'AE' : 'HB';
      dot.appendChild(label);

      packetLayerEl.appendChild(dot);
      dot.addEventListener('animationend', () => dot.remove());
      setTimeout(() => dot.remove(), 900);
    }

    function animatePackets(packets = []) {
      packets.slice(0, 14).forEach((pkt, idx) => {
        setTimeout(() => spawnPacketAnimation(pkt), idx * 40);
      });
    }

    function renderRpcLog() {
      if (!rpcLogEl) return;
      rpcLogEl.textContent = '';
      const entries = cluster.rpcHistory.slice(-18).reverse();
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'rpc-entry muted';
        empty.textContent = 'No RPC messages dispatched yet. Start an election or run simulation.';
        rpcLogEl.appendChild(empty);
        return;
      }

      for (const item of entries) {
        const row = document.createElement('div');
        row.className = `rpc-entry ${item.delivered ? 'delivered' : 'dropped'}`;
        row.textContent = `[T${item.term}] ${item.type} ${item.from} -> ${item.to}: ${item.detail}`;
        rpcLogEl.appendChild(row);
      }
    }

    function renderLogReplicationViewer(snapshot) {
      if (!logViewerEl) return;
      logViewerEl.textContent = '';

      for (const node of snapshot.nodes) {
        const row = document.createElement('div');
        row.className = `log-node-row${node.alive ? '' : ' offline'}`;

        const header = document.createElement('div');
        header.className = 'log-node-meta';
        header.textContent = `${node.id} (${node.state}${node.alive ? '' : ' / DEAD'}) · commit=${node.commitIndex}`;
        row.appendChild(header);

        const cells = document.createElement('div');
        cells.className = 'log-entries-strip';
        if (node.log.length === 0) {
          const empty = document.createElement('span');
          empty.className = 'log-empty';
          empty.textContent = 'Empty log';
          cells.appendChild(empty);
        } else {
          for (const entry of node.log) {
            const cell = document.createElement('span');
            cell.className = `log-cell ${entry.committed ? 'committed' : 'uncommitted'}`;
            cell.textContent = `#${entry.index} [T${entry.term}] ${entry.command}`;
            cells.appendChild(cell);
          }
        }
        row.appendChild(cells);
        logViewerEl.appendChild(row);
      }
    }

    function render() {
      const snapshot = cluster.getStateSnapshot();
      if (termCounterEl) termCounterEl.textContent = String(snapshot.currentTerm);
      if (leaderBadgeEl) leaderBadgeEl.textContent = snapshot.leaderId || 'None';
      if (quorumBadgeEl) quorumBadgeEl.textContent = `${snapshot.quorumSize} / ${snapshot.nodeCount}`;
      if (partitionStatusEl) {
        partitionStatusEl.textContent = snapshot.partitioned ? 'PARTITIONED' : 'Healthy Mesh';
        partitionStatusEl.className = `stat-value ${snapshot.partitioned ? 'status-danger' : 'status-ok'}`;
      }
      if (partitionBtn) {
        partitionBtn.textContent = snapshot.partitioned ? 'Heal Network Partition' : 'Partition Network';
        partitionBtn.classList.toggle('active-danger', snapshot.partitioned);
      }

      if (clusterGridEl) {
        clusterGridEl.dataset.count = String(snapshot.nodeCount);
        clusterGridEl.textContent = '';

        for (const node of snapshot.nodes) {
          const stateClass = node.state.toLowerCase();
          const card = document.createElement('article');
          card.className = `node-card ${stateClass}${node.alive ? '' : ' dead'}${
            snapshot.partitioned && node.partitionGroup === 1 ? ' partitioned-minority' : ''
          }`;
          card.dataset.nodeId = node.id;

          const top = document.createElement('div');
          top.className = 'node-card-header';
          const title = document.createElement('span');
          title.className = 'node-id';
          title.textContent = node.id.toUpperCase();

          const role = document.createElement('span');
          role.className = `role-pill ${stateClass}`;
          role.textContent = node.alive ? node.state : 'OFFLINE';
          top.append(title, role);

          const meta = document.createElement('div');
          meta.className = 'node-meta';
          const metaLines = [
            `Term: ${node.currentTerm}`,
            `Voted For: ${node.votedFor || '—'}`,
            `Commit Idx: ${node.commitIndex}`,
            `Partition: ${snapshot.partitioned ? (node.partitionGroup === 1 ? 'Minority' : 'Majority') : 'Mesh'}`
          ];
          for (const line of metaLines) {
            const span = document.createElement('span');
            span.textContent = line;
            meta.appendChild(span);
          }

          const progressWrap = document.createElement('div');
          progressWrap.className = 'timeout-bar-wrap';
          const progressFill = document.createElement('div');
          progressFill.className = 'timeout-bar-fill';
          const pct =
            node.state === NODE_STATES.LEADER || !node.alive
              ? 0
              : Math.min(100, Math.round((node.elapsedSinceHeartbeat / node.electionTimeout) * 100));
          progressFill.style.width = `${pct}%`;
          progressWrap.appendChild(progressFill);

          const actions = document.createElement('div');
          actions.className = 'node-actions';

          const electBtn = document.createElement('button');
          electBtn.className = 'mini-btn';
          electBtn.textContent = 'Start Election';
          electBtn.disabled = !node.alive;
          electBtn.addEventListener('click', () => {
            const res = cluster.startElection(node.id);
            render();
            animatePackets(res.packets);
          });

          const killBtn = document.createElement('button');
          killBtn.className = `mini-btn ${node.alive ? 'danger-btn' : 'success-btn'}`;
          killBtn.textContent = node.alive ? 'Kill Node' : 'Revive Node';
          killBtn.addEventListener('click', () => {
            if (node.alive) {
              cluster.handleNodeFailure(node.id);
            } else {
              cluster.recoverNode(node.id);
            }
            render();
          });

          actions.append(electBtn, killBtn);
          card.append(top, meta, progressWrap, actions);
          clusterGridEl.appendChild(card);
        }
      }

      renderLogReplicationViewer(snapshot);
      renderRpcLog();
    }

    function stopAutoSim() {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
      if (autoTickBtn) autoTickBtn.textContent = 'Start Auto Simulation';
    }

    if (autoTickBtn) {
      autoTickBtn.addEventListener('click', () => {
        if (autoTimer) {
          stopAutoSim();
          return;
        }
        autoTickBtn.textContent = 'Pause Simulation';
        autoTimer = setInterval(() => {
          const res = cluster.tick(25);
          render();
          if (res.packets.length > 0) animatePackets(res.packets);
        }, 220);
      });
    }

    if (stepTickBtn) {
      stepTickBtn.addEventListener('click', () => {
        const res = cluster.tick(60);
        render();
        animatePackets(res.packets);
      });
    }

    if (heartbeatBtn) {
      heartbeatBtn.addEventListener('click', () => {
        const res = cluster.sendHeartbeats();
        render();
        animatePackets(res.packets);
      });
    }

    if (partitionBtn) {
      partitionBtn.addEventListener('click', () => {
        cluster.togglePartition();
        render();
      });
    }

    if (splitVoteBtn) {
      splitVoteBtn.addEventListener('click', () => {
        const ids = cluster.nodes.slice(0, Math.min(3, cluster.nodes.length)).map((n) => n.id);
        const res = cluster.triggerSimultaneousElections(ids);
        render();
        animatePackets(res.packets);
      });
    }

    if (replicateBtn && commandInput) {
      const submitCommand = () => {
        const cmd = commandInput.value.trim() || `SET qbit=${Math.floor(Math.random() * 999)}`;
        const res = cluster.replicateLog(cmd);
        if (res.success) {
          commandInput.value = '';
        }
        render();
        animatePackets(res.packets);
      };
      replicateBtn.addEventListener('click', submitCommand);
      commandInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitCommand();
      });
    }

    if (clusterSizeSelect) {
      clusterSizeSelect.addEventListener('change', () => {
        stopAutoSim();
        const count = Number(clusterSizeSelect.value) || 5;
        cluster = new QuantumForgeRaftCluster({ nodeCount: count });
        render();
      });
    }

    if (resetClusterBtn) {
      resetClusterBtn.addEventListener('click', () => {
        stopAutoSim();
        const count = clusterSizeSelect ? Number(clusterSizeSelect.value) || 5 : 5;
        cluster = new QuantumForgeRaftCluster({ nodeCount: count });
        render();
      });
    }

    render();
  });
}
