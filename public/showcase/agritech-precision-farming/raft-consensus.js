/**
 * AgritechPrecisionFarmingRaftCluster
 * Distributed Raft Consensus & Leader Election State Machine.
 * Simulates Leader, Follower, and Candidate states, majority quorum calculations,
 * election term increments, vote exchanges, and replicated log commits.
 */

export class AgritechPrecisionFarmingRaftCluster {
  constructor(nodeCount = 5, options = {}) {
    this.name = 'AgritechPrecisionFarmingRaftCluster';
    this.nodeCount = nodeCount;
    this.currentTerm = 1;
    this.leaderId = null;
    this.logs = [];
    this.partitionedNodes = new Set();
    this.listeners = [];
    this.nodes = [];

    this.initNodes(nodeCount);
  }

  /**
   * Initializes the cluster nodes.
   * @param {number} count
   */
  initNodes(count) {
    this.nodeCount = count;
    this.nodes = [];
    for (let i = 1; i <= count; i++) {
      this.nodes.push({
        id: `node-${i}`,
        state: 'Follower',
        currentTerm: this.currentTerm,
        votedFor: null,
        log: [],
        commitIndex: 0,
        isAlive: true,
        isPartitioned: false
      });
    }
    this.leaderId = null;
  }

  /**
   * Calculates majority quorum threshold for the cluster.
   * Raft consensus requires floor(N / 2) + 1 nodes.
   * @returns {number}
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  /**
   * Returns active, living, non-partitioned nodes.
   * @returns {Array<object>}
   */
  getReachableNodes() {
    return this.nodes.filter((n) => n.isAlive && !n.isPartitioned);
  }

  /**
   * Initiates a leader election on a candidate node.
   * @param {string} candidateId
   * @returns {object}
   */
  startElection(candidateId) {
    const candidate = this.nodes.find((n) => n.id === candidateId);
    if (!candidate || !candidate.isAlive || candidate.isPartitioned) {
      return { success: false, reason: 'Candidate node unreachable or dead' };
    }

    // Convert to Candidate and increment term
    this.currentTerm++;
    candidate.currentTerm = this.currentTerm;
    candidate.state = 'Candidate';
    candidate.votedFor = candidateId;

    let votesCount = 1; // Votes for itself
    const voters = [candidateId];

    // Request votes from other reachable nodes
    const reachable = this.getReachableNodes();
    for (const node of reachable) {
      if (node.id === candidateId) continue;

      // In Raft, if candidate's term is higher, node updates its term and resets votedFor
      if (candidate.currentTerm > node.currentTerm) {
        node.currentTerm = candidate.currentTerm;
        node.votedFor = null;
        node.state = 'Follower';
      }

      // Follower votes if it hasn't voted in this term and candidate term is >= its term
      if (node.currentTerm <= candidate.currentTerm && (node.votedFor === null || node.votedFor === candidateId)) {
        node.currentTerm = candidate.currentTerm;
        node.votedFor = candidateId;
        votesCount++;
        voters.push(node.id);
      }
    }

    const quorum = this.getQuorumSize();

    // Check majority quorum
    if (votesCount >= quorum) {
      candidate.state = 'Leader';
      this.leaderId = candidateId;

      // Re-align other reachable followers
      for (const node of reachable) {
        if (node.id !== candidateId) {
          node.state = 'Follower';
          node.currentTerm = this.currentTerm;
        }
      }

      this.notify('election_won', { leaderId: candidateId, term: this.currentTerm, votes: votesCount, voters });
      return {
        success: true,
        leaderId: candidateId,
        term: this.currentTerm,
        votes: votesCount,
        quorum
      };
    } else {
      // Split vote or quorum not achieved
      candidate.state = 'Follower';
      this.notify('split_vote', { candidateId, term: this.currentTerm, votes: votesCount, quorum });
      return {
        success: false,
        reason: 'Split vote or quorum not achieved',
        votes: votesCount,
        quorum,
        term: this.currentTerm
      };
    }
  }

  /**
   * Sends heartbeat signals from the active leader to all followers.
   * @returns {object}
   */
  sendHeartbeats() {
    if (!this.leaderId) {
      return { success: false, reason: 'No active leader elected' };
    }

    const leader = this.nodes.find((n) => n.id === this.leaderId);
    if (!leader || !leader.isAlive || leader.isPartitioned) {
      this.leaderId = null;
      return { success: false, reason: 'Leader is dead or partitioned' };
    }

    let acks = 1;
    const reachable = this.getReachableNodes();
    for (const node of reachable) {
      if (node.id !== this.leaderId) {
        node.state = 'Follower';
        node.currentTerm = leader.currentTerm;
        node.votedFor = null;
        acks++;
      }
    }

    this.notify('heartbeat_pulse', { leaderId: this.leaderId, acks });
    return {
      success: true,
      leaderId: this.leaderId,
      term: leader.currentTerm,
      acknowledgedNodes: acks
    };
  }

  /**
   * Replicates a command across cluster logs and commits upon quorum acknowledgement.
   * @param {string} command
   * @returns {object}
   */
  replicateLog(command) {
    if (!this.leaderId) {
      return { success: false, reason: 'No active leader to accept client command' };
    }

    const leader = this.nodes.find((n) => n.id === this.leaderId);
    if (!leader || !leader.isAlive || leader.isPartitioned) {
      this.leaderId = null;
      return { success: false, reason: 'Leader is unreachable' };
    }

    const logIndex = this.logs.length + 1;
    const logEntry = {
      index: logIndex,
      term: leader.currentTerm,
      command,
      committed: false,
      replicatedBy: [this.leaderId]
    };

    leader.log.push(logEntry);

    // Replicate to reachable followers
    let ackCount = 1;
    const reachable = this.getReachableNodes();
    for (const node of reachable) {
      if (node.id !== this.leaderId) {
        node.log.push({ ...logEntry });
        logEntry.replicatedBy.push(node.id);
        ackCount++;
      }
    }

    const quorum = this.getQuorumSize();

    // Commit upon quorum
    if (ackCount >= quorum) {
      logEntry.committed = true;
      leader.commitIndex = logIndex;
      for (const node of reachable) {
        node.commitIndex = logIndex;
      }
      this.logs.push({ ...logEntry });
      this.notify('log_committed', { entry: logEntry, acks: ackCount, quorum });
      return {
        success: true,
        committed: true,
        entry: logEntry,
        acks: ackCount,
        quorum
      };
    } else {
      this.notify('log_uncommitted', { entry: logEntry, acks: ackCount, quorum });
      return {
        success: false,
        committed: false,
        entry: logEntry,
        acks: ackCount,
        quorum,
        reason: 'Quorum not reached for commit'
      };
    }
  }

  /**
   * Handles failure or recovery of a node (kill / revive).
   * @param {string} nodeId
   * @param {boolean} [aliveStatus=null]
   * @returns {object}
   */
  handleNodeFailure(nodeId, aliveStatus = null) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return { success: false, reason: 'Node not found' };

    node.isAlive = aliveStatus !== null ? aliveStatus : !node.isAlive;

    if (!node.isAlive) {
      node.state = 'Dead';
      // If leader died, clear current leader
      if (this.leaderId === nodeId) {
        this.leaderId = null;
        this.notify('leader_dropped', { droppedLeaderId: nodeId });
      }
    } else {
      node.state = 'Follower';
    }

    this.notify('node_status_changed', { nodeId, isAlive: node.isAlive, state: node.state });
    return {
      success: true,
      nodeId,
      isAlive: node.isAlive,
      state: node.state
    };
  }

  /**
   * Toggles network partition for a subset of nodes.
   * @param {Array<string>} nodeIds
   * @returns {object}
   */
  togglePartition(nodeIds) {
    nodeIds.forEach((id) => {
      const node = this.nodes.find((n) => n.id === id);
      if (node) {
        node.isPartitioned = !node.isPartitioned;
        if (node.isPartitioned) {
          this.partitionedNodes.add(id);
          if (this.leaderId === id) {
            this.leaderId = null;
          }
        } else {
          this.partitionedNodes.delete(id);
        }
      }
    });

    this.notify('partition_toggled', { partitioned: [...this.partitionedNodes] });
    return {
      success: true,
      partitioned: [...this.partitionedNodes]
    };
  }

  /**
   * Subscribes a listener to cluster events.
   * @param {Function} callback
   */
  subscribe(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }

  /**
   * Notifies registered listeners.
   */
  notify(event, data) {
    this.listeners.forEach((fn) => fn(event, data));
  }
}

// Browser DOM controller
if (typeof document !== 'undefined') {
  const initClusterLab = () => {
    const root = document.querySelector('[data-raft-lab]');
    if (!root) return;

    let cluster = new AgritechPrecisionFarmingRaftCluster(5);

    const termVal = root.querySelector('#current-term-val');
    const leaderVal = root.querySelector('#current-leader-val');
    const quorumVal = root.querySelector('#quorum-val');
    const committedLogsVal = root.querySelector('#committed-logs-val');
    const nodesContainer = root.querySelector('#nodes-container');
    const clusterSizeSelect = root.querySelector('#cluster-size');
    const electionBtn = root.querySelector('#election-btn');
    const heartbeatBtn = root.querySelector('#heartbeat-btn');
    const killLeaderBtn = root.querySelector('#kill-leader-btn');
    const partitionBtn = root.querySelector('#partition-btn');
    const commandInput = root.querySelector('#command-input');
    const replicateBtn = root.querySelector('#replicate-btn');
    const replicateStatus = root.querySelector('#replicate-status');
    const logEntriesBody = root.querySelector('#log-entries-body');
    const logCountTag = root.querySelector('#log-count-tag');
    const packetOverlay = root.querySelector('#packet-overlay');

    function animatePackets() {
      if (!packetOverlay) return;
      packetOverlay.innerHTML = '';
      const leaderCard = nodesContainer.querySelector('.node-card.leader');
      if (!leaderCard) return;

      const rectLeader = leaderCard.getBoundingClientRect();
      const rectContainer = nodesContainer.getBoundingClientRect();

      nodesContainer.querySelectorAll('.node-card.follower').forEach((followerCard) => {
        const rectFollower = followerCard.getBoundingClientRect();
        const pulse = document.createElement('div');
        pulse.className = 'packet-pulse';
        pulse.style.left = `${rectFollower.left - rectContainer.left + 80}px`;
        pulse.style.top = `${rectFollower.top - rectContainer.top + 30}px`;
        packetOverlay.appendChild(pulse);
      });
    }

    function renderUI() {
      // 1. Update status bar
      termVal.textContent = cluster.currentTerm;
      leaderVal.textContent = cluster.leaderId ?? 'None (Elections needed)';
      quorumVal.textContent = `${cluster.getQuorumSize()} of ${cluster.nodes.length} Nodes`;
      committedLogsVal.textContent = cluster.logs.length;
      logCountTag.textContent = `${cluster.logs.length} entries committed`;

      // 2. Render node cards
      nodesContainer.innerHTML = '';
      cluster.nodes.forEach((node) => {
        const card = document.createElement('div');
        const stateClass = node.isAlive
          ? (node.state === 'Leader' ? 'leader' : node.state === 'Candidate' ? 'candidate' : 'follower')
          : 'dead';
        const partitionedClass = node.isPartitioned ? 'partitioned' : '';

        card.className = `node-card ${stateClass} ${partitionedClass}`;
        card.innerHTML = `
          <div class="node-card-header">
            <span class="node-id-title">${node.id.toUpperCase()}</span>
            <span class="role-pill role-${stateClass}">${node.isAlive ? node.state : 'OFFLINE'}</span>
          </div>
          <div class="node-details">
            <div>Term: <strong>${node.currentTerm}</strong></div>
            <div>Voted For: <strong>${node.votedFor ?? 'None'}</strong></div>
            <div>Log Count: <strong>${node.log.length}</strong></div>
            <div>Status: <strong>${node.isPartitioned ? 'Isolated' : node.isAlive ? 'Connected' : 'Dead'}</strong></div>
          </div>
          <div class="node-actions">
            <button class="node-btn btn-kill">${node.isAlive ? 'Kill' : 'Revive'}</button>
            <button class="node-btn btn-elect" ${!node.isAlive || node.isPartitioned ? 'disabled' : ''}>Elect</button>
          </div>
        `;

        card.querySelector('.btn-kill').addEventListener('click', () => {
          cluster.handleNodeFailure(node.id);
          renderUI();
        });

        card.querySelector('.btn-elect').addEventListener('click', () => {
          const res = cluster.startElection(node.id);
          replicateStatus.textContent = res.success
            ? `✔ Node ${node.id} won election with ${res.votes} votes.`
            : `✖ Election failed for ${node.id} (${res.reason}).`;
          renderUI();
          if (res.success) animatePackets();
        });

        nodesContainer.appendChild(card);
      });

      // 3. Render log table
      if (cluster.logs.length === 0) {
        logEntriesBody.innerHTML = `<tr><td colspan="5" class="empty-log-msg">No commands replicated yet. Use the replicate input above.</td></tr>`;
      } else {
        logEntriesBody.innerHTML = '';
        cluster.logs.forEach((entry) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>#${entry.index}</td>
            <td>Term ${entry.term}</td>
            <td><code>${entry.command}</code></td>
            <td><span class="commit-badge commit-yes">COMMITTED</span></td>
            <td>${entry.replicatedBy.join(', ')}</td>
          `;
          logEntriesBody.appendChild(tr);
        });
      }
    }

    // Event listeners
    clusterSizeSelect.addEventListener('change', (e) => {
      cluster = new AgritechPrecisionFarmingRaftCluster(Number(e.target.value));
      cluster.startElection('node-1');
      renderUI();
    });

    electionBtn.addEventListener('click', () => {
      const candidates = cluster.getReachableNodes();
      if (candidates.length === 0) {
        replicateStatus.textContent = '✖ No live reachable nodes available to elect.';
        return;
      }
      const candidate = candidates[0];
      const res = cluster.startElection(candidate.id);
      replicateStatus.textContent = res.success
        ? `✔ Node ${candidate.id} won election in Term ${res.term}.`
        : `✖ Election failed (${res.reason}).`;
      renderUI();
      if (res.success) animatePackets();
    });

    heartbeatBtn.addEventListener('click', () => {
      const res = cluster.sendHeartbeats();
      replicateStatus.textContent = res.success
        ? `💓 Heartbeat pulse sent by Leader ${res.leaderId} to ${res.acknowledgedNodes} nodes.`
        : `✖ Heartbeat failed: ${res.reason}`;
      renderUI();
      if (res.success) animatePackets();
    });

    killLeaderBtn.addEventListener('click', () => {
      if (!cluster.leaderId) {
        replicateStatus.textContent = '⚠ No active leader to drop.';
        return;
      }
      const currentLeader = cluster.leaderId;
      cluster.handleNodeFailure(currentLeader, false);
      replicateStatus.textContent = `🛑 Leader ${currentLeader} killed! Node dropped from cluster.`;
      renderUI();
    });

    let isPartitioned = false;
    partitionBtn.addEventListener('click', () => {
      isPartitioned = !isPartitioned;
      const targetNodes = cluster.nodes.length === 5 ? ['node-4', 'node-5'] : ['node-3'];
      cluster.togglePartition(targetNodes);
      partitionBtn.textContent = isPartitioned ? '🔄 Reconnect Minority Partition' : '🔀 Partition Minority (Nodes 4,5)';
      replicateStatus.textContent = isPartitioned
        ? `🔀 Nodes [${targetNodes.join(', ')}] isolated into minority partition.`
        : `🔄 Network partition healed. All nodes reconnected.`;
      renderUI();
    });

    replicateBtn.addEventListener('click', () => {
      const cmd = commandInput.value.trim();
      if (!cmd) return;
      const res = cluster.replicateLog(cmd);
      if (res.success) {
        replicateStatus.textContent = `✔ Log entry #${res.entry.index} committed across ${res.acks} nodes.`;
        animatePackets();
      } else {
        replicateStatus.textContent = `✖ Replicate failed: ${res.reason}`;
      }
      renderUI();
    });

    // Auto-elect initial leader for smooth demo
    cluster.startElection('node-1');
    renderUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initClusterLab);
  } else {
    initClusterLab();
  }
}
