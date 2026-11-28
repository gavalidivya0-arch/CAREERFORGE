/**
 * Travel Odyssey — Distributed Raft Consensus & Leader Election State Machine
 *
 * Models a multi-node Raft cluster with Leader, Follower, Candidate, and Dead states,
 * randomized election timeouts, RequestVote RPCs, split-vote resolution, network
 * partitioning, and AppendEntries log replication commit cycles.
 */

export const NODE_STATES = Object.freeze({
  FOLLOWER: 'FOLLOWER',
  CANDIDATE: 'CANDIDATE',
  LEADER: 'LEADER',
  DEAD: 'DEAD'
});

const DEFAULT_ELECTION_MIN_MS = 150;
const DEFAULT_ELECTION_MAX_MS = 300;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 50;
const MAX_MESSAGE_LOG = 120;

export class TravelOdysseyRaftCluster {
  /**
   * @param {Object} [options]
   * @param {number} [options.nodeCount=5] Number of nodes in the cluster (3 or 5 recommended)
   * @param {number} [options.electionTimeoutMin=150] Minimum randomized election timeout (ms)
   * @param {number} [options.electionTimeoutMax=300] Maximum randomized election timeout (ms)
   * @param {number} [options.heartbeatInterval=50] Leader heartbeat interval (ms)
   * @param {() => number} [options.rng=Math.random] Random generator for timeouts
   * @param {(event: Object) => void} [options.onMessage] Callback fired on RPC / cluster events
   * @param {(snapshot: Object) => void} [options.onStateChange] Callback fired when state mutates
   */
  constructor(options = {}) {
    const {
      nodeCount = 5,
      electionTimeoutMin = DEFAULT_ELECTION_MIN_MS,
      electionTimeoutMax = DEFAULT_ELECTION_MAX_MS,
      heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS,
      rng = Math.random,
      onMessage = null,
      onStateChange = null
    } = options;

    if (!Number.isInteger(nodeCount) || nodeCount < 1) {
      throw new RangeError('nodeCount must be a positive integer.');
    }
    if (electionTimeoutMin <= 0 || electionTimeoutMax < electionTimeoutMin) {
      throw new RangeError('Invalid election timeout bounds.');
    }

    this.nodeCount = nodeCount;
    this.electionTimeoutMin = electionTimeoutMin;
    this.electionTimeoutMax = electionTimeoutMax;
    this.heartbeatInterval = heartbeatInterval;
    this.rng = rng;
    this.onMessage = typeof onMessage === 'function' ? onMessage : null;
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;

    this.leaderId = null;
    this.partitions = null; // Array<Set<string>> when partitioned, null when fully connected
    this.heartbeatElapsed = 0;
    this.messageSeq = 0;
    this.messageLog = [];

    this.nodes = Array.from({ length: nodeCount }, (_, idx) => {
      const id = `node-${idx + 1}`;
      return {
        id,
        label: `Node ${idx + 1}`,
        state: NODE_STATES.FOLLOWER,
        alive: true,
        currentTerm: 0,
        votedFor: null,
        log: [],
        commitIndex: 0,
        lastApplied: 0,
        electionTimeout: this._randomElectionTimeout(),
        elapsedSinceHeartbeat: 0,
        votesReceived: new Set(),
        nextIndex: {},
        matchIndex: {}
      };
    });
  }

  /**
   * Computes strict Raft majority quorum based on configured cluster size.
   * @returns {number}
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  /**
   * Resolves a node record by ID.
   * @param {string} nodeId
   */
  _getNodeRef(nodeId) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Unknown cluster node: ${nodeId}`);
    }
    return node;
  }

  /**
   * Returns a cloned view of a node's state.
   * @param {string} nodeId
   */
  getNode(nodeId) {
    return this._serializeNode(this._getNodeRef(nodeId));
  }

  /**
   * Returns cloned views of all nodes in the cluster.
   */
  getNodes() {
    return this.nodes.map((node) => this._serializeNode(node));
  }

  /**
   * Returns the current alive leader snapshot, or null if none exists.
   */
  getLeader() {
    const leader = this.nodes.find((n) => n.alive && n.state === NODE_STATES.LEADER);
    return leader ? this._serializeNode(leader) : null;
  }

  /**
   * Returns the highest term currently known by any node in the cluster.
   */
  getCurrentTerm() {
    return this.nodes.reduce((max, n) => Math.max(max, n.currentTerm), 0);
  }

  /**
   * Returns full cluster state snapshot for UI rendering or inspection.
   */
  getSnapshot() {
    const leader = this.getLeader();
    return {
      nodeCount: this.nodes.length,
      quorumSize: this.getQuorumSize(),
      currentTerm: this.getCurrentTerm(),
      leaderId: leader ? leader.id : null,
      partitioned: this.partitions !== null,
      partitions: this.partitions ? this.partitions.map((group) => Array.from(group)) : null,
      nodes: this.getNodes(),
      messageLog: this.messageLog.slice()
    };
  }

  /**
   * Checks whether two nodes are alive and in the same network partition.
   * @param {string} fromId
   * @param {string} toId
   */
  canCommunicate(fromId, toId) {
    const fromNode = this._getNodeRef(fromId);
    const toNode = this._getNodeRef(toId);
    if (!fromNode.alive || !toNode.alive) {
      return false;
    }
    if (!this.partitions) {
      return true;
    }
    return this.partitions.some((group) => group.has(fromId) && group.has(toId));
  }

  /**
   * Splits the cluster into isolated network partition groups.
   * Nodes omitted from explicit groups are placed in a separate remainder group.
   * @param {string[][]} groups
   */
  partitionNetwork(groups) {
    if (!Array.isArray(groups) || groups.length < 2) {
      throw new Error('partitionNetwork requires at least two partition groups.');
    }

    const assigned = new Set();
    const normalized = groups.map((group) => {
      const set = new Set();
      for (const id of group) {
        this._getNodeRef(id);
        if (assigned.has(id)) {
          throw new Error(`Duplicate node in partitions: ${id}`);
        }
        assigned.add(id);
        set.add(id);
      }
      return set;
    });

    const unassigned = this.nodes.filter((n) => !assigned.has(n.id)).map((n) => n.id);
    if (unassigned.length > 0) {
      normalized.push(new Set(unassigned));
    }

    this.partitions = normalized;
    this._recordEvent({
      type: 'PARTITION_APPLIED',
      from: 'cluster',
      to: 'cluster',
      term: this.getCurrentTerm(),
      delivered: true,
      detail: `Partitions: ${normalized.map((g) => `[${Array.from(g).join(', ')}]`).join(' | ')}`
    });
    this._emitStateChange();
    return this.partitions.map((g) => Array.from(g));
  }

  /**
   * Toggles a network partition isolating a minority group from the majority.
   * @param {string[]} [isolatedIds]
   */
  togglePartition(isolatedIds = null) {
    if (this.partitions !== null) {
      this.healPartition();
      return { partitioned: false, groups: null };
    }

    const minoritySize = Math.max(1, Math.floor(this.nodes.length / 2));
    let isolated;
    if (Array.isArray(isolatedIds) && isolatedIds.length > 0) {
      isolated = isolatedIds;
    } else {
      const leader = this.nodes.find((n) => n.alive && n.state === NODE_STATES.LEADER);
      const pool = this.nodes.map((n) => n.id);
      isolated = leader
        ? [leader.id, ...pool.filter((id) => id !== leader.id)].slice(0, minoritySize)
        : pool.slice(0, minoritySize);
    }

    const isolatedSet = new Set(isolated);
    const majority = this.nodes.filter((n) => !isolatedSet.has(n.id)).map((n) => n.id);
    const groups = this.partitionNetwork([Array.from(isolatedSet), majority]);
    return { partitioned: true, groups };
  }

  /**
   * Restores full network connectivity across all cluster nodes.
   */
  healPartition() {
    this.partitions = null;
    this._recordEvent({
      type: 'PARTITION_HEALED',
      from: 'cluster',
      to: 'cluster',
      term: this.getCurrentTerm(),
      delivered: true,
      detail: 'All network links restored'
    });
    this._emitStateChange();
  }

  /**
   * Starts a Raft leader election for a given node.
   * Increments term, transitions to CANDIDATE, votes for self, and exchanges RequestVote RPCs.
   * @param {string} nodeId
   */
  startElection(nodeId) {
    const candidate = this._getNodeRef(nodeId);
    if (!candidate.alive) {
      return {
        started: false,
        won: false,
        splitVote: false,
        term: candidate.currentTerm,
        votes: 0,
        quorum: this.getQuorumSize(),
        reason: 'NODE_DEAD'
      };
    }

    this._enterCandidateState(candidate);
    const responses = this._broadcastRequestVote(candidate);
    const result = this._finalizeElection(candidate, responses);
    this._emitStateChange();
    return result;
  }

  /**
   * Simulates simultaneous elections by multiple candidates in the same term,
   * interleaving RequestVote RPC delivery to model Raft split-vote contention.
   * @param {string[]} candidateIds
   */
  startConcurrentElections(candidateIds) {
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      throw new Error('candidateIds must be a non-empty array.');
    }

    const activeCandidates = candidateIds
      .map((id) => this._getNodeRef(id))
      .filter((node) => node.alive);

    for (const candidate of activeCandidates) {
      this._enterCandidateState(candidate);
    }

    // Interleave RequestVote delivery round-robin with rotated non-candidate targets
    // to realistically model concurrent in-flight election RPC contention.
    const candidateSet = new Set(activeCandidates.map((c) => c.id));
    const nonCandidates = this.nodes.filter((n) => !candidateSet.has(n.id));
    const peerQueues = activeCandidates.map((candidate, cIdx) => {
      const rotatedNonCandidates = nonCandidates.length > 0
        ? nonCandidates.map((_, offset) => nonCandidates[(cIdx + offset) % nonCandidates.length])
        : [];
      const otherCandidates = activeCandidates.filter((c) => c.id !== candidate.id);
      return {
        candidate,
        peers: [...rotatedNonCandidates, ...otherCandidates],
        responses: []
      };
    });

    const maxPeers = Math.max(0, ...peerQueues.map((q) => q.peers.length));
    for (let step = 0; step < maxPeers; step += 1) {
      for (const queue of peerQueues) {
        if (step >= queue.peers.length) continue;
        const resp = this._sendSingleRequestVote(queue.candidate, queue.peers[step]);
        queue.responses.push(resp);
      }
    }

    const results = peerQueues.map((queue) => ({
      nodeId: queue.candidate.id,
      ...this._finalizeElection(queue.candidate, queue.responses)
    }));

    this._emitStateChange();
    return {
      leaderId: this.leaderId,
      term: this.getCurrentTerm(),
      splitVote: this.leaderId === null && activeCandidates.some((c) => c.state === NODE_STATES.CANDIDATE),
      results
    };
  }

  /**
   * Processes an incoming RequestVote RPC at a target peer node.
   * @param {string} targetId
   * @param {Object} rpc
   */
  handleRequestVote(targetId, rpc) {
    const peer = this._getNodeRef(targetId);
    if (!peer.alive) {
      return { term: peer.currentTerm, voteGranted: false, reason: 'NODE_DEAD' };
    }

    if (rpc.term < peer.currentTerm) {
      return { term: peer.currentTerm, voteGranted: false, reason: 'STALE_TERM' };
    }

    if (rpc.term > peer.currentTerm) {
      this._stepDown(peer, rpc.term);
    }

    const canVote = peer.votedFor === null || peer.votedFor === rpc.candidateId;
    const logUpToDate = this._isLogUpToDate(rpc.lastLogIndex, rpc.lastLogTerm, peer);

    if (canVote && logUpToDate) {
      peer.votedFor = rpc.candidateId;
      peer.elapsedSinceHeartbeat = 0;
      peer.electionTimeout = this._randomElectionTimeout();
      return { term: peer.currentTerm, voteGranted: true, reason: 'VOTE_GRANTED' };
    }

    return {
      term: peer.currentTerm,
      voteGranted: false,
      reason: !canVote ? 'ALREADY_VOTED' : 'LOG_OUTDATED'
    };
  }

  /**
   * Sends AppendEntries heartbeats (and any missing log entries) from the active leader
   * to all peer nodes, resetting follower election timers and stepping down stale leaders.
   * @param {string|null} [leaderId=null]
   */
  sendHeartbeats(leaderId = null) {
    const leader = leaderId ? this._getNodeRef(leaderId) : this.nodes.find((n) => n.alive && n.state === NODE_STATES.LEADER);
    if (!leader || !leader.alive || leader.state !== NODE_STATES.LEADER) {
      return { sent: false, reason: 'NO_LEADER', responses: [] };
    }

    const responses = [];
    for (const peer of this.nodes) {
      if (peer.id === leader.id) continue;

      const resp = this._sendAppendEntriesToPeer(leader, peer, 'HEARTBEAT');
      responses.push(resp);

      if (leader.state !== NODE_STATES.LEADER) {
        break;
      }
    }

    this._emitStateChange();
    return {
      sent: true,
      leaderId: leader.id,
      term: leader.currentTerm,
      steppedDown: leader.state !== NODE_STATES.LEADER,
      responses
    };
  }

  /**
   * Processes an incoming AppendEntries RPC (heartbeat or log replication) at a target node.
   * @param {string} targetId
   * @param {Object} rpc
   */
  handleAppendEntries(targetId, rpc) {
    const peer = this._getNodeRef(targetId);
    if (!peer.alive) {
      return { term: peer.currentTerm, success: false, matchIndex: 0, reason: 'NODE_DEAD' };
    }

    if (rpc.term < peer.currentTerm) {
      return { term: peer.currentTerm, success: false, matchIndex: peer.log.length, reason: 'STALE_TERM' };
    }

    if (rpc.term > peer.currentTerm) {
      this._stepDown(peer, rpc.term);
    } else if (peer.state !== NODE_STATES.FOLLOWER) {
      peer.state = NODE_STATES.FOLLOWER;
      peer.votesReceived = new Set();
      if (this.leaderId === peer.id) {
        this.leaderId = rpc.leaderId;
      }
    }

    peer.elapsedSinceHeartbeat = 0;
    peer.electionTimeout = this._randomElectionTimeout();

    if (rpc.prevLogIndex > 0) {
      const prevEntry = peer.log[rpc.prevLogIndex - 1];
      if (!prevEntry || prevEntry.term !== rpc.prevLogTerm) {
        return { term: peer.currentTerm, success: false, matchIndex: peer.log.length, reason: 'LOG_MISMATCH' };
      }
    }

    if (Array.isArray(rpc.entries) && rpc.entries.length > 0) {
      for (const entry of rpc.entries) {
        const idx = entry.index - 1;
        const existing = peer.log[idx];
        if (existing) {
          if (existing.term !== entry.term) {
            peer.log = peer.log.slice(0, idx);
            peer.log.push({ ...entry, committed: false });
          }
        } else {
          peer.log.push({ ...entry, committed: false });
        }
      }
    }

    if (rpc.leaderCommit > peer.commitIndex) {
      peer.commitIndex = Math.min(rpc.leaderCommit, peer.log.length);
      peer.lastApplied = peer.commitIndex;
      for (const entry of peer.log) {
        if (entry.index <= peer.commitIndex) {
          entry.committed = true;
        }
      }
    }

    return {
      term: peer.currentTerm,
      success: true,
      matchIndex: peer.log.length,
      reason: 'APPEND_OK'
    };
  }

  /**
   * Replicates a new command through the active leader across the cluster.
   * Commits the entry once a strict majority quorum acknowledges replication.
   * @param {string|Object} command
   */
  replicateLog(command) {
    if (command === null || command === undefined || (typeof command === 'string' && command.trim() === '')) {
      throw new Error('Log command must be a non-empty string or payload.');
    }

    const leader = this.nodes.find((n) => n.alive && n.state === NODE_STATES.LEADER);
    const quorum = this.getQuorumSize();

    if (!leader) {
      return {
        success: false,
        committed: false,
        reason: 'NO_LEADER',
        entry: null,
        ackCount: 0,
        quorum,
        commitIndex: 0
      };
    }

    const entry = {
      index: leader.log.length + 1,
      term: leader.currentTerm,
      command: typeof command === 'string' ? command.trim() : structuredClone(command),
      committed: false
    };
    leader.log.push(entry);

    let ackCount = 1; // Leader counts itself
    for (const peer of this.nodes) {
      if (peer.id === leader.id) continue;

      const resp = this._replicateToPeerWithCatchup(leader, peer);
      if (leader.state !== NODE_STATES.LEADER) {
        return {
          success: false,
          committed: false,
          reason: 'STEPPED_DOWN',
          entry: { ...entry },
          ackCount,
          quorum,
          commitIndex: leader.commitIndex
        };
      }
      if (resp.delivered && resp.success && resp.matchIndex >= entry.index) {
        ackCount += 1;
      }
    }

    let committed = false;
    if (ackCount >= quorum) {
      committed = true;
      leader.commitIndex = entry.index;
      leader.lastApplied = entry.index;
      for (const logEntry of leader.log) {
        if (logEntry.index <= leader.commitIndex) {
          logEntry.committed = true;
        }
      }

      // Propagate new commitIndex to reachable followers
      for (const peer of this.nodes) {
        if (peer.id === leader.id) continue;
        this._sendAppendEntriesToPeer(leader, peer, 'COMMIT_SYNC');
      }
    }

    this._recordEvent({
      type: committed ? 'LOG_COMMITTED' : 'LOG_UNCOMMITTED',
      from: leader.id,
      to: 'cluster',
      term: leader.currentTerm,
      delivered: committed,
      detail: `${typeof entry.command === 'string' ? entry.command : JSON.stringify(entry.command)} (${ackCount}/${quorum} acks)`
    });

    this._emitStateChange();
    return {
      success: true,
      committed,
      reason: committed ? 'COMMITTED' : 'QUORUM_UNAVAILABLE',
      entry: { ...entry },
      ackCount,
      quorum,
      commitIndex: leader.commitIndex
    };
  }

  /**
   * Simulates sudden crash/failure of a cluster node.
   * @param {string} nodeId
   */
  handleNodeFailure(nodeId) {
    const node = this._getNodeRef(nodeId);
    const wasLeader = node.state === NODE_STATES.LEADER;

    node.alive = false;
    node.state = NODE_STATES.DEAD;
    node.votesReceived = new Set();

    if (wasLeader || this.leaderId === node.id) {
      this.leaderId = null;
    }

    const aliveCount = this.nodes.filter((n) => n.alive).length;
    const quorum = this.getQuorumSize();

    this._recordEvent({
      type: 'NODE_FAILED',
      from: node.id,
      to: 'cluster',
      term: node.currentTerm,
      delivered: true,
      detail: `${node.label} offline${wasLeader ? ' (was LEADER)' : ''}`
    });

    this._emitStateChange();
    return {
      nodeId: node.id,
      wasLeader,
      aliveCount,
      quorum,
      hasQuorumAvailable: aliveCount >= quorum
    };
  }

  /**
   * Brings a crashed node back online as a Follower.
   * @param {string} nodeId
   */
  recoverNode(nodeId) {
    const node = this._getNodeRef(nodeId);
    node.alive = true;
    node.state = NODE_STATES.FOLLOWER;
    node.votesReceived = new Set();
    node.elapsedSinceHeartbeat = 0;
    node.electionTimeout = this._randomElectionTimeout();

    this._recordEvent({
      type: 'NODE_RECOVERED',
      from: node.id,
      to: 'cluster',
      term: node.currentTerm,
      delivered: true,
      detail: `${node.label} recovered as FOLLOWER`
    });

    this._emitStateChange();
    return this._serializeNode(node);
  }

  /**
   * Advances the simulation clock by elapsedMs, triggering leader heartbeats
   * and follower/candidate election timeouts when deadlines elapse.
   * @param {number} [elapsedMs=25]
   */
  tick(elapsedMs = 25) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new RangeError('elapsedMs must be a non-negative number.');
    }

    let heartbeatsSent = 0;
    const leader = this.nodes.find((n) => n.alive && n.state === NODE_STATES.LEADER);

    if (leader) {
      this.heartbeatElapsed += elapsedMs;
      if (this.heartbeatElapsed >= this.heartbeatInterval) {
        this.heartbeatElapsed = 0;
        this.sendHeartbeats(leader.id);
        heartbeatsSent += 1;
      }
    }

    const timedOutIds = [];
    for (const node of this.nodes) {
      if (!node.alive || node.state === NODE_STATES.LEADER) continue;
      node.elapsedSinceHeartbeat += elapsedMs;
      if (node.elapsedSinceHeartbeat >= node.electionTimeout) {
        timedOutIds.push(node.id);
      }
    }

    let electionsTriggered = 0;
    if (timedOutIds.length === 1) {
      this.startElection(timedOutIds[0]);
      electionsTriggered = 1;
    } else if (timedOutIds.length > 1) {
      this.startConcurrentElections(timedOutIds);
      electionsTriggered = timedOutIds.length;
    } else if (heartbeatsSent === 0) {
      this._emitStateChange();
    }

    return {
      elapsedMs,
      heartbeatsSent,
      electionsTriggered,
      leaderId: this.leaderId,
      term: this.getCurrentTerm()
    };
  }

  /**
   * Resets all nodes and cluster state back to initial Term 0 Followers.
   */
  reset() {
    this.leaderId = null;
    this.partitions = null;
    this.heartbeatElapsed = 0;
    this.messageLog = [];

    for (const node of this.nodes) {
      node.state = NODE_STATES.FOLLOWER;
      node.alive = true;
      node.currentTerm = 0;
      node.votedFor = null;
      node.log = [];
      node.commitIndex = 0;
      node.lastApplied = 0;
      node.elapsedSinceHeartbeat = 0;
      node.electionTimeout = this._randomElectionTimeout();
      node.votesReceived = new Set();
      node.nextIndex = {};
      node.matchIndex = {};
    }

    this._emitStateChange();
  }

  _enterCandidateState(node) {
    if (this.leaderId === node.id) {
      this.leaderId = null;
    }
    node.currentTerm += 1;
    node.state = NODE_STATES.CANDIDATE;
    node.votedFor = node.id;
    node.votesReceived = new Set([node.id]);
    node.elapsedSinceHeartbeat = 0;
    node.electionTimeout = this._randomElectionTimeout();
  }

  _broadcastRequestVote(candidate) {
    const responses = [];
    for (const peer of this.nodes) {
      if (peer.id === candidate.id) continue;
      responses.push(this._sendSingleRequestVote(candidate, peer));
    }
    return responses;
  }

  _sendSingleRequestVote(candidate, peer) {
    const lastLogIndex = candidate.log.length;
    const lastLogTerm = lastLogIndex > 0 ? candidate.log[lastLogIndex - 1].term : 0;
    const rpc = {
      term: candidate.currentTerm,
      candidateId: candidate.id,
      lastLogIndex,
      lastLogTerm
    };

    const reachable = this.canCommunicate(candidate.id, peer.id);
    this._recordEvent({
      type: 'REQUEST_VOTE',
      from: candidate.id,
      to: peer.id,
      term: candidate.currentTerm,
      delivered: reachable,
      detail: reachable
        ? `Term ${candidate.currentTerm} vote request`
        : `Dropped (${!peer.alive ? 'offline' : 'partitioned'})`
    });

    if (!reachable) {
      return { peerId: peer.id, delivered: false, voteGranted: false, term: candidate.currentTerm };
    }

    const resp = this.handleRequestVote(peer.id, rpc);
    const replyReachable = this.canCommunicate(peer.id, candidate.id);

    this._recordEvent({
      type: 'VOTE_RESPONSE',
      from: peer.id,
      to: candidate.id,
      term: resp.term,
      delivered: replyReachable,
      granted: resp.voteGranted,
      detail: resp.voteGranted ? 'Vote granted' : `Vote denied (${resp.reason})`
    });

    if (replyReachable) {
      if (resp.term > candidate.currentTerm) {
        this._stepDown(candidate, resp.term);
      } else if (
        candidate.state === NODE_STATES.CANDIDATE &&
        resp.term === candidate.currentTerm &&
        resp.voteGranted
      ) {
        candidate.votesReceived.add(peer.id);
      }
    }

    return { peerId: peer.id, delivered: replyReachable, ...resp };
  }

  _finalizeElection(candidate) {
    const quorum = this.getQuorumSize();
    if (candidate.state === NODE_STATES.CANDIDATE && candidate.votesReceived.size >= quorum) {
      this._becomeLeader(candidate);
      this.sendHeartbeats(candidate.id);
      return {
        started: true,
        won: true,
        splitVote: false,
        term: candidate.currentTerm,
        votes: candidate.votesReceived.size,
        quorum
      };
    }

    return {
      started: true,
      won: false,
      splitVote: candidate.state === NODE_STATES.CANDIDATE,
      term: candidate.currentTerm,
      votes: candidate.votesReceived.size,
      quorum
    };
  }

  _becomeLeader(node) {
    for (const other of this.nodes) {
      if (other.id !== node.id && other.state === NODE_STATES.LEADER) {
        other.state = NODE_STATES.FOLLOWER;
        other.votesReceived = new Set();
      }
    }

    node.state = NODE_STATES.LEADER;
    node.elapsedSinceHeartbeat = 0;
    this.leaderId = node.id;
    this.heartbeatElapsed = 0;

    const nextIdx = node.log.length + 1;
    node.nextIndex = {};
    node.matchIndex = {};
    for (const peer of this.nodes) {
      if (peer.id === node.id) continue;
      node.nextIndex[peer.id] = nextIdx;
      node.matchIndex[peer.id] = 0;
    }

    this._recordEvent({
      type: 'LEADER_ELECTED',
      from: node.id,
      to: 'cluster',
      term: node.currentTerm,
      delivered: true,
      detail: `${node.label} elected Leader (${node.votesReceived.size}/${this.getQuorumSize()} votes)`
    });
  }

  _replicateToPeerWithCatchup(leader, peer) {
    const maxAttempts = leader.log.length + 1;
    let lastResult = { peerId: peer.id, delivered: false, success: false, matchIndex: 0 };

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      lastResult = this._sendAppendEntriesToPeer(leader, peer, 'APPEND_ENTRIES');
      if (!lastResult.delivered || lastResult.success || leader.state !== NODE_STATES.LEADER) {
        return lastResult;
      }
    }

    return lastResult;
  }

  _sendAppendEntriesToPeer(leader, peer, rpcType = 'HEARTBEAT') {
    const peerNext = leader.nextIndex[peer.id] ?? leader.log.length + 1;
    const prevLogIndex = Math.max(0, peerNext - 1);
    const prevLogTerm = prevLogIndex > 0 && leader.log[prevLogIndex - 1]
      ? leader.log[prevLogIndex - 1].term
      : 0;
    const entries = leader.log.slice(prevLogIndex).map((e) => ({ ...e }));

    const rpc = {
      term: leader.currentTerm,
      leaderId: leader.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: leader.commitIndex
    };

    const reachable = this.canCommunicate(leader.id, peer.id);
    const effectiveType = entries.length > 0 ? 'APPEND_ENTRIES' : rpcType;

    this._recordEvent({
      type: effectiveType,
      from: leader.id,
      to: peer.id,
      term: leader.currentTerm,
      delivered: reachable,
      detail: reachable
        ? (entries.length > 0 ? `Replicate ${entries.length} entry(s)` : `Heartbeat commit=${leader.commitIndex}`)
        : `Dropped (${!peer.alive ? 'offline' : 'partitioned'})`
    });

    if (!reachable) {
      return { peerId: peer.id, delivered: false, success: false, term: leader.currentTerm, matchIndex: 0 };
    }

    const resp = this.handleAppendEntries(peer.id, rpc);
    const replyReachable = this.canCommunicate(peer.id, leader.id);

    if (effectiveType === 'APPEND_ENTRIES') {
      this._recordEvent({
        type: 'APPEND_RESPONSE',
        from: peer.id,
        to: leader.id,
        term: resp.term,
        delivered: replyReachable,
        success: resp.success,
        detail: resp.success ? `Ack matchIndex=${resp.matchIndex}` : `Rejected (${resp.reason})`
      });
    }

    if (replyReachable) {
      if (resp.term > leader.currentTerm) {
        this._stepDown(leader, resp.term);
      } else if (resp.success) {
        leader.matchIndex[peer.id] = resp.matchIndex;
        leader.nextIndex[peer.id] = resp.matchIndex + 1;
      } else {
        leader.nextIndex[peer.id] = Math.max(1, prevLogIndex);
      }
    }

    return { peerId: peer.id, delivered: replyReachable, ...resp };
  }

  _stepDown(node, newTerm) {
    node.currentTerm = newTerm;
    if (node.alive) {
      node.state = NODE_STATES.FOLLOWER;
    }
    node.votedFor = null;
    node.votesReceived = new Set();
    if (this.leaderId === node.id) {
      this.leaderId = null;
    }
  }

  _isLogUpToDate(candidateLastIndex, candidateLastTerm, peer) {
    const peerLastIndex = peer.log.length;
    const peerLastTerm = peerLastIndex > 0 ? peer.log[peerLastIndex - 1].term : 0;
    if (candidateLastTerm !== peerLastTerm) {
      return candidateLastTerm > peerLastTerm;
    }
    return candidateLastIndex >= peerLastIndex;
  }

  _randomElectionTimeout() {
    const span = this.electionTimeoutMax - this.electionTimeoutMin + 1;
    return Math.floor(this.electionTimeoutMin + this.rng() * span);
  }

  _serializeNode(node) {
    return {
      id: node.id,
      label: node.label,
      state: node.state,
      alive: node.alive,
      currentTerm: node.currentTerm,
      votedFor: node.votedFor,
      log: node.log.map((entry) => ({ ...entry })),
      commitIndex: node.commitIndex,
      lastApplied: node.lastApplied,
      electionTimeout: node.electionTimeout,
      elapsedSinceHeartbeat: node.elapsedSinceHeartbeat,
      votesReceived: Array.from(node.votesReceived)
    };
  }

  _recordEvent(event) {
    const record = {
      seq: ++this.messageSeq,
      timestamp: Date.now(),
      ...event
    };
    this.messageLog.push(record);
    if (this.messageLog.length > MAX_MESSAGE_LOG) {
      this.messageLog.shift();
    }
    if (this.onMessage) {
      this.onMessage(record);
    }
  }

  _emitStateChange() {
    if (this.onStateChange) {
      this.onStateChange(this.getSnapshot());
    }
  }
}
