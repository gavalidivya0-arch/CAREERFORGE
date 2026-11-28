/**
 * PodcastAudioStreamRaftCluster
 * Distributed Raft Consensus & Leader Election State Machine for Podcast Audio Stream.
 * Models Leader, Follower, and Candidate states, randomized heartbeat election timeouts,
 * RequestVote / AppendEntries RPC exchanges, split-vote resolution, and log replication commit cycles.
 */

export class PodcastAudioStreamRaftCluster {
  /**
   * @param {number} [nodeCount=5] Number of nodes in cluster (e.g. 3 or 5)
   * @param {Object} [options={}] Configuration options
   * @param {number} [options.minElectionTimeoutMs=150] Minimum randomized election timeout (ms)
   * @param {number} [options.maxElectionTimeoutMs=300] Maximum randomized election timeout (ms)
   * @param {Function} [options.rng=Math.random] Random generator in [0, 1)
   */
  constructor(nodeCount = 5, options = {}) {
    this.name = 'PodcastAudioStreamRaftCluster';
    this.nodeCount = Number.isInteger(nodeCount) && nodeCount >= 1 ? nodeCount : 5;
    this.minElectionTimeoutMs = Number.isFinite(options.minElectionTimeoutMs)
      ? Math.max(50, options.minElectionTimeoutMs)
      : 150;
    this.maxElectionTimeoutMs = Number.isFinite(options.maxElectionTimeoutMs)
      ? Math.max(this.minElectionTimeoutMs, options.maxElectionTimeoutMs)
      : 300;
    this.rng = typeof options.rng === 'function' ? options.rng : Math.random;

    this.currentTerm = 1;
    this.leaderId = null;
    this.logs = [];
    this.rpcHistory = [];
    this.partitionedNodes = new Set();
    this.listeners = [];
    this.nodes = [];

    this.initNodes(this.nodeCount);
  }

  /**
   * Generates a randomized election timeout within [minElectionTimeoutMs, maxElectionTimeoutMs].
   * @returns {number}
   */
  generateElectionTimeout() {
    const span = this.maxElectionTimeoutMs - this.minElectionTimeoutMs;
    return Math.round(this.minElectionTimeoutMs + this.rng() * span);
  }

  /**
   * Initializes cluster nodes in Follower state with randomized election timeouts.
   * @param {number} count
   */
  initNodes(count) {
    this.nodeCount = count;
    this.nodes = [];
    for (let i = 1; i <= count; i++) {
      this.nodes.push({
        id: `node-${i}`,
        label: `Stream Node ${i}`,
        state: 'Follower',
        currentTerm: this.currentTerm,
        votedFor: null,
        log: [],
        commitIndex: 0,
        isAlive: true,
        isPartitioned: false,
        electionTimeoutMs: this.generateElectionTimeout(),
        electionElapsedMs: 0
      });
    }
    this.leaderId = null;
  }

  /**
   * Calculates majority quorum threshold: floor(N / 2) + 1.
   * @returns {number}
   */
  getQuorumSize() {
    return Math.floor(this.nodes.length / 2) + 1;
  }

  /**
   * Returns all live, non-partitioned nodes currently reachable in the primary partition.
   * @returns {Array<object>}
   */
  getReachableNodes() {
    return this.nodes.filter((n) => n.isAlive && !n.isPartitioned);
  }

  /**
   * Records an RPC message exchange in a bounded history buffer.
   * @param {object} rpc
   * @returns {object}
   * @private
   */
  _recordRpc(rpc) {
    const entry = {
      id: this.rpcHistory.length + 1,
      ...rpc
    };
    this.rpcHistory.unshift(entry);
    if (this.rpcHistory.length > 60) {
      this.rpcHistory.length = 60;
    }
    return entry;
  }

  /**
   * Executes a single RequestVote RPC from candidateId to voterId for the given term.
   * @param {string} candidateId
   * @param {string} voterId
   * @param {number} term
   * @returns {{ voteGranted: boolean, term: number, reason: string, rpc: object }}
   */
  requestVote(candidateId, voterId, term) {
    const candidate = this.nodes.find((n) => n.id === candidateId);
    const voter = this.nodes.find((n) => n.id === voterId);

    if (!candidate || !voter || !voter.isAlive || voter.isPartitioned) {
      const rpc = this._recordRpc({
        type: 'RequestVote',
        from: candidateId,
        to: voterId,
        term,
        granted: false,
        detail: 'Voter unreachable or offline'
      });
      return { voteGranted: false, term: voter ? voter.currentTerm : term, reason: 'Unreachable', rpc };
    }

    if (term < voter.currentTerm) {
      const rpc = this._recordRpc({
        type: 'RequestVote',
        from: candidateId,
        to: voterId,
        term,
        granted: false,
        detail: `Stale term (${term} < ${voter.currentTerm})`
      });
      return { voteGranted: false, term: voter.currentTerm, reason: 'Stale term', rpc };
    }

    if (term > voter.currentTerm) {
      voter.currentTerm = term;
      voter.votedFor = null;
      voter.state = 'Follower';
      if (this.leaderId === voter.id) {
        this.leaderId = null;
      }
    }

    const candidateLastLog = candidate.log[candidate.log.length - 1];
    const voterLastLog = voter.log[voter.log.length - 1];
    const candidateLastTerm = candidateLastLog ? candidateLastLog.term : 0;
    const voterLastTerm = voterLastLog ? voterLastLog.term : 0;
    const logUpToDate =
      candidateLastTerm > voterLastTerm ||
      (candidateLastTerm === voterLastTerm && candidate.log.length >= voter.log.length);

    const canVote = (voter.votedFor === null || voter.votedFor === candidateId) && logUpToDate;
    if (canVote) {
      voter.votedFor = candidateId;
      voter.electionElapsedMs = 0;
      const rpc = this._recordRpc({
        type: 'RequestVote',
        from: candidateId,
        to: voterId,
        term,
        granted: true,
        detail: `Vote granted to ${candidateId}`
      });
      return { voteGranted: true, term: voter.currentTerm, reason: 'Granted', rpc };
    }

    const rpc = this._recordRpc({
      type: 'RequestVote',
      from: candidateId,
      to: voterId,
      term,
      granted: false,
      detail: `Already voted for ${voter.votedFor}`
    });
    return { voteGranted: false, term: voter.currentTerm, reason: 'Already voted', rpc };
  }

  /**
   * Starts a leader election for a candidate node, increments term, sends RequestVote RPCs,
   * and elects the node as Leader if majority quorum is reached.
   * @param {string} nodeId
   * @returns {object}
   */
  startElection(nodeId) {
    const candidate = this.nodes.find((n) => n.id === nodeId);
    if (!candidate || !candidate.isAlive || candidate.isPartitioned) {
      return { success: false, reason: 'Candidate node unreachable or dead' };
    }

    this.currentTerm += 1;
    candidate.currentTerm = this.currentTerm;
    candidate.state = 'Candidate';
    candidate.votedFor = nodeId;
    candidate.electionElapsedMs = 0;
    candidate.electionTimeoutMs = this.generateElectionTimeout();

    if (this.leaderId && this.leaderId !== nodeId) {
      const oldLeader = this.nodes.find((n) => n.id === this.leaderId);
      if (oldLeader && oldLeader.isAlive && !oldLeader.isPartitioned) {
        oldLeader.state = 'Follower';
      }
      this.leaderId = null;
    }

    let votesCount = 1;
    const voters = [nodeId];
    const rpcs = [];

    const reachable = this.getReachableNodes();
    for (const node of reachable) {
      if (node.id === nodeId) continue;
      const response = this.requestVote(nodeId, node.id, candidate.currentTerm);
      rpcs.push(response.rpc);
      if (response.voteGranted) {
        votesCount += 1;
        voters.push(node.id);
      }
    }

    const quorum = this.getQuorumSize();

    if (votesCount >= quorum) {
      candidate.state = 'Leader';
      this.leaderId = nodeId;

      for (const node of reachable) {
        if (node.id !== nodeId) {
          node.state = 'Follower';
          node.currentTerm = this.currentTerm;
          node.electionElapsedMs = 0;
        }
      }

      this.notify('election_won', {
        leaderId: nodeId,
        term: this.currentTerm,
        votes: votesCount,
        voters,
        quorum,
        rpcs
      });

      return {
        success: true,
        leaderId: nodeId,
        term: this.currentTerm,
        votes: votesCount,
        voters,
        quorum,
        rpcs
      };
    }

    candidate.state = 'Follower';
    this.notify('split_vote', {
      candidateId: nodeId,
      term: this.currentTerm,
      votes: votesCount,
      quorum,
      rpcs
    });

    return {
      success: false,
      reason: 'Split vote or quorum not achieved',
      votes: votesCount,
      voters,
      quorum,
      term: this.currentTerm,
      rpcs
    };
  }

  /**
   * Simulates a concurrent split vote in a single term where multiple candidates
   * compete simultaneously and divide votes so no candidate achieves majority quorum.
   * @param {Array<string>} [candidateIds]
   * @returns {object}
   */
  simulateSplitVote(candidateIds = null) {
    const reachable = this.getReachableNodes();
    const quorum = this.getQuorumSize();

    let contenders = Array.isArray(candidateIds) && candidateIds.length >= 2
      ? reachable.filter((n) => candidateIds.includes(n.id))
      : reachable.slice(0, Math.min(reachable.length, reachable.length >= 5 ? 3 : 2));

    if (contenders.length < 2) {
      return { success: false, reason: 'Need at least 2 reachable nodes for concurrent split vote' };
    }

    this.currentTerm += 1;
    this.leaderId = null;
    const term = this.currentTerm;
    const tallies = new Map();
    const rpcs = [];

    for (const node of reachable) {
      node.currentTerm = term;
      node.votedFor = null;
      node.state = 'Follower';
    }

    for (const contender of contenders) {
      contender.state = 'Candidate';
      contender.votedFor = contender.id;
      contender.electionElapsedMs = 0;
      contender.electionTimeoutMs = this.generateElectionTimeout();
      tallies.set(contender.id, 1);
    }

    const remainingFollowers = reachable.filter((n) => !contenders.some((c) => c.id === n.id));
    remainingFollowers.forEach((follower, idx) => {
      const targetCandidate = contenders[idx % contenders.length];
      const res = this.requestVote(targetCandidate.id, follower.id, term);
      rpcs.push(res.rpc);
      if (res.voteGranted) {
        tallies.set(targetCandidate.id, (tallies.get(targetCandidate.id) || 0) + 1);
      }
    });

    // Check if any candidate unexpectedly reached quorum (e.g., 3-node cluster with 2 contenders & 1 follower)
    for (const contender of contenders) {
      const votes = tallies.get(contender.id) || 0;
      if (votes >= quorum) {
        contender.state = 'Leader';
        this.leaderId = contender.id;
        this.notify('election_won', { leaderId: contender.id, term, votes, quorum, rpcs });
        return {
          success: true,
          splitVote: false,
          leaderId: contender.id,
          term,
          tallies: Object.fromEntries(tallies),
          quorum,
          rpcs
        };
      }
    }

    for (const contender of contenders) {
      contender.state = 'Follower';
    }

    this.notify('split_vote', { term, tallies: Object.fromEntries(tallies), quorum, rpcs });
    return {
      success: false,
      splitVote: true,
      reason: 'Split vote — no candidate reached majority quorum',
      term,
      tallies: Object.fromEntries(tallies),
      quorum,
      rpcs
    };
  }

  /**
   * Dispatches AppendEntries heartbeat RPCs from the active Leader to reachable Followers,
   * resetting their randomized election timeouts.
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
    const rpcs = [];
    const reachable = this.getReachableNodes();

    for (const node of reachable) {
      if (node.id !== this.leaderId) {
        node.state = 'Follower';
        node.currentTerm = leader.currentTerm;
        node.votedFor = null;
        node.electionElapsedMs = 0;
        node.electionTimeoutMs = this.generateElectionTimeout();
        acks += 1;
        rpcs.push(
          this._recordRpc({
            type: 'Heartbeat',
            from: this.leaderId,
            to: node.id,
            term: leader.currentTerm,
            granted: true,
            detail: `Reset timeout (${node.electionTimeoutMs}ms)`
          })
        );
      }
    }

    this.notify('heartbeat_pulse', {
      leaderId: this.leaderId,
      term: leader.currentTerm,
      acks,
      rpcs
    });

    return {
      success: true,
      leaderId: this.leaderId,
      term: leader.currentTerm,
      acknowledgedNodes: acks,
      rpcs
    };
  }

  /**
   * Advances election timeout clocks for reachable non-leader nodes and triggers elections
   * for any node whose randomized timeout expires.
   * @param {number} [deltaMs=50]
   * @returns {{ electionsTriggered: Array<object> }}
   */
  tick(deltaMs = 50) {
    const electionsTriggered = [];
    const reachable = this.getReachableNodes();

    for (const node of reachable) {
      if (node.state === 'Leader') continue;
      node.electionElapsedMs += deltaMs;
      if (node.electionElapsedMs >= node.electionTimeoutMs) {
        const result = this.startElection(node.id);
        electionsTriggered.push({ nodeId: node.id, result });
        break;
      }
    }

    return { electionsTriggered };
  }

  /**
   * Replicates a podcast audio stream command through AppendEntries RPCs and commits
   * when majority quorum acknowledges.
   * @param {string} command
   * @returns {object}
   */
  replicateLog(command) {
    if (!this.leaderId) {
      return { success: false, committed: false, reason: 'No active leader to accept client command' };
    }

    const leader = this.nodes.find((n) => n.id === this.leaderId);
    if (!leader || !leader.isAlive || leader.isPartitioned) {
      this.leaderId = null;
      return { success: false, committed: false, reason: 'Leader is unreachable' };
    }

    const cleanCommand = String(command ?? '').trim();
    if (!cleanCommand) {
      return { success: false, committed: false, reason: 'Command payload cannot be empty' };
    }

    const logIndex = leader.log.length + 1;
    const logEntry = {
      index: logIndex,
      term: leader.currentTerm,
      command: cleanCommand,
      committed: false,
      replicatedBy: [this.leaderId]
    };

    leader.log.push(logEntry);

    let ackCount = 1;
    const rpcs = [];
    const reachable = this.getReachableNodes();

    for (const node of reachable) {
      if (node.id !== this.leaderId) {
        node.log.push({ ...logEntry, replicatedBy: [...logEntry.replicatedBy] });
        logEntry.replicatedBy.push(node.id);
        node.electionElapsedMs = 0;
        ackCount += 1;
        rpcs.push(
          this._recordRpc({
            type: 'AppendEntries',
            from: this.leaderId,
            to: node.id,
            term: leader.currentTerm,
            granted: true,
            detail: `Replicated #${logIndex}`
          })
        );
      }
    }

    const quorum = this.getQuorumSize();

    if (ackCount >= quorum) {
      logEntry.committed = true;
      leader.commitIndex = logIndex;
      for (const node of reachable) {
        node.commitIndex = logIndex;
        const localEntry = node.log.find((e) => e.index === logIndex);
        if (localEntry) {
          localEntry.committed = true;
          localEntry.replicatedBy = [...logEntry.replicatedBy];
        }
      }
      this.logs.push({ ...logEntry, replicatedBy: [...logEntry.replicatedBy] });
      this.notify('log_committed', { entry: logEntry, acks: ackCount, quorum, rpcs });

      return {
        success: true,
        committed: true,
        entry: logEntry,
        acks: ackCount,
        quorum,
        rpcs
      };
    }

    this.notify('log_uncommitted', { entry: logEntry, acks: ackCount, quorum, rpcs });
    return {
      success: false,
      committed: false,
      entry: logEntry,
      acks: ackCount,
      quorum,
      rpcs,
      reason: 'Quorum not reached for commit'
    };
  }

  /**
   * Simulates node crash/kill or recovery/revive. Clears leaderId when the active leader drops.
   * @param {string} nodeId
   * @param {boolean|null} [aliveStatus=null]
   * @returns {object}
   */
  handleNodeFailure(nodeId, aliveStatus = null) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return { success: false, reason: 'Node not found' };
    }

    node.isAlive = aliveStatus !== null ? Boolean(aliveStatus) : !node.isAlive;

    if (!node.isAlive) {
      node.state = 'Dead';
      node.electionElapsedMs = 0;
      if (this.leaderId === nodeId) {
        this.leaderId = null;
        this.notify('leader_dropped', { droppedLeaderId: nodeId });
      }
    } else {
      node.state = 'Follower';
      node.electionElapsedMs = 0;
      node.electionTimeoutMs = this.generateElectionTimeout();
    }

    this.notify('node_status_changed', {
      nodeId,
      isAlive: node.isAlive,
      state: node.state
    });

    return {
      success: true,
      nodeId,
      isAlive: node.isAlive,
      state: node.state
    };
  }

  /**
   * Toggles network partition isolation for one or more nodes.
   * @param {string|Array<string>} nodeIds
   * @returns {{ success: boolean, partitioned: Array<string> }}
   */
  togglePartition(nodeIds) {
    const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    ids.forEach((id) => {
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
          node.electionElapsedMs = 0;
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
   * Subscribes a listener callback to cluster state events.
   * @param {Function} callback
   */
  subscribe(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
    }
  }

  /**
   * Notifies all registered listeners.
   * @param {string} event
   * @param {object} data
   */
  notify(event, data) {
    this.listeners.forEach((fn) => fn(event, data));
  }
}

// Browser DOM controller
if (typeof document !== 'undefined') {
  const initRaftWorkbench = () => {
    const root = document.querySelector('[data-raft-lab]');
    if (!root) return;

    let cluster = new PodcastAudioStreamRaftCluster(5);
    let autoSimTimer = null;
    let isPartitioned = false;

    const termVal = root.querySelector('#current-term-val');
    const leaderVal = root.querySelector('#current-leader-val');
    const quorumVal = root.querySelector('#quorum-val');
    const committedLogsVal = root.querySelector('#committed-logs-val');
    const nodesContainer = root.querySelector('#nodes-container');
    const clusterSizeSelect = root.querySelector('#cluster-size');
    const electionBtn = root.querySelector('#election-btn');
    const splitVoteBtn = root.querySelector('#split-vote-btn');
    const heartbeatBtn = root.querySelector('#heartbeat-btn');
    const killLeaderBtn = root.querySelector('#kill-leader-btn');
    const partitionBtn = root.querySelector('#partition-btn');
    const autoSimBtn = root.querySelector('#auto-sim-btn');
    const commandInput = root.querySelector('#command-input');
    const replicateBtn = root.querySelector('#replicate-btn');
    const replicateStatus = root.querySelector('#replicate-status');
    const logEntriesBody = root.querySelector('#log-entries-body');
    const logCountTag = root.querySelector('#log-count-tag');
    const rpcFeedList = root.querySelector('#rpc-feed-list');
    const rpcCountTag = root.querySelector('#rpc-count-tag');
    const packetOverlay = root.querySelector('#packet-overlay');

    function animateRpcPackets(sourceId, packetClass = 'packet-heartbeat') {
      if (!packetOverlay || !nodesContainer) return;
      const sourceCard = nodesContainer.querySelector(`[data-node-id="${sourceId}"]`);
      if (!sourceCard) return;

      const stageRect = nodesContainer.getBoundingClientRect();
      const srcRect = sourceCard.getBoundingClientRect();
      const srcX = srcRect.left - stageRect.left + srcRect.width / 2;
      const srcY = srcRect.top - stageRect.top + srcRect.height / 2;

      nodesContainer.querySelectorAll('.node-card').forEach((targetCard) => {
        const targetId = targetCard.getAttribute('data-node-id');
        if (targetId === sourceId || targetCard.classList.contains('dead') || targetCard.classList.contains('partitioned')) {
          return;
        }
        const dstRect = targetCard.getBoundingClientRect();
        const dstX = dstRect.left - stageRect.left + dstRect.width / 2;
        const dstY = dstRect.top - stageRect.top + dstRect.height / 2;

        const packet = document.createElement('div');
        packet.className = `packet-traveler ${packetClass}`;
        packet.style.left = `${srcX}px`;
        packet.style.top = `${srcY}px`;
        packet.style.setProperty('--dx', `${dstX - srcX}px`);
        packet.style.setProperty('--dy', `${dstY - srcY}px`);
        packetOverlay.appendChild(packet);
        window.setTimeout(() => packet.remove(), 760);
      });
    }

    function renderUI() {
      termVal.textContent = String(cluster.currentTerm);
      leaderVal.textContent = cluster.leaderId ?? 'None (Election needed)';
      quorumVal.textContent = `${cluster.getQuorumSize()} of ${cluster.nodes.length} Nodes`;
      committedLogsVal.textContent = String(cluster.logs.length);
      logCountTag.textContent = `${cluster.logs.length} ${cluster.logs.length === 1 ? 'entry' : 'entries'} committed`;
      rpcCountTag.textContent = `${cluster.rpcHistory.length} RPCs`;

      nodesContainer.innerHTML = '';
      cluster.nodes.forEach((node) => {
        const stateClass = !node.isAlive
          ? 'dead'
          : node.state === 'Leader'
            ? 'leader'
            : node.state === 'Candidate'
              ? 'candidate'
              : 'follower';

        const timeoutPct = node.state === 'Leader' || !node.isAlive
          ? 0
          : Math.min(100, Math.round((node.electionElapsedMs / node.electionTimeoutMs) * 100));

        const card = document.createElement('article');
        card.className = `node-card ${stateClass}${node.isPartitioned ? ' partitioned' : ''}`;
        card.setAttribute('data-node-id', node.id);

        card.innerHTML = `
          <div class="node-card-header">
            <span class="node-id-title">${node.id.toUpperCase()}</span>
            <span class="role-pill role-${stateClass}">${node.isAlive ? node.state : 'Offline'}</span>
          </div>
          <div class="node-details">
            <div>Term: <strong>${node.currentTerm}</strong></div>
            <div>Voted For: <strong>${node.votedFor ?? 'None'}</strong></div>
            <div>Log / Commit: <strong>${node.log.length} / ${node.commitIndex}</strong></div>
            <div>Timeout: <strong>${node.electionTimeoutMs}ms</strong></div>
            <div>Link: <strong>${!node.isAlive ? 'Dead' : node.isPartitioned ? 'Partitioned' : 'Connected'}</strong></div>
          </div>
          <div class="timeout-meter" title="Election timeout progress">
            <div class="timeout-fill" style="width: ${timeoutPct}%"></div>
          </div>
          <div class="node-actions">
            <button type="button" class="node-btn btn-kill">${node.isAlive ? 'Kill' : 'Revive'}</button>
            <button type="button" class="node-btn btn-elect" ${!node.isAlive || node.isPartitioned ? 'disabled' : ''}>Elect</button>
            <button type="button" class="node-btn btn-partition">${node.isPartitioned ? 'Heal' : 'Isolate'}</button>
          </div>
        `;

        card.querySelector('.btn-kill').addEventListener('click', () => {
          const res = cluster.handleNodeFailure(node.id);
          replicateStatus.textContent = res.isAlive
            ? `✔ ${node.id} revived as Follower.`
            : `🛑 ${node.id} killed (node offline).`;
          renderUI();
        });

        card.querySelector('.btn-elect').addEventListener('click', () => {
          const res = cluster.startElection(node.id);
          replicateStatus.textContent = res.success
            ? `✔ ${node.id} elected Leader in Term ${res.term} (${res.votes}/${cluster.nodes.length} votes).`
            : `✖ Election failed for ${node.id}: ${res.reason}.`;
          renderUI();
          animateRpcPackets(node.id, 'packet-vote');
        });

        card.querySelector('.btn-partition').addEventListener('click', () => {
          cluster.togglePartition(node.id);
          replicateStatus.textContent = node.isPartitioned
            ? `🔀 ${node.id} isolated from cluster network.`
            : `🔄 ${node.id} reconnected to cluster network.`;
          renderUI();
        });

        nodesContainer.appendChild(card);
      });

      if (cluster.logs.length === 0) {
        logEntriesBody.innerHTML = '<tr><td colspan="5" class="empty-log-msg">No stream log entries replicated yet. Submit a command above.</td></tr>';
      } else {
        logEntriesBody.innerHTML = '';
        cluster.logs.forEach((entry) => {
          const tr = document.createElement('tr');
          const idxTd = document.createElement('td');
          idxTd.textContent = `#${entry.index}`;
          const termTd = document.createElement('td');
          termTd.textContent = `Term ${entry.term}`;
          const cmdTd = document.createElement('td');
          const code = document.createElement('code');
          code.textContent = entry.command;
          cmdTd.appendChild(code);
          const statusTd = document.createElement('td');
          statusTd.innerHTML = `<span class="commit-badge ${entry.committed ? 'commit-yes' : 'commit-pending'}">${entry.committed ? 'COMMITTED' : 'PENDING'}</span>`;
          const ackTd = document.createElement('td');
          ackTd.textContent = entry.replicatedBy.join(', ');

          tr.append(idxTd, termTd, cmdTd, statusTd, ackTd);
          logEntriesBody.appendChild(tr);
        });
      }

      if (cluster.rpcHistory.length === 0) {
        rpcFeedList.innerHTML = '<li class="empty-rpc-msg">Waiting for RequestVote / AppendEntries RPCs...</li>';
      } else {
        rpcFeedList.innerHTML = '';
        cluster.rpcHistory.slice(0, 18).forEach((rpc) => {
          const li = document.createElement('li');
          const rpcClass = rpc.type === 'RequestVote'
            ? 'rpc-vote'
            : rpc.type === 'AppendEntries'
              ? 'rpc-append'
              : 'rpc-heartbeat';
          li.className = `rpc-item ${rpcClass}`;

          const route = document.createElement('span');
          route.className = 'rpc-route';
          route.textContent = `[T${rpc.term}] ${rpc.type}: ${rpc.from} → ${rpc.to}`;

          const meta = document.createElement('span');
          meta.className = 'rpc-meta';
          meta.textContent = `${rpc.granted ? 'ACK' : 'NACK'} • ${rpc.detail}`;

          li.append(route, meta);
          rpcFeedList.appendChild(li);
        });
      }
    }

    clusterSizeSelect.addEventListener('change', (e) => {
      cluster = new PodcastAudioStreamRaftCluster(Number(e.target.value));
      isPartitioned = false;
      partitionBtn.textContent = '🔀 Partition Network';
      cluster.startElection('node-1');
      replicateStatus.textContent = `✔ Switched to ${cluster.nodes.length}-node cluster (Quorum: ${cluster.getQuorumSize()}).`;
      renderUI();
    });

    electionBtn.addEventListener('click', () => {
      const candidates = cluster.getReachableNodes().filter((n) => n.id !== cluster.leaderId);
      const target = candidates[0] || cluster.getReachableNodes()[0];
      if (!target) {
        replicateStatus.textContent = '✖ No reachable nodes available to start an election.';
        return;
      }
      const res = cluster.startElection(target.id);
      replicateStatus.textContent = res.success
        ? `✔ ${target.id} won election in Term ${res.term} (${res.votes} votes).`
        : `✖ Election failed in Term ${res.term}: ${res.reason}.`;
      renderUI();
      animateRpcPackets(target.id, 'packet-vote');
    });

    splitVoteBtn.addEventListener('click', () => {
      const res = cluster.simulateSplitVote();
      if (res.splitVote) {
        replicateStatus.textContent = `⚖️ Split vote in Term ${res.term} — tallies ${JSON.stringify(res.tallies)} (< quorum ${res.quorum}).`;
      } else if (res.success) {
        replicateStatus.textContent = `✔ ${res.leaderId} broke tie in Term ${res.term}.`;
      } else {
        replicateStatus.textContent = `✖ ${res.reason}`;
      }
      renderUI();
    });

    heartbeatBtn.addEventListener('click', () => {
      const res = cluster.sendHeartbeats();
      replicateStatus.textContent = res.success
        ? `💓 Leader ${res.leaderId} pulsed heartbeats to ${res.acknowledgedNodes} reachable nodes.`
        : `✖ Heartbeat failed: ${res.reason}`;
      renderUI();
      if (res.success) animateRpcPackets(res.leaderId, 'packet-heartbeat');
    });

    killLeaderBtn.addEventListener('click', () => {
      if (!cluster.leaderId) {
        replicateStatus.textContent = '⚠ No active leader to kill.';
        return;
      }
      const dropped = cluster.leaderId;
      cluster.handleNodeFailure(dropped, false);
      replicateStatus.textContent = `🛑 Active Leader ${dropped} killed! Trigger an election or enable auto timeouts.`;
      renderUI();
    });

    partitionBtn.addEventListener('click', () => {
      isPartitioned = !isPartitioned;
      const targets = cluster.nodes.length === 5 ? ['node-4', 'node-5'] : ['node-3'];
      cluster.togglePartition(targets);
      partitionBtn.textContent = isPartitioned ? '🔄 Heal Partition' : '🔀 Partition Network';
      replicateStatus.textContent = isPartitioned
        ? `🔀 Minority [${targets.join(', ')}] partitioned from quorum.`
        : '🔄 Network partition healed; all nodes reconnected.';
      renderUI();
    });

    autoSimBtn.addEventListener('click', () => {
      if (autoSimTimer) {
        window.clearInterval(autoSimTimer);
        autoSimTimer = null;
        autoSimBtn.setAttribute('aria-pressed', 'false');
        autoSimBtn.textContent = '⏱️ Auto Timeouts: OFF';
        replicateStatus.textContent = '⏸ Auto election timeout & heartbeat loop paused.';
      } else {
        autoSimBtn.setAttribute('aria-pressed', 'true');
        autoSimBtn.textContent = '⏱️ Auto Timeouts: ON';
        replicateStatus.textContent = '▶ Auto election timeout & heartbeat loop running.';
        autoSimTimer = window.setInterval(() => {
          if (cluster.leaderId) {
            cluster.sendHeartbeats();
          } else {
            cluster.tick(60);
          }
          renderUI();
        }, 450);
      }
    });

    root.querySelectorAll('.preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        commandInput.value = chip.getAttribute('data-command') || '';
      });
    });

    replicateBtn.addEventListener('click', () => {
      const cmd = commandInput.value.trim();
      if (!cmd) return;
      const res = cluster.replicateLog(cmd);
      if (res.success) {
        replicateStatus.textContent = `✔ Entry #${res.entry.index} committed across ${res.acks} nodes (quorum ${res.quorum}).`;
        animateRpcPackets(cluster.leaderId, 'packet-append');
      } else {
        replicateStatus.textContent = `✖ Replication failed: ${res.reason}`;
      }
      renderUI();
    });

    cluster.startElection('node-1');
    renderUI();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRaftWorkbench);
  } else {
    initRaftWorkbench();
  }
}
