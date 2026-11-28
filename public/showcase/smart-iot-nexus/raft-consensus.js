/**
 * Smart IoT Nexus - Distributed Raft Consensus Engine
 * Simulates Leader, Follower, and Candidate states with
 * randomized election timeouts, vote RPCs, and log replication.
 */

export class SmartIotNexusRaftCluster {
  constructor(numNodes = 3) {
    this.numNodes = numNodes;
    this.nodes = new Map();
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = [];
    this.leaderId = null;
    this.electionTimeouts = new Map();
    this.heartbeatInterval = null;
    this.isPartitioned = false;
    this.logEntryCount = 0;

    this.STATES = {
      FOLLOWER: 'Follower',
      CANDIDATE: 'Candidate',
      LEADER: 'Leader'
    };

    this._initInMemoryNodes(numNodes);
  }

  _initInMemoryNodes(numNodes) {
    for (let i = 1; i <= numNodes; i++) {
      const nodeId = `node-${i}`;
      this.nodes.set(nodeId, {
        id: nodeId,
        state: this.STATES.FOLLOWER,
        term: 0,
        log: [],
        lastHeartbeat: 0
      });

      this.electionTimeouts.set(nodeId, this._randomElectionTimeout());
    }
  }

  _randomElectionTimeout() {
    return 1500 + Math.random() * 3000;
  }

  startElection(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return false;

    node.state = this.STATES.CANDIDATE;
    node.term++;
    this.currentTerm = node.term;
    this.votedFor = nodeId;

    this._updateNodeStateDom(nodeId, this.STATES.CANDIDATE);
    this._updateNodeTermDom(nodeId, node.term);

    return this._grantVote(nodeId);
  }

  _grantVote(candidateId) {
    return new Promise(async resolve => {
      let votesReceived = 1;

      const votePromises = [];
      for (const [otherId, otherNode] of this.nodes) {
        if (otherId === candidateId) continue;
        if (otherNode.term > this.currentTerm) {
          continue;
        }
        votePromises.push(this._simulateVoteRequest(candidateId, otherId));
      }

      const results = await Promise.all(votePromises);

      for (const granted of results) {
        if (granted) {
          votesReceived++;
        }
      }

      if (votesReceived > Math.floor(this.numNodes / 2)) {
        this._becomeLeader(candidateId);
      }

      resolve(votesReceived);
    });
  }

  _simulateVoteRequest(candidateId, voterId) {
    const voter = this.nodes.get(voterId);
    if (!voter) return false;

    const delay = 10 + Math.random() * 50;
    return new Promise(resolve => {
      setTimeout(() => {
        if (this.isPartitioned && voterId % 2 === 0) {
          resolve(false);
        } else {
          if (voter.state === this.STATES.FOLLOWER && voter.term <= this.currentTerm) {
            voter.state = this.STATES.CANDIDATE;
            voter.term = this.currentTerm;
          }
          resolve(true);
        }
      }, delay);
    });
  }

  _becomeLeader(candidateId) {
    const node = this.nodes.get(candidateId);
    if (!node) return;

    this.leaderId = candidateId;
    node.state = this.STATES.LEADER;

    for (const [id, n] of this.nodes) {
      if (id !== candidateId) {
        n.state = this.STATES.FOLLOWER;
        n.term = this.currentTerm;
      }
    }

    this._updateNodeStateDom(candidateId, this.STATES.LEADER);
    for (const id of this.nodes.keys()) {
      if (id !== candidateId) {
        this._updateNodeStateDom(id, this.STATES.FOLLOWER);
      }
    }

    this._startHeartbeatSender();
  }

  _updateNodeStateDom(nodeId, state) {
    const el = this._getNodeElement(nodeId);
    if (!el) return;

    el.element.classList.remove('follower', 'candidate', 'leader', 'pulse');
    el.element.classList.add(state.toLowerCase());

    el.stateDisplay.textContent = state;
    el.stateDisplay.className = `node-state ${state.toLowerCase()}`;
  }

  _updateNodeTermDom(nodeId, term) {
    const el = this._getNodeElement(nodeId);
    if (!el) return;

    el.termDisplay.textContent = `Term: ${term}`;
  }

  _getNodeElement(nodeId) {
    if (typeof document === 'undefined') return null;
    const idNum = nodeId.split('-')[1];
    const element = document.getElementById(`node-${idNum}`);
    if (!element) return null;
    return {
      element,
      stateDisplay: element.querySelector('.node-state'),
      termDisplay: element.querySelector('.node-term'),
      logDisplay: element.querySelector('.node-log-log')
    };
  }

  _startHeartbeatSender() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
    }, 100);
  }

  sendHeartbeats() {
    if (!this.leaderId) return;

    const leader = this.nodes.get(this.leaderId);
    if (!leader || leader.state !== this.STATES.LEADER) return;

    for (const [followerId, follower] of this.nodes) {
      if (followerId === this.leaderId) continue;

      this._replicateToFollower(this.leaderId, followerId, null);
    }

    this._updateLeaderLogDom();
  }

  _replicateToFollower(leaderId, followerId, command) {
    if (followerId === null) {
      return { success: true };
    }

    const follower = this.nodes.get(followerId);
    if (!follower) return { success: false };

    const delay = 5 + Math.random() * 20;
    return new Promise(resolve => {
      setTimeout(() => {
        if (this.isPartitioned && followerId % 3 === 0) {
          resolve(false);
        } else {
          if (command !== null) {
            follower.log.push({
              term: this.currentTerm,
              command,
              index: this.logEntryCount++
            });
          }
          follower.term = this.currentTerm;
          follower.state = this.STATES.FOLLOWER;
          resolve(true);
        }
      }, delay);
    });
  }

  _updateLeaderLogDom() {
    if (typeof document === 'undefined') return;

    const entriesEl = document.getElementById('log-entries');
    if (!entriesEl) return;

    entriesEl.innerHTML = '';
    for (let i = 0; i < this.log.length; i++) {
      const entry = this.log[i];
      const el = document.createElement('div');
      el.className = `log-entry ${entry.term >= this.currentTerm ? 'committed' : 'pending'}`;
      el.innerHTML = `
        <span>${i}</span>
        <span>${entry.command || 'heartbeat'}</span>
        <span>L${entry.term}</span>
        <span>OK</span>
      `;
      entriesEl.appendChild(el);
    }
  }

  replicateLog(command) {
    if (!this.leaderId) {
      return { success: false, reason: 'No leader' };
    }

    const leader = this.nodes.get(this.leaderId);
    if (!leader) return { success: false, reason: 'No leader' };

    leader.log.push({
      term: this.currentTerm,
      command,
      index: this.logEntryCount++
    });

    return this._replicateToFollower(this.leaderId, null, command);
  }

  handleNodeFailure(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return false;

    node.state = this.STATES.FOLLOWER;

    this._updateNodeStateDom(nodeId, this.STATES.FOLLOWER);

    if (this.leaderId === nodeId) {
      this.leaderId = null;
      this._triggerNewElection();
    }

    return true;
  }

  _triggerNewElection() {
    this.currentTerm++;
    this.votedFor = null;

    for (const [nodeId, node] of this.nodes) {
      node.term = this.currentTerm;
      node.state = this.STATES.FOLLOWER;
      this._updateNodeStateDom(nodeId, this.STATES.FOLLOWER);
      this._updateNodeTermDom(nodeId, this.currentTerm);
    }

    const initiator = `node-${Math.floor(Math.random() * this.numNodes) + 1}`;
    setTimeout(() => {
      this.startElection(initiator);
    }, this.electionTimeouts.get(initiator));
  }

  _waitForVotes(candidateId) {
    return new Promise(resolve => {
      setTimeout(() => {
        const candidate = this.nodes.get(candidateId);
        if (candidate && candidate.state === this.STATES.CANDIDATE) {
          this.startElection(candidateId);
        }
        resolve();
      }, 3000);
    });
  }

  togglePartition(partitioned) {
    this.isPartitioned = partitioned;
  }
}