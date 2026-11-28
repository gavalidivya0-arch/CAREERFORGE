/**
 * Crypto Exchange Pro - Distributed Raft Consensus & Leader Election State Machine
 * Models Leader, Follower, and Candidate states, randomized election timeouts,
 * RequestVote & AppendEntries RPC exchanges, network partitions, and log replication commit cycles.
 */

export const RAFT_ROLES = Object.freeze({
  FOLLOWER: 'Follower',
  CANDIDATE: 'Candidate',
  LEADER: 'Leader'
});

export class CryptoExchangeProRaftCluster {
  /**
   * @param {number} nodeCount Number of nodes in the cluster (e.g., 3 or 5).
   * @param {object} [options] Optional timing and RNG configuration.
   */
  constructor(nodeCount = 5, options = {}) {
    const count = Number.isInteger(nodeCount) && nodeCount >= 3 ? nodeCount : 5;
    this.minTimeout = options.minTimeout ?? 180;
    this.maxTimeout = options.maxTimeout ?? 340;
    this.heartbeatInterval = options.heartbeatInterval ?? 75;
    this.randomFn = typeof options.randomFn === 'function' ? options.randomFn : Math.random;

    this.nodes = [];
    this.eventLog = [];
    this.rpcHistory = [];
    this.heartbeatElapsed = 0;
    this.partitionActive = false;

    this.#initNodes(count);
  }

  #initNodes(count) {
    this.nodes = [];
    for (let i = 1; i <= count; i += 1) {
      this.nodes.push({
        id: `node-${i}`,
        label: `Node ${i}`,
        state: RAFT_ROLES.FOLLOWER,
        currentTerm: 0,
        votedFor: null,
        votesReceived: [],
        alive: true,
        partition: 'A',
        electionTimeout: this.#randomTimeout(),
        electionElapsed: 0,
        log: [],
        commitIndex: 0
      });
    }
    this.heartbeatElapsed = 0;
    this.partitionActive = false;
    this.#recordEvent(`Cluster initialized with ${count} nodes (quorum ${this.getQuorumSize()}).`);
  }

  #randomTimeout() {
    const span = Math.max(1, this.maxTimeout - this.minTimeout);
    return Math.floor(this.minTimeout + this.randomFn() * span);
  }

  #recordEvent(message) {
    this.eventLog.unshift({
      timestamp: new Date().toISOString(),
      message
    });
    if (this.eventLog.length > 60) {
      this.eventLog.length = 60;
    }
  }

  #recordRpc(type, from, to, term, granted = true, detail = '') {
    const packet = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      from,
      to,
      term,
      granted,
      detail
    };
    this.rpcHistory.push(packet);
    if (this.rpcHistory.length > 80) {
      this.rpcHistory.shift();
    }
    return packet;
  }

  /**
   * Returns majority quorum required for elections and log commits.
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  /**
   * Looks up a node by ID.
   */
  getNode(nodeId) {
    return this.nodes.find((n) => n.id === nodeId) || null;
  }

  /**
   * Returns the highest current term observed across all nodes.
   */
  getCurrentTerm() {
    return this.nodes.reduce((max, n) => Math.max(max, n.currentTerm), 0);
  }

  /**
   * Returns the active alive Leader node (preferring highest term if stale state exists).
   */
  getLeader() {
    const leaders = this.nodes
      .filter((n) => n.alive && n.state === RAFT_ROLES.LEADER)
      .sort((a, b) => b.currentTerm - a.currentTerm);
    return leaders[0] || null;
  }

  /**
   * Checks whether two nodes can exchange RPCs across health and network partition boundaries.
   */
  canCommunicate(nodeA, nodeB) {
    if (!nodeA || !nodeB) return false;
    return nodeA.alive && nodeB.alive && nodeA.partition === nodeB.partition;
  }

  /**
   * Compares candidate log freshness against a voter's log per Raft Section 5.4.1.
   */
  #isLogUpToDate(candidate, voter) {
    const candLast = candidate.log[candidate.log.length - 1];
    const voterLast = voter.log[voter.log.length - 1];
    const candLastTerm = candLast ? candLast.term : 0;
    const voterLastTerm = voterLast ? voterLast.term : 0;

    if (candLastTerm !== voterLastTerm) {
      return candLastTerm > voterLastTerm;
    }
    return candidate.log.length >= voter.log.length;
  }

  /**
   * Transitions a node into Candidate state, increments term, requests votes,
   * and promotes to Leader if a majority quorum is reached.
   *
   * @param {string} nodeId
   * @param {object} [options] Optional simulation hooks (e.g., forceTerm, maxGrantedVotes).
   */
  startElection(nodeId, options = {}) {
    const candidate = this.getNode(nodeId);
    if (!candidate) {
      return { elected: false, error: `Unknown node "${nodeId}"`, messages: [] };
    }
    if (!candidate.alive) {
      return { elected: false, error: `Node "${nodeId}" is offline`, messages: [] };
    }

    const nextTerm = typeof options.forceTerm === 'number'
      ? options.forceTerm
      : candidate.currentTerm + 1;

    candidate.currentTerm = nextTerm;
    candidate.state = RAFT_ROLES.CANDIDATE;
    candidate.votedFor = candidate.id;
    candidate.votesReceived = [candidate.id];
    candidate.electionElapsed = 0;
    candidate.electionTimeout = this.#randomTimeout();

    const messages = [];
    const quorum = this.getQuorumSize();
    const denyFrom = new Set(options.denyFrom || []);
    let steppedDown = false;

    this.#recordEvent(`${candidate.label} started election for Term ${candidate.currentTerm}.`);

    for (const peer of this.nodes) {
      if (peer.id === candidate.id) continue;

      if (!this.canCommunicate(candidate, peer)) {
        messages.push(
          this.#recordRpc('RequestVote', candidate.id, peer.id, candidate.currentTerm, false, 'unreachable')
        );
        continue;
      }

      if (peer.currentTerm > candidate.currentTerm) {
        // Higher term discovered: candidate immediately steps down to Follower
        candidate.currentTerm = peer.currentTerm;
        candidate.state = RAFT_ROLES.FOLLOWER;
        candidate.votedFor = null;
        candidate.votesReceived = [];
        steppedDown = true;
        messages.push(
          this.#recordRpc('RequestVote', candidate.id, peer.id, candidate.currentTerm, false, 'higher-term')
        );
        this.#recordEvent(
          `${candidate.label} stepped down to Follower (saw higher Term ${peer.currentTerm} from ${peer.label}).`
        );
        break;
      }

      if (peer.currentTerm < candidate.currentTerm) {
        peer.currentTerm = candidate.currentTerm;
        peer.state = RAFT_ROLES.FOLLOWER;
        peer.votedFor = null;
        peer.votesReceived = [];
      }

      const canVote =
        !denyFrom.has(peer.id) &&
        (peer.votedFor === null || peer.votedFor === candidate.id) &&
        this.#isLogUpToDate(candidate, peer);

      if (canVote) {
        peer.votedFor = candidate.id;
        peer.electionElapsed = 0;
        candidate.votesReceived.push(peer.id);
        messages.push(
          this.#recordRpc('RequestVote', candidate.id, peer.id, candidate.currentTerm, true, 'vote-granted')
        );
      } else {
        messages.push(
          this.#recordRpc('RequestVote', candidate.id, peer.id, candidate.currentTerm, false, 'vote-denied')
        );
      }
    }

    const elected = !steppedDown && candidate.votesReceived.length >= quorum;

    if (elected) {
      candidate.state = RAFT_ROLES.LEADER;
      this.heartbeatElapsed = 0;
      this.#recordEvent(
        `${candidate.label} won Term ${candidate.currentTerm} election (${candidate.votesReceived.length}/${this.nodes.length} votes).`
      );
      const hb = this.sendHeartbeats();
      messages.push(...hb.messages);
    } else if (!steppedDown) {
      this.#recordEvent(
        `${candidate.label} failed to reach quorum in Term ${candidate.currentTerm} (${candidate.votesReceived.length}/${quorum} needed).`
      );
    }

    return {
      elected,
      steppedDown,
      term: candidate.currentTerm,
      candidateId: candidate.id,
      leaderId: elected ? candidate.id : this.getLeader()?.id ?? null,
      votesReceived: [...candidate.votesReceived],
      quorum,
      state: candidate.state,
      messages
    };
  }

  /**
   * Simulates a split vote where multiple candidates enter the same next term simultaneously
   * and split available followers so no candidate reaches majority quorum.
   *
   * @param {string[]} candidateIds
   */
  simulateSplitVote(candidateIds) {
    const aliveCandidates = (candidateIds || [])
      .map((id) => this.getNode(id))
      .filter((n) => n && n.alive);

    if (aliveCandidates.length < 2) {
      return { splitVote: false, reason: 'Need at least two alive candidates', messages: [] };
    }

    const splitTerm = this.getCurrentTerm() + 1;
    const messages = [];
    const quorum = this.getQuorumSize();

    // All competing candidates advance to the same term and vote for themselves first
    for (const cand of aliveCandidates) {
      cand.currentTerm = splitTerm;
      cand.state = RAFT_ROLES.CANDIDATE;
      cand.votedFor = cand.id;
      cand.votesReceived = [cand.id];
      cand.electionElapsed = 0;
      cand.electionTimeout = this.#randomTimeout();
    }

    // Remaining alive followers are distributed round-robin among reachable candidates
    // (capped below quorum if possible to model a contested split)
    const candidateSet = new Set(aliveCandidates.map((c) => c.id));
    const followers = this.nodes.filter((n) => n.alive && !candidateSet.has(n.id));

    followers.forEach((follower, idx) => {
      follower.currentTerm = splitTerm;
      follower.state = RAFT_ROLES.FOLLOWER;
      follower.votedFor = null;
      follower.votesReceived = [];

      const target = aliveCandidates[idx % aliveCandidates.length];
      if (this.canCommunicate(target, follower) && target.votesReceived.length + 1 < quorum) {
        follower.votedFor = target.id;
        target.votesReceived.push(follower.id);
        messages.push(
          this.#recordRpc('RequestVote', target.id, follower.id, splitTerm, true, 'split-vote-grant')
        );
      } else {
        messages.push(
          this.#recordRpc('RequestVote', target.id, follower.id, splitTerm, false, 'already-voted-or-split')
        );
      }
    });

    // Cross-candidate requests are rejected because each candidate already voted for itself
    for (const cand of aliveCandidates) {
      for (const other of aliveCandidates) {
        if (cand.id === other.id) continue;
        messages.push(
          this.#recordRpc(
            'RequestVote',
            cand.id,
            other.id,
            splitTerm,
            false,
            this.canCommunicate(cand, other) ? 'already-voted' : 'unreachable'
          )
        );
      }
    }

    const winner = aliveCandidates.find((c) => c.votesReceived.length >= quorum) || null;
    if (winner) {
      winner.state = RAFT_ROLES.LEADER;
      this.#recordEvent(`${winner.label} broke tie in Term ${splitTerm}.`);
    } else {
      this.#recordEvent(
        `Split vote in Term ${splitTerm}: ${aliveCandidates
          .map((c) => `${c.label} (${c.votesReceived.length})`)
          .join(' vs ')} — no leader elected.`
      );
    }

    return {
      splitVote: !winner,
      term: splitTerm,
      leaderId: winner ? winner.id : null,
      tallies: aliveCandidates.map((c) => ({ id: c.id, votes: c.votesReceived.length })),
      quorum,
      messages
    };
  }

  /**
   * Leader broadcasts AppendEntries heartbeats to reachable followers,
   * resetting their election timers and syncing committed state.
   */
  sendHeartbeats() {
    const leader = this.getLeader();
    if (!leader) {
      return { sent: false, reason: 'No active leader', messages: [] };
    }

    const messages = [];
    let acks = 1;
    let steppedDown = false;

    for (const peer of this.nodes) {
      if (peer.id === leader.id) continue;

      if (!this.canCommunicate(leader, peer)) {
        messages.push(
          this.#recordRpc('AppendEntries', leader.id, peer.id, leader.currentTerm, false, 'unreachable')
        );
        continue;
      }

      if (peer.currentTerm > leader.currentTerm) {
        leader.currentTerm = peer.currentTerm;
        leader.state = RAFT_ROLES.FOLLOWER;
        leader.votedFor = null;
        leader.votesReceived = [];
        steppedDown = true;
        messages.push(
          this.#recordRpc('AppendEntries', leader.id, peer.id, leader.currentTerm, false, 'higher-term')
        );
        this.#recordEvent(`${leader.label} stepped down on heartbeat reply (Term ${peer.currentTerm}).`);
        break;
      }

      if (peer.currentTerm < leader.currentTerm) {
        peer.currentTerm = leader.currentTerm;
        peer.votedFor = null;
      }
      peer.state = RAFT_ROLES.FOLLOWER;
      peer.votesReceived = [];
      peer.electionElapsed = 0;

      // Sync leader's log and commitIndex to reachable follower
      this.#syncLogToFollower(leader, peer);
      acks += 1;
      messages.push(
        this.#recordRpc('AppendEntries', leader.id, peer.id, leader.currentTerm, true, 'heartbeat-ack')
      );
    }

    this.heartbeatElapsed = 0;

    return {
      sent: !steppedDown,
      steppedDown,
      leaderId: steppedDown ? null : leader.id,
      term: leader.currentTerm,
      acks,
      messages
    };
  }

  #syncLogToFollower(leader, follower) {
    // Replace follower suffix if divergent, then match leader's log entries
    follower.log = leader.log.map((entry) => ({ ...entry }));
    follower.commitIndex = Math.min(leader.commitIndex, follower.log.length);
  }

  /**
   * Appends a command to the active Leader's log, replicates via AppendEntries,
   * and commits if a majority quorum acknowledges the entry.
   *
   * @param {string} command
   */
  replicateLog(command) {
    const trimmed = String(command ?? '').trim();
    if (!trimmed) {
      return { committed: false, error: 'Command must be non-empty', entry: null, messages: [] };
    }

    const leader = this.getLeader();
    if (!leader) {
      this.#recordEvent(`Log append rejected ("${trimmed}"): no active Leader.`);
      return { committed: false, error: 'No active leader', entry: null, messages: [] };
    }

    const entry = {
      index: leader.log.length + 1,
      term: leader.currentTerm,
      command: trimmed,
      committed: false
    };
    leader.log.push(entry);

    const messages = [];
    const quorum = this.getQuorumSize();
    let acks = 1; // Leader itself

    for (const peer of this.nodes) {
      if (peer.id === leader.id) continue;

      if (!this.canCommunicate(leader, peer)) {
        messages.push(
          this.#recordRpc('AppendEntries', leader.id, peer.id, leader.currentTerm, false, 'partitioned-or-down')
        );
        continue;
      }

      if (peer.currentTerm > leader.currentTerm) {
        leader.currentTerm = peer.currentTerm;
        leader.state = RAFT_ROLES.FOLLOWER;
        leader.votedFor = null;
        messages.push(
          this.#recordRpc('AppendEntries', leader.id, peer.id, leader.currentTerm, false, 'higher-term')
        );
        return { committed: false, error: 'Leader deposed by higher term', entry, acks, quorum, messages };
      }

      peer.currentTerm = leader.currentTerm;
      peer.state = RAFT_ROLES.FOLLOWER;
      peer.electionElapsed = 0;
      this.#syncLogToFollower(leader, peer);
      acks += 1;
      messages.push(
        this.#recordRpc('AppendEntries', leader.id, peer.id, leader.currentTerm, true, `replicated-#${entry.index}`)
      );
    }

    const committed = acks >= quorum;
    if (committed) {
      leader.commitIndex = entry.index;
      for (const logItem of leader.log) {
        if (logItem.index <= leader.commitIndex) {
          logItem.committed = true;
        }
      }
      for (const peer of this.nodes) {
        if (peer.id !== leader.id && this.canCommunicate(leader, peer)) {
          this.#syncLogToFollower(leader, peer);
        }
      }
      this.#recordEvent(
        `Committed log #${entry.index} ("${entry.command}") in Term ${leader.currentTerm} (${acks}/${quorum} acks).`
      );
    } else {
      this.#recordEvent(
        `Uncommitted log #${entry.index} ("${entry.command}"): only ${acks}/${quorum} acks reachable.`
      );
    }

    return {
      committed,
      entry: { ...entry },
      acks,
      quorum,
      commitIndex: leader.commitIndex,
      messages
    };
  }

  /**
   * Simulates a node crash/failure. If the failed node was the Leader,
   * clears its leadership so surviving nodes can elect a replacement leader.
   *
   * @param {string} nodeId
   */
  handleNodeFailure(nodeId) {
    const node = this.getNode(nodeId);
    if (!node) {
      return { handled: false, error: `Unknown node "${nodeId}"` };
    }

    const wasLeader = node.state === RAFT_ROLES.LEADER;
    node.alive = false;
    node.state = RAFT_ROLES.FOLLOWER;
    node.votesReceived = [];
    node.electionElapsed = 0;

    this.#recordEvent(
      wasLeader
        ? `${node.label} (Leader) went OFFLINE — cluster awaiting new election.`
        : `${node.label} went OFFLINE.`
    );

    return {
      handled: true,
      nodeId: node.id,
      wasLeader,
      alive: node.alive,
      currentLeaderId: this.getLeader()?.id ?? null
    };
  }

  /**
   * Restores a previously failed node back online as a Follower.
   */
  recoverNode(nodeId) {
    const node = this.getNode(nodeId);
    if (!node) {
      return { recovered: false, error: `Unknown node "${nodeId}"` };
    }
    node.alive = true;
    node.state = RAFT_ROLES.FOLLOWER;
    node.votesReceived = [];
    node.electionElapsed = 0;
    node.electionTimeout = this.#randomTimeout();

    this.#recordEvent(`${node.label} recovered and rejoined as Follower.`);
    const leader = this.getLeader();
    if (leader && this.canCommunicate(leader, node)) {
      this.sendHeartbeats();
    }
    return { recovered: true, nodeId: node.id, state: node.state };
  }

  /**
   * Toggles a network partition isolating a subset of nodes (partition 'B') from the rest ('A').
   *
   * @param {boolean} [enable] Explicit boolean; omits to toggle current state.
   * @param {string[]} [isolatedIds] Node IDs placed in partition 'B'.
   */
  setNetworkPartition(enable, isolatedIds = null) {
    const nextState = typeof enable === 'boolean' ? enable : !this.partitionActive;
    this.partitionActive = nextState;

    if (!nextState) {
      for (const node of this.nodes) {
        node.partition = 'A';
      }
      this.#recordEvent('Network partition healed — all nodes in Partition A.');
      return { partitionActive: false, groups: { A: this.nodes.map((n) => n.id), B: [] } };
    }

    const defaultIsolatedCount = Math.floor(this.nodes.length / 2);
    const targetSet = new Set(
      Array.isArray(isolatedIds) && isolatedIds.length > 0
        ? isolatedIds
        : this.nodes.slice(0, defaultIsolatedCount).map((n) => n.id)
    );

    const groupA = [];
    const groupB = [];
    for (const node of this.nodes) {
      if (targetSet.has(node.id)) {
        node.partition = 'B';
        groupB.push(node.id);
      } else {
        node.partition = 'A';
        groupA.push(node.id);
      }
    }

    this.#recordEvent(`Network partitioned: Group A [${groupA.join(', ')}] | Group B [${groupB.join(', ')}].`);
    return { partitionActive: true, groups: { A: groupA, B: groupB } };
  }

  /**
   * Advances simulation timers by `deltaMs`, sending leader heartbeats or triggering
   * randomized election timeouts when followers lose contact with a leader.
   *
   * @param {number} [deltaMs=50]
   */
  tick(deltaMs = 50) {
    const step = Math.max(1, Number(deltaMs) || 50);
    const messages = [];
    const leader = this.getLeader();

    if (leader) {
      this.heartbeatElapsed += step;
      if (this.heartbeatElapsed >= this.heartbeatInterval) {
        const hb = this.sendHeartbeats();
        messages.push(...hb.messages);
      }
    }

    // Advance election clocks for alive non-leader nodes not receiving heartbeats
    for (const node of this.nodes) {
      if (!node.alive || node.state === RAFT_ROLES.LEADER) continue;
      if (leader && this.canCommunicate(leader, node)) continue;

      node.electionElapsed += step;
      if (node.electionElapsed >= node.electionTimeout) {
        const election = this.startElection(node.id);
        messages.push(...election.messages);
        if (election.elected) break;
      }
    }

    return {
      term: this.getCurrentTerm(),
      leaderId: this.getLeader()?.id ?? null,
      messages
    };
  }

  /**
   * Resets the cluster with optional new node count (3 or 5).
   */
  reset(nodeCount = this.nodes.length) {
    const count = Number.isInteger(nodeCount) && nodeCount >= 3 ? nodeCount : 5;
    this.rpcHistory = [];
    this.eventLog = [];
    this.#initNodes(count);
  }

  /**
   * Returns a serializable snapshot of cluster state for UI rendering or diagnostics.
   */
  getSnapshot() {
    return {
      term: this.getCurrentTerm(),
      quorum: this.getQuorumSize(),
      leaderId: this.getLeader()?.id ?? null,
      partitionActive: this.partitionActive,
      nodes: this.nodes.map((n) => ({
        ...n,
        votesReceived: [...n.votesReceived],
        log: n.log.map((entry) => ({ ...entry }))
      })),
      eventLog: [...this.eventLog]
    };
  }
}

// Browser DOM UI controller
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const cluster = new CryptoExchangeProRaftCluster(5);
    let autoTimer = null;

    const clusterGrid = document.getElementById('cluster-nodes-grid');
    const packetLayer = document.getElementById('packet-animation-layer');
    const termBadge = document.getElementById('cluster-term-value');
    const leaderBadge = document.getElementById('cluster-leader-value');
    const quorumBadge = document.getElementById('cluster-quorum-value');
    const partitionBtn = document.getElementById('toggle-partition-btn');
    const killLeaderBtn = document.getElementById('kill-leader-btn');
    const electBtn = document.getElementById('trigger-election-btn');
    const splitVoteBtn = document.getElementById('split-vote-btn');
    const stepTickBtn = document.getElementById('step-tick-btn');
    const autoToggleBtn = document.getElementById('auto-sim-btn');
    const clusterSizeSelect = document.getElementById('cluster-size-select');
    const commandInput = document.getElementById('log-command-input');
    const replicateBtn = document.getElementById('replicate-log-btn');
    const logViewer = document.getElementById('log-replication-viewer');
    const eventFeed = document.getElementById('cluster-event-log');

    function spawnPacketAnimations(messages) {
      if (!packetLayer || !clusterGrid || !Array.isArray(messages) || messages.length === 0) return;

      const gridRect = clusterGrid.getBoundingClientRect();
      const recent = messages.slice(0, 8);

      recent.forEach((msg, idx) => {
        const fromEl = clusterGrid.querySelector(`[data-node-id="${msg.from}"]`);
        const toEl = clusterGrid.querySelector(`[data-node-id="${msg.to}"]`);
        if (!fromEl || !toEl) return;

        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();

        const startX = fromRect.left - gridRect.left + fromRect.width / 2;
        const startY = fromRect.top - gridRect.top + fromRect.height / 2;
        const endX = toRect.left - gridRect.left + toRect.width / 2;
        const endY = toRect.top - gridRect.top + toRect.height / 2;

        const packet = document.createElement('div');
        const typeClass = msg.type === 'RequestVote' ? 'packet-vote' : 'packet-heartbeat';
        const statusClass = msg.granted ? 'packet-ok' : 'packet-drop';
        packet.className = `rpc-packet ${typeClass} ${statusClass}`;
        packet.textContent = msg.type === 'RequestVote' ? 'RV' : 'AE';
        packet.style.setProperty('--start-x', `${startX}px`);
        packet.style.setProperty('--start-y', `${startY}px`);
        packet.style.setProperty('--end-x', `${endX}px`);
        packet.style.setProperty('--end-y', `${endY}px`);
        packet.style.animationDelay = `${idx * 45}ms`;

        packetLayer.appendChild(packet);
        window.setTimeout(() => {
          packet.remove();
        }, 900);
      });
    }

    function render() {
      const snap = cluster.getSnapshot();

      if (termBadge) termBadge.textContent = String(snap.term);
      if (quorumBadge) quorumBadge.textContent = `${snap.quorum} / ${snap.nodes.length}`;
      if (leaderBadge) {
        const leaderNode = snap.nodes.find((n) => n.id === snap.leaderId);
        leaderBadge.textContent = leaderNode ? leaderNode.label : 'None (Election Needed)';
        leaderBadge.className = leaderNode ? 'meta-value leader-active' : 'meta-value leader-none';
      }

      if (partitionBtn) {
        partitionBtn.textContent = snap.partitionActive ? 'Heal Network Partition' : 'Partition Network';
        partitionBtn.classList.toggle('active-warning', snap.partitionActive);
      }

      if (killLeaderBtn) {
        killLeaderBtn.disabled = !snap.leaderId;
      }

      if (clusterGrid) {
        clusterGrid.innerHTML = snap.nodes
          .map((node) => {
            const roleClass = !node.alive
              ? 'node-offline'
              : `role-${node.state.toLowerCase()}`;
            const partClass = node.partition === 'B' ? 'partition-b' : 'partition-a';
            const timeoutPct = Math.min(
              100,
              Math.round((node.electionElapsed / Math.max(1, node.electionTimeout)) * 100)
            );
            const actionLabel = node.alive ? 'Kill Node' : 'Recover Node';
            const actionClass = node.alive ? 'btn-danger-sm' : 'btn-recover-sm';

            return `
              <article class="raft-node-card ${roleClass} ${partClass}" data-node-id="${node.id}">
                <div class="node-card-top">
                  <div>
                    <span class="node-id-tag">${node.label}</span>
                    <span class="partition-pill">Net ${node.partition}</span>
                  </div>
                  <span class="role-badge">${node.alive ? node.state : 'Offline'}</span>
                </div>

                <div class="node-metrics">
                  <div><span>Term</span><strong>${node.currentTerm}</strong></div>
                  <div><span>Voted For</span><strong>${node.votedFor || '—'}</strong></div>
                  <div><span>Votes</span><strong>${node.votesReceived.length}</strong></div>
                  <div><span>Commit Idx</span><strong>${node.commitIndex}</strong></div>
                </div>

                <div class="timeout-track" title="Election Timeout Progress">
                  <div class="timeout-bar" style="width: ${node.state === 'Leader' || !node.alive ? 0 : timeoutPct}%"></div>
                </div>
                <div class="timeout-caption">
                  Timeout: ${node.electionElapsed}ms / ${node.electionTimeout}ms
                </div>

                <div class="node-actions">
                  <button type="button" class="btn-secondary-sm" data-action="elect" data-node="${node.id}" ${node.alive ? '' : 'disabled'}>
                    Start Election
                  </button>
                  <button type="button" class="${actionClass}" data-action="toggle-life" data-node="${node.id}">
                    ${actionLabel}
                  </button>
                </div>
              </article>
            `;
          })
          .join('');
      }

      if (logViewer) {
        logViewer.innerHTML = snap.nodes
          .map((node) => {
            const entriesHtml =
              node.log.length === 0
                ? '<span class="log-empty">No entries</span>'
                : node.log
                    .map(
                      (entry) => `
                        <span class="log-chip ${entry.committed ? 'committed' : 'uncommitted'}">
                          #${entry.index} [T${entry.term}] ${entry.command}
                          <em>${entry.committed ? 'COMMITTED' : 'PENDING'}</em>
                        </span>
                      `
                    )
                    .join('');

            return `
              <div class="node-log-row">
                <div class="node-log-label">${node.label} (${node.alive ? node.state : 'Offline'})</div>
                <div class="node-log-entries">${entriesHtml}</div>
              </div>
            `;
          })
          .join('');
      }

      if (eventFeed) {
        eventFeed.innerHTML = snap.eventLog
          .slice(0, 14)
          .map((item) => `<div class="event-row">${item.message}</div>`)
          .join('');
      }
    }

    if (clusterGrid) {
      clusterGrid.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        const nodeId = btn.getAttribute('data-node');

        if (action === 'elect') {
          const res = cluster.startElection(nodeId);
          render();
          spawnPacketAnimations(res.messages);
        } else if (action === 'toggle-life') {
          const target = cluster.getNode(nodeId);
          if (target && target.alive) {
            cluster.handleNodeFailure(nodeId);
          } else {
            cluster.recoverNode(nodeId);
          }
          render();
        }
      });
    }

    if (killLeaderBtn) {
      killLeaderBtn.addEventListener('click', () => {
        const leader = cluster.getLeader();
        if (leader) {
          cluster.handleNodeFailure(leader.id);
          render();
        }
      });
    }

    if (partitionBtn) {
      partitionBtn.addEventListener('click', () => {
        cluster.setNetworkPartition();
        render();
      });
    }

    if (electBtn) {
      electBtn.addEventListener('click', () => {
        const candidate = cluster.nodes.find((n) => n.alive && n.state !== RAFT_ROLES.LEADER);
        if (candidate) {
          const res = cluster.startElection(candidate.id);
          render();
          spawnPacketAnimations(res.messages);
        }
      });
    }

    if (splitVoteBtn) {
      splitVoteBtn.addEventListener('click', () => {
        const aliveIds = cluster.nodes.filter((n) => n.alive).slice(0, 2).map((n) => n.id);
        const res = cluster.simulateSplitVote(aliveIds);
        render();
        spawnPacketAnimations(res.messages);
      });
    }

    if (stepTickBtn) {
      stepTickBtn.addEventListener('click', () => {
        const res = cluster.tick(90);
        render();
        spawnPacketAnimations(res.messages);
      });
    }

    if (autoToggleBtn) {
      autoToggleBtn.addEventListener('click', () => {
        if (autoTimer) {
          window.clearInterval(autoTimer);
          autoTimer = null;
          autoToggleBtn.textContent = 'Start Auto-Tick';
          autoToggleBtn.classList.remove('active-auto');
        } else {
          autoTimer = window.setInterval(() => {
            const res = cluster.tick(55);
            render();
            spawnPacketAnimations(res.messages);
          }, 450);
          autoToggleBtn.textContent = 'Pause Auto-Tick';
          autoToggleBtn.classList.add('active-auto');
        }
      });
    }

    if (clusterSizeSelect) {
      clusterSizeSelect.addEventListener('change', () => {
        const count = Number(clusterSizeSelect.value) || 5;
        cluster.reset(count);
        render();
      });
    }

    if (replicateBtn) {
      replicateBtn.addEventListener('click', () => {
        const cmd = commandInput ? commandInput.value.trim() : '';
        const res = cluster.replicateLog(cmd || 'SETTLE_ORDER BTC-USDT');
        if (commandInput && res.committed) {
          commandInput.value = '';
        }
        render();
        spawnPacketAnimations(res.messages);
      });
    }

    // Bootstrap initial leader election for immediate visualization
    const initialElection = cluster.startElection('node-1');
    render();
    spawnPacketAnimations(initialElection.messages);
  });
}
