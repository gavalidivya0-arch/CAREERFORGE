/**
 * Cybersecurity Sentinel - Distributed Raft Consensus & Leader Election Engine
 * Models Leader, Follower, and Candidate states, randomized heartbeat election
 * timeouts, RequestVote / AppendEntries RPC exchanges, network partitions,
 * node failures, and majority-quorum log replication commit cycles.
 */

export const NODE_STATES = Object.freeze({
  LEADER: 'Leader',
  FOLLOWER: 'Follower',
  CANDIDATE: 'Candidate',
  DEAD: 'Dead'
});

export class CybersecuritySentinelRaftCluster {
  /**
   * @param {number} [nodeCount=5] - Number of nodes in the cluster (3 or 5)
   * @param {Object} [options] - Optional timing and RNG configuration
   * @param {number} [options.minTimeoutMs=150] - Minimum randomized election timeout (ms)
   * @param {number} [options.maxTimeoutMs=300] - Maximum randomized election timeout (ms)
   * @param {number} [options.heartbeatIntervalMs=50] - Leader heartbeat interval (ms)
   * @param {Function} [options.randomFn=Math.random] - Optional deterministic RNG for tests
   */
  constructor(nodeCount = 5, options = {}) {
    this.minTimeoutMs = Number.isFinite(options.minTimeoutMs) ? options.minTimeoutMs : 150;
    this.maxTimeoutMs = Number.isFinite(options.maxTimeoutMs) ? options.maxTimeoutMs : 300;
    this.heartbeatIntervalMs = Number.isFinite(options.heartbeatIntervalMs) ? options.heartbeatIntervalMs : 50;
    this.randomFn = typeof options.randomFn === 'function' ? options.randomFn : Math.random;

    this.currentTerm = 0;
    this.leaderId = null;
    this.logs = [];
    this.commitIndex = 0;
    this.partitionedNodes = new Set();
    this.rpcHistory = [];
    this.listeners = [];
    this.nodes = [];

    this.initNodes(nodeCount);
  }

  /**
   * Generates a randomized election timeout within [minTimeoutMs, maxTimeoutMs].
   * @returns {number}
   */
  getRandomizedTimeout() {
    const span = Math.max(1, this.maxTimeoutMs - this.minTimeoutMs);
    return Math.floor(this.minTimeoutMs + this.randomFn() * span);
  }

  /**
   * Initializes or resets cluster nodes.
   * @param {number} [count=5]
   */
  initNodes(count = 5) {
    const validCount = count === 3 ? 3 : 5;
    this.nodeCount = validCount;
    this.currentTerm = 0;
    this.leaderId = null;
    this.logs = [];
    this.commitIndex = 0;
    this.partitionedNodes.clear();
    this.rpcHistory = [];
    this.nodes = [];

    for (let i = 1; i <= validCount; i++) {
      const timeout = this.getRandomizedTimeout();
      this.nodes.push({
        id: `node-${i}`,
        label: `SENTINEL-0${i}`,
        state: NODE_STATES.FOLLOWER,
        currentTerm: 0,
        votedFor: null,
        log: [],
        commitIndex: 0,
        isAlive: true,
        isPartitioned: false,
        electionTimeoutMs: timeout,
        elapsedMs: 0,
        votesReceived: 0
      });
    }
  }

  /**
   * Reconfigures the cluster size (3 or 5 nodes).
   * @param {number} count
   */
  setClusterSize(count) {
    this.initNodes(count);
    this.notify('cluster_reset', { nodeCount: this.nodeCount, quorum: this.getQuorumSize() });
  }

  /**
   * Majority quorum size: floor(N / 2) + 1.
   * @returns {number}
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  /**
   * Returns a node by ID.
   * @param {string} nodeId
   * @returns {Object|undefined}
   */
  getNode(nodeId) {
    return this.nodes.find((n) => n.id === nodeId);
  }

  /**
   * Returns living nodes in the main (non-partitioned) network segment,
   * or in the same partition segment as a reference node if provided.
   * @param {Object|null} [referenceNode=null]
   * @returns {Array<Object>}
   */
  getReachableNodes(referenceNode = null) {
    if (!referenceNode) {
      return this.nodes.filter((n) => n.isAlive && !n.isPartitioned);
    }
    if (!referenceNode.isAlive) return [];
    return this.nodes.filter(
      (n) => n.isAlive && n.isPartitioned === referenceNode.isPartitioned
    );
  }

  /**
   * Checks whether candidate's log is at least as up-to-date as voter's log (Raft §5.4.1).
   * @param {Object} candidate
   * @param {Object} voter
   * @returns {boolean}
   */
  isLogUpToDate(candidate, voter) {
    const candLastIndex = candidate.log.length;
    const candLastTerm = candLastIndex > 0 ? candidate.log[candLastIndex - 1].term : 0;
    const voterLastIndex = voter.log.length;
    const voterLastTerm = voterLastIndex > 0 ? voter.log[voterLastIndex - 1].term : 0;

    if (candLastTerm !== voterLastTerm) {
      return candLastTerm > voterLastTerm;
    }
    return candLastIndex >= voterLastIndex;
  }

  /**
   * Records an RPC exchange for diagnostics and UI packet animations.
   * @param {string} type - RequestVote | VoteResponse | Heartbeat | AppendEntries
   * @param {string} from
   * @param {string} to
   * @param {number} term
   * @param {Object} [details={}]
   * @returns {Object}
   */
  recordRpc(type, from, to, term, details = {}) {
    const rpc = {
      id: this.rpcHistory.length + 1,
      type,
      from,
      to,
      term,
      ...details
    };
    this.rpcHistory.push(rpc);
    if (this.rpcHistory.length > 100) {
      this.rpcHistory.shift();
    }
    return rpc;
  }

  /**
   * Initiates a leader election for the given nodeId.
   * Increments term, transitions node to Candidate, votes for self,
   * exchanges RequestVote RPCs with reachable peers, and promotes to Leader
   * if majority quorum is achieved.
   *
   * @param {string} nodeId
   * @returns {Object}
   */
  startElection(nodeId) {
    const candidate = this.getNode(nodeId);
    if (!candidate) {
      return { success: false, reason: `Node ${nodeId} not found`, rpcs: [] };
    }
    if (!candidate.isAlive) {
      return { success: false, reason: `Node ${nodeId} is offline`, rpcs: [] };
    }

    // Increment term and transition to Candidate
    const nextTerm = Math.max(this.currentTerm, candidate.currentTerm) + 1;
    this.currentTerm = nextTerm;
    candidate.currentTerm = nextTerm;
    candidate.state = NODE_STATES.CANDIDATE;
    candidate.votedFor = candidate.id;
    candidate.elapsedMs = 0;
    candidate.electionTimeoutMs = this.getRandomizedTimeout();

    // Clear previous leader if election is triggered in a higher term
    if (this.leaderId && this.leaderId !== candidate.id) {
      const prevLeader = this.getNode(this.leaderId);
      if (prevLeader && prevLeader.isAlive && prevLeader.isPartitioned === candidate.isPartitioned) {
        prevLeader.state = NODE_STATES.FOLLOWER;
        this.leaderId = null;
      }
    }

    const voters = [candidate.id];
    const rpcs = [];
    const reachablePeers = this.getReachableNodes(candidate).filter((n) => n.id !== candidate.id);

    for (const peer of reachablePeers) {
      const reqRpc = this.recordRpc('RequestVote', candidate.id, peer.id, nextTerm, {
        lastLogIndex: candidate.log.length,
        lastLogTerm: candidate.log.length > 0 ? candidate.log[candidate.log.length - 1].term : 0
      });
      rpcs.push(reqRpc);

      // Higher term forces peer to step down and reset votedFor
      if (candidate.currentTerm > peer.currentTerm) {
        peer.currentTerm = candidate.currentTerm;
        peer.votedFor = null;
        if (peer.isAlive) {
          peer.state = NODE_STATES.FOLLOWER;
        }
      }

      const canVote =
        peer.currentTerm <= candidate.currentTerm &&
        (peer.votedFor === null || peer.votedFor === candidate.id) &&
        this.isLogUpToDate(candidate, peer);

      if (canVote) {
        peer.votedFor = candidate.id;
        peer.currentTerm = candidate.currentTerm;
        peer.elapsedMs = 0;
        voters.push(peer.id);
      }

      const resRpc = this.recordRpc('VoteResponse', peer.id, candidate.id, peer.currentTerm, {
        voteGranted: canVote
      });
      rpcs.push(resRpc);
    }

    const votes = voters.length;
    const quorum = this.getQuorumSize();
    candidate.votesReceived = votes;

    if (votes >= quorum) {
      candidate.state = NODE_STATES.LEADER;
      this.leaderId = candidate.id;

      for (const peer of reachablePeers) {
        peer.state = NODE_STATES.FOLLOWER;
        peer.currentTerm = nextTerm;
        peer.elapsedMs = 0;
      }

      this.notify('election_won', {
        leaderId: candidate.id,
        term: nextTerm,
        votes,
        quorum,
        voters,
        rpcs
      });

      return {
        success: true,
        leaderId: candidate.id,
        term: nextTerm,
        votes,
        quorum,
        voters,
        rpcs
      };
    }

    // Quorum not achieved (split vote or partition/failure loss)
    this.notify('split_vote', {
      candidateId: candidate.id,
      term: nextTerm,
      votes,
      quorum,
      voters,
      rpcs
    });

    return {
      success: false,
      leaderId: null,
      candidateId: candidate.id,
      term: nextTerm,
      votes,
      quorum,
      voters,
      rpcs,
      reason: 'Split vote or insufficient quorum'
    };
  }

  /**
   * Simulates a true concurrent split vote where two or more candidates
   * time out simultaneously in the same term and divide follower votes.
   *
   * @param {Array<string>} [candidateIds=['node-1', 'node-2', 'node-3']]
   * @returns {Object}
   */
  simulateSplitVote(candidateIds = ['node-1', 'node-2', 'node-3']) {
    const activeCandidates = candidateIds
      .map((id) => this.getNode(id))
      .filter((n) => n && n.isAlive && !n.isPartitioned);

    if (activeCandidates.length < 2) {
      return {
        success: false,
        reason: 'Need at least 2 reachable living nodes to simulate a concurrent split vote',
        term: this.currentTerm
      };
    }

    const splitTerm = this.currentTerm + 1;
    this.currentTerm = splitTerm;
    this.leaderId = null;

    const rpcs = [];
    const tally = new Map();

    for (const cand of activeCandidates) {
      cand.currentTerm = splitTerm;
      cand.state = NODE_STATES.CANDIDATE;
      cand.votedFor = cand.id;
      cand.elapsedMs = 0;
      cand.electionTimeoutMs = this.getRandomizedTimeout();
      tally.set(cand.id, [cand.id]);
    }

    const candidateSet = new Set(activeCandidates.map((c) => c.id));
    const remainingFollowers = this.getReachableNodes().filter((n) => !candidateSet.has(n.id));

    // Distribute remaining follower votes round-robin across competing candidates
    remainingFollowers.forEach((follower, idx) => {
      const targetCand = activeCandidates[idx % activeCandidates.length];
      follower.currentTerm = splitTerm;
      follower.state = NODE_STATES.FOLLOWER;
      follower.votedFor = targetCand.id;
      follower.elapsedMs = 0;

      rpcs.push(this.recordRpc('RequestVote', targetCand.id, follower.id, splitTerm));
      rpcs.push(this.recordRpc('VoteResponse', follower.id, targetCand.id, splitTerm, { voteGranted: true }));

      tally.get(targetCand.id).push(follower.id);
    });

    const quorum = this.getQuorumSize();
    const results = activeCandidates.map((c) => {
      const voters = tally.get(c.id);
      c.votesReceived = voters.length;
      return {
        candidateId: c.id,
        votes: voters.length,
        voters,
        won: voters.length >= quorum
      };
    });

    const winner = results.find((r) => r.won);
    if (winner) {
      const winNode = this.getNode(winner.candidateId);
      winNode.state = NODE_STATES.LEADER;
      this.leaderId = winner.candidateId;
      this.notify('election_won', {
        leaderId: winner.candidateId,
        term: splitTerm,
        votes: winner.votes,
        quorum,
        rpcs
      });
      return {
        success: true,
        splitVote: false,
        leaderId: winner.candidateId,
        term: splitTerm,
        quorum,
        results,
        rpcs
      };
    }

    this.notify('split_vote', {
      term: splitTerm,
      quorum,
      results,
      rpcs
    });

    return {
      success: false,
      splitVote: true,
      leaderId: null,
      term: splitTerm,
      quorum,
      results,
      rpcs,
      reason: 'Concurrent split vote: no candidate achieved majority quorum'
    };
  }

  /**
   * Sends AppendEntries heartbeat RPCs from the active leader to reachable followers.
   * Synchronizes term, resets follower election timers, and catches up any lagging followers.
   *
   * @returns {Object}
   */
  sendHeartbeats() {
    if (!this.leaderId) {
      return { success: false, reason: 'No active leader elected', rpcs: [] };
    }

    const leader = this.getNode(this.leaderId);
    if (!leader || !leader.isAlive) {
      this.leaderId = null;
      return { success: false, reason: 'Leader is dead', rpcs: [] };
    }

    const reachablePeers = this.getReachableNodes(leader).filter((n) => n.id !== leader.id);
    const rpcs = [];
    let acks = 1; // Leader itself

    for (const peer of reachablePeers) {
      if (peer.currentTerm <= leader.currentTerm) {
        peer.currentTerm = leader.currentTerm;
        peer.state = NODE_STATES.FOLLOWER;
        peer.votedFor = null;
        peer.elapsedMs = 0;

        // Replicate missing log entries to caught-up/revived followers
        if (peer.log.length < leader.log.length) {
          peer.log = leader.log.map((entry) => ({ ...entry }));
        }
        peer.commitIndex = Math.min(leader.commitIndex, peer.log.length);

        rpcs.push(
          this.recordRpc('Heartbeat', leader.id, peer.id, leader.currentTerm, {
            commitIndex: leader.commitIndex,
            ack: true
          })
        );
        acks++;
      }
    }

    const quorum = this.getQuorumSize();
    const hasQuorum = acks >= quorum;

    this.notify('heartbeat_pulse', {
      leaderId: leader.id,
      term: leader.currentTerm,
      acks,
      quorum,
      hasQuorum,
      rpcs
    });

    return {
      success: true,
      leaderId: leader.id,
      term: leader.currentTerm,
      acks,
      acknowledgedNodes: acks,
      quorum,
      hasQuorum,
      rpcs
    };
  }

  /**
   * Replicates a command from a client to the leader and across followers.
   * Commits the entry once majority quorum acknowledgements are received.
   *
   * @param {string} command
   * @returns {Object}
   */
  replicateLog(command) {
    const trimmed = typeof command === 'string' ? command.trim() : '';
    if (!trimmed) {
      return { success: false, committed: false, reason: 'Command payload cannot be empty', rpcs: [] };
    }

    if (!this.leaderId) {
      return { success: false, committed: false, reason: 'No active leader to accept command', rpcs: [] };
    }

    const leader = this.getNode(this.leaderId);
    if (!leader || !leader.isAlive) {
      this.leaderId = null;
      return { success: false, committed: false, reason: 'Leader is offline', rpcs: [] };
    }

    const nextIndex = leader.log.length + 1;
    const entry = {
      index: nextIndex,
      term: leader.currentTerm,
      command: trimmed,
      committed: false,
      replicatedBy: [leader.id]
    };

    leader.log.push(entry);

    const reachablePeers = this.getReachableNodes(leader).filter((n) => n.id !== leader.id);
    const rpcs = [];
    let acks = 1;

    for (const peer of reachablePeers) {
      // Sync any missing prior entries first, then append new entry
      if (peer.log.length < leader.log.length - 1) {
        peer.log = leader.log.slice(0, leader.log.length - 1).map((e) => ({ ...e }));
      }
      peer.log.push({ ...entry });
      peer.currentTerm = leader.currentTerm;
      peer.state = NODE_STATES.FOLLOWER;
      peer.elapsedMs = 0;

      entry.replicatedBy.push(peer.id);
      acks++;

      rpcs.push(
        this.recordRpc('AppendEntries', leader.id, peer.id, leader.currentTerm, {
          index: nextIndex,
          command: trimmed,
          ack: true
        })
      );
    }

    const quorum = this.getQuorumSize();

    if (acks >= quorum) {
      entry.committed = true;
      leader.commitIndex = nextIndex;
      this.commitIndex = nextIndex;

      for (const peer of reachablePeers) {
        peer.commitIndex = nextIndex;
        const peerEntry = peer.log.find((e) => e.index === nextIndex);
        if (peerEntry) peerEntry.committed = true;
      }

      this.logs.push({ ...entry });

      this.notify('log_committed', {
        entry,
        acks,
        quorum,
        rpcs
      });

      return {
        success: true,
        committed: true,
        entry,
        acks,
        quorum,
        rpcs
      };
    }

    this.notify('log_uncommitted', {
      entry,
      acks,
      quorum,
      rpcs
    });

    return {
      success: false,
      committed: false,
      entry,
      acks,
      quorum,
      rpcs,
      reason: `Quorum not reached (${acks}/${quorum} acknowledgements)`
    };
  }

  /**
   * Simulates node crash/kill or recovery.
   * If aliveStatus is omitted, toggles the node's current alive state.
   *
   * @param {string} nodeId
   * @param {boolean|null} [aliveStatus=null]
   * @returns {Object}
   */
  handleNodeFailure(nodeId, aliveStatus = null) {
    const node = this.getNode(nodeId);
    if (!node) {
      return { success: false, reason: `Node ${nodeId} not found` };
    }

    const nextAlive = aliveStatus !== null ? Boolean(aliveStatus) : !node.isAlive;
    node.isAlive = nextAlive;
    let leaderDropped = false;

    if (!nextAlive) {
      node.state = NODE_STATES.DEAD;
      node.votesReceived = 0;
      if (this.leaderId === nodeId) {
        this.leaderId = null;
        leaderDropped = true;
        this.notify('leader_dropped', { droppedLeaderId: nodeId, term: this.currentTerm });
      }
    } else {
      node.state = NODE_STATES.FOLLOWER;
      node.elapsedMs = 0;
      node.electionTimeoutMs = this.getRandomizedTimeout();
      if (node.currentTerm < this.currentTerm) {
        node.currentTerm = this.currentTerm;
        node.votedFor = null;
      }
    }

    this.notify('node_status_changed', {
      nodeId,
      isAlive: node.isAlive,
      state: node.state,
      leaderDropped
    });

    return {
      success: true,
      nodeId,
      isAlive: node.isAlive,
      state: node.state,
      leaderDropped
    };
  }

  /**
   * Toggles network partition isolation for one or more nodes.
   * Partitioned nodes form an isolated segment and cannot communicate with the main cluster.
   *
   * @param {string|Array<string>} nodeIds
   * @returns {Object}
   */
  togglePartition(nodeIds) {
    const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    for (const id of ids) {
      const node = this.getNode(id);
      if (!node) continue;
      node.isPartitioned = !node.isPartitioned;
      if (node.isPartitioned) {
        this.partitionedNodes.add(id);
      } else {
        this.partitionedNodes.delete(id);
      }
    }

    // If active leader cannot reach a quorum in its partition, it steps down
    if (this.leaderId) {
      const leader = this.getNode(this.leaderId);
      if (leader) {
        const reachableCount = this.getReachableNodes(leader).length;
        if (reachableCount < this.getQuorumSize()) {
          leader.state = NODE_STATES.FOLLOWER;
          this.leaderId = null;
        }
      }
    }

    this.notify('partition_toggled', {
      partitioned: [...this.partitionedNodes],
      leaderId: this.leaderId
    });

    return {
      success: true,
      partitioned: [...this.partitionedNodes],
      leaderId: this.leaderId
    };
  }

  /**
   * Advances election timeout timers by elapsedMs.
   * If a living non-leader node reaches its randomized electionTimeoutMs
   * without a reachable leader heartbeat, it automatically starts an election.
   *
   * @param {number} elapsedMs
   * @returns {Object}
   */
  tick(elapsedMs = 50) {
    const step = Math.max(1, Number(elapsedMs) || 50);
    const electionsTriggered = [];

    // Check if an active leader exists and can reach its followers
    const leader = this.leaderId ? this.getNode(this.leaderId) : null;
    const activeLeader = leader && leader.isAlive ? leader : null;

    for (const node of this.nodes) {
      if (!node.isAlive) continue;

      if (activeLeader && node.id === activeLeader.id) {
        node.elapsedMs = 0;
        continue;
      }

      // If leader is alive and on the same partition, follower timer stays healthy via heartbeats
      if (activeLeader && activeLeader.isPartitioned === node.isPartitioned) {
        node.elapsedMs = 0;
        continue;
      }

      node.elapsedMs += step;
      if (node.elapsedMs >= node.electionTimeoutMs) {
        const res = this.startElection(node.id);
        electionsTriggered.push({ nodeId: node.id, result: res });
        // If a new leader won, stop triggering additional elections in this tick
        if (res.success) {
          break;
        }
      }
    }

    return {
      elapsedMs: step,
      electionsTriggered,
      leaderId: this.leaderId,
      currentTerm: this.currentTerm
    };
  }

  /**
   * Registers an event listener for state machine updates.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((fn) => fn !== callback);
    };
  }

  /**
   * Broadcasts an event to all registered listeners.
   * @param {string} event
   * @param {Object} data
   */
  notify(event, data) {
    for (const listener of this.listeners) {
      listener(event, data);
    }
  }
}

/* ============================================================================
   Browser UI Controller (runs only when mounted in raft-consensus.html)
   ============================================================================ */
if (typeof document !== 'undefined') {
  const initSentinelRaftLab = () => {
    const root = document.querySelector('[data-raft-lab]');
    if (!root) return;

    const cluster = new CybersecuritySentinelRaftCluster(5);

    const termCounterEl = root.querySelector('#term-counter-val');
    const leaderValEl = root.querySelector('#leader-val');
    const quorumValEl = root.querySelector('#quorum-val');
    const committedValEl = root.querySelector('#committed-val');
    const clusterSizeSelect = root.querySelector('#cluster-size-select');

    const startElectionBtn = root.querySelector('#start-election-btn');
    const sendHeartbeatBtn = root.querySelector('#send-heartbeat-btn');
    const killLeaderBtn = root.querySelector('#kill-leader-btn');
    const partitionToggleBtn = root.querySelector('#partition-toggle-btn');
    const splitVoteBtn = root.querySelector('#split-vote-btn');
    const autoTimeoutToggleBtn = root.querySelector('#auto-timeout-toggle-btn');

    const commandInput = root.querySelector('#command-input');
    const replicateBtn = root.querySelector('#replicate-btn');
    const presetButtons = root.querySelectorAll('[data-preset-cmd]');
    const actionStatusEl = root.querySelector('#action-status');

    const nodesGrid = root.querySelector('#nodes-grid');
    const packetLayer = root.querySelector('#packet-layer');
    const logViewerBody = root.querySelector('#log-viewer-body');
    const logTotalBadge = root.querySelector('#log-total-badge');
    const rpcStreamEl = root.querySelector('#rpc-stream');

    let autoTickTimer = null;

    function pushRpcTelemetry(message, tone = 'info') {
      if (!rpcStreamEl) return;
      const item = document.createElement('li');
      item.className = `rpc-item rpc-${tone}`;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      item.innerHTML = `<span class="rpc-ts">[${ts}]</span> <span class="rpc-msg"></span>`;
      item.querySelector('.rpc-msg').textContent = message;
      rpcStreamEl.prepend(item);
      while (rpcStreamEl.children.length > 30) {
        rpcStreamEl.removeChild(rpcStreamEl.lastElementChild);
      }
    }

    function setActionStatus(message, tone = 'info') {
      if (!actionStatusEl) return;
      actionStatusEl.textContent = message;
      actionStatusEl.className = `action-status status-${tone}`;
    }

    function spawnPacketAnimation(fromId, toId, kind = 'heartbeat') {
      if (!packetLayer || !nodesGrid) return;
      const fromCard = nodesGrid.querySelector(`[data-node-id="${fromId}"]`);
      const toCard = nodesGrid.querySelector(`[data-node-id="${toId}"]`);
      if (!fromCard || !toCard) return;

      const gridRect = nodesGrid.getBoundingClientRect();
      const fromRect = fromCard.getBoundingClientRect();
      const toRect = toCard.getBoundingClientRect();

      const startX = fromRect.left - gridRect.left + fromRect.width / 2;
      const startY = fromRect.top - gridRect.top + fromRect.height / 2;
      const endX = toRect.left - gridRect.left + toRect.width / 2;
      const endY = toRect.top - gridRect.top + toRect.height / 2;

      const packet = document.createElement('div');
      packet.className = `rpc-packet packet-${kind}`;
      packet.style.setProperty('--start-x', `${startX}px`);
      packet.style.setProperty('--start-y', `${startY}px`);
      packet.style.setProperty('--end-x', `${endX}px`);
      packet.style.setProperty('--end-y', `${endY}px`);
      packet.setAttribute('aria-hidden', 'true');

      packetLayer.appendChild(packet);
      setTimeout(() => {
        packet.remove();
      }, 750);
    }

    function animateRpcBatch(rpcs = []) {
      rpcs.slice(0, 10).forEach((rpc, idx) => {
        const kind =
          rpc.type === 'RequestVote' || rpc.type === 'VoteResponse'
            ? 'vote'
            : rpc.type === 'AppendEntries'
              ? 'append'
              : 'heartbeat';
        setTimeout(() => {
          spawnPacketAnimation(rpc.from, rpc.to, kind);
        }, idx * 45);
      });
    }

    function getStateCssClass(node) {
      if (!node.isAlive) return 'dead';
      if (node.state === NODE_STATES.LEADER) return 'leader';
      if (node.state === NODE_STATES.CANDIDATE) return 'candidate';
      return 'follower';
    }

    function renderCluster() {
      if (termCounterEl) termCounterEl.textContent = String(cluster.currentTerm);
      if (leaderValEl) leaderValEl.textContent = cluster.leaderId ? cluster.leaderId.toUpperCase() : 'NO LEADER';
      if (quorumValEl) quorumValEl.textContent = `${cluster.getQuorumSize()} / ${cluster.nodes.length} Nodes`;
      if (committedValEl) committedValEl.textContent = String(cluster.logs.length);
      if (logTotalBadge) logTotalBadge.textContent = `${cluster.logs.length} committed`;

      if (killLeaderBtn) {
        killLeaderBtn.disabled = !cluster.leaderId;
      }

      if (partitionToggleBtn) {
        const hasPartition = cluster.partitionedNodes.size > 0;
        partitionToggleBtn.textContent = hasPartition
          ? `🔗 Heal Network Partition (${cluster.partitionedNodes.size})`
          : '🚧 Partition Network (Isolate Minority)';
        partitionToggleBtn.classList.toggle('is-active', hasPartition);
      }

      // Render Node Cards
      if (nodesGrid) {
        nodesGrid.innerHTML = '';
        for (const node of cluster.nodes) {
          const stateClass = getStateCssClass(node);
          const card = document.createElement('article');
          card.className = `node-card state-${stateClass} ${node.isPartitioned ? 'is-partitioned' : ''}`;
          card.setAttribute('data-node-id', node.id);

          const timeoutPct = Math.min(
            100,
            Math.round((node.elapsedMs / Math.max(1, node.electionTimeoutMs)) * 100)
          );

          card.innerHTML = `
            <div class="node-card-top">
              <div>
                <div class="node-label">${node.label}</div>
                <div class="node-id">${node.id}</div>
              </div>
              <span class="state-pill pill-${stateClass}">
                ${node.isAlive ? node.state.toUpperCase() : 'OFFLINE'}
              </span>
            </div>

            <div class="node-metrics">
              <div class="metric-row"><span>Term</span><strong>T${node.currentTerm}</strong></div>
              <div class="metric-row"><span>Voted For</span><strong>${node.votedFor ?? '—'}</strong></div>
              <div class="metric-row"><span>Log / Commit</span><strong>${node.log.length} / ${node.commitIndex}</strong></div>
              <div class="metric-row"><span>Network</span><strong class="${node.isPartitioned ? 'net-isolated' : 'net-ok'}">${node.isPartitioned ? 'PARTITIONED' : node.isAlive ? 'CONNECTED' : 'DOWN'}</strong></div>
            </div>

            <div class="timeout-bar-wrap" title="Randomized election timeout: ${node.electionTimeoutMs}ms">
              <div class="timeout-meta">
                <span>Election Timer</span>
                <span>${node.electionTimeoutMs}ms</span>
              </div>
              <div class="timeout-track">
                <div class="timeout-fill" style="width: ${node.state === NODE_STATES.LEADER || !node.isAlive ? 0 : timeoutPct}%"></div>
              </div>
            </div>

            <div class="node-card-actions">
              <button type="button" class="node-action-btn btn-kill-node">
                ${node.isAlive ? 'Kill Node' : 'Revive Node'}
              </button>
              <button type="button" class="node-action-btn btn-partition-node" ${!node.isAlive ? 'disabled' : ''}>
                ${node.isPartitioned ? 'Heal Link' : 'Isolate'}
              </button>
              <button type="button" class="node-action-btn btn-elect-node" ${!node.isAlive ? 'disabled' : ''}>
                Elect
              </button>
            </div>
          `;

          card.querySelector('.btn-kill-node').addEventListener('click', () => {
            const res = cluster.handleNodeFailure(node.id);
            setActionStatus(
              res.isAlive
                ? `${node.id} recovered as Follower (Term ${cluster.currentTerm}).`
                : `${node.id} killed.${res.leaderDropped ? ' Active leader dropped — election required!' : ''}`,
              res.isAlive ? 'success' : 'warning'
            );
            renderCluster();
          });

          card.querySelector('.btn-partition-node').addEventListener('click', () => {
            cluster.togglePartition([node.id]);
            setActionStatus(
              node.isPartitioned
                ? `${node.id} isolated into network partition.`
                : `${node.id} rejoined primary network segment.`,
              node.isPartitioned ? 'warning' : 'success'
            );
            renderCluster();
          });

          card.querySelector('.btn-elect-node').addEventListener('click', () => {
            const res = cluster.startElection(node.id);
            animateRpcBatch(res.rpcs);
            setActionStatus(
              res.success
                ? `${res.leaderId} elected Leader for Term ${res.term} (${res.votes}/${res.quorum} votes).`
                : `Election failed on ${node.id} in Term ${res.term}: ${res.votes}/${res.quorum} votes.`,
              res.success ? 'success' : 'error'
            );
            renderCluster();
          });

          nodesGrid.appendChild(card);
        }
      }

      // Render Log Replication Viewer
      if (logViewerBody) {
        if (cluster.logs.length === 0) {
          logViewerBody.innerHTML =
            '<tr><td colspan="5" class="empty-row">No security policy logs committed yet. Elect a leader and replicate a command.</td></tr>';
        } else {
          logViewerBody.innerHTML = '';
          [...cluster.logs].reverse().forEach((entry) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>#${entry.index}</td>
              <td>T${entry.term}</td>
              <td class="cmd-cell"></td>
              <td><span class="commit-badge">COMMITTED</span></td>
              <td>${entry.replicatedBy.join(', ')}</td>
            `;
            tr.querySelector('.cmd-cell').textContent = entry.command;
            logViewerBody.appendChild(tr);
          });
        }
      }
    }

    // Subscribe to cluster events for RPC telemetry log
    cluster.subscribe((event, data) => {
      if (event === 'election_won') {
        pushRpcTelemetry(
          `LEADER ELECTED: ${data.leaderId} won Term ${data.term} (${data.votes}/${data.quorum} quorum)`,
          'leader'
        );
      } else if (event === 'split_vote') {
        pushRpcTelemetry(
          `SPLIT VOTE / QUORUM MISS (Term ${data.term}): no majority achieved`,
          'warn'
        );
      } else if (event === 'heartbeat_pulse') {
        pushRpcTelemetry(
          `HEARTBEAT: ${data.leaderId} (Term ${data.term}) -> ${data.acks} nodes acked`,
          'heartbeat'
        );
      } else if (event === 'log_committed') {
        pushRpcTelemetry(
          `LOG COMMITTED #${data.entry.index} (T${data.entry.term}): "${data.entry.command}" [${data.acks}/${data.quorum}]`,
          'commit'
        );
      } else if (event === 'log_uncommitted') {
        pushRpcTelemetry(
          `LOG UNCOMMITTED #${data.entry.index}: Quorum lost (${data.acks}/${data.quorum})`,
          'error'
        );
      } else if (event === 'leader_dropped') {
        pushRpcTelemetry(
          `LEADER FAILURE: ${data.droppedLeaderId} went offline in Term ${data.term}`,
          'error'
        );
      } else if (event === 'partition_toggled') {
        pushRpcTelemetry(
          `PARTITION UPDATE: isolated=[${data.partitioned.join(', ') || 'none'}]`,
          'warn'
        );
      }
    });

    if (clusterSizeSelect) {
      clusterSizeSelect.addEventListener('change', (e) => {
        const count = Number(e.target.value) === 3 ? 3 : 5;
        cluster.setClusterSize(count);
        setActionStatus(`Cluster reconfigured to ${count} nodes (Quorum: ${cluster.getQuorumSize()}).`, 'info');
        renderCluster();
      });
    }

    if (startElectionBtn) {
      startElectionBtn.addEventListener('click', () => {
        const candidate =
          cluster.nodes.find((n) => n.isAlive && !n.isPartitioned && n.id !== cluster.leaderId) ||
          cluster.nodes.find((n) => n.isAlive);
        if (!candidate) {
          setActionStatus('No living nodes available to start election.', 'error');
          return;
        }
        const res = cluster.startElection(candidate.id);
        animateRpcBatch(res.rpcs);
        setActionStatus(
          res.success
            ? `${res.leaderId} elected Leader in Term ${res.term} (${res.votes}/${res.quorum} votes).`
            : `Election in Term ${res.term} failed (${res.votes}/${res.quorum} votes).`,
          res.success ? 'success' : 'error'
        );
        renderCluster();
      });
    }

    if (sendHeartbeatBtn) {
      sendHeartbeatBtn.addEventListener('click', () => {
        const res = cluster.sendHeartbeats();
        if (!res.success) {
          setActionStatus(`Heartbeat skipped: ${res.reason}`, 'warning');
          return;
        }
        animateRpcBatch(res.rpcs);
        setActionStatus(
          `Heartbeats sent by ${res.leaderId} (Term ${res.term}) — ${res.acks}/${res.quorum} nodes reachable.`,
          res.hasQuorum ? 'success' : 'warning'
        );
        renderCluster();
      });
    }

    if (killLeaderBtn) {
      killLeaderBtn.addEventListener('click', () => {
        if (!cluster.leaderId) return;
        const targetId = cluster.leaderId;
        cluster.handleNodeFailure(targetId, false);
        setActionStatus(`Active leader ${targetId} killed! Trigger an election or enable auto-timeouts.`, 'warning');
        renderCluster();
      });
    }

    if (partitionToggleBtn) {
      partitionToggleBtn.addEventListener('click', () => {
        if (cluster.partitionedNodes.size > 0) {
          cluster.togglePartition([...cluster.partitionedNodes]);
          setActionStatus('Network partition healed. All living nodes connected.', 'success');
        } else {
          const minority = cluster.nodes.length === 5 ? ['node-4', 'node-5'] : ['node-3'];
          cluster.togglePartition(minority);
          setActionStatus(`Network partitioned: [${minority.join(', ')}] isolated from majority.`, 'warning');
        }
        renderCluster();
      });
    }

    if (splitVoteBtn) {
      splitVoteBtn.addEventListener('click', () => {
        const res = cluster.simulateSplitVote();
        if (res.rpcs) animateRpcBatch(res.rpcs);
        setActionStatus(
          res.splitVote
            ? `Split vote in Term ${res.term}! Candidates divided votes without reaching quorum ${res.quorum}.`
            : res.reason || `Election resolved in Term ${res.term}.`,
          res.splitVote ? 'warning' : 'info'
        );
        renderCluster();
      });
    }

    if (replicateBtn) {
      replicateBtn.addEventListener('click', () => {
        const cmd = commandInput ? commandInput.value : '';
        const res = cluster.replicateLog(cmd);
        if (res.rpcs) animateRpcBatch(res.rpcs);
        setActionStatus(
          res.committed
            ? `Committed #${res.entry.index} in Term ${res.entry.term} (${res.acks}/${res.quorum} acks).`
            : `Replication failed: ${res.reason}`,
          res.committed ? 'success' : 'error'
        );
        renderCluster();
      });
    }

    presetButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (commandInput) {
          commandInput.value = btn.getAttribute('data-preset-cmd') || '';
        }
      });
    });

    if (autoTimeoutToggleBtn) {
      autoTimeoutToggleBtn.addEventListener('click', () => {
        if (autoTickTimer) {
          clearInterval(autoTickTimer);
          autoTickTimer = null;
          autoTimeoutToggleBtn.textContent = '⏱️ Auto-Timeouts: OFF';
          autoTimeoutToggleBtn.classList.remove('is-active');
        } else {
          autoTickTimer = setInterval(() => {
            if (cluster.leaderId) {
              const hb = cluster.sendHeartbeats();
              if (hb.success) animateRpcBatch(hb.rpcs);
            } else {
              const tickRes = cluster.tick(50);
              tickRes.electionsTriggered.forEach((ev) => {
                if (ev.result?.rpcs) animateRpcBatch(ev.result.rpcs);
              });
            }
            renderCluster();
          }, 900);
          autoTimeoutToggleBtn.textContent = '⏱️ Auto-Timeouts: ON';
          autoTimeoutToggleBtn.classList.add('is-active');
        }
      });
    }

    // Boot cluster with an initial leader election so dashboard is immediately live
    const bootElection = cluster.startElection('node-1');
    renderCluster();
    if (bootElection.rpcs) animateRpcBatch(bootElection.rpcs);
    setActionStatus(
      `Cluster initialized. ${bootElection.leaderId} elected Leader in Term ${bootElection.term}.`,
      'success'
    );
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSentinelRaftLab);
  } else {
    initSentinelRaftLab();
  }
}
