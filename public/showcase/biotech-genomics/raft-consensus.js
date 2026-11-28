/**
 * BiotechGenomicsRaftCluster
 *
 * A dependency-free, simulated Raft consensus engine for a genomics
 * sequencing cluster. It models the three Raft roles (Leader, Follower,
 * Candidate), randomized election timeouts, RequestVote exchanges,
 * heartbeat propagation, network partitions, and quorum-based log
 * replication of genomic ledger commands.
 *
 * The class is intentionally UI-agnostic so it can be unit tested in Node
 * with `node --test`. A small DOM controller at the bottom wires the engine
 * to the showcase page when a browser document is present.
 */

export const RAFT_NODE_STATES = Object.freeze({
  FOLLOWER: 'Follower',
  CANDIDATE: 'Candidate',
  LEADER: 'Leader',
  DEAD: 'Dead'
});

const DEFAULT_TIMEOUT_MIN = 150;
const DEFAULT_TIMEOUT_MAX = 300;

export class BiotechGenomicsRaftCluster {
  /**
   * @param {number} [nodeCount=5] Number of sequencing validator nodes.
   * @param {object} [options]
   * @param {number} [options.initialTerm=1]
   * @param {Function} [options.random=Math.random]
   * @param {number} [options.electionTimeoutMin=150]
   * @param {number} [options.electionTimeoutMax=300]
   * @param {number} [options.heartbeatInterval=50]
   */
  constructor(nodeCount = 5, options = {}) {
    if (!Number.isInteger(nodeCount) || nodeCount < 1) {
      throw new Error('nodeCount must be a positive integer');
    }

    this.name = 'BiotechGenomicsRaftCluster';
    this.nodeCount = nodeCount;
    this.currentTerm = options.initialTerm ?? 1;
    this.leaderId = null;
    this.logs = [];
    this.partitionedNodes = new Set();
    this.listeners = [];

    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.electionTimeoutMin = options.electionTimeoutMin ?? DEFAULT_TIMEOUT_MIN;
    this.electionTimeoutMax = options.electionTimeoutMax ?? DEFAULT_TIMEOUT_MAX;
    this.heartbeatInterval = options.heartbeatInterval ?? 50;

    if (this.electionTimeoutMin > this.electionTimeoutMax) {
      throw new Error('electionTimeoutMin cannot exceed electionTimeoutMax');
    }

    this.nodes = [];
    this.initNodes(nodeCount);
  }

  /**
   * (Re)builds the validator node ring.
   * @param {number} count
   * @returns {Array<object>}
   */
  initNodes(count) {
    this.nodeCount = count;
    this.nodes = Array.from({ length: count }, (_, index) => {
      const node = {
        id: `node-${index + 1}`,
        state: RAFT_NODE_STATES.FOLLOWER,
        currentTerm: this.currentTerm,
        votedFor: null,
        log: [],
        commitIndex: 0,
        isAlive: true,
        isPartitioned: false,
        electionTimeout: 0,
        lastHeartbeatAt: 0
      };
      node.electionTimeout = this.getRandomizedTimeout();
      return node;
    });

    this.leaderId = null;
    this.partitionedNodes.clear();
    this.logs = [];
    return this.nodes;
  }

  /**
   * Draws a randomized election timeout in milliseconds. Raft uses this
   * jitter to avoid repeated split votes between candidates.
   * @returns {number}
   */
  getRandomizedTimeout() {
    const span = this.electionTimeoutMax - this.electionTimeoutMin;
    return this.electionTimeoutMin + Math.floor(this.random() * (span + 1));
  }

  /**
   * Majority quorum for the configured cluster: floor(N / 2) + 1.
   * @returns {number}
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  /**
   * @param {string} nodeId
   * @returns {object|undefined}
   */
  getNode(nodeId) {
    return this.nodes.find((node) => node.id === nodeId);
  }

  /**
   * Nodes that can currently send/receive RPCs.
   * @returns {Array<object>}
   */
  getReachableNodes() {
    return this.nodes.filter((node) => node.isAlive && !node.isPartitioned);
  }

  /**
   * Returns the leader only if it is still alive and connected.
   * @returns {object|null}
   */
  getActiveLeader() {
    if (!this.leaderId) return null;
    const leader = this.getNode(this.leaderId);
    if (!leader || !leader.isAlive || leader.isPartitioned) return null;
    return leader;
  }

  /**
   * @returns {Array<{id: string, electionTimeout: number, lastHeartbeatAt: number}>}
   */
  getElectionTimeouts() {
    return this.nodes.map((node) => ({
      id: node.id,
      electionTimeout: node.electionTimeout,
      lastHeartbeatAt: node.lastHeartbeatAt
    }));
  }

  /**
   * Aggregated role counts used by the UI.
   * @returns {{leaders: number, followers: number, candidates: number, dead: number, partitioned: number}}
   */
  getStateSummary() {
    const summary = { leaders: 0, followers: 0, candidates: 0, dead: 0, partitioned: 0 };
    for (const node of this.nodes) {
      if (node.isPartitioned) summary.partitioned += 1;
      if (!node.isAlive) {
        summary.dead += 1;
      } else if (node.state === RAFT_NODE_STATES.LEADER) {
        summary.leaders += 1;
      } else if (node.state === RAFT_NODE_STATES.CANDIDATE) {
        summary.candidates += 1;
      } else {
        summary.followers += 1;
      }
    }
    return summary;
  }

  /**
   * Runs a RequestVote round for `candidateId`.
   *
   * `options.denyVoters` simulates peers that already cast their vote for a
   * competing candidate in the same term, which is how a split vote is
   * produced deterministically in tests.
   *
   * @param {string} candidateId
   * @param {{denyVoters?: string[]}} [options]
   * @returns {object}
   */
  startElection(candidateId, options = {}) {
    const candidate = this.getNode(candidateId);
    const quorum = this.getQuorumSize();

    if (!candidate) {
      return { success: false, reason: 'Candidate node not found', votes: 0, quorum, term: this.currentTerm };
    }
    if (!candidate.isAlive) {
      return { success: false, reason: 'Candidate node is offline', votes: 0, quorum, term: this.currentTerm };
    }
    if (candidate.isPartitioned) {
      return { success: false, reason: 'Candidate node is network-partitioned', votes: 0, quorum, term: this.currentTerm };
    }

    const denyVoters = new Set(options.denyVoters ?? []);

    // Every election starts a new term and invalidates the previous leader.
    this.currentTerm += 1;
    this.leaderId = null;

    candidate.currentTerm = this.currentTerm;
    candidate.state = RAFT_NODE_STATES.CANDIDATE;
    candidate.votedFor = candidateId;
    candidate.electionTimeout = this.getRandomizedTimeout();
    candidate.lastHeartbeatAt = Date.now();

    const voters = [candidateId];
    const deniedVoters = [];
    let votes = 1;

    for (const node of this.getReachableNodes()) {
      if (node.id === candidateId) continue;

      if (denyVoters.has(node.id)) {
        node.currentTerm = Math.max(node.currentTerm, candidate.currentTerm);
        deniedVoters.push(node.id);
        continue;
      }

      // A higher term forces the peer to adopt it and clear its vote.
      if (candidate.currentTerm > node.currentTerm) {
        node.currentTerm = candidate.currentTerm;
        node.votedFor = null;
        node.state = RAFT_NODE_STATES.FOLLOWER;
      }

      const canVote =
        node.currentTerm <= candidate.currentTerm &&
        (node.votedFor === null || node.votedFor === candidateId);

      if (canVote) {
        node.currentTerm = candidate.currentTerm;
        node.votedFor = candidateId;
        node.state = RAFT_NODE_STATES.FOLLOWER;
        node.electionTimeout = this.getRandomizedTimeout();
        node.lastHeartbeatAt = Date.now();
        votes += 1;
        voters.push(node.id);
      } else {
        deniedVoters.push(node.id);
      }
    }

    if (votes >= quorum) {
      candidate.state = RAFT_NODE_STATES.LEADER;
      this.leaderId = candidateId;

      for (const node of this.getReachableNodes()) {
        if (node.id !== candidateId) {
          node.state = RAFT_NODE_STATES.FOLLOWER;
          node.currentTerm = candidate.currentTerm;
        }
      }

      this.notify('election_won', {
        leaderId: candidateId,
        term: this.currentTerm,
        votes,
        quorum,
        voters
      });

      return {
        success: true,
        leaderId: candidateId,
        term: this.currentTerm,
        votes,
        quorum,
        voters,
        deniedVoters
      };
    }

    // Split vote or lost quorum: stand down so a later timeout can retry.
    candidate.state = RAFT_NODE_STATES.FOLLOWER;
    candidate.votedFor = null;

    this.notify('split_vote', {
      candidateId,
      term: this.currentTerm,
      votes,
      quorum,
      deniedVoters
    });

    return {
      success: false,
      reason: 'Split vote or quorum not achieved',
      candidateId,
      term: this.currentTerm,
      votes,
      quorum,
      voters,
      deniedVoters
    };
  }

  /**
   * Leader heartbeat (AppendEntries with no new command). Resets follower
   * election timers and reasserts the leader's term.
   * @returns {object}
   */
  sendHeartbeats() {
    const leader = this.getActiveLeader();

    if (!leader) {
      const reason = this.leaderId ? 'Leader is dead or partitioned' : 'No active leader elected';
      this.leaderId = null;
      return { success: false, reason, acknowledgedNodes: 0, quorum: this.getQuorumSize() };
    }

    const now = Date.now();
    let acks = 1;

    for (const node of this.getReachableNodes()) {
      if (node.id === leader.id) continue;
      node.state = RAFT_NODE_STATES.FOLLOWER;
      node.currentTerm = leader.currentTerm;
      node.votedFor = null;
      node.electionTimeout = this.getRandomizedTimeout();
      node.lastHeartbeatAt = now;
      acks += 1;
    }

    const quorum = this.getQuorumSize();
    this.notify('heartbeat_pulse', {
      leaderId: leader.id,
      term: leader.currentTerm,
      acks,
      quorum
    });

    return {
      success: true,
      leaderId: leader.id,
      term: leader.currentTerm,
      acknowledgedNodes: acks,
      quorum,
      quorumReached: acks >= quorum
    };
  }

  /**
   * Replicates a genomic ledger command and commits it once a majority of
   * the cluster acknowledges the entry.
   * @param {string} command
   * @returns {object}
   */
  replicateLog(command) {
    const leader = this.getActiveLeader();
    const quorum = this.getQuorumSize();

    if (!leader) {
      this.leaderId = null;
      return {
        success: false,
        committed: false,
        reason: 'No active leader to accept the genomic command',
        acks: 0,
        quorum
      };
    }

    if (typeof command !== 'string' || command.trim() === '') {
      return {
        success: false,
        committed: false,
        reason: 'Command payload is empty',
        acks: 0,
        quorum
      };
    }

    const index = this.logs.length + 1;
    const entry = {
      index,
      term: leader.currentTerm,
      command: command.trim(),
      committed: false,
      replicatedBy: [leader.id],
      timestamp: Date.now()
    };

    leader.log.push({ ...entry, replicatedBy: [...entry.replicatedBy] });

    let acks = 1;
    const followerCopies = [];

    for (const node of this.getReachableNodes()) {
      if (node.id === leader.id) continue;
      const copy = { ...entry, replicatedBy: [...entry.replicatedBy, node.id] };
      node.log.push(copy);
      followerCopies.push({ node, copy });
      entry.replicatedBy.push(node.id);
      acks += 1;
    }

    if (acks >= quorum) {
      entry.committed = true;
      leader.commitIndex = index;
      leader.log[leader.log.length - 1].committed = true;

      for (const { node, copy } of followerCopies) {
        copy.committed = true;
        node.commitIndex = index;
      }

      const committedEntry = { ...entry, replicatedBy: [...entry.replicatedBy] };
      this.logs.push(committedEntry);
      this.notify('log_committed', { entry: committedEntry, acks, quorum });

      return {
        success: true,
        committed: true,
        entry: committedEntry,
        acks,
        quorum
      };
    }

    // Quorum lost: discard the speculative append so logs stay consistent.
    leader.log.pop();
    for (const { node } of followerCopies) node.log.pop();

    const rejectedEntry = { ...entry, replicatedBy: [...entry.replicatedBy] };
    this.notify('log_uncommitted', { entry: rejectedEntry, acks, quorum });

    return {
      success: false,
      committed: false,
      entry: rejectedEntry,
      acks,
      quorum,
      reason: 'Quorum not reached for commit'
    };
  }

  /**
   * Kills or revives a node. Killing the active leader clears leadership.
   * @param {string} nodeId
   * @param {boolean|null} [aliveStatus=null] null toggles the current state.
   * @returns {object}
   */
  handleNodeFailure(nodeId, aliveStatus = null) {
    const node = this.getNode(nodeId);
    if (!node) return { success: false, reason: 'Node not found' };

    const nextAlive = aliveStatus === null ? !node.isAlive : Boolean(aliveStatus);
    node.isAlive = nextAlive;

    if (nextAlive) {
      node.state = RAFT_NODE_STATES.FOLLOWER;
      node.votedFor = null;
      node.currentTerm = Math.max(node.currentTerm, this.currentTerm);
      node.electionTimeout = this.getRandomizedTimeout();
      node.lastHeartbeatAt = Date.now();
    } else {
      node.state = RAFT_NODE_STATES.DEAD;
      node.votedFor = null;

      if (this.leaderId === nodeId) {
        this.leaderId = null;
        this.notify('leader_dropped', {
          droppedLeaderId: nodeId,
          term: this.currentTerm,
          cause: 'failure'
        });
      }
    }

    this.notify('node_status_changed', {
      nodeId,
      isAlive: node.isAlive,
      state: node.state
    });

    return { success: true, nodeId, isAlive: node.isAlive, state: node.state };
  }

  /**
   * Toggles the network partition flag for one or more nodes. A partitioned
   * leader immediately loses leadership because it can no longer reach peers.
   * @param {string|string[]} nodeIds
   * @returns {object}
   */
  togglePartition(nodeIds) {
    const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    const affected = [];

    for (const id of ids) {
      const node = this.getNode(id);
      if (!node) continue;

      node.isPartitioned = !node.isPartitioned;
      if (node.isPartitioned) {
        this.partitionedNodes.add(id);
      } else {
        this.partitionedNodes.delete(id);
      }

      if (node.isPartitioned && this.leaderId === id) {
        this.leaderId = null;
        this.notify('leader_dropped', {
          droppedLeaderId: id,
          term: this.currentTerm,
          cause: 'partition'
        });
      }

      affected.push({ id, isPartitioned: node.isPartitioned });
    }

    this.notify('partition_toggled', { partitioned: [...this.partitionedNodes] });

    return {
      success: true,
      partitioned: [...this.partitionedNodes],
      affected
    };
  }

  /**
   * Resets the cluster to a fresh term with no leader or committed log.
   * @returns {object}
   */
  reset() {
    this.currentTerm = 1;
    this.initNodes(this.nodeCount);
    this.notify('cluster_reset', { term: this.currentTerm });
    return this.getStateSummary();
  }

  /**
   * @param {(event: string, data: object) => void} callback
   */
  subscribe(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }

  /**
   * @param {string} event
   * @param {object} data
   */
  notify(event, data) {
    for (const listener of this.listeners) {
      listener(event, data);
    }
  }
}

/**
 * Browser-only controller that renders the cluster into the showcase page.
 * Kept behind a `document` guard so importing this module in Node tests does
 * not touch the DOM.
 */
function initRaftConsensusLab() {
  const root = document.querySelector('[data-raft-lab]');
  if (!root) return;

  let cluster = new BiotechGenomicsRaftCluster(5);
  let packetTimer = null;

  const termVal = root.querySelector('#current-term-val');
  const leaderVal = root.querySelector('#current-leader-val');
  const quorumVal = root.querySelector('#quorum-val');
  const committedLogsVal = root.querySelector('#committed-logs-val');
  const nodesContainer = root.querySelector('#nodes-container');
  const packetOverlay = root.querySelector('#packet-overlay');
  const clusterSizeSelect = root.querySelector('#cluster-size');
  const electionBtn = root.querySelector('#election-btn');
  const heartbeatBtn = root.querySelector('#heartbeat-btn');
  const killLeaderBtn = root.querySelector('#kill-leader-btn');
  const partitionBtn = root.querySelector('#partition-btn');
  const resetBtn = root.querySelector('#reset-btn');
  const commandInput = root.querySelector('#command-input');
  const replicateBtn = root.querySelector('#replicate-btn');
  const replicateStatus = root.querySelector('#replicate-status');
  const logEntriesBody = root.querySelector('#log-entries-body');
  const logCountTag = root.querySelector('#log-count-tag');

  const setStatus = (message) => {
    if (replicateStatus) replicateStatus.textContent = message;
  };

  function animatePackets() {
    if (!packetOverlay || !nodesContainer) return;
    packetOverlay.innerHTML = '';

    const leaderCard = nodesContainer.querySelector('.node-card.leader');
    if (!leaderCard) return;

    const containerRect = nodesContainer.getBoundingClientRect();
    const leaderRect = leaderCard.getBoundingClientRect();
    const originX = leaderRect.left - containerRect.left + leaderRect.width / 2;
    const originY = leaderRect.top - containerRect.top + leaderRect.height / 2;

    nodesContainer.querySelectorAll('.node-card.follower').forEach((card, index) => {
      const rect = card.getBoundingClientRect();
      const targetX = rect.left - containerRect.left + rect.width / 2;
      const targetY = rect.top - containerRect.top + rect.height / 2;

      const pulse = document.createElement('span');
      pulse.className = 'packet-pulse';
      pulse.style.setProperty('--origin-x', `${originX}px`);
      pulse.style.setProperty('--origin-y', `${originY}px`);
      pulse.style.setProperty('--target-x', `${targetX}px`);
      pulse.style.setProperty('--target-y', `${targetY}px`);
      pulse.style.animationDelay = `${index * 70}ms`;
      packetOverlay.appendChild(pulse);
    });

    window.clearTimeout(packetTimer);
    packetTimer = window.setTimeout(() => {
      if (packetOverlay) packetOverlay.innerHTML = '';
    }, 1400);
  }

  function renderNodes() {
    nodesContainer.innerHTML = '';

    cluster.nodes.forEach((node) => {
      const roleClass = !node.isAlive
        ? 'dead'
        : node.state === RAFT_NODE_STATES.LEADER
          ? 'leader'
          : node.state === RAFT_NODE_STATES.CANDIDATE
            ? 'candidate'
            : 'follower';

      const card = document.createElement('div');
      card.className = `node-card ${roleClass}${node.isPartitioned ? ' partitioned' : ''}`;
      card.dataset.nodeId = node.id;
      card.innerHTML = `
        <div class="node-card-header">
          <span class="node-id-title">${node.id.replace('node-', 'SEQ-')}</span>
          <span class="role-pill role-${roleClass}">${node.isAlive ? node.state : 'OFFLINE'}</span>
        </div>
        <div class="node-details">
          <div><span>Term</span><strong>${node.currentTerm}</strong></div>
          <div><span>Voted For</span><strong>${node.votedFor ?? '—'}</strong></div>
          <div><span>Log</span><strong>${node.log.length}</strong></div>
          <div><span>Timeout</span><strong>${node.electionTimeout} ms</strong></div>
          <div><span>Network</span><strong>${node.isPartitioned ? 'Isolated' : node.isAlive ? 'Connected' : 'Offline'}</strong></div>
        </div>
        <div class="node-actions">
          <button type="button" class="node-btn btn-kill">${node.isAlive ? 'Kill Node' : 'Revive Node'}</button>
          <button type="button" class="node-btn btn-elect" ${!node.isAlive || node.isPartitioned ? 'disabled' : ''}>Run Election</button>
        </div>
      `;

      card.querySelector('.btn-kill').addEventListener('click', () => {
        const wasLeader = cluster.leaderId === node.id;
        const result = cluster.handleNodeFailure(node.id);
        setStatus(
          result.isAlive
            ? `Node ${node.id} revived and rejoined as a Follower.`
            : `${wasLeader ? 'Leader' : 'Node'} ${node.id} failed and left the cluster.`
        );
        renderAll();
      });

      card.querySelector('.btn-elect').addEventListener('click', () => {
        const result = cluster.startElection(node.id);
        setStatus(
          result.success
            ? `Node ${node.id} won the election with ${result.votes}/${cluster.nodes.length} votes in term ${result.term}.`
            : `Election failed for ${node.id}: ${result.reason} (${result.votes}/${result.quorum} quorum).`
        );
        renderAll();
        if (result.success) animatePackets();
      });

      nodesContainer.appendChild(card);
    });
  }

  function renderLogs() {
    if (cluster.logs.length === 0) {
      logEntriesBody.innerHTML =
        '<tr><td colspan="5" class="empty-log-msg">No genomic ledger entries committed yet. Submit a command above.</td></tr>';
      logCountTag.textContent = '0 entries committed';
      return;
    }

    logEntriesBody.innerHTML = '';
    cluster.logs.forEach((entry) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>#${entry.index}</td>
        <td>Term ${entry.term}</td>
        <td><code>${entry.command}</code></td>
        <td><span class="commit-badge commit-yes">COMMITTED</span></td>
        <td>${entry.replicatedBy.join(', ')}</td>
      `;
      logEntriesBody.appendChild(row);
    });
    logCountTag.textContent = `${cluster.logs.length} entr${cluster.logs.length === 1 ? 'y' : 'ies'} committed`;
  }

  function renderAll() {
    termVal.textContent = cluster.currentTerm;
    leaderVal.textContent = cluster.leaderId ?? 'None — election required';
    quorumVal.textContent = `${cluster.getQuorumSize()} of ${cluster.nodes.length} nodes`;
    committedLogsVal.textContent = cluster.logs.length;

    renderNodes();
    renderLogs();

    if (partitionBtn) {
      partitionBtn.textContent =
        cluster.partitionedNodes.size > 0
          ? 'Reconnect Partitioned Nodes'
          : 'Partition Minority Nodes';
    }
  }

  if (clusterSizeSelect) {
    clusterSizeSelect.addEventListener('change', (event) => {
      cluster = new BiotechGenomicsRaftCluster(Number(event.target.value));
      const election = cluster.startElection('node-1');
      setStatus(
        election.success
          ? `Bootstrapped a ${cluster.nodes.length}-node cluster; node-1 elected leader.`
          : 'Bootstrapped cluster; waiting for an election.'
      );
      renderAll();
    });
  }

  if (electionBtn) {
    electionBtn.addEventListener('click', () => {
      const candidates = cluster.getReachableNodes();
      if (candidates.length === 0) {
        setStatus('No reachable nodes are available to run an election.');
        return;
      }
      const candidate = candidates[0];
      const result = cluster.startElection(candidate.id);
      setStatus(
        result.success
          ? `Node ${candidate.id} won the election in term ${result.term} with ${result.votes} votes.`
          : `Election failed: ${result.reason} (${result.votes}/${result.quorum} quorum).`
      );
      renderAll();
      if (result.success) animatePackets();
    });
  }

  if (heartbeatBtn) {
    heartbeatBtn.addEventListener('click', () => {
      const result = cluster.sendHeartbeats();
      setStatus(
        result.success
          ? `Heartbeat from ${result.leaderId} acknowledged by ${result.acknowledgedNodes} nodes.`
          : `Heartbeat failed: ${result.reason}.`
      );
      renderAll();
      if (result.success) animatePackets();
    });
  }

  if (killLeaderBtn) {
    killLeaderBtn.addEventListener('click', () => {
      if (!cluster.leaderId) {
        setStatus('There is no active leader to fail.');
        return;
      }
      const dropped = cluster.leaderId;
      cluster.handleNodeFailure(dropped, false);
      setStatus(`Leader ${dropped} failed. The cluster now needs a new election.`);
      renderAll();
    });
  }

  if (partitionBtn) {
    partitionBtn.addEventListener('click', () => {
      if (cluster.partitionedNodes.size > 0) {
        const healed = [...cluster.partitionedNodes];
        cluster.togglePartition(healed);
        setStatus(`Network healed: ${healed.join(', ')} rejoined the cluster.`);
      } else {
        const target = cluster.nodes.length === 5 ? ['node-4', 'node-5'] : ['node-3'];
        cluster.togglePartition(target);
        setStatus(`Network partitioned: ${target.join(', ')} isolated as a minority.`);
      }
      renderAll();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      cluster.reset();
      cluster.startElection('node-1');
      setStatus('Cluster reset to a fresh term; node-1 elected leader.');
      renderAll();
    });
  }

  if (replicateBtn) {
    replicateBtn.addEventListener('click', () => {
      const command = commandInput.value.trim();
      if (!command) {
        setStatus('Enter a genomic ledger command before replicating.');
        return;
      }
      const result = cluster.replicateLog(command);
      setStatus(
        result.success
          ? `Entry #${result.entry.index} committed across ${result.acks} nodes.`
          : `Replication rejected: ${result.reason} (${result.acks}/${result.quorum} acks).`
      );
      renderAll();
      if (result.success) animatePackets();
    });
  }

  cluster.startElection('node-1');
  renderAll();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRaftConsensusLab);
  } else {
    initRaftConsensusLab();
  }
}
