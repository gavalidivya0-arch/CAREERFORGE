/**
 * Gaming Esports Hub — Resilient WebSocket Heartbeat & Reconnection Engine
 *
 * Implements ping/pong heartbeat supervision, jittered exponential backoff,
 * bounded offline message queue, and deterministic simulation for demo/testing.
 * No external dependencies; inject `WebSocketImpl` for a real socket.
 */

export const SOCKET_STATES = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED'
});

export const LIMITS = Object.freeze({
  maxBackoffMs: 30000,
  maxAttempts: 10,
  maxQueue: 200,
  maxTimeline: 200,
  minBaseBackoffMs: 100,
  maxBaseBackoffMs: 10000,
  minHeartbeatMs: 500,
  maxHeartbeatMs: 60000,
  minPongTimeoutMs: 200,
  maxPongTimeoutMs: 10000,
  minSimOpenMs: 50,
  maxSimOpenMs: 5000,
  minSimPongMs: 10,
  maxSimPongMs: 2000
});

const DEFAULTS = Object.freeze({
  baseBackoffMs: 1000,
  maxBackoffMs: 10000,
  maxAttempts: 5,
  heartbeatIntervalMs: 4000,
  pongTimeoutMs: 1500,
  jitter: true,
  jitterRatio: 0.3,
  simulatedOpenMs: 420,
  simulatedPongMs: 140,
  WebSocketImpl: null
});

function assertNumber(value, name, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be a finite number${integer ? ' integer' : ''} between ${min} and ${max}.`);
  }
  return value;
}

function assertPositiveInteger(value, name, max) {
  return assertNumber(value, name, 1, max, true);
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean.`);
  }
  return value;
}

function assertRatio(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a number between 0 and 1.`);
  }
  return value;
}

function createMetrics() {
  return {
    packetsSent: 0,
    packetsReceived: 0,
    packetsDropped: 0,
    heartbeatsSent: 0,
    heartbeatsAcked: 0,
    heartbeatsMissed: 0,
    lastLatencyMs: null,
    reconnectCount: 0,
    connectedAt: null,
    queueOverflows: 0
  };
}

/**
 * A tiny WebSocket look-alike used by the standalone demo and tests.
 * It speaks the same events as a real WebSocket: open, message, close, error.
 */
export class SimulatedSocketTransport {
  constructor(options = {}) {
    this.openDelayMs = options.openDelayMs ?? DEFAULTS.simulatedOpenMs;
    this.pongDelayMs = options.pongDelayMs ?? DEFAULTS.simulatedPongMs;
    this.scheduler = options.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id)
    };
    this.shouldFailOpen = false;
    this.listeners = new Map();
    this.readyState = 0; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    this.sent = [];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  #emit(type, data) {
    for (const handler of this.listeners.get(type) ?? []) {
      try { handler({ type, ...data }); } catch { /* ignore */ }
    }
  }

  async open() {
    this.readyState = 0;
    if (this.shouldFailOpen) {
      await new Promise(r => this.scheduler.setTimeout(r, this.openDelayMs));
      this.readyState = 3;
      this.#emit('error', { message: 'Simulated connection failure' });
      this.#emit('close', { code: 1006, reason: 'Simulated failure' });
      return;
    }
    await new Promise(r => this.scheduler.setTimeout(r, this.openDelayMs));
    this.readyState = 1;
    this.#emit('open', {});
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('Socket not open');
    this.sent.push(data);
    // If it's a ping, schedule a pong
    try {
      const msg = JSON.parse(data);
      if (msg?.type === 'ping' && msg.id !== undefined) {
        this.scheduler.setTimeout(() => {
          if (this.readyState === 1) {
            this.#emit('message', { data: JSON.stringify({ type: 'pong', id: msg.id, ts: this.scheduler.now() }) });
          }
        }, this.pongDelayMs);
      }
    } catch { /* ignore non-JSON */ }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit('close', { code, reason });
  }

  simulateDrop() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.#emit('close', { code: 1006, reason: 'Simulated drop' });
  }
}

/**
 * GamingEsportsHubResilientSocket — production-grade WebSocket wrapper.
 *
 * Features:
 *  - Continuous ping/pong heartbeat with RTT measurement
 *  - Jittered exponential backoff (configurable jitter ratio)
 *  - Bounded FIFO offline queue with overflow accounting
 *  - State machine: DISCONNECTED → CONNECTING → CONNECTED ↔ RECONNECTING → FAILED
 *  - Manual `connect()` resets retry budget; automatic retries consume it
 *  - Deterministic scheduler injection for testing
 */
export class GamingEsportsHubResilientSocket {
  constructor(endpoint, options = {}) {
    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new TypeError('Endpoint must be a non-empty string.');
    }
    if (options !== null && typeof options !== 'object') {
      throw new TypeError('Options must be an object.');
    }

    const {
      baseBackoffMs = DEFAULTS.baseBackoffMs,
      maxBackoffMs = DEFAULTS.maxBackoffMs,
      maxAttempts = DEFAULTS.maxAttempts,
      heartbeatIntervalMs = DEFAULTS.heartbeatIntervalMs,
      pongTimeoutMs = DEFAULTS.pongTimeoutMs,
      jitter = DEFAULTS.jitter,
      jitterRatio = DEFAULTS.jitterRatio,
      simulatedOpenMs = DEFAULTS.simulatedOpenMs,
      simulatedPongMs = DEFAULTS.simulatedPongMs,
      WebSocketImpl = DEFAULTS.WebSocketImpl,
      scheduler = null
    } = options;

    this.endpoint = endpoint;
    this.baseBackoffMs = assertNumber(baseBackoffMs, 'baseBackoffMs', LIMITS.minBaseBackoffMs, LIMITS.maxBaseBackoffMs);
    this.maxBackoffMs = assertNumber(maxBackoffMs, 'maxBackoffMs', LIMITS.minBaseBackoffMs, LIMITS.maxBackoffMs);
    if (this.maxBackoffMs < this.baseBackoffMs) {
      throw new RangeError('maxBackoffMs must be >= baseBackoffMs.');
    }
    this.maxAttempts = assertPositiveInteger(maxAttempts, 'maxAttempts', LIMITS.maxAttempts);
    this.heartbeatIntervalMs = assertNumber(heartbeatIntervalMs, 'heartbeatIntervalMs', LIMITS.minHeartbeatMs, LIMITS.maxHeartbeatMs);
    this.pongTimeoutMs = assertNumber(pongTimeoutMs, 'pongTimeoutMs', LIMITS.minPongTimeoutMs, LIMITS.maxPongTimeoutMs);
    this.jitter = assertBoolean(jitter, 'jitter');
    this.jitterRatio = assertRatio(jitterRatio, 'jitterRatio');
    this.simulatedOpenMs = assertNumber(simulatedOpenMs, 'simulatedOpenMs', LIMITS.minSimOpenMs, LIMITS.maxSimOpenMs);
    this.simulatedPongMs = assertNumber(simulatedPongMs, 'simulatedPongMs', LIMITS.minSimPongMs, LIMITS.maxSimPongMs);
    this.WebSocketImpl = WebSocketImpl;
    this.scheduler = scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id)
    };

    // State
    this.state = SOCKET_STATES.DISCONNECTED;
    this.transport = null;
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.pendingPingId = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.manualConnect = false;
    this.outage = false; // when true, transport.open() will short-circuit to failure

    // Queues & logs
    this.queue = [];
    this.sentMessages = [];
    this.timeline = [];
    this.metrics = createMetrics();

    // Subscriptions
    this.subscribers = new Set();

    // Arrow function bindings for event handlers
    this._onTransportOpen = () => this.#onTransportOpen();
    this._onTransportMessage = (event) => this.#onTransportMessage(event);
    this._onTransportClose = (event) => this.#onTransportClose(event);
    this._onTransportError = () => this.#onTransportError();
  }

  /** Subscribe to state/timeline/metric events. Returns unsubscribe function. */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('Subscriber must be a function.');
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Emit an event to all subscribers. */
  #emit(event) {
    for (const fn of this.subscribers) {
      try { fn(event); } catch { /* ignore */ }
    }
  }

  /** Record a timeline entry. */
  #recordTimeline(entry) {
    const record = { ...entry, timestamp: this.scheduler.now() };
    this.timeline.push(record);
    if (this.timeline.length > LIMITS.maxTimeline) this.timeline.shift();
    this.#emit({ type: 'timeline', entry: record });
  }

  /** Update connection state and notify. */
  #setState(newState) {
    if (this.state === newState) return;
    const prev = this.state;
    this.state = newState;
    this.#recordTimeline({ kind: 'status', previous: prev, status: newState, endpoint: this.endpoint });
    this.#emit({ type: 'state', previous: prev, current: newState });
  }

  /** Get current metrics snapshot. */
  stats() {
    return {
      status: this.state,
      queueSize: this.queue.length,
      deliveredCount: this.sentMessages.length,
      failedCount: this.metrics.packetsDropped,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: this.maxAttempts,
      lastLatencyMs: this.metrics.lastLatencyMs,
      heartbeatsSent: this.metrics.heartbeatsSent,
      heartbeatsAcked: this.metrics.heartbeatsAcked,
      heartbeatsMissed: this.metrics.heartbeatsMissed,
      reconnectCount: this.metrics.reconnectCount,
      connectedAt: this.metrics.connectedAt,
      queueOverflows: this.metrics.queueOverflows
    };
  }

  /** Calculate backoff for a given attempt (0-indexed). */
  calculateBackoff(attempt) {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new RangeError('Attempt must be a non-negative integer.');
    }
    const exp = this.baseBackoffMs * Math.pow(2, attempt);
    const capped = Math.min(this.maxBackoffMs, exp);
    if (!this.jitter || this.jitterRatio <= 0) return Math.round(capped);
    // Equal jitter: random value in [capped * (1 - ratio), capped]
    const min = capped * (1 - this.jitterRatio);
    return Math.round(min + Math.random() * (capped - min));
  }

  /** Start heartbeat loop. */
  #startHeartbeat() {
    this.#stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    const tick = () => this.#sendPing();
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      tick();
      this.heartbeatTimer = this.scheduler.setInterval(tick, this.heartbeatIntervalMs);
    }, this.heartbeatIntervalMs);
  }

  /** Stop heartbeat loop. */
  #stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.scheduler.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      this.scheduler.clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** Send a ping frame and arm the pong timeout. */
  #sendPing() {
    if (this.state !== SOCKET_STATES.CONNECTED || !this.transport) return;
    const id = ++this.pendingPingId;
    const payload = JSON.stringify({ type: 'ping', id, ts: this.scheduler.now() });
    try {
      this.transport.send(payload);
      this.metrics.heartbeatsSent += 1;
      this.#recordTimeline({ kind: 'heartbeat', direction: 'sent', id, sentAt: this.scheduler.now() });
    } catch {
      return;
    }
    // Arm pong timeout
    this.pongTimer = this.scheduler.setTimeout(() => {
      this.metrics.heartbeatsMissed += 1;
      this.#recordTimeline({ kind: 'heartbeat', direction: 'timeout', id });
      this.#teardownTransport('pong timeout');
    }, this.pongTimeoutMs);
  }

  /** Handle incoming transport message. */
  #onTransportMessage(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === 'pong' && data.id !== undefined) {
      if (this.pongTimer) {
        this.scheduler.clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      const rtt = this.scheduler.now() - (data.ts ?? this.scheduler.now());
      this.metrics.lastLatencyMs = rtt;
      this.metrics.heartbeatsAcked += 1;
      this.#recordTimeline({ kind: 'heartbeat', direction: 'received', id: data.id, latencyMs: rtt });
    }
    // Forward other messages to subscribers
    this.#emit({ type: 'message', data });
  }

  /** Handle transport open. */
  #onTransportOpen() {
    this.#setState(SOCKET_STATES.CONNECTED);
    this.reconnectAttempts = 0;
    this.manualConnect = false; // Allow auto-reconnect after successful connection
    this.metrics.connectedAt = this.scheduler.now();
    this.metrics.reconnectCount += 1;
    this.#startHeartbeat();
    this.flushQueue();
  }

  /** Handle transport close/error. */
  #onTransportClose(_event) {
    this.#stopHeartbeat();
    if (this.state === SOCKET_STATES.DISCONNECTED || this.state === SOCKET_STATES.FAILED) return;
    if (this.manualConnect) {
      // Manual disconnect — don't auto-reconnect
      this.#setState(SOCKET_STATES.DISCONNECTED);
      return;
    }
    this.#scheduleReconnect();
  }

  #onTransportError() {
    // Error fires before close; close handler will schedule reconnect
  }

  /** Tear down transport and trigger reconnect logic. */
  #teardownTransport(reason) {
    if (this.transport) {
      this.transport.removeEventListener('open', this._onTransportOpen);
      this.transport.removeEventListener('message', this._onTransportMessage);
      this.transport.removeEventListener('close', this._onTransportClose);
      this.transport.removeEventListener('error', this._onTransportError);
      this.transport = null;
    }
    this.#onTransportClose({ code: 1006, reason });
  }

  /** Schedule a reconnection attempt with backoff. */
  #scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxAttempts) {
      this.#setState(SOCKET_STATES.FAILED);
      return;
    }
    this.#setState(SOCKET_STATES.RECONNECTING);
    const delay = this.calculateBackoff(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.#recordTimeline({ kind: 'retry', attempt: this.reconnectAttempts, delayMs: delay });
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      // Don't clear reconnectTimer here; let connect() do it
      this.connect();
    }, delay);
  }

  /** Create and open a new transport. */
  async #createTransport() {
    if (this.WebSocketImpl) {
      const ws = new this.WebSocketImpl(this.endpoint);
      ws.addEventListener('open', this._onTransportOpen);
      ws.addEventListener('message', this._onTransportMessage);
      ws.addEventListener('close', this._onTransportClose);
      ws.addEventListener('error', this._onTransportError);
      this.transport = ws;
      return;
    }
    // Simulated transport for demo/testing
    const sim = new SimulatedSocketTransport({
      openDelayMs: this.simulatedOpenMs,
      pongDelayMs: this.simulatedPongMs,
      scheduler: this.scheduler
    });
    sim.shouldFailOpen = this.outage;
    sim.addEventListener('open', this._onTransportOpen);
    sim.addEventListener('message', this._onTransportMessage);
    sim.addEventListener('close', this._onTransportClose);
    sim.addEventListener('error', this._onTransportError);
    this.transport = sim;
    await sim.open();
  }

  /** Public API: connect to the endpoint. Resets retry budget. */
  async connect() {
    if (this.state === SOCKET_STATES.CONNECTING) return this._connectPromise;
    const wasRetrying = !!this.reconnectTimer;
    if (this.reconnectTimer) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Only set manualConnect=true for manual connects; for retries, preserve the existing value
    if (!wasRetrying) {
      this.manualConnect = true;
      this.outage = false; // Reset outage on manual connect
    }
    // For automatic retries, manualConnect stays false (set by simulateDrop)
    this.#setState(SOCKET_STATES.CONNECTING);
    this._connectPromise = (async () => {
      try {
        await this.#createTransport();
      } catch (err) {
        this.#teardownTransport(err?.message ?? 'connection error');
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }

  /** Public API: disconnect manually (no auto-reconnect). */
  disconnect() {
    this.manualConnect = true;
    if (this.reconnectTimer) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.#teardownTransport('manual disconnect');
    this.#setState(SOCKET_STATES.DISCONNECTED);
    this.reconnectAttempts = 0;
  }

  /** Simulate a connection drop (triggers reconnect logic). */
  simulateDrop() {
    if (this.state !== SOCKET_STATES.CONNECTED && this.state !== SOCKET_STATES.CONNECTING) return;
    this.manualConnect = false;
    if (this.transport && typeof this.transport.simulateDrop === 'function') {
      this.transport.simulateDrop();
    } else {
      this.#teardownTransport('simulated drop');
    }
  }

  /** Enable/disable simulated network outage (causes connect() to fail). */
  setOutage(enabled) {
    this.outage = !!enabled;
  }

  /** Send a message. Queues if not connected. Returns true if sent immediately. */
  send(message) {
    if (message === undefined || message === null) {
      throw new TypeError('Message cannot be null or undefined.');
    }
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    if (this.state === SOCKET_STATES.CONNECTED && this.transport) {
      try {
        this.transport.send(payload);
        this.metrics.packetsSent += 1;
        this.sentMessages.push({ payload, timestamp: this.scheduler.now(), status: 'DELIVERED' });
        this.#recordTimeline({ kind: 'message', direction: 'sent', payload });
        return true;
      } catch {
        // Fall through to queue
      }
    }
    // Queue for later
    if (this.queue.length >= LIMITS.maxQueue) {
      this.queue.shift();
      this.metrics.queueOverflows += 1;
    }
    this.queue.push({ payload, timestamp: this.scheduler.now(), status: 'QUEUED' });
    this.metrics.packetsDropped += 1;
    this.#recordTimeline({ kind: 'message', direction: 'queued', payload });
    return false;
  }

  /** Flush the offline queue. Returns array of flushed messages. */
  flushQueue() {
    if (this.state !== SOCKET_STATES.CONNECTED || !this.transport) return [];
    const flushed = [];
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        this.transport.send(item.payload);
        this.metrics.packetsSent += 1;
        item.status = 'DELIVERED';
        item.deliveredAt = this.scheduler.now();
        this.sentMessages.push(item);
        flushed.push(item);
        this.#recordTimeline({ kind: 'message', direction: 'flushed', payload: item.payload });
      } catch {
        // If send fails, put it back and stop
        this.queue.unshift(item);
        break;
      }
    }
    return flushed;
  }

  /** Clear the offline queue. Returns number of dropped messages. */
  clearQueue() {
    const count = this.queue.length;
    this.queue.length = 0;
    return count;
  }

  /** Clear the timeline. */
  clearTimeline() {
    this.timeline.length = 0;
  }

  /** Full reset: disconnect, clear queues, reset metrics. */
  reset() {
    this.disconnect();
    this.outage = false;
    this.queue.length = 0;
    this.sentMessages.length = 0;
    this.timeline.length = 0;
    this.metrics = createMetrics();
    this.reconnectAttempts = 0;
    this.manualConnect = false;
  }
}

/**
 * Mount the standalone demo UI onto the page.
 * Returns the engine instance for programmatic access.
 */
export function mountResilientSocketDemo(root = document) {
  const $ = (id) => root.getElementById?.(id) ?? null;
  const els = {
    statusPill: $('ws-status-pill'),
    statusText: $('ws-status-text'),
    statusHint: $('ws-status-hint'),
    btnConnect: $('btn-connect'),
    btnDrop: $('btn-drop'),
    btnOutage: $('btn-outage'),
    metricAttempt: $('metric-attempt'),
    metricRetry: $('metric-retry'),
    metricLatency: $('metric-latency'),
    metricQueue: $('metric-queue'),
    metricDelivered: $('metric-delivered'),
    metricHeartbeat: $('metric-heartbeat'),
    heartbeatLabel: $('heartbeat-label'),
    heartbeatSub: $('heartbeat-sub'),
    heartbeatCounts: $('heartbeat-counts'),
    timeline: $('ws-timeline'),
    queueList: $('queue-list'),
    deliveredList: $('delivered-list'),
    form: $('message-form'),
    input: $('message-input'),
    btnQuick: $('btn-quick'),
    btnBurst: $('btn-burst'),
    backoffTrack: $('retry-track'),
    backoffLabel: $('retry-label'),
    backoffCountdown: $('retry-countdown'),
    backoffChart: $('backoff-chart')
  };

  if (!els.statusPill || !els.timeline || !els.form || !els.queueList || !els.deliveredList) {
    return null;
  }
  if (!els.backoffChart || !els.metricAttempt) return null;

  const engine = new GamingEsportsHubResilientSocket('wss://stream.esportshub.gg/v1/tournaments', {
    baseBackoffMs: 800,
    maxBackoffMs: 12000,
    maxAttempts: 4,
    heartbeatIntervalMs: 2400,
    pongTimeoutMs: 1400,
    simulatedOpenMs: 420,
    simulatedPongMs: 140
  });

  const renderBackoffChart = () => {
    els.backoffChart.innerHTML = '';
    for (let i = 0; i < engine.maxAttempts; i++) {
      const delay = engine.calculateBackoff(i);
      const row = document.createElement('div');
      row.className = 'backoff-row';
      row.dataset.attempt = String(i + 1);
      if (engine.state === SOCKET_STATES.RECONNECTING && engine.reconnectAttempts - 1 === i) {
        row.classList.add('is-current');
      }
      row.innerHTML = `
        <span class="backoff-label">Attempt ${i + 1}</span>
        <span class="backoff-value">${delay} ms</span>
        <div class="backoff-bar"><div class="backoff-fill" style="width: ${Math.min(100, (delay / engine.maxBackoffMs) * 100)}%"></div></div>
      `;
      els.backoffChart.appendChild(row);
    }
  };

  const updateBackoffCountdown = () => {
    if (engine.state === SOCKET_STATES.RECONNECTING && engine.reconnectTimer) {
      const attempt = engine.reconnectAttempts - 1;
      const delay = engine.calculateBackoff(attempt);
      els.backoffTrack.dataset.active = 'true';
      els.backoffLabel.textContent = `Retry ${engine.reconnectAttempts}/${engine.maxAttempts}`;
      els.backoffCountdown.textContent = `${delay} ms`;
    } else {
      els.backoffTrack.dataset.active = 'false';
      els.backoffLabel.textContent = 'Idle';
      els.backoffCountdown.textContent = '—';
    }
  };

  const appendTimeline = (entry) => {
    const item = document.createElement('li');
    item.className = `timeline-item timeline-${entry.kind}`;
    const time = new Date(entry.timestamp).toLocaleTimeString();
    let detail = '';
    switch (entry.kind) {
      case 'status':
        detail = `State: ${entry.previous} → ${entry.status}`;
        break;
      case 'heartbeat':
        if (entry.direction === 'sent') detail = `Ping #${entry.id} sent`;
        else if (entry.direction === 'received') detail = `Pong #${entry.id} received · ${entry.latencyMs} ms`;
        else if (entry.direction === 'timeout') detail = `Ping #${entry.id} timed out`;
        break;
      case 'retry':
        detail = `Retry ${entry.attempt}/${engine.maxAttempts} in ${entry.delayMs} ms`;
        break;
      case 'message':
        if (entry.direction === 'sent') detail = `Sent: ${entry.payload.slice(0, 60)}`;
        else if (entry.direction === 'queued') detail = `Queued: ${entry.payload.slice(0, 60)}`;
        else if (entry.direction === 'flushed') detail = `Flushed: ${entry.payload.slice(0, 60)}`;
        break;
    }
    item.innerHTML = `
      <span class="timeline-time">${time}</span>
      <span class="timeline-kind">${entry.kind}</span>
      <span class="timeline-detail">${detail}</span>
    `;
    els.timeline.prepend(item);
    while (els.timeline.children.length > 100) els.timeline.lastChild.remove();
  };

  const renderQueue = () => {
    els.queueList.innerHTML = '';
    if (engine.queue.length === 0) {
      els.queueList.innerHTML = '<li class="empty">No queued messages</li>';
    } else {
      for (const item of engine.queue.slice(-20).reverse()) {
        const li = document.createElement('li');
        li.className = 'queue-item';
        li.innerHTML = `
          <span class="queue-time">${new Date(item.timestamp).toLocaleTimeString()}</span>
          <code class="queue-payload">${item.payload.slice(0, 80)}</code>
        `;
        els.queueList.appendChild(li);
      }
    }
    if (els.metricQueue) els.metricQueue.textContent = String(engine.queue.length);
  };

  const renderDelivered = () => {
    els.deliveredList.innerHTML = '';
    for (const item of engine.sentMessages.slice(-20).reverse()) {
      const li = document.createElement('li');
      li.className = 'delivered-item';
      li.innerHTML = `
        <span class="delivered-time">${new Date(item.timestamp).toLocaleTimeString()}</span>
        <code class="delivered-payload">${item.payload.slice(0, 80)}</code>
      `;
      els.deliveredList.appendChild(li);
    }
    if (els.metricDelivered) els.metricDelivered.textContent = String(engine.sentMessages.length);
  };

  const render = () => {
    const stats = engine.stats();
    els.statusPill.dataset.state = stats.status;
    els.statusText.textContent = stats.status;
    els.statusHint.textContent = stats.status === SOCKET_STATES.CONNECTED
      ? `Latency ${stats.lastLatencyMs ?? '—'} ms · Queue ${stats.queueSize}`
      : stats.status === SOCKET_STATES.RECONNECTING
        ? `Attempt ${stats.reconnectAttempts}/${stats.maxAttempts}`
        : stats.status === SOCKET_STATES.FAILED
          ? 'Max retries exhausted'
          : 'Disconnected';
    if (els.metricAttempt) els.metricAttempt.textContent = `${stats.reconnectAttempts}/${stats.maxAttempts}`;
    if (els.metricLatency) els.metricLatency.textContent = stats.lastLatencyMs ? `${stats.lastLatencyMs} ms` : '—';
    if (els.metricQueue) els.metricQueue.textContent = String(stats.queueSize);
    if (els.metricDelivered) els.metricDelivered.textContent = String(stats.deliveredCount);
    if (els.metricHeartbeat) {
      const total = stats.heartbeatsSent;
      const acked = stats.heartbeatsAcked;
      els.metricHeartbeat.textContent = `${acked}/${total}`;
    }
    if (els.heartbeatLabel) {
      if (stats.status === SOCKET_STATES.CONNECTED) {
        els.heartbeatLabel.dataset.live = 'true';
        els.heartbeatLabel.textContent = stats.lastLatencyMs ? `Pong · ${stats.lastLatencyMs} ms` : 'Pong · — ms';
      } else {
        delete els.heartbeatLabel.dataset.live;
        els.heartbeatLabel.textContent = stats.status === SOCKET_STATES.RECONNECTING ? 'Standby' : 'Idle';
      }
    }
    if (els.heartbeatCounts) {
      els.heartbeatCounts.textContent = `${stats.heartbeatsAcked} / ${stats.heartbeatsSent}`;
    }
    if (els.heartbeatSub) {
      els.heartbeatSub.textContent = stats.status === SOCKET_STATES.CONNECTED
        ? 'Heartbeat active — ping/pong every 2.4 s'
        : 'Heartbeat starts when the stream opens';
    }
    renderBackoffChart();
    updateBackoffCountdown();
    renderQueue();
    renderDelivered();
  };

  // Initial timeline render
  for (const entry of engine.timeline) appendTimeline(entry);

  engine.subscribe((event) => {
    if (event.type === 'timeline') appendTimeline(event.entry);
    if (event.type === 'state') render();
  });

  // Periodic render for countdown/metrics
  setInterval(render, 200);

  // UI handlers
  els.btnConnect?.addEventListener('click', async () => {
    if (engine.state === SOCKET_STATES.CONNECTED || engine.state === SOCKET_STATES.CONNECTING) {
      engine.disconnect();
    } else {
      await engine.connect();
    }
    render();
  });

  els.btnDrop?.addEventListener('click', () => {
    engine.simulateDrop();
    render();
  });

  els.btnOutage?.addEventListener('click', () => {
    const enabled = !engine.outage;
    engine.setOutage(enabled);
    els.btnOutage.setAttribute('aria-pressed', String(enabled));
    els.btnOutage.textContent = enabled ? 'Restore Link' : 'Simulate Outage';
    render();
  });

  els.form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = els.input.value.trim();
    if (!value) return;
    engine.send(value);
    els.input.value = '';
    render();
  });

  els.btnQuick?.addEventListener('click', () => {
    const msg = { type: 'telemetry', match: 'vortex-vs-neon', event: 'kill', player: 's1mple', weapon: 'AWP' };
    engine.send(msg);
    render();
  });

  els.btnBurst?.addEventListener('click', () => {
    for (let i = 0; i < 5; i++) {
      engine.send({ type: 'event', action: i % 3 === 0 ? 'kill' : i % 3 === 1 ? 'assist' : 'death', round: i });
    }
    render();
  });

  // Auto-connect after a brief delay
  setTimeout(() => {
    engine.connect();
    render();
  }, 450);

  if (typeof window !== 'undefined') window.gamingEsportsHubSocket = engine;
  return engine;
}

// Auto-mount on DOM ready
if (typeof document !== 'undefined') {
  const start = () => mountResilientSocketDemo();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}