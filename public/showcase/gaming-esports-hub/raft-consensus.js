export const NODE_STATES = Object.freeze({
  FOLLOWER: 'FOLLOWER',
  CANDIDATE: 'CANDIDATE',
  LEADER: 'LEADER',
  DEAD: 'DEAD'
});

const DEFAULT_REGION_LABELS = [
  'NA-EAST',
  'EU-WEST',
  'AP-NORTH',
  'SA-SOUTH',
  'OC-PRIME',
  'EU-CENTRAL',
  'NA-WEST'
];

/**
 * Simulated multi-node Raft consensus & leader election state machine
 * for Gaming Esports Hub (Vortex Arena).
 */
export class GamingEsportsHubRaftCluster {
  #rng;
  #rpcCounter = 0;
  #eventCounter = 0;

  constructor(options = {}) {
    const requestedCount = options.nodeIds ? options.nodeIds.length : (options.nodeCount ?? 5);
    if (!Number.isInteger(requestedCount) || requestedCount < 1) {
      throw new RangeError('Cluster must contain at least 1 node.');
    }

    this.electionTimeoutMin = options.electionTimeoutMin ?? 150;
    this.electionTimeoutMax = options.electionTimeoutMax ?? 300;
    if (this.electionTimeoutMin <= 0 || this.electionTimeoutMax < this.electionTimeoutMin) {
      throw new RangeError('Invalid election timeout bounds.');
    }

    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 50;
    this.#rng = typeof options.rng === 'function' ? options.rng : Math.random;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    this.onRpc = typeof options.onRpc === 'function' ? options.onRpc : null;

    const ids = options.nodeIds ?? Array.from({ length: requestedCount }, (_, i) => `node-${i + 1}`);
    this.nodes = ids.map((id, idx) => ({
      id,
      label: `${id.toUpperCase()} · ${DEFAULT_REGION_LABELS[idx % DEFAULT_REGION_LABELS.length]}`,
      state: NODE_STATES.FOLLOWER,
      alive: true,
      currentTerm: 0,
      votedFor: null,
      log: [],
      commitIndex: 0,
      lastApplied: 0,
      appliedCommands: [],
      votesReceived: new Set(),
      electionTimeoutMs: this.#nextElectionTimeout(),
      electionElapsedMs: 0,
      heartbeatElapsedMs: 0,
      partitionGroup: 0,
      nextIndex: {},
      matchIndex: {}
    }));

    this.rpcHistory = [];
    this.eventLog = [];
    this.#recordEvent('CLUSTER_INIT', `Initialized ${this.nodes.length}-node Raft cluster (quorum: ${this.getQuorumSize()}).`, 0);
  }

  #nextElectionTimeout() {
    const span = this.electionTimeoutMax - this.electionTimeoutMin;
    return Math.round(this.electionTimeoutMin + this.#rng() * span);
  }

  #recordEvent(type, message, term = this.getCurrentTerm()) {
    const entry = {
      id: ++this.#eventCounter,
      type,
      term,
      message,
      timestamp: Date.now()
    };
    this.eventLog.unshift(entry);
    if (this.eventLog.length > 60) {
      this.eventLog.length = 60;
    }
    return entry;
  }

  #emitRpc(rpc) {
    const record = {
      id: ++this.#rpcCounter,
      timestamp: Date.now(),
      ...rpc
    };
    this.rpcHistory.unshift(record);
    if (this.rpcHistory.length > 80) {
      this.rpcHistory.length = 80;
    }
    if (this.onRpc) {
      this.onRpc(record);
    }
    return record;
  }

  #notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange(this.getSnapshot());
    }
  }

  #lastLogInfo(node) {
    if (node.log.length === 0) {
      return { index: 0, term: 0 };
    }
    const last = node.log[node.log.length - 1];
    return { index: last.index, term: last.term };
  }

  #isLogAtLeastAsUpToDate(candidateLastIndex, candidateLastTerm, peer) {
    const peerLast = this.#lastLogInfo(peer);
    if (candidateLastTerm !== peerLast.term) {
      return candidateLastTerm > peerLast.term;
    }
    return candidateLastIndex >= peerLast.index;
  }

  #applyCommittedEntries(node) {
    while (node.lastApplied < node.commitIndex && node.lastApplied < node.log.length) {
      node.lastApplied += 1;
      const entry = node.log[node.lastApplied - 1];
      entry.committed = true;
      node.appliedCommands.push(entry.command);
    }
  }

  #stepDownToFollower(node, newTerm) {
    if (newTerm > node.currentTerm) {
      node.currentTerm = newTerm;
      node.votedFor = null;
    }
    node.state = NODE_STATES.FOLLOWER;
    node.votesReceived.clear();
  }

  #promoteToLeader(node) {
    node.state = NODE_STATES.LEADER;
    node.heartbeatElapsedMs = 0;
    node.electionElapsedMs = 0;
    const nextIdx = node.log.length + 1;
    node.nextIndex = {};
    node.matchIndex = {};
    for (const peer of this.nodes) {
      if (peer.id === node.id) {
        node.matchIndex[peer.id] = node.log.length;
        node.nextIndex[peer.id] = nextIdx;
      } else {
        node.nextIndex[peer.id] = nextIdx;
        node.matchIndex[peer.id] = 0;
      }
    }
    this.#recordEvent('LEADER_ELECTED', `${node.id} elected LEADER for Term ${node.currentTerm} (${node.votesReceived.size}/${this.nodes.length} votes).`, node.currentTerm);
  }

  #handleRequestVote(candidate, peer, term, candidateLastIndex, candidateLastTerm) {
    if (!this.canCommunicate(candidate.id, peer.id)) {
      this.#emitRpc({
        type: 'RequestVote',
        from: candidate.id,
        to: peer.id,
        term,
        delivered: false,
        voteGranted: false
      });
      return { term: peer.currentTerm, voteGranted: false, delivered: false };
    }

    if (term < peer.currentTerm) {
      this.#emitRpc({
        type: 'RequestVote',
        from: candidate.id,
        to: peer.id,
        term,
        delivered: true,
        voteGranted: false
      });
      return { term: peer.currentTerm, voteGranted: false, delivered: true };
    }

    if (term > peer.currentTerm) {
      this.#stepDownToFollower(peer, term);
    }

    const canVote = peer.votedFor === null || peer.votedFor === candidate.id;
    const logOk = this.#isLogAtLeastAsUpToDate(candidateLastIndex, candidateLastTerm, peer);
    const voteGranted = canVote && logOk;

    if (voteGranted) {
      peer.votedFor = candidate.id;
      peer.electionElapsedMs = 0;
    }

    this.#emitRpc({
      type: 'RequestVote',
      from: candidate.id,
      to: peer.id,
      term,
      delivered: true,
      voteGranted
    });

    if (voteGranted) {
      this.#emitRpc({
        type: 'VoteGranted',
        from: peer.id,
        to: candidate.id,
        term: peer.currentTerm,
        delivered: true,
        voteGranted: true
      });
    }

    return { term: peer.currentTerm, voteGranted, delivered: true };
  }

  #sendAppendEntriesToPeer(leader, peer) {
    if (!this.canCommunicate(leader.id, peer.id)) {
      this.#emitRpc({
        type: 'AppendEntries',
        from: leader.id,
        to: peer.id,
        term: leader.currentTerm,
        entriesCount: 0,
        delivered: false,
        success: false
      });
      return { term: leader.currentTerm, success: false, delivered: false };
    }

    const nextIdx = leader.nextIndex[peer.id] ?? (leader.log.length + 1);
    const prevLogIndex = Math.max(0, nextIdx - 1);
    const prevLogTerm = prevLogIndex > 0 ? (leader.log[prevLogIndex - 1]?.term ?? 0) : 0;
    const entries = leader.log.slice(prevLogIndex).map((entry) => ({
      index: entry.index,
      term: entry.term,
      command: entry.command,
      committed: entry.committed,
      timestamp: entry.timestamp
    }));

    if (leader.currentTerm < peer.currentTerm) {
      this.#emitRpc({
        type: 'AppendEntries',
        from: leader.id,
        to: peer.id,
        term: leader.currentTerm,
        entriesCount: entries.length,
        delivered: true,
        success: false
      });
      return { term: peer.currentTerm, success: false, delivered: true };
    }

    if (leader.currentTerm > peer.currentTerm || peer.state !== NODE_STATES.FOLLOWER) {
      this.#stepDownToFollower(peer, leader.currentTerm);
    }
    peer.electionElapsedMs = 0;

    const logMatches =
      prevLogIndex === 0 ||
      (peer.log.length >= prevLogIndex && peer.log[prevLogIndex - 1].term === prevLogTerm);

    if (!logMatches) {
      leader.nextIndex[peer.id] = Math.max(1, prevLogIndex);
      this.#emitRpc({
        type: 'AppendEntries',
        from: leader.id,
        to: peer.id,
        term: leader.currentTerm,
        entriesCount: entries.length,
        delivered: true,
        success: false
      });
      return { term: peer.currentTerm, success: false, delivered: true };
    }

    // Reconcile conflicting uncommitted entries and append new ones.
    let insertAt = prevLogIndex;
    for (const entry of entries) {
      const existing = peer.log[insertAt];
      if (existing && existing.term !== entry.term) {
        peer.log.length = insertAt;
      }
      if (!peer.log[insertAt]) {
        peer.log.push({ ...entry });
      }
      insertAt += 1;
    }

    if (leader.commitIndex > peer.commitIndex) {
      peer.commitIndex = Math.min(leader.commitIndex, peer.log.length);
      this.#applyCommittedEntries(peer);
    }

    leader.matchIndex[peer.id] = prevLogIndex + entries.length;
    leader.nextIndex[peer.id] = leader.matchIndex[peer.id] + 1;

    this.#emitRpc({
      type: 'AppendEntries',
      from: leader.id,
      to: peer.id,
      term: leader.currentTerm,
      entriesCount: entries.length,
      delivered: true,
      success: true
    });

    if (entries.length > 0) {
      this.#emitRpc({
        type: 'AppendAck',
        from: peer.id,
        to: leader.id,
        term: peer.currentTerm,
        entriesCount: entries.length,
        delivered: true,
        success: true
      });
    }

    return { term: peer.currentTerm, success: true, delivered: true };
  }

  #advanceLeaderCommitIndex(leader) {
    const quorum = this.getQuorumSize();
    leader.matchIndex[leader.id] = leader.log.length;

    for (let idx = leader.log.length; idx > leader.commitIndex; idx -= 1) {
      const entry = leader.log[idx - 1];
      if (entry.term !== leader.currentTerm) continue;
      let replicatedCount = 0;
      for (const node of this.nodes) {
        if ((leader.matchIndex[node.id] ?? 0) >= idx) {
          replicatedCount += 1;
        }
      }
      if (replicatedCount >= quorum) {
        leader.commitIndex = idx;
        this.#applyCommittedEntries(leader);
        return true;
      }
    }
    return false;
  }

  /**
   * Majority quorum size required for elections and log commits.
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  getNode(nodeId) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Unknown Raft node: ${nodeId}`);
    }
    return node;
  }

  getCurrentTerm() {
    return this.nodes.reduce((max, node) => Math.max(max, node.currentTerm), 0);
  }

  getLeaders() {
    return this.nodes.filter((n) => n.alive && n.state === NODE_STATES.LEADER);
  }

  getLeader() {
    const leaders = this.getLeaders();
    if (leaders.length === 0) return null;
    return leaders.reduce((best, curr) => (curr.currentTerm >= best.currentTerm ? curr : best), leaders[0]);
  }

  canCommunicate(fromId, toId) {
    const from = this.getNode(fromId);
    const to = this.getNode(toId);
    return from.alive && to.alive && from.partitionGroup === to.partitionGroup;
  }

  isPartitioned() {
    const groups = new Set(this.nodes.map((n) => n.partitionGroup));
    return groups.size > 1;
  }

  /**
   * Trigger a Raft leader election starting from `nodeId`.
   */
  startElection(nodeId) {
    const candidate = this.getNode(nodeId);
    const quorum = this.getQuorumSize();

    if (!candidate.alive) {
      return {
        elected: false,
        leaderId: null,
        term: candidate.currentTerm,
        votes: 0,
        quorum,
        reason: 'NODE_DEAD'
      };
    }

    candidate.currentTerm += 1;
    candidate.state = NODE_STATES.CANDIDATE;
    candidate.votedFor = candidate.id;
    candidate.votesReceived = new Set([candidate.id]);
    candidate.electionElapsedMs = 0;
    candidate.electionTimeoutMs = this.#nextElectionTimeout();

    const term = candidate.currentTerm;
    const { index: lastLogIndex, term: lastLogTerm } = this.#lastLogInfo(candidate);
    this.#recordEvent('ELECTION_START', `${candidate.id} started election for Term ${term}.`, term);

    for (const peer of this.nodes) {
      if (peer.id === candidate.id) continue;
      const res = this.#handleRequestVote(candidate, peer, term, lastLogIndex, lastLogTerm);
      if (res.delivered && res.term > candidate.currentTerm) {
        this.#stepDownToFollower(candidate, res.term);
        this.#recordEvent('STEP_DOWN', `${candidate.id} stepped down after seeing Term ${res.term} from ${peer.id}.`, res.term);
        this.#notifyStateChange();
        return {
          elected: false,
          leaderId: null,
          term: candidate.currentTerm,
          votes: candidate.votesReceived.size,
          quorum,
          reason: 'HIGHER_TERM'
        };
      }
      if (res.voteGranted) {
        candidate.votesReceived.add(peer.id);
      }
    }

    if (candidate.state === NODE_STATES.CANDIDATE && candidate.votesReceived.size >= quorum) {
      this.#promoteToLeader(candidate);
      this.sendHeartbeats();
      this.#notifyStateChange();
      return {
        elected: true,
        leaderId: candidate.id,
        term: candidate.currentTerm,
        votes: candidate.votesReceived.size,
        quorum
      };
    }

    this.#recordEvent(
      'ELECTION_NO_QUORUM',
      `${candidate.id} stalled in Term ${candidate.currentTerm} (${candidate.votesReceived.size}/${quorum} votes).`,
      candidate.currentTerm
    );
    this.#notifyStateChange();
    return {
      elected: false,
      leaderId: null,
      term: candidate.currentTerm,
      votes: candidate.votesReceived.size,
      quorum,
      reason: 'QUORUM_NOT_REACHED'
    };
  }

  /**
   * Simulate simultaneous candidate timeouts in the same term (split vote scenario).
   */
  startConcurrentElections(candidateIds) {
    const candidates = candidateIds
      .map((id) => this.getNode(id))
      .filter((node) => node.alive);

    const quorum = this.getQuorumSize();
    if (candidates.length === 0) {
      return { elected: false, leaderId: null, term: this.getCurrentTerm(), reason: 'NO_ALIVE_CANDIDATES' };
    }

    const electionTerm = this.getCurrentTerm() + 1;
    for (const candidate of candidates) {
      candidate.currentTerm = electionTerm;
      candidate.state = NODE_STATES.CANDIDATE;
      candidate.votedFor = candidate.id;
      candidate.votesReceived = new Set([candidate.id]);
      candidate.electionElapsedMs = 0;
      candidate.electionTimeoutMs = this.#nextElectionTimeout();
    }

    this.#recordEvent(
      'CONCURRENT_ELECTION',
      `Concurrent elections in Term ${electionTerm} by [${candidates.map((c) => c.id).join(', ')}].`,
      electionTerm
    );

    const candidateSet = new Set(candidates.map((c) => c.id));
    const remainingPeers = this.nodes.filter((n) => !candidateSet.has(n.id));

    // Round-robin RequestVote delivery across non-candidate peers so candidates contend for votes.
    remainingPeers.forEach((peer, idx) => {
      const preferredCandidate = candidates[idx % candidates.length];
      const ordered = [
        preferredCandidate,
        ...candidates.filter((c) => c.id !== preferredCandidate.id)
      ];
      for (const candidate of ordered) {
        const { index: lastLogIndex, term: lastLogTerm } = this.#lastLogInfo(candidate);
        const res = this.#handleRequestVote(candidate, peer, electionTerm, lastLogIndex, lastLogTerm);
        if (res.voteGranted) {
          candidate.votesReceived.add(peer.id);
        }
      }
    });

    // Also exchange RequestVote among candidates themselves (each already voted for self).
    for (const candidate of candidates) {
      const { index: lastLogIndex, term: lastLogTerm } = this.#lastLogInfo(candidate);
      for (const other of candidates) {
        if (other.id === candidate.id) continue;
        this.#handleRequestVote(candidate, other, electionTerm, lastLogIndex, lastLogTerm);
      }
    }

    const winner = candidates.find((c) => c.votesReceived.size >= quorum) ?? null;
    if (winner) {
      this.#promoteToLeader(winner);
      this.sendHeartbeats();
      this.#notifyStateChange();
      return {
        elected: true,
        leaderId: winner.id,
        term: electionTerm,
        votes: winner.votesReceived.size,
        quorum
      };
    }

    this.#recordEvent(
      'SPLIT_VOTE',
      `Split vote in Term ${electionTerm}: no candidate reached quorum (${quorum}).`,
      electionTerm
    );
    this.#notifyStateChange();
    return {
      elected: false,
      leaderId: null,
      term: electionTerm,
      votesByCandidate: Object.fromEntries(candidates.map((c) => [c.id, c.votesReceived.size])),
      quorum,
      reason: 'SPLIT_VOTE'
    };
  }

  /**
   * Broadcast AppendEntries heartbeats (and catch-up log entries) from active leader(s).
   */
  sendHeartbeats() {
    const leaders = this.getLeaders();
    if (leaders.length === 0) {
      return { sent: 0, acks: 0, leaderCount: 0, results: [] };
    }

    const results = [];
    let sent = 0;
    let acks = 0;

    for (const leader of leaders) {
      leader.heartbeatElapsedMs = 0;
      let steppedDown = false;

      for (const peer of this.nodes) {
        if (peer.id === leader.id) continue;
        sent += 1;
        const res = this.#sendAppendEntriesToPeer(leader, peer);
        results.push({ leaderId: leader.id, peerId: peer.id, ...res });
        if (res.delivered && res.term > leader.currentTerm) {
          this.#stepDownToFollower(leader, res.term);
          this.#recordEvent('STEP_DOWN', `${leader.id} stepped down to FOLLOWER on Term ${res.term}.`, res.term);
          steppedDown = true;
          break;
        }
        if (res.success) {
          acks += 1;
        }
      }

      if (!steppedDown) {
        const committedMore = this.#advanceLeaderCommitIndex(leader);
        if (committedMore) {
          // Propagate updated commitIndex to reachable peers immediately.
          for (const peer of this.nodes) {
            if (peer.id !== leader.id && this.canCommunicate(leader.id, peer.id)) {
              this.#sendAppendEntriesToPeer(leader, peer);
            }
          }
        }
      }
    }

    this.#notifyStateChange();
    return { sent, acks, leaderCount: leaders.length, results };
  }

  /**
   * Append a command to the active leader's log and replicate across the cluster.
   */
  replicateLog(command) {
    const normalized = typeof command === 'string' ? command.trim() : command;
    if (normalized === '' || normalized === null || normalized === undefined) {
      throw new TypeError('Command must be a non-empty string or value.');
    }

    const leader = this.getLeader();
    if (!leader) {
      this.#recordEvent('REPLICATE_FAILED', 'Cannot replicate log: no active leader elected.');
      return {
        success: false,
        committed: false,
        reason: 'NO_LEADER',
        entry: null
      };
    }

    const entry = {
      index: leader.log.length + 1,
      term: leader.currentTerm,
      command: normalized,
      committed: false,
      timestamp: Date.now()
    };
    leader.log.push(entry);
    leader.matchIndex[leader.id] = leader.log.length;
    leader.nextIndex[leader.id] = leader.log.length + 1;

    let replicatedCount = 1;
    let steppedDown = false;

    for (const peer of this.nodes) {
      if (peer.id === leader.id) continue;
      const res = this.#sendAppendEntriesToPeer(leader, peer);
      if (res.delivered && res.term > leader.currentTerm) {
        this.#stepDownToFollower(leader, res.term);
        steppedDown = true;
        break;
      }
      if (res.success && (leader.matchIndex[peer.id] ?? 0) >= entry.index) {
        replicatedCount += 1;
      }
    }

    const quorum = this.getQuorumSize();
    if (!steppedDown && replicatedCount >= quorum) {
      this.#advanceLeaderCommitIndex(leader);
      // Sync commitIndex to reachable followers so their log viewers show committed immediately.
      for (const peer of this.nodes) {
        if (peer.id !== leader.id && this.canCommunicate(leader.id, peer.id)) {
          this.#sendAppendEntriesToPeer(leader, peer);
        }
      }
      this.#recordEvent(
        'LOG_COMMITTED',
        `Committed #${entry.index} "${String(normalized)}" in Term ${leader.currentTerm} (${replicatedCount}/${this.nodes.length} replicas).`,
        leader.currentTerm
      );
      this.#notifyStateChange();
      return {
        success: true,
        committed: true,
        entry: { ...entry, committed: true },
        replicatedCount,
        quorum,
        term: leader.currentTerm,
        leaderId: leader.id
      };
    }

    this.#recordEvent(
      'LOG_UNCOMMITTED',
      `Appended #${entry.index} "${String(normalized)}" on ${leader.id} awaiting quorum (${replicatedCount}/${quorum}).`,
      leader.currentTerm
    );
    this.#notifyStateChange();
    return {
      success: true,
      committed: false,
      entry: { ...entry },
      replicatedCount,
      quorum,
      term: leader.currentTerm,
      leaderId: leader.id,
      reason: steppedDown ? 'HIGHER_TERM' : 'QUORUM_NOT_REACHED'
    };
  }

  /**
   * Simulate node crash / failure.
   */
  handleNodeFailure(nodeId) {
    const node = this.getNode(nodeId);
    const wasLeader = node.state === NODE_STATES.LEADER;
    node.alive = false;
    node.state = NODE_STATES.DEAD;
    node.votesReceived.clear();

    this.#recordEvent(
      'NODE_FAILED',
      `${node.id} (${wasLeader ? 'LEADER' : 'node'}) crashed and went offline.`,
      node.currentTerm
    );
    this.#notifyStateChange();

    return {
      nodeId: node.id,
      alive: false,
      state: node.state,
      wasLeader,
      remainingAlive: this.nodes.filter((n) => n.alive).length,
      quorum: this.getQuorumSize()
    };
  }

  /**
   * Bring a failed node back online as a Follower.
   */
  recoverNode(nodeId) {
    const node = this.getNode(nodeId);
    if (node.alive) return { nodeId: node.id, alive: true, state: node.state };
    node.alive = true;
    node.state = NODE_STATES.FOLLOWER;
    node.electionElapsedMs = 0;
    node.electionTimeoutMs = this.#nextElectionTimeout();
    this.#recordEvent('NODE_RECOVERED', `${node.id} recovered and rejoined as FOLLOWER.`, node.currentTerm);
    this.#notifyStateChange();
    return { nodeId: node.id, alive: true, state: node.state };
  }

  /**
   * Isolate a set of nodes (or minority / current leader) into partition group 1.
   */
  partitionNodes(isolatedNodeIds) {
    const isolatedSet = new Set(isolatedNodeIds);
    for (const node of this.nodes) {
      node.partitionGroup = isolatedSet.has(node.id) ? 1 : 0;
    }
    this.#recordEvent(
      'NETWORK_PARTITION',
      `Network partitioned: isolated [${[...isolatedSet].join(', ')}] from majority.`,
      this.getCurrentTerm()
    );
    this.#notifyStateChange();
  }

  healPartition() {
    for (const node of this.nodes) {
      node.partitionGroup = 0;
    }
    this.#recordEvent('PARTITION_HEALED', 'Network partition healed; all nodes connected.', this.getCurrentTerm());
    this.sendHeartbeats();
    this.#notifyStateChange();
  }

  /**
   * Advance simulation clock by `elapsedMs`, triggering heartbeats and election timeouts.
   */
  tick(elapsedMs = 50) {
    const leaders = this.getLeaders();
    for (const leader of leaders) {
      leader.heartbeatElapsedMs += elapsedMs;
      if (leader.heartbeatElapsedMs >= this.heartbeatIntervalMs) {
        this.sendHeartbeats();
      }
    }

    const timedOut = [];
    for (const node of this.nodes) {
      if (!node.alive || node.state === NODE_STATES.LEADER) continue;
      node.electionElapsedMs += elapsedMs;
      if (node.electionElapsedMs >= node.electionTimeoutMs) {
        timedOut.push(node.id);
      }
    }

    if (timedOut.length === 1) {
      this.startElection(timedOut[0]);
    } else if (timedOut.length > 1) {
      this.startConcurrentElections(timedOut);
    } else {
      this.#notifyStateChange();
    }

    return timedOut;
  }

  getSnapshot() {
    const leader = this.getLeader();
    return {
      currentTerm: this.getCurrentTerm(),
      quorum: this.getQuorumSize(),
      leaderId: leader ? leader.id : null,
      partitioned: this.isPartitioned(),
      nodes: this.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        state: n.state,
        alive: n.alive,
        currentTerm: n.currentTerm,
        votedFor: n.votedFor,
        commitIndex: n.commitIndex,
        lastApplied: n.lastApplied,
        votesCount: n.votesReceived.size,
        electionTimeoutMs: n.electionTimeoutMs,
        electionElapsedMs: n.electionElapsedMs,
        partitionGroup: n.partitionGroup,
        log: n.log.map((entry) => ({ ...entry }))
      })),
      rpcHistory: this.rpcHistory.slice(0, 20),
      eventLog: this.eventLog.slice(0, 20)
    };
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function mountRaftConsensus(root) {
  const get = (id) => root.querySelector(`#${id}`);
  let clusterSize = 5;
  let selectedNodeId = 'node-1';
  let autoRunTimer = null;
  let cluster = null;

  const PRESET_COMMANDS = [
    'LOCK_BRACKET_BO5',
    'UPDATE_SCORE_2_1',
    'BAN_CHEATER_ID_884',
    'SETTLE_PRIZE_500K',
    'SYNC_MATCH_SEEDING'
  ];
  let presetCursor = 0;

  function computeNodePositions(nodes, width = 760, height = 400) {
    const cx = width / 2;
    const cy = height / 2;
    const rx = width * 0.34;
    const ry = height * 0.34;
    return new Map(
      nodes.map((node, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / nodes.length;
        return [
          node.id,
          {
            x: Math.round(cx + rx * Math.cos(angle)),
            y: Math.round(cy + ry * Math.sin(angle))
          }
        ];
      })
    );
  }

  function spawnPacketAnimation(rpc) {
    const layer = get('packet-layer');
    if (!layer || !cluster) return;
    const positions = computeNodePositions(cluster.nodes);
    const fromPos = positions.get(rpc.from);
    const toPos = positions.get(rpc.to);
    if (!fromPos || !toPos) return;

    const packet = document.createElement('div');
    const kindClass = rpc.delivered
      ? rpc.type.toLowerCase()
      : 'dropped';
    packet.className = `rpc-packet rpc-${kindClass}`;
    packet.style.setProperty('--from-x', `${(fromPos.x / 760) * 100}%`);
    packet.style.setProperty('--from-y', `${(fromPos.y / 400) * 100}%`);
    packet.style.setProperty('--to-x', `${(toPos.x / 760) * 100}%`);
    packet.style.setProperty('--to-y', `${(toPos.y / 400) * 100}%`);
    packet.title = `${rpc.type} (${rpc.from} → ${rpc.to}) T${rpc.term}`;
    packet.textContent = rpc.delivered
      ? (rpc.type === 'RequestVote' ? 'RV' : rpc.type === 'VoteGranted' ? 'VOTE' : rpc.type === 'AppendAck' ? 'ACK' : 'AE')
      : '✕';

    layer.append(packet);
    setTimeout(() => {
      packet.remove();
    }, 680);
  }

  function createCluster(size) {
    clusterSize = size;
    selectedNodeId = 'node-1';
    cluster = new GamingEsportsHubRaftCluster({
      nodeCount: size,
      electionTimeoutMin: 200,
      electionTimeoutMax: 420,
      heartbeatIntervalMs: 80,
      onRpc: (rpc) => spawnPacketAnimation(rpc)
    });
    // Elect initial leader cleanly so cluster starts ready for log replication & failure testing.
    cluster.startElection('node-1');
    render();
  }

  function svgEl(tag, attrs = {}, text = '') {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    if (text) el.textContent = text;
    return el;
  }

  function renderTopology(snapshot) {
    const svg = get('cluster-topology');
    if (!svg) return;
    svg.replaceChildren();

    const positions = computeNodePositions(snapshot.nodes);

    // Draw mesh links between nodes
    for (let i = 0; i < snapshot.nodes.length; i += 1) {
      for (let j = i + 1; j < snapshot.nodes.length; j += 1) {
        const a = snapshot.nodes[i];
        const b = snapshot.nodes[j];
        const pa = positions.get(a.id);
        const pb = positions.get(b.id);
        const connected = a.alive && b.alive && a.partitionGroup === b.partitionGroup;
        const isLeaderLink =
          connected &&
          (a.state === NODE_STATES.LEADER || b.state === NODE_STATES.LEADER);

        svg.append(
          svgEl('line', {
            x1: pa.x,
            y1: pa.y,
            x2: pb.x,
            y2: pb.y,
            class: `mesh-link ${connected ? 'connected' : 'severed'} ${isLeaderLink ? 'leader-link' : ''}`
          })
        );
      }
    }

    // Draw node hubs in SVG
    for (const node of snapshot.nodes) {
      const pos = positions.get(node.id);
      const isSelected = node.id === selectedNodeId;
      const g = svgEl('g', {
        class: `svg-node state-${node.state.toLowerCase()} ${isSelected ? 'selected' : ''} ${node.partitionGroup === 1 ? 'partitioned' : ''}`,
        transform: `translate(${pos.x}, ${pos.y})`,
        tabindex: '0',
        role: 'button',
        'aria-label': `${node.id} ${node.state} Term ${node.currentTerm}`
      });

      g.addEventListener('click', () => {
        selectedNodeId = node.id;
        render();
      });

      g.append(svgEl('circle', { r: 42, class: 'node-halo' }));
      g.append(svgEl('circle', { r: 34, class: 'node-core' }));
      g.append(svgEl('text', { y: -6, class: 'node-svg-id' }, node.id.toUpperCase()));
      g.append(svgEl('text', { y: 11, class: 'node-svg-role' }, node.state));
      g.append(svgEl('text', { y: 25, class: 'node-svg-term' }, `T${node.currentTerm} · C${node.commitIndex}`));
      svg.append(g);
    }
  }

  function renderNodeCards(snapshot) {
    const container = get('node-cards');
    if (!container) return;
    container.replaceChildren();

    for (const node of snapshot.nodes) {
      const card = document.createElement('article');
      const stateClass = node.state.toLowerCase();
      card.className = [
        'node-card',
        `state-${stateClass}`,
        node.id === selectedNodeId ? 'selected' : '',
        node.partitionGroup === 1 ? 'partitioned' : ''
      ].filter(Boolean).join(' ');

      const timeoutPct = node.alive && node.state !== NODE_STATES.LEADER
        ? Math.min(100, Math.round((node.electionElapsedMs / node.electionTimeoutMs) * 100))
        : 0;

      const header = document.createElement('div');
      header.className = 'node-card-header';
      const title = document.createElement('strong');
      title.textContent = node.label;
      const badge = document.createElement('span');
      badge.className = `state-pill pill-${stateClass}`;
      badge.textContent = node.partitionGroup === 1 ? `${node.state} · ISOLATED` : node.state;
      header.append(title, badge);

      const meta = document.createElement('div');
      meta.className = 'node-card-meta';
      meta.innerHTML = `
        <span>Term: <strong>${node.currentTerm}</strong></span>
        <span>VotedFor: <strong>${node.votedFor ?? '—'}</strong></span>
        <span>Log: <strong>${node.log.length}</strong></span>
        <span>Commit: <strong>${node.commitIndex}</strong></span>
      `;

      const timerWrap = document.createElement('div');
      timerWrap.className = 'timeout-track';
      timerWrap.title = node.state === NODE_STATES.LEADER
        ? 'Leader sends periodic heartbeats'
        : `Election timeout: ${node.electionElapsedMs}/${node.electionTimeoutMs}ms`;
      const timerFill = document.createElement('div');
      timerFill.className = 'timeout-fill';
      timerFill.style.width = `${timeoutPct}%`;
      timerWrap.append(timerFill);

      const actions = document.createElement('div');
      actions.className = 'node-card-actions';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'btn-mini';
      selectBtn.textContent = node.id === selectedNodeId ? 'Selected' : 'Select';
      selectBtn.addEventListener('click', () => {
        selectedNodeId = node.id;
        render();
      });

      const electBtn = document.createElement('button');
      electBtn.type = 'button';
      electBtn.className = 'btn-mini btn-elect';
      electBtn.textContent = 'Start Election';
      electBtn.disabled = !node.alive;
      electBtn.addEventListener('click', () => {
        cluster.startElection(node.id);
        render();
      });

      const killBtn = document.createElement('button');
      killBtn.type = 'button';
      killBtn.className = `btn-mini ${node.alive ? 'btn-kill' : 'btn-revive'}`;
      killBtn.textContent = node.alive ? 'Kill Node' : 'Recover';
      killBtn.addEventListener('click', () => {
        if (node.alive) {
          cluster.handleNodeFailure(node.id);
        } else {
          cluster.recoverNode(node.id);
        }
        render();
      });

      actions.append(selectBtn, electBtn, killBtn);
      card.append(header, meta, timerWrap, actions);
      container.append(card);
    }
  }

  function renderLogViewer(snapshot) {
    const tbody = get('log-replication-body');
    if (!tbody) return;
    tbody.replaceChildren();

    const maxLen = snapshot.nodes.reduce((m, n) => Math.max(m, n.log.length), 0);
    if (maxLen === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-cell';
      td.textContent = 'No log commands replicated yet. Submit a command above to run an AppendEntries cycle.';
      tr.append(td);
      tbody.append(tr);
      return;
    }

    const leader = snapshot.nodes.find((n) => n.id === snapshot.leaderId)
      ?? snapshot.nodes.reduce((best, n) => (n.log.length >= best.log.length ? n : best), snapshot.nodes[0]);

    for (let i = maxLen - 1; i >= 0; i -= 1) {
      const idx = i + 1;
      const refEntry = leader.log[i] ?? snapshot.nodes.find((n) => n.log[i])?.log[i];
      if (!refEntry) continue;

      const replicas = snapshot.nodes.filter(
        (n) => n.log[i] && n.log[i].term === refEntry.term && n.log[i].command === refEntry.command
      ).length;
      const isCommitted = snapshot.nodes.some((n) => n.log[i]?.committed || n.commitIndex >= idx);

      const tr = document.createElement('tr');
      tr.className = isCommitted ? 'log-row committed' : 'log-row uncommitted';

      const idxTd = document.createElement('td');
      idxTd.textContent = `#${idx}`;
      const termTd = document.createElement('td');
      termTd.textContent = `T${refEntry.term}`;
      const cmdTd = document.createElement('td');
      cmdTd.className = 'cmd-cell';
      cmdTd.textContent = String(refEntry.command);
      const repTd = document.createElement('td');
      repTd.textContent = `${replicas}/${snapshot.nodes.length}`;
      const statusTd = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `commit-badge ${isCommitted ? 'committed' : 'uncommitted'}`;
      badge.textContent = isCommitted ? 'COMMITTED' : 'UNCOMMITTED';
      statusTd.append(badge);

      tr.append(idxTd, termTd, cmdTd, repTd, statusTd);
      tbody.append(tr);
    }
  }

  function renderEventFeed(snapshot) {
    const list = get('cluster-event-log');
    if (!list) return;
    list.replaceChildren();
    for (const ev of snapshot.eventLog.slice(0, 14)) {
      const li = document.createElement('li');
      const termSpan = document.createElement('span');
      termSpan.className = 'ev-term';
      termSpan.textContent = `T${ev.term}`;
      const typeSpan = document.createElement('span');
      typeSpan.className = 'ev-type';
      typeSpan.textContent = ev.type;
      li.append(termSpan, ' ', typeSpan, ` — ${ev.message}`);
      list.append(li);
    }
  }

  function render() {
    const snapshot = cluster.getSnapshot();
    const termEl = get('term-counter');
    const leaderEl = get('active-leader-badge');
    const quorumEl = get('quorum-badge');
    const partitionBtn = get('btn-partition-toggle');
    const killBtn = get('btn-kill-node');
    const selectedNode = snapshot.nodes.find((n) => n.id === selectedNodeId) ?? snapshot.nodes[0];

    if (termEl) termEl.textContent = String(snapshot.currentTerm);
    if (leaderEl) leaderEl.textContent = snapshot.leaderId ? snapshot.leaderId.toUpperCase() : 'NO LEADER';
    if (quorumEl) quorumEl.textContent = `${snapshot.quorum} / ${snapshot.nodes.length}`;

    if (partitionBtn) {
      partitionBtn.textContent = snapshot.partitioned ? 'Heal Network Partition' : 'Partition Network';
      partitionBtn.classList.toggle('active', snapshot.partitioned);
    }

    if (killBtn && selectedNode) {
      killBtn.textContent = selectedNode.alive
        ? `Kill Node (${selectedNode.id})`
        : `Recover Node (${selectedNode.id})`;
    }

    renderTopology(snapshot);
    renderNodeCards(snapshot);
    renderLogViewer(snapshot);
    renderEventFeed(snapshot);
  }

  get('btn-cluster-3')?.addEventListener('click', () => createCluster(3));
  get('btn-cluster-5')?.addEventListener('click', () => createCluster(5));

  get('btn-kill-node')?.addEventListener('click', () => {
    const node = cluster.getNode(selectedNodeId);
    if (node.alive) {
      cluster.handleNodeFailure(selectedNodeId);
    } else {
      cluster.recoverNode(selectedNodeId);
    }
    render();
  });

  get('btn-partition-toggle')?.addEventListener('click', () => {
    if (cluster.isPartitioned()) {
      cluster.healPartition();
    } else {
      const leader = cluster.getLeader();
      const minority = leader
        ? [leader.id]
        : cluster.nodes.slice(0, Math.floor(cluster.nodes.length / 2)).map((n) => n.id);
      cluster.partitionNodes(minority);
    }
    render();
  });

  get('btn-send-heartbeat')?.addEventListener('click', () => {
    cluster.sendHeartbeats();
    render();
  });

  get('btn-step-tick')?.addEventListener('click', () => {
    cluster.tick(60);
    render();
  });

  get('btn-split-vote')?.addEventListener('click', () => {
    const alive = cluster.nodes.filter((n) => n.alive).slice(0, 3).map((n) => n.id);
    if (alive.length >= 2) {
      cluster.startConcurrentElections(alive);
    }
    render();
  });

  get('btn-auto-toggle')?.addEventListener('click', (e) => {
    if (autoRunTimer) {
      clearInterval(autoRunTimer);
      autoRunTimer = null;
      e.currentTarget.textContent = 'Start Auto-Tick';
      e.currentTarget.classList.remove('active');
    } else {
      autoRunTimer = setInterval(() => {
        cluster.tick(45);
        render();
      }, 250);
      e.currentTarget.textContent = 'Pause Auto-Tick';
      e.currentTarget.classList.add('active');
    }
  });

  get('btn-reset-cluster')?.addEventListener('click', () => {
    createCluster(clusterSize);
  });

  get('log-command-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = get('log-command-input');
    const cmd = input?.value.trim() || PRESET_COMMANDS[presetCursor++ % PRESET_COMMANDS.length];
    cluster.replicateLog(cmd);
    if (input) input.value = '';
    render();
  });

  createCluster(5);
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('[data-gaming-esports-hub-raft]');
  if (root) {
    mountRaftConsensus(root);
  }
}
