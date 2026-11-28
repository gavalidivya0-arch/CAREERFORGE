/**
 * Travel Odyssey — resilient WebSocket heartbeat & reconnection engine.
 *
 * The module has two halves:
 *   1. `TravelOdysseyResilientSocket` — a dependency-free connection manager with
 *      ping/pong supervision, jittered exponential backoff, and an offline queue.
 *   2. `mountResilientSocketDemo()` — progressive enhancement for
 *      websocket-reconnect.html. It only runs in a browser, so the engine stays
 *      fully testable under `node:test`.
 *
 * A simulated transport is used by default so the demo works without a server.
 * Pass `WebSocketImpl` (the browser `WebSocket` constructor, or a test double) to
 * talk to a real endpoint instead.
 */

export const SOCKET_STATES = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED'
});

const LIMITS = Object.freeze({
  timeline: 200,
  delivered: 200,
  queue: 500,
  characters: 4096
});

const DEFAULTS = Object.freeze({
  baseBackoffMs: 1000,
  maxBackoffMs: 30000,
  maxAttempts: 5,
  jitter: true,
  jitterRatio: 0.5,
  heartbeatIntervalMs: 5000,
  pongTimeoutMs: 3000,
  maxQueueSize: 200,
  simulatedOpenDelayMs: 120,
  simulatedPongDelayMs: 40,
  autoReconnect: true,
  heartbeatEnabled: true
});

const DEFAULT_SCHEDULER = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle)
});

function positiveNumber(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function nonNegativeInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function ratioNumber(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1.`);
  }
  return value;
}

/**
 * A tiny WebSocket look-alike used by the standalone demo. It speaks the same
 * `open` / `message` / `close` events as the browser API and automatically
 * answers heartbeat pings with pongs.
 */
export class SimulatedSocketTransport {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  #scheduler;
  #openDelayMs;
  #pongDelayMs;
  #offline;
  #openTimer = null;
  #listeners = new Map();

  constructor(url, options = {}) {
    this.url = url;
    this.readyState = SimulatedSocketTransport.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#openDelayMs = positiveNumber(options.openDelayMs, 120, 'openDelayMs');
    this.#pongDelayMs = positiveNumber(options.pongDelayMs, 40, 'pongDelayMs');
    this.#offline = Boolean(options.offline);

    this.#openTimer = this.#scheduler.setTimeout(() => {
      this.#openTimer = null;
      if (this.readyState !== SimulatedSocketTransport.CONNECTING) return;
      if (this.#offline) {
        this.readyState = SimulatedSocketTransport.CLOSED;
        this.#dispatch('error', { type: 'error', message: 'Simulated network outage' });
        this.#dispatch('close', {
          type: 'close',
          code: 1006,
          reason: 'Simulated network outage',
          wasClean: false
        });
        return;
      }
      this.readyState = SimulatedSocketTransport.OPEN;
      this.#dispatch('open', { type: 'open' });
    }, this.#openDelayMs);
  }

  addEventListener(type, handler) {
    if (typeof handler !== 'function') return;
    const handlers = this.#listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.#listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }

  send(raw) {
    if (this.readyState !== SimulatedSocketTransport.OPEN) {
      throw new Error('Simulated transport is not open.');
    }
    this.sent.push(raw);
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    if (payload && payload.type === 'ping') {
      const ping = payload;
      this.#scheduler.setTimeout(() => {
        if (this.readyState !== SimulatedSocketTransport.OPEN) return;
        this.#dispatch('message', {
          type: 'message',
          data: JSON.stringify({
            type: 'pong',
            id: ping.id,
            sentAt: ping.sentAt,
            serverTime: this.#scheduler.now()
          })
        });
      }, this.#pongDelayMs);
    }
  }

  close(code = 1000, reason = 'client disconnect') {
    if (this.readyState === SimulatedSocketTransport.CLOSED) return;
    this.readyState = SimulatedSocketTransport.CLOSING;
    if (this.#openTimer !== null) {
      this.#scheduler.clearTimeout(this.#openTimer);
      this.#openTimer = null;
    }
    this.#scheduler.setTimeout(() => {
      if (this.readyState === SimulatedSocketTransport.CLOSED) return;
      this.readyState = SimulatedSocketTransport.CLOSED;
      this.#dispatch('close', { type: 'close', code, reason, wasClean: true });
    }, 0);
  }

  simulateDrop(code = 1006, reason = 'Simulated network drop') {
    if (this.readyState === SimulatedSocketTransport.CLOSED) return;
    if (this.#openTimer !== null) {
      this.#scheduler.clearTimeout(this.#openTimer);
      this.#openTimer = null;
    }
    this.readyState = SimulatedSocketTransport.CLOSED;
    this.#dispatch('close', { type: 'close', code, reason, wasClean: false });
  }

  #dispatch(type, event) {
    const propertyHandler = this[`on${type}`];
    if (typeof propertyHandler === 'function') propertyHandler(event);
    const handlers = this.#listeners.get(type);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(event);
  }
}

/**
 * Connection manager with heartbeat supervision, jittered exponential backoff,
 * and an offline message queue.
 */
export class TravelOdysseyResilientSocket {
  #scheduler;
  #random;
  #WebSocketImpl;
  #transport = null;
  #listeners = new Set();
  #retryTimer = null;
  #heartbeatTimer = null;
  #pongTimer = null;
  #connectResolve = null;
  #connectPromise = null;
  #manualClose = false;
  #eventSeq = 0;
  #messageSeq = 0;
  #pingSeq = 0;
  #awaitingPong = false;
  #lastPingAt = null;
  #lastPingId = null;
  #startedAt;

  constructor(url = 'wss://live.travel-odyssey.io/stream', options = {}) {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new TypeError('A non-empty WebSocket URL is required.');
    }
    this.url = url.trim();
    this.baseBackoffMs = positiveNumber(options.baseBackoffMs, DEFAULTS.baseBackoffMs, 'baseBackoffMs');
    this.maxBackoffMs = positiveNumber(options.maxBackoffMs, DEFAULTS.maxBackoffMs, 'maxBackoffMs');
    this.maxAttempts = nonNegativeInteger(options.maxAttempts, DEFAULTS.maxAttempts, 'maxAttempts');
    this.jitter = options.jitter ?? DEFAULTS.jitter;
    this.jitterRatio = ratioNumber(options.jitterRatio, DEFAULTS.jitterRatio, 'jitterRatio');
    this.heartbeatIntervalMs = positiveNumber(
      options.heartbeatIntervalMs,
      DEFAULTS.heartbeatIntervalMs,
      'heartbeatIntervalMs'
    );
    this.pongTimeoutMs = positiveNumber(options.pongTimeoutMs, DEFAULTS.pongTimeoutMs, 'pongTimeoutMs');
    this.maxQueueSize = Math.min(
      LIMITS.queue,
      nonNegativeInteger(options.maxQueueSize, DEFAULTS.maxQueueSize, 'maxQueueSize')
    );
    this.autoReconnect = options.autoReconnect ?? DEFAULTS.autoReconnect;
    this.heartbeatEnabled = options.heartbeatEnabled ?? DEFAULTS.heartbeatEnabled;
    this.simulatedOpenDelayMs = positiveNumber(
      options.simulatedOpenDelayMs,
      DEFAULTS.simulatedOpenDelayMs,
      'simulatedOpenDelayMs'
    );
    this.simulatedPongDelayMs = positiveNumber(
      options.simulatedPongDelayMs,
      DEFAULTS.simulatedPongDelayMs,
      'simulatedPongDelayMs'
    );

    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#random = options.random ?? Math.random;
    this.#WebSocketImpl = options.WebSocketImpl ?? null;
    this.#startedAt = this.#scheduler.now();

    this.status = SOCKET_STATES.DISCONNECTED;
    this.reconnectAttempts = 0;
    this.queue = [];
    this.sentMessages = [];
    this.failedMessages = [];
    this.timeline = [];
    this.lastLatencyMs = null;
    this.pingsSent = 0;
    this.pongsReceived = 0;
    this.missedHeartbeats = 0;
    this.messagesReceived = 0;
    this.droppedMessages = 0;
    this.deliveredTotal = 0;
    this.nextRetryAt = null;
    this.lastBackoffMs = 0;
    this.connectedAt = null;
    this.outage = false;
    this.onStateChange = null;

    this.#emit('status', 'Resilient socket initialised', { endpoint: this.url });
  }

  /**
   * Exponential backoff with optional equal jitter.
   * `delay = min(maxBackoffMs, baseBackoffMs * 2 ** attempt)`, then a random
   * slice of the remaining headroom is added back when jitter is enabled.
   */
  calculateBackoff(attempt) {
    if (typeof attempt !== 'number' || !Number.isFinite(attempt) || attempt < 0) {
      throw new RangeError('Attempt must be a non-negative finite number.');
    }
    const exponent = Math.floor(attempt);
    const raw = this.baseBackoffMs * 2 ** exponent;
    const capped = Math.min(this.maxBackoffMs, raw);
    if (!this.jitter) return Math.round(capped);
    const floor = capped * (1 - this.jitterRatio);
    const jittered = floor + this.#random() * (capped - floor);
    return Math.round(Math.min(this.maxBackoffMs, jittered));
  }

  get backoffRemainingMs() {
    if (this.nextRetryAt === null) return 0;
    return Math.max(0, this.nextRetryAt - this.#scheduler.now());
  }

  /** Open the stream. A manual call resets the reconnect budget. */
  connect() {
    return this.#open(false);
  }

  /** Close the stream on purpose and cancel any pending retry. */
  disconnect() {
    this.#manualClose = true;
    this.#clearRetryTimer();
    this.#stopHeartbeat();
    const transport = this.#transport;
    this.#transport = null;
    if (transport) {
      try {
        transport.close?.(1000, 'client disconnect');
      } catch {
        /* the transport is already gone */
      }
    }
    this.reconnectAttempts = 0;
    this.nextRetryAt = null;
    this.lastBackoffMs = 0;
    this.connectedAt = null;
    this.#resolveConnect(false);
    this.#setStatus(SOCKET_STATES.DISCONNECTED, { reason: 'Client disconnected' });
    this.#manualClose = false;
  }

  /**
   * Send immediately when live, otherwise buffer until the next successful open.
   * Returns `true` when the message went out on the wire.
   */
  send(message) {
    if (message === undefined || message === null) {
      throw new TypeError('Message cannot be null or undefined.');
    }
    let payload;
    if (typeof message === 'string') {
      payload = message;
    } else {
      payload = JSON.stringify(message);
      if (payload === undefined) {
        throw new TypeError('Message could not be serialized.');
      }
    }
    if (payload.length > LIMITS.characters) {
      throw new RangeError(`Messages are limited to ${LIMITS.characters} characters.`);
    }

    const now = this.#scheduler.now();
    const record = {
      id: ++this.#messageSeq,
      payload,
      queuedAt: now,
      sentAt: null,
      deliveredAt: null,
      status: 'QUEUED',
      attempts: 0
    };

    if (this.status === SOCKET_STATES.CONNECTED && this.#transport?.readyState === 1) {
      try {
        this.#transport.send(payload);
        record.status = 'DELIVERED';
        record.sentAt = now;
        record.deliveredAt = now;
        record.attempts = 1;
        this.#recordDelivered(record);
        this.#emit('message', 'Outbound packet delivered', { id: record.id, payload });
        this.#notify({ type: 'message', direction: 'out', message: { ...record } });
        return true;
      } catch (error) {
        this.#emit('error', 'Send failed — packet buffered', { message: error.message });
      }
    }

    this.queue.push(record);
    if (this.queue.length > this.maxQueueSize) {
      const dropped = this.queue.shift();
      this.droppedMessages += 1;
      this.#emit('queue', 'Queue full — oldest packet dropped', { id: dropped.id, payload: dropped.payload });
    }
    this.#emit('queue', 'Packet buffered offline', { id: record.id, queueSize: this.queue.length });
    this.#notify({ type: 'queue', message: { ...record }, size: this.queue.length });
    return false;
  }

  /** Drain the offline queue in FIFO order. Only works while connected. */
  flushQueue() {
    if (this.status !== SOCKET_STATES.CONNECTED || !this.#transport || this.#transport.readyState !== 1) {
      return [];
    }
    const flushed = [];
    while (this.queue.length > 0) {
      const item = this.queue[0];
      try {
        this.#transport.send(item.payload);
      } catch (error) {
        item.status = 'FAILED';
        item.error = error.message;
        this.queue.shift();
        this.failedMessages.push(item);
        if (this.failedMessages.length > LIMITS.delivered) this.failedMessages.shift();
        this.#emit('error', 'Queued packet failed to flush', { id: item.id, message: error.message });
        break;
      }
      this.queue.shift();
      item.status = 'DELIVERED';
      item.sentAt = this.#scheduler.now();
      item.deliveredAt = item.sentAt;
      item.attempts += 1;
      this.#recordDelivered(item);
      flushed.push({ ...item });
      this.#emit('message', 'Queued packet flushed', { id: item.id, payload: item.payload });
      this.#notify({ type: 'message', direction: 'out', message: { ...item }, flushed: true });
    }
    if (flushed.length > 0) this.#notify({ type: 'queue-flushed', count: flushed.length });
    return flushed;
  }

  /** Simulate an abnormal closure so the retry ladder can be observed. */
  simulateDrop(reason = 'Simulated network drop') {
    if (this.status !== SOCKET_STATES.CONNECTED && this.status !== SOCKET_STATES.CONNECTING) {
      this.#emit('status', 'Drop ignored — stream is not live', { status: this.status });
      return false;
    }
    this.#emit('status', 'Simulated network drop', { reason });
    this.#terminateTransport(1006, reason);
    return true;
  }

  /**
   * Toggle a simulated outage. While active, every new transport refuses to
   * open so the reconnect budget can exhaust and the FAILED state is reachable.
   */
  setOutage(active) {
    const next = Boolean(active);
    if (this.outage === next) return this.outage;
    this.outage = next;
    this.#emit('status', next ? 'Simulated outage enabled' : 'Simulated outage cleared', {});
    if (next && (this.status === SOCKET_STATES.CONNECTED || this.status === SOCKET_STATES.CONNECTING)) {
      this.#terminateTransport(1006, 'Simulated network outage');
    }
    return this.outage;
  }

  clearQueue() {
    const count = this.queue.length;
    this.queue.length = 0;
    if (count > 0) this.#emit('queue', `Cleared ${count} buffered packet${count === 1 ? '' : 's'}`, { count });
    return count;
  }

  clearTimeline() {
    const count = this.timeline.length;
    this.timeline.length = 0;
    this.#notify({ type: 'timeline-cleared' });
    return count;
  }

  /** Return to a pristine demo state without touching configuration. */
  reset() {
    this.disconnect();
    this.outage = false;
    this.queue.length = 0;
    this.sentMessages.length = 0;
    this.failedMessages.length = 0;
    this.reconnectAttempts = 0;
    this.pingsSent = 0;
    this.pongsReceived = 0;
    this.missedHeartbeats = 0;
    this.messagesReceived = 0;
    this.droppedMessages = 0;
    this.deliveredTotal = 0;
    this.lastLatencyMs = null;
    this.nextRetryAt = null;
    this.lastBackoffMs = 0;
    this.connectedAt = null;
    this.#emit('status', 'Demo reset', {});
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function.');
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  stats() {
    const now = this.#scheduler.now();
    return {
      status: this.status,
      endpoint: this.url,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: this.maxAttempts,
      queueSize: this.queue.length,
      deliveredCount: this.sentMessages.length,
      deliveredTotal: this.deliveredTotal,
      failedCount: this.failedMessages.length,
      droppedMessages: this.droppedMessages,
      messagesReceived: this.messagesReceived,
      pingsSent: this.pingsSent,
      pongsReceived: this.pongsReceived,
      missedHeartbeats: this.missedHeartbeats,
      lastLatencyMs: this.lastLatencyMs,
      nextRetryAt: this.nextRetryAt,
      backoffRemainingMs: this.backoffRemainingMs,
      lastBackoffMs: this.lastBackoffMs,
      connectedForMs: this.connectedAt === null ? 0 : now - this.connectedAt,
      uptimeMs: now - this.#startedAt
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #open(isRetry) {
    if (this.status === SOCKET_STATES.CONNECTED || this.status === SOCKET_STATES.CONNECTING) {
      return this.#connectPromise ?? Promise.resolve(true);
    }

    this.#clearRetryTimer();
    this.nextRetryAt = null;
    if (!isRetry) this.reconnectAttempts = 0;

    this.#setStatus(SOCKET_STATES.CONNECTING, { retry: isRetry, attempt: this.reconnectAttempts });

    const promise = new Promise((resolve) => {
      this.#connectResolve = resolve;
    });
    this.#connectPromise = promise;

    if (this.outage) {
      this.#scheduler.setTimeout(() => {
        if (this.status !== SOCKET_STATES.CONNECTING) return;
        this.#afterDisconnect({
          code: 1006,
          reason: 'Simulated network outage',
          wasClean: false
        });
      }, this.simulatedOpenDelayMs);
      return promise;
    }

    let transport;
    try {
      transport = this.#createTransport();
    } catch (error) {
      this.#emit('error', 'Transport creation failed', { message: error.message });
      this.#resolveConnect(false);
      this.#afterDisconnect({ code: 1006, reason: error.message || 'Transport error', wasClean: false });
      return promise;
    }

    this.#transport = transport;
    this.#attachTransport(transport);
    if (transport.readyState === 1) this.#handleOpen(transport);
    return promise;
  }

  #createTransport() {
    if (this.#WebSocketImpl) return new this.#WebSocketImpl(this.url);
    return new SimulatedSocketTransport(this.url, {
      scheduler: this.#scheduler,
      offline: this.outage,
      openDelayMs: this.simulatedOpenDelayMs,
      pongDelayMs: this.simulatedPongDelayMs
    });
  }

  #attachTransport(transport) {
    const guard = (handler) => (event) => {
      if (this.#transport !== transport) return;
      handler(event);
    };

    const onOpen = guard(() => this.#handleOpen(transport));
    const onMessage = guard((event) => this.#handleMessage(event));
    const onClose = guard((event) => {
      this.#transport = null;
      this.#stopHeartbeat();
      this.#afterDisconnect({
        code: event?.code ?? 1006,
        reason: event?.reason || 'Socket closed',
        wasClean: Boolean(event?.wasClean)
      });
    });
    const onError = guard((event) => {
      this.#emit('error', 'Transport error', { message: event?.message || 'Unknown transport error' });
    });

    if (typeof transport.addEventListener === 'function') {
      transport.addEventListener('open', onOpen);
      transport.addEventListener('message', onMessage);
      transport.addEventListener('close', onClose);
      transport.addEventListener('error', onError);
    } else {
      transport.onopen = onOpen;
      transport.onmessage = onMessage;
      transport.onclose = onClose;
      transport.onerror = onError;
    }
  }

  #handleOpen(transport) {
    if (this.#transport !== transport) return;
    this.reconnectAttempts = 0;
    this.nextRetryAt = null;
    this.lastBackoffMs = 0;
    this.connectedAt = this.#scheduler.now();
    this.#resolveConnect(true);
    this.#setStatus(SOCKET_STATES.CONNECTED, { endpoint: this.url });
    const flushed = this.flushQueue();
    if (flushed.length > 0) {
      this.#emit('queue', `Flushed ${flushed.length} buffered packet${flushed.length === 1 ? '' : 's'}`, {
        count: flushed.length
      });
    }
    this.#startHeartbeat();
  }

  #handleMessage(event) {
    let payload = event?.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = { type: 'text', data: event.data };
      }
    }
    if (payload && payload.type === 'pong') {
      this.#handlePong(payload);
      return;
    }
    this.messagesReceived += 1;
    this.#emit('message', 'Inbound packet received', { payload });
    this.#notify({ type: 'message', direction: 'in', payload });
  }

  #handlePong(payload) {
    if (payload.id !== this.#lastPingId) return;
    this.#awaitingPong = false;
    this.pongsReceived += 1;
    this.missedHeartbeats = 0;
    const sentAt = Number.isFinite(payload.sentAt) ? payload.sentAt : this.#lastPingAt;
    const latency = Math.max(0, this.#scheduler.now() - (sentAt ?? this.#scheduler.now()));
    this.lastLatencyMs = latency;
    this.#clearPongTimer();
    this.#emit('heartbeat', `Pong ${payload.id} · ${latency} ms`, { id: payload.id, latencyMs: latency });
    this.#notify({ type: 'heartbeat', latencyMs: latency, id: payload.id });
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    if (!this.heartbeatEnabled) return;
    this.#sendPing();
    this.#heartbeatTimer = this.#scheduler.setTimeout(
      () => this.#heartbeatTick(),
      this.heartbeatIntervalMs
    );
  }

  #heartbeatTick() {
    this.#heartbeatTimer = null;
    if (this.status !== SOCKET_STATES.CONNECTED || !this.#transport) return;
    if (!this.#awaitingPong) this.#sendPing();
    this.#heartbeatTimer = this.#scheduler.setTimeout(
      () => this.#heartbeatTick(),
      this.heartbeatIntervalMs
    );
  }

  #sendPing() {
    if (!this.#transport || this.#transport.readyState !== 1) return;
    const id = ++this.#pingSeq;
    const sentAt = this.#scheduler.now();
    this.#awaitingPong = true;
    this.#lastPingId = id;
    this.#lastPingAt = sentAt;
    this.pingsSent += 1;
    try {
      this.#transport.send(JSON.stringify({ type: 'ping', id, sentAt, source: 'travel-odyssey' }));
    } catch (error) {
      this.#emit('error', 'Heartbeat send failed', { message: error.message });
      this.#terminateTransport(4001, 'heartbeat-send-failed');
      return;
    }
    this.#emit('heartbeat', `Ping ${id} sent`, { id, sentAt });
    this.#notify({ type: 'heartbeat-ping', id, sentAt });
    this.#clearPongTimer();
    this.#pongTimer = this.#scheduler.setTimeout(() => {
      this.#pongTimer = null;
      if (!this.#awaitingPong || this.#lastPingId !== id) return;
      this.#handleHeartbeatTimeout(id);
    }, this.pongTimeoutMs);
  }

  #handleHeartbeatTimeout(id) {
    this.missedHeartbeats += 1;
    this.#awaitingPong = false;
    this.#emit('heartbeat', `Pong ${id} timed out after ${this.pongTimeoutMs} ms`, {
      id,
      timeoutMs: this.pongTimeoutMs
    });
    this.#notify({ type: 'heartbeat-timeout', id });
    this.#terminateTransport(4000, 'heartbeat-timeout');
  }

  #terminateTransport(code, reason) {
    const transport = this.#transport;
    if (!transport) {
      if (this.status === SOCKET_STATES.CONNECTED || this.status === SOCKET_STATES.CONNECTING) {
        this.#afterDisconnect({ code, reason, wasClean: false });
      }
      return;
    }
    this.#transport = null;
    this.#stopHeartbeat();
    try {
      transport.close?.(code, reason);
    } catch {
      /* the transport is already gone */
    }
    this.#afterDisconnect({ code, reason, wasClean: false });
  }

  #afterDisconnect(info) {
    this.connectedAt = null;
    this.#resolveConnect(false);
    this.#stopHeartbeat();

    if (this.#manualClose) {
      this.nextRetryAt = null;
      this.#setStatus(SOCKET_STATES.DISCONNECTED, { reason: info.reason });
      return;
    }

    this.#emit('status', `Link lost (${info.code})`, info);

    if (!this.autoReconnect) {
      this.nextRetryAt = null;
      this.#setStatus(SOCKET_STATES.DISCONNECTED, { reason: info.reason, code: info.code });
      return;
    }

    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > this.maxAttempts) {
      this.nextRetryAt = null;
      this.lastBackoffMs = 0;
      this.#setStatus(SOCKET_STATES.FAILED, {
        attempts: this.reconnectAttempts,
        maxAttempts: this.maxAttempts,
        reason: info.reason
      });
      this.#emit('error', 'Reconnection budget exhausted', { attempts: this.maxAttempts });
      return;
    }

    const delay = this.calculateBackoff(this.reconnectAttempts - 1);
    this.lastBackoffMs = delay;
    this.nextRetryAt = this.#scheduler.now() + delay;
    this.#setStatus(SOCKET_STATES.RECONNECTING, {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxAttempts,
      delay,
      reason: info.reason
    });
    this.#emit('retry', `Retry ${this.reconnectAttempts}/${this.maxAttempts} in ${delay} ms`, {
      attempt: this.reconnectAttempts,
      delay
    });

    this.#retryTimer = this.#scheduler.setTimeout(() => {
      this.#retryTimer = null;
      this.#open(true);
    }, delay);
  }

  #resolveConnect(value) {
    const resolve = this.#connectResolve;
    this.#connectResolve = null;
    this.#connectPromise = null;
    resolve?.(value);
  }

  #clearRetryTimer() {
    if (this.#retryTimer === null) return;
    this.#scheduler.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #clearPongTimer() {
    if (this.#pongTimer === null) return;
    this.#scheduler.clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer !== null) {
      this.#scheduler.clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#clearPongTimer();
    this.#awaitingPong = false;
  }

  #recordDelivered(record) {
    this.deliveredTotal += 1;
    this.sentMessages.push(record);
    if (this.sentMessages.length > LIMITS.delivered) this.sentMessages.shift();
  }

  #setStatus(next, detail = {}) {
    const previous = this.status;
    this.status = next;
    this.#emit('status', `${previous} → ${next}`, { previous, status: next, ...detail });
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(next, { ...detail, previous, stats: this.stats() });
    }
    this.#notify({ type: 'state', status: next, previous, detail: { ...detail } });
  }

  #emit(kind, label, detail) {
    const entry = {
      id: ++this.#eventSeq,
      at: this.#scheduler.now(),
      kind,
      label,
      detail: detail ?? null
    };
    this.timeline.push(entry);
    if (this.timeline.length > LIMITS.timeline) this.timeline.shift();
    this.#notify({ type: 'timeline', entry });
  }

  #notify(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event, this);
      } catch {
        /* listener failures must never break the connection loop */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Browser UI
// ---------------------------------------------------------------------------

const STATUS_COPY = Object.freeze({
  DISCONNECTED: { label: 'Disconnected', hint: 'Stream idle' },
  CONNECTING: { label: 'Connecting', hint: 'Opening handshake' },
  CONNECTED: { label: 'Connected', hint: 'Heartbeat active' },
  RECONNECTING: { label: 'Reconnecting', hint: 'Backoff in progress' },
  FAILED: { label: 'Failed', hint: 'Retry budget exhausted' }
});

const KIND_ICONS = Object.freeze({
  status: '🛰️',
  heartbeat: '💓',
  message: '📡',
  queue: '📥',
  retry: '🔁',
  error: '⚠️'
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatClock(timestamp) {
  if (!Number.isFinite(timestamp)) return '--:--:--';
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function previewPayload(payload) {
  let text;
  if (typeof payload === 'string') {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload);
    } catch {
      text = String(payload);
    }
  }
  const value = text ?? '';
  return value.length > 64 ? `${value.slice(0, 61)}…` : value;
}

/**
 * Wire the engine to the standalone demo page. Returns the engine so tests and
 * console users can drive it directly.
 */
export function mountResilientSocketDemo(root = document) {
  const $ = (id) => root.getElementById?.(id) ?? null;
  const els = {
    statusPill: $('ws-status-pill'),
    statusDot: $('ws-status-dot'),
    statusText: $('ws-status-text'),
    statusHint: $('ws-status-hint'),
    endpoint: $('ws-endpoint'),
    connect: $('btn-connect'),
    disconnect: $('btn-disconnect'),
    drop: $('btn-drop'),
    outage: $('btn-outage'),
    burst: $('btn-burst'),
    clearQueue: $('btn-clear-queue'),
    reset: $('btn-reset'),
    outageBanner: $('ws-outage-banner'),
    metricAttempt: $('metric-attempt'),
    metricRetry: $('metric-retry'),
    metricLatency: $('metric-latency'),
    metricQueue: $('metric-queue'),
    metricDelivered: $('metric-delivered'),
    metricHeartbeat: $('metric-heartbeat'),
    retryTrack: $('retry-track'),
    retryFill: $('retry-fill'),
    timeline: $('ws-timeline'),
    timelineCount: $('timeline-count'),
    clearTimeline: $('btn-clear-timeline'),
    heartbeatPulse: $('heartbeat-pulse'),
    heartbeatLabel: $('heartbeat-label'),
    heartbeatSub: $('heartbeat-sub'),
    heartbeatCounts: $('heartbeat-counts'),
    heartbeatInterval: $('heartbeat-interval'),
    heartbeatDeadline: $('heartbeat-deadline'),
    backoffChart: $('backoff-chart'),
    backoffFormula: $('backoff-formula'),
    form: $('message-form'),
    input: $('message-input'),
    composerStatus: $('composer-status'),
    queueList: $('queue-list'),
    queueCount: $('queue-count'),
    deliveredList: $('delivered-list'),
    deliveredCount: $('delivered-count')
  };

  if (!els.statusPill || !els.timeline || !els.form || !els.queueList || !els.deliveredList) {
    return null;
  }
  if (!els.backoffChart || !els.metricAttempt) return null;

  const engine = new TravelOdysseyResilientSocket('wss://live.travel-odyssey.io/stream', {
    baseBackoffMs: 800,
    maxBackoffMs: 12000,
    maxAttempts: 4,
    jitter: true,
    heartbeatIntervalMs: 2400,
    pongTimeoutMs: 1400,
    maxQueueSize: 40,
    simulatedOpenDelayMs: 420,
    simulatedPongDelayMs: 140
  });

  let lastTimelineId = 0;
  let composerTimer = null;

  const setComposerStatus = (text, tone = 'info') => {
    if (!els.composerStatus) return;
    els.composerStatus.textContent = text;
    els.composerStatus.dataset.tone = tone;
    if (composerTimer) clearTimeout(composerTimer);
    composerTimer = setTimeout(() => {
      if (els.composerStatus) els.composerStatus.textContent = '';
    }, 4200);
  };

  const renderStatus = (stats) => {
    const meta = STATUS_COPY[stats.status] ?? STATUS_COPY.DISCONNECTED;
    els.statusPill.dataset.state = stats.status;
    els.statusPill.setAttribute('aria-label', `Connection status: ${meta.label}`);
    if (els.statusDot) els.statusDot.dataset.state = stats.status;
    els.statusText.textContent = meta.label;
    els.statusHint.textContent = meta.hint;
    if (els.endpoint) els.endpoint.textContent = stats.endpoint;

    if (els.connect) {
      els.connect.disabled = stats.status === 'CONNECTED'
        || stats.status === 'CONNECTING'
        || stats.status === 'RECONNECTING';
    }
    if (els.disconnect) els.disconnect.disabled = stats.status === 'DISCONNECTED' || stats.status === 'FAILED';
    if (els.drop) els.drop.disabled = stats.status !== 'CONNECTED';
    if (els.burst) els.burst.disabled = false;
  };

  const renderMetrics = (stats) => {
    els.metricAttempt.textContent = `${stats.reconnectAttempts}/${stats.maxAttempts}`;
    els.metricLatency.textContent = stats.lastLatencyMs === null ? '—' : `${stats.lastLatencyMs} ms`;
    els.metricQueue.textContent = String(stats.queueSize);
    els.metricDelivered.textContent = String(stats.deliveredTotal);
    els.metricHeartbeat.textContent = stats.pingsSent === 0
      ? '—'
      : `${stats.pongsReceived}/${stats.pingsSent}`;
    els.metricRetry.textContent = stats.status === 'RECONNECTING'
      ? formatDuration(stats.backoffRemainingMs)
      : '—';

    if (els.retryTrack && els.retryFill) {
      const ratio = stats.status === 'RECONNECTING' && stats.lastBackoffMs > 0
        ? Math.max(0, Math.min(1, stats.backoffRemainingMs / stats.lastBackoffMs))
        : 0;
      els.retryFill.style.transform = `scaleX(${ratio})`;
      els.retryTrack.dataset.active = String(stats.status === 'RECONNECTING');
    }
  };

  const renderQueue = () => {
    els.queueList.replaceChildren();
    if (engine.queue.length === 0) {
      els.queueList.append(element('li', 'empty-state', 'No buffered packets — the channel is clear.'));
    } else {
      for (const item of engine.queue) {
        const row = element('li', 'queue-item');
        const head = element('div', 'queue-head');
        head.append(
          element('span', 'queue-id', `#${item.id}`),
          element('span', 'queue-time', formatClock(item.queuedAt)),
          element('span', 'queue-chip', 'QUEUED')
        );
        row.append(head, element('code', 'queue-payload', previewPayload(item.payload)));
        els.queueList.append(row);
      }
    }
    if (els.queueCount) els.queueCount.textContent = String(engine.queue.length);
  };

  const renderDelivered = () => {
    els.deliveredList.replaceChildren();
    const recent = engine.sentMessages.slice(-6).reverse();
    if (recent.length === 0) {
      els.deliveredList.append(element('li', 'empty-state', 'Nothing delivered yet.'));
    } else {
      for (const item of recent) {
        const row = element('li', 'delivered-item');
        row.append(
          element('span', 'delivered-id', `#${item.id}`),
          element('code', 'delivered-payload', previewPayload(item.payload)),
          element('span', 'delivered-time', formatClock(item.deliveredAt))
        );
        els.deliveredList.append(row);
      }
    }
    if (els.deliveredCount) els.deliveredCount.textContent = String(engine.deliveredTotal);
  };

  const renderHeartbeat = (stats) => {
    if (els.heartbeatCounts) els.heartbeatCounts.textContent = `${stats.pongsReceived} / ${stats.pingsSent}`;
    if (els.heartbeatInterval) els.heartbeatInterval.textContent = formatDuration(engine.heartbeatIntervalMs);
    if (els.heartbeatDeadline) els.heartbeatDeadline.textContent = formatDuration(engine.pongTimeoutMs);
    if (stats.status !== 'CONNECTED') {
      if (els.heartbeatLabel) {
        delete els.heartbeatLabel.dataset.live;
        els.heartbeatLabel.textContent = stats.status === 'RECONNECTING' ? 'Standby' : 'Idle';
      }
      if (els.heartbeatSub) els.heartbeatSub.textContent = 'Heartbeat starts when the stream opens';
    } else if (els.heartbeatLabel && !els.heartbeatLabel.dataset.live) {
      els.heartbeatLabel.textContent = 'Live';
      if (els.heartbeatSub) els.heartbeatSub.textContent = 'Waiting for the next pong';
    }
  };

  const renderBackoff = (stats) => {
    els.backoffChart.replaceChildren();
    const maxDelay = Math.max(...Array.from({ length: engine.maxAttempts }, (_, index) => (
      Math.min(engine.maxBackoffMs, engine.baseBackoffMs * 2 ** index)
    )), 1);
    for (let index = 0; index < engine.maxAttempts; index += 1) {
      const delay = Math.min(engine.maxBackoffMs, engine.baseBackoffMs * 2 ** index);
      const row = element('li', 'backoff-row');
      row.dataset.attempt = String(index + 1);
      if (stats.reconnectAttempts === index + 1) row.classList.add('is-current');
      if (stats.reconnectAttempts > index + 1) row.classList.add('is-past');
      const label = element('span', 'backoff-label', `#${index + 1}`);
      const track = element('span', 'backoff-track');
      const fill = element('span', 'backoff-fill');
      fill.style.setProperty('--ratio', String(Math.max(0.06, delay / maxDelay)));
      track.append(fill);
      row.append(label, track, element('span', 'backoff-value', formatDuration(delay)));
      els.backoffChart.append(row);
    }
    els.backoffFormula.textContent = `min(${engine.maxBackoffMs} ms, ${engine.baseBackoffMs} ms × 2^attempt) + jitter`;
  };

  const renderTimelineCount = () => {
    if (els.timelineCount) {
      els.timelineCount.textContent = `${engine.timeline.length} event${engine.timeline.length === 1 ? '' : 's'}`;
    }
  };

  const appendTimeline = (entry) => {
    if (entry.id <= lastTimelineId) return;
    lastTimelineId = entry.id;
    const item = element('li', `timeline-item kind-${entry.kind}`);
    const marker = element('span', 'timeline-marker', KIND_ICONS[entry.kind] ?? '•');
    const body = element('div', 'timeline-body');
    const head = element('div', 'timeline-head');
    head.append(
      element('span', 'timeline-kind', entry.kind),
      element('time', 'timeline-time', formatClock(entry.at))
    );
    body.append(head, element('p', 'timeline-label', entry.label));
    if (entry.detail && Object.keys(entry.detail).length > 0) {
      const detail = element('code', 'timeline-detail', previewPayload(entry.detail));
      body.append(detail);
    }
    item.append(marker, body);
    els.timeline.append(item);
    while (els.timeline.children.length > 80) els.timeline.firstElementChild.remove();
    const nearBottom = els.timeline.scrollHeight - els.timeline.scrollTop - els.timeline.clientHeight < 120;
    if (nearBottom) els.timeline.scrollTop = els.timeline.scrollHeight;
    renderTimelineCount();
  };

  const pulseHeartbeat = (latencyMs) => {
    if (els.heartbeatPulse) {
      els.heartbeatPulse.classList.remove('is-pulsing');
      void els.heartbeatPulse.offsetWidth;
      els.heartbeatPulse.classList.add('is-pulsing');
    }
    if (els.heartbeatLabel) {
      els.heartbeatLabel.dataset.live = 'true';
      els.heartbeatLabel.textContent = `Pong · ${latencyMs} ms`;
    }
    if (els.heartbeatSub) els.heartbeatSub.textContent = 'Round-trip verified';
  };

  const renderAll = () => {
    const stats = engine.stats();
    renderStatus(stats);
    renderMetrics(stats);
    renderQueue();
    renderDelivered();
    renderHeartbeat(stats);
    renderBackoff(stats);
    renderTimelineCount();
  };

  for (const entry of engine.timeline) appendTimeline(entry);

  engine.subscribe((event) => {
    if (event.type === 'timeline') appendTimeline(event.entry);    if (event.type === 'heartbeat') pulseHeartbeat(event.latencyMs);
    if (event.type === 'heartbeat-ping') {
      if (els.heartbeatLabel) {
        els.heartbeatLabel.dataset.live = 'true';
        els.heartbeatLabel.textContent = 'Ping sent…';
      }
      if (els.heartbeatSub) els.heartbeatSub.textContent = 'Awaiting pong';
    }
    if (event.type === 'heartbeat-timeout') {
      if (els.heartbeatLabel) els.heartbeatLabel.textContent = 'Pong timeout';
      if (els.heartbeatSub) els.heartbeatSub.textContent = 'Recycling the transport';
    }
    if (event.type === 'timeline-cleared') {
      els.timeline.replaceChildren();
      lastTimelineId = 0;
      renderTimelineCount();
      return;
    }
    renderAll();
  });

  els.connect?.addEventListener('click', () => {
    setComposerStatus('Opening the stream…');
    engine.connect();
  });

  els.disconnect?.addEventListener('click', () => {
    engine.disconnect();
    setComposerStatus('Stream closed by the client.', 'warn');
  });

  els.drop?.addEventListener('click', () => {
    engine.simulateDrop('Drop button pressed');
    setComposerStatus('Link severed — watch the backoff ladder.', 'warn');
  });

  els.outage?.addEventListener('click', () => {
    const active = engine.setOutage(!engine.outage);
    els.outage.setAttribute('aria-pressed', String(active));
    els.outage.textContent = active ? 'Restore simulated link' : 'Simulate outage';
    if (els.outageBanner) els.outageBanner.hidden = !active;
    if (!active && (engine.status === 'FAILED' || engine.status === 'DISCONNECTED')) engine.connect();
  });

  els.burst?.addEventListener('click', () => {
    const packets = [
      { type: 'telemetry', channel: 'radar/flight-tracks', note: 'Burst packet A' },
      { type: 'telemetry', channel: 'gates/broadcast', note: 'Burst packet B' },
      { type: 'telemetry', channel: 'hotel/concierge', note: 'Burst packet C' }
    ];
    packets.forEach((packet) => engine.send(packet));
    setComposerStatus('Burst queued — three telemetry packets.', engine.status === 'CONNECTED' ? 'ok' : 'warn');
  });

  els.clearQueue?.addEventListener('click', () => {
    const count = engine.clearQueue();
    setComposerStatus(count > 0 ? `Cleared ${count} buffered packet(s).` : 'Queue already empty.');
  });

  els.reset?.addEventListener('click', () => {
    engine.reset();
    els.timeline.replaceChildren();
    lastTimelineId = 0;
    if (els.outage) {
      els.outage.setAttribute('aria-pressed', 'false');
      els.outage.textContent = 'Simulate outage';
    }
    if (els.outageBanner) els.outageBanner.hidden = true;
    renderAll();
    setComposerStatus('Demo reset — connect to start a new session.');
  });

  els.clearTimeline?.addEventListener('click', () => {
    engine.clearTimeline();
  });

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = els.input.value.trim();
    if (!value) return;
    const delivered = engine.send({ type: 'chat', text: value, sentAt: new Date().toISOString() });
    els.input.value = '';
    setComposerStatus(
      delivered ? 'Packet delivered on the live stream.' : 'Offline — packet buffered until reconnect.',
      delivered ? 'ok' : 'warn'
    );
  });

  for (const chip of root.querySelectorAll('[data-payload]')) {
    chip.addEventListener('click', () => {
      const payload = chip.dataset.payload;
      if (!payload) return;
      const delivered = engine.send({ type: 'quick-action', action: payload, sentAt: new Date().toISOString() });
      setComposerStatus(
        delivered ? `Sent “${payload}”.` : `“${payload}” buffered until reconnect.`,
        delivered ? 'ok' : 'warn'
      );
    });
  }

  setInterval(() => {
    const stats = engine.stats();
    if (stats.status === 'RECONNECTING') {
      els.metricRetry.textContent = formatDuration(stats.backoffRemainingMs);
      if (els.retryTrack && els.retryFill) {
        const ratio = stats.lastBackoffMs > 0
          ? Math.max(0, Math.min(1, stats.backoffRemainingMs / stats.lastBackoffMs))
          : 0;
        els.retryFill.style.transform = `scaleX(${ratio})`;
      }
    }
  }, 100);

  renderAll();
  setTimeout(() => {
    if (engine.status === 'DISCONNECTED') engine.connect();
  }, 450);

  if (typeof window !== 'undefined') window.travelOdysseySocket = engine;
  return engine;
}

if (typeof document !== 'undefined') {
  const start = () => mountResilientSocketDemo();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
