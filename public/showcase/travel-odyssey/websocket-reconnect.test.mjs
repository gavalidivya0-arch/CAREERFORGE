import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TravelOdysseyResilientSocket,
  SimulatedSocketTransport,
  SOCKET_STATES
} from './websocket-reconnect.js';

/**
 * Deterministic scheduler so backoff, heartbeat, and retry timing can be tested
 * without sleeping. `advance()` runs timers in timestamp order and flushes
 * microtasks between them so transport opens/pongs settle before returning.
 */
function createClock(start = 0) {
  let current = start;
  let sequence = 0;
  const timers = new Map();

  return {
    now: () => current,
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      timers.set(id, { at: current + Math.max(0, Number(delay) || 0), callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        let nextId = null;
        let nextTimer = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (!nextTimer || timer.at < nextTimer.at || (timer.at === nextTimer.at && id < nextId)) {
            nextId = id;
            nextTimer = timer;
          }
        }
        if (!nextTimer) break;
        timers.delete(nextId);
        current = nextTimer.at;
        nextTimer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      current = target;
    },
    pending: () => timers.size
  };
}

class FakeSocket {
  static instances = [];
  static behavior = { autoOpen: true, autoPong: false, failOpen: false, failSend: false };

  static reset(overrides = {}) {
    FakeSocket.instances = [];
    FakeSocket.behavior = { autoOpen: true, autoPong: false, failOpen: false, failSend: false, ...overrides };
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);

    if (FakeSocket.behavior.failOpen) {
      queueMicrotask(() => this.drop(1006, 'connection refused'));
    } else if (FakeSocket.behavior.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, event) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }

  open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit('open', { type: 'open' });
  }

  send(raw) {
    if (this.readyState !== 1) throw new Error('FakeSocket is not open');
    if (FakeSocket.behavior.failSend) throw new Error('FakeSocket send failure');
    this.sent.push(raw);
    if (FakeSocket.behavior.autoPong) {
      const payload = JSON.parse(raw);
      if (payload.type === 'ping') {
        queueMicrotask(() => this.emit('message', {
          type: 'message',
          data: JSON.stringify({ type: 'pong', id: payload.id, sentAt: payload.sentAt })
        }));
      }
    }
  }

  close(code = 1000, reason = 'client close') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { type: 'close', code, reason, wasClean: true });
  }

  drop(code = 1006, reason = 'network drop') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { type: 'close', code, reason, wasClean: false });
  }
}

function makeEngine(clock, overrides = {}) {
  return new TravelOdysseyResilientSocket('wss://test.local/stream', {
    scheduler: clock,
    WebSocketImpl: FakeSocket,
    jitter: false,
    baseBackoffMs: 1000,
    maxBackoffMs: 10000,
    maxAttempts: 3,
    heartbeatEnabled: false,
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

test('calculateBackoff - doubles per attempt and clamps at maxBackoffMs', () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock(), { jitter: false, baseBackoffMs: 1000, maxBackoffMs: 10000 });

  assert.equal(socket.calculateBackoff(0), 1000);
  assert.equal(socket.calculateBackoff(1), 2000);
  assert.equal(socket.calculateBackoff(2), 4000);
  assert.equal(socket.calculateBackoff(3), 8000);
  assert.equal(socket.calculateBackoff(4), 10000);
  assert.equal(socket.calculateBackoff(5), 10000);
  assert.equal(socket.calculateBackoff(64), 10000);
});

test('calculateBackoff - floors fractional attempts and rejects invalid input', () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock(), { jitter: false, baseBackoffMs: 250, maxBackoffMs: 5000 });

  assert.equal(socket.calculateBackoff(0.9), 250);
  assert.equal(socket.calculateBackoff(1.9), 500);
  for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
    assert.throws(() => socket.calculateBackoff(bad), RangeError);
  }
});

test('calculateBackoff - equal jitter stays between the floor and the cap', () => {
  FakeSocket.reset();
  let seed = 42;
  const socket = makeEngine(createClock(), {
    jitter: true,
    jitterRatio: 0.5,
    baseBackoffMs: 1000,
    maxBackoffMs: 10000,
    random: () => 0.5
  });

  assert.equal(socket.calculateBackoff(0), 750);
  assert.equal(socket.calculateBackoff(4), 7500);

  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const fuzzed = makeEngine(createClock(), {
    jitter: true,
    jitterRatio: 0.5,
    baseBackoffMs: 1000,
    maxBackoffMs: 10000,
    random
  });

  for (let index = 0; index < 100; index += 1) {
    const attempt = index % 6;
    const capped = Math.min(10000, 1000 * 2 ** attempt);
    const delay = fuzzed.calculateBackoff(attempt);
    assert.ok(delay >= capped / 2, `delay ${delay} should keep at least half of ${capped}`);
    assert.ok(delay <= capped, `delay ${delay} should never exceed ${capped}`);
    assert.ok(delay <= fuzzed.maxBackoffMs);
  }
});

// ---------------------------------------------------------------------------
// Offline queue
// ---------------------------------------------------------------------------

test('send - buffers messages while disconnected and reports QUEUED', () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock());

  assert.equal(socket.status, SOCKET_STATES.DISCONNECTED);
  assert.equal(socket.send('telemetry-packet'), false);
  assert.equal(socket.queue.length, 1);
  assert.equal(socket.queue[0].payload, 'telemetry-packet');
  assert.equal(socket.queue[0].status, 'QUEUED');
  assert.equal(socket.flushQueue().length, 0, 'flushQueue is a no-op while offline');
});

test('send - serialises objects and rejects null, undefined, and oversized payloads', () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock());

  assert.equal(socket.send({ type: 'chat', text: 'hello' }), false);
  assert.equal(socket.queue[0].payload, JSON.stringify({ type: 'chat', text: 'hello' }));
  assert.throws(() => socket.send(null), TypeError);
  assert.throws(() => socket.send(undefined), TypeError);
  const circular = {};
  circular.self = circular;
  assert.throws(() => socket.send(circular), TypeError);
  assert.throws(() => socket.send('x'.repeat(4097)), RangeError);
});

test('send - caps the queue and drops the oldest packet', () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock(), { maxQueueSize: 2 });

  socket.send('a');
  socket.send('b');
  socket.send('c');

  assert.deepEqual(socket.queue.map((item) => item.payload), ['b', 'c']);
  assert.equal(socket.droppedMessages, 1);
});

test('flushQueue - drains in FIFO order only while connected', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock);

  socket.send('first');
  socket.send('second');
  const connected = socket.connect();
  await connected;

  assert.equal(socket.status, SOCKET_STATES.CONNECTED);
  assert.equal(socket.queue.length, 0);
  assert.equal(socket.sentMessages.length, 2);
  assert.deepEqual(socket.sentMessages.map((item) => item.payload), ['first', 'second']);
  assert.deepEqual(FakeSocket.instances[0].sent.slice(0, 2), ['first', 'second']);
  assert.equal(socket.flushQueue().length, 0, 'queue is already empty');
});

test('send - delivers immediately once the transport is open', async () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock());
  await socket.connect();

  assert.equal(socket.send({ type: 'chat', text: 'live' }), true);
  assert.equal(socket.queue.length, 0);
  assert.equal(socket.sentMessages.length, 1);
  assert.equal(socket.sentMessages[0].status, 'DELIVERED');
  assert.equal(JSON.parse(FakeSocket.instances[0].sent.at(-1)).text, 'live');
});

test('clearQueue - empties the buffer and reports the count', () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock());
  socket.send('a');
  socket.send('b');

  assert.equal(socket.clearQueue(), 2);
  assert.equal(socket.queue.length, 0);
  assert.equal(socket.clearQueue(), 0);
});

// ---------------------------------------------------------------------------
// Reconnection lifecycle
// ---------------------------------------------------------------------------

test('connect - transitions CONNECTING to CONNECTED and resets the retry budget', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock);

  const pending = socket.connect();
  assert.equal(socket.status, SOCKET_STATES.CONNECTING);
  assert.equal(await pending, true);
  assert.equal(socket.status, SOCKET_STATES.CONNECTED);
  assert.equal(socket.reconnectAttempts, 0);
  assert.equal(FakeSocket.instances.length, 1);
});

test('connect - is idempotent while a handshake is already in flight', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock);

  const first = socket.connect();
  const second = socket.connect();
  assert.equal(first, second);
  await first;
  assert.equal(FakeSocket.instances.length, 1);
});

test('simulateDrop - schedules a jitter-free retry and recovers to CONNECTED', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, { baseBackoffMs: 1000, maxBackoffMs: 8000 });
  await socket.connect();

  assert.equal(socket.simulateDrop(), true);
  assert.equal(socket.status, SOCKET_STATES.RECONNECTING);
  assert.equal(socket.reconnectAttempts, 1);
  assert.equal(socket.backoffRemainingMs, 1000);

  await clock.advance(999);
  assert.equal(FakeSocket.instances.length, 1, 'retry must wait for the full backoff');
  await clock.advance(1);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(socket.status, SOCKET_STATES.CONNECTED);
  assert.equal(socket.reconnectAttempts, 0);
  assert.equal(socket.backoffRemainingMs, 0);
});

test('simulateDrop - ignores drops when the stream is not live', () => {
  FakeSocket.reset();
  const socket = makeEngine(createClock());
  assert.equal(socket.simulateDrop(), false);
  assert.equal(socket.status, SOCKET_STATES.DISCONNECTED);
});

test('reconnect - flushes packets buffered during the outage after recovery', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, { baseBackoffMs: 500, maxBackoffMs: 2000 });
  await socket.connect();

  socket.simulateDrop();
  assert.equal(socket.send('buffered-during-outage'), false);
  assert.equal(socket.queue.length, 1);

  await clock.advance(500);
  assert.equal(socket.status, SOCKET_STATES.CONNECTED);
  assert.equal(socket.queue.length, 0);
  assert.equal(socket.sentMessages.at(-1).payload, 'buffered-during-outage');
  assert.ok(FakeSocket.instances[1].sent.includes('buffered-during-outage'));
});

test('reconnect - exhausts the budget and settles in FAILED', async () => {
  FakeSocket.reset({ failOpen: true });
  const clock = createClock();
  const socket = makeEngine(clock, {
    maxAttempts: 2,
    baseBackoffMs: 100,
    maxBackoffMs: 1000
  });

  const result = await socket.connect();
  assert.equal(result, false);
  assert.equal(socket.status, SOCKET_STATES.RECONNECTING);

  await clock.advance(1000);
  assert.equal(socket.status, SOCKET_STATES.FAILED);
  assert.equal(socket.reconnectAttempts, 3, 'initial failure plus two retries');
  assert.equal(FakeSocket.instances.length, 3);
  assert.equal(clock.pending(), 0, 'no retry may remain scheduled after FAILED');
});

test('disconnect - cancels a pending retry and stays offline', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, { baseBackoffMs: 1000 });
  await socket.connect();

  socket.simulateDrop();
  assert.equal(socket.status, SOCKET_STATES.RECONNECTING);
  socket.disconnect();
  assert.equal(socket.status, SOCKET_STATES.DISCONNECTED);
  assert.equal(socket.reconnectAttempts, 0);

  await clock.advance(10000);
  assert.equal(socket.status, SOCKET_STATES.DISCONNECTED);
  assert.equal(FakeSocket.instances.length, 1, 'manual disconnect must not reconnect');
});

test('setOutage - exhausts retries while offline and recovers when cleared', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, {
    baseBackoffMs: 50,
    maxBackoffMs: 200,
    maxAttempts: 1,
    simulatedOpenDelayMs: 10
  });

  socket.setOutage(true);
  const pending = socket.connect();
  await clock.advance(10);
  assert.equal(await pending, false);
  await clock.advance(1000);
  assert.equal(socket.status, SOCKET_STATES.FAILED);
  assert.equal(socket.outage, true);

  socket.setOutage(false);
  await socket.connect();
  assert.equal(socket.status, SOCKET_STATES.CONNECTED);
  assert.equal(socket.reconnectAttempts, 0);
});

// ---------------------------------------------------------------------------
// Heartbeat supervision
// ---------------------------------------------------------------------------

test('heartbeat - sends a ping on open and measures pong round-trip latency', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, {
    heartbeatEnabled: true,
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 500
  });
  await socket.connect();

  const fake = FakeSocket.instances[0];
  assert.equal(socket.pingsSent, 1);
  const ping = JSON.parse(fake.sent[0]);
  assert.equal(ping.type, 'ping');
  assert.equal(ping.source, 'travel-odyssey');

  await clock.advance(120);
  fake.emit('message', {
    type: 'message',
    data: JSON.stringify({ type: 'pong', id: ping.id, sentAt: ping.sentAt })
  });

  assert.equal(socket.pongsReceived, 1);
  assert.equal(socket.lastLatencyMs, 120);
  assert.equal(socket.missedHeartbeats, 0);
});

test('heartbeat - keeps pinging on the configured interval', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, {
    heartbeatEnabled: true,
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 2000
  });
  await socket.connect();

  const fake = FakeSocket.instances[0];
  const first = JSON.parse(fake.sent[0]);
  fake.emit('message', {
    type: 'message',
    data: JSON.stringify({ type: 'pong', id: first.id, sentAt: first.sentAt })
  });

  await clock.advance(1000);
  assert.equal(socket.pingsSent, 2);
  const second = JSON.parse(fake.sent.at(-1));
  assert.equal(second.type, 'ping');
  assert.ok(second.id > first.id);
});

test('heartbeat - a missed pong tears down the transport and starts a retry', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, {
    heartbeatEnabled: true,
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 400,
    baseBackoffMs: 100
  });
  await socket.connect();
  assert.equal(socket.status, SOCKET_STATES.CONNECTED);

  await clock.advance(400);
  assert.equal(socket.missedHeartbeats, 1);
  assert.equal(socket.status, SOCKET_STATES.RECONNECTING);
  assert.equal(socket.reconnectAttempts, 1);
});

test('heartbeat - ignores stale pong ids', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, {
    heartbeatEnabled: true,
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 500
  });
  await socket.connect();
  const fake = FakeSocket.instances[0];

  fake.emit('message', {
    type: 'message',
    data: JSON.stringify({ type: 'pong', id: 9999, sentAt: clock.now() })
  });

  assert.equal(socket.pongsReceived, 0);
  assert.equal(socket.lastLatencyMs, null);
});

test('heartbeat - can be disabled entirely', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, { heartbeatEnabled: false });
  await socket.connect();

  assert.equal(socket.pingsSent, 0);
  await clock.advance(30000);
  assert.equal(socket.pingsSent, 0);
  assert.equal(socket.status, SOCKET_STATES.CONNECTED);
});

// ---------------------------------------------------------------------------
// Simulated transport
// ---------------------------------------------------------------------------

test('SimulatedSocketTransport - opens, answers pings, and rejects sends while closed', async () => {
  const clock = createClock();
  const transport = new SimulatedSocketTransport('wss://demo.local', {
    scheduler: clock,
    openDelayMs: 10,
    pongDelayMs: 5
  });

  assert.throws(() => transport.send('nope'), Error);
  let opened = false;
  transport.addEventListener('open', () => {
    opened = true;
  });
  await clock.advance(10);
  assert.equal(opened, true);
  assert.equal(transport.readyState, 1);

  let pong = null;
  transport.addEventListener('message', (event) => {
    pong = JSON.parse(event.data);
  });
  transport.send(JSON.stringify({ type: 'ping', id: 7, sentAt: clock.now() }));
  await clock.advance(5);
  assert.equal(pong.type, 'pong');
  assert.equal(pong.id, 7);
});

test('SimulatedSocketTransport - outage mode closes with code 1006', async () => {
  const clock = createClock();
  const transport = new SimulatedSocketTransport('wss://demo.local', {
    scheduler: clock,
    openDelayMs: 10,
    offline: true
  });
  let close = null;
  transport.addEventListener('close', (event) => {
    close = event;
  });

  await clock.advance(10);
  assert.equal(close.code, 1006);
  assert.equal(close.wasClean, false);
  assert.equal(transport.readyState, 3);
});

test('engine + simulated transport - heartbeat round-trip without a real server', async () => {
  const clock = createClock();
  const socket = new TravelOdysseyResilientSocket('wss://demo.local', {
    scheduler: clock,
    simulatedOpenDelayMs: 10,
    simulatedPongDelayMs: 5,
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 500,
    jitter: false
  });

  const pending = socket.connect();
  await clock.advance(10);
  assert.equal(socket.status, SOCKET_STATES.CONNECTED);
  assert.equal(socket.pingsSent, 1);

  await clock.advance(5);
  assert.equal(socket.pongsReceived, 1);
  assert.equal(socket.lastLatencyMs, 5);
  assert.equal(await pending, true);
});

// ---------------------------------------------------------------------------
// Events, stats, and reset
// ---------------------------------------------------------------------------

test('timeline - records lifecycle, retry, and heartbeat events', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, {
    heartbeatEnabled: true,
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 500,
    baseBackoffMs: 100
  });
  await socket.connect();
  socket.simulateDrop();

  const kinds = new Set(socket.timeline.map((entry) => entry.kind));
  assert.ok(kinds.has('status'));
  assert.ok(kinds.has('heartbeat'));
  assert.ok(kinds.has('retry'));
  assert.ok(socket.timeline.every((entry) => Number.isFinite(entry.at) && typeof entry.label === 'string'));

  const cleared = socket.clearTimeline();
  assert.ok(cleared > 0);
  assert.equal(socket.timeline.length, 0);
});

test('subscribe - delivers events and unsubscribes cleanly', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, { baseBackoffMs: 100 });
  const events = [];
  const unsubscribe = socket.subscribe((event) => events.push(event.type));

  await socket.connect();
  assert.ok(events.includes('state'));
  assert.ok(events.includes('timeline'));

  unsubscribe();
  const count = events.length;
  socket.simulateDrop();
  assert.equal(events.length, count);
});

test('stats - reports queue, retry, heartbeat, and uptime counters', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock, {
    heartbeatEnabled: true,
    heartbeatIntervalMs: 1000,
    pongTimeoutMs: 500,
    baseBackoffMs: 100
  });
  socket.send('queued');
  await socket.connect();
  await clock.advance(250);

  const stats = socket.stats();
  assert.equal(stats.status, SOCKET_STATES.CONNECTED);
  assert.equal(stats.queueSize, 0);
  assert.equal(stats.deliveredCount, 1);
  assert.equal(stats.deliveredTotal, 1);
  assert.equal(stats.reconnectAttempts, 0);
  assert.equal(stats.maxAttempts, 3);
  assert.equal(stats.pingsSent, 1);
  assert.equal(stats.uptimeMs, 250);
  assert.ok(stats.connectedForMs >= 0);
  assert.equal(typeof stats.backoffRemainingMs, 'number');
});

test('reset - returns the engine to a pristine disconnected state', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock);
  socket.send('queued');
  await socket.connect();
  socket.send('delivered');

  socket.reset();

  assert.equal(socket.status, SOCKET_STATES.DISCONNECTED);
  assert.equal(socket.queue.length, 0);
  assert.equal(socket.sentMessages.length, 0);
  assert.equal(socket.reconnectAttempts, 0);
  assert.equal(socket.stats().deliveredCount, 0);
});

test('constructor - validates the endpoint and numeric configuration', () => {
  FakeSocket.reset();
  assert.throws(() => new TravelOdysseyResilientSocket(''), TypeError);
  assert.throws(
    () => new TravelOdysseyResilientSocket('wss://x', { baseBackoffMs: 0 }),
    RangeError
  );
  assert.throws(
    () => new TravelOdysseyResilientSocket('wss://x', { maxAttempts: -1 }),
    RangeError
  );
  assert.throws(
    () => new TravelOdysseyResilientSocket('wss://x', { maxQueueSize: 1.5 }),
    RangeError
  );
});

test('queued packets survive a transport that fails to send', async () => {
  FakeSocket.reset();
  const clock = createClock();
  const socket = makeEngine(clock);
  socket.send('will-fail');

  FakeSocket.behavior.failSend = true;
  await socket.connect();

  assert.equal(socket.queue.length, 0);
  assert.equal(socket.failedMessages.length, 1);
  assert.equal(socket.failedMessages[0].status, 'FAILED');
  assert.equal(socket.sentMessages.length, 0);
});
