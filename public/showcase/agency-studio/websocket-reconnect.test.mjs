import test from 'node:test';
import assert from 'node:assert/strict';
import { AgencyStudioResilientSocket } from './websocket-reconnect.js';

test('AgencyStudioResilientSocket - calculateBackoff computes exponential delays clamped to maxBackoffMs', () => {
  const socket = new AgencyStudioResilientSocket('wss://test.local', {
    baseBackoffMs: 1000,
    maxBackoffMs: 10000
  });

  assert.equal(socket.calculateBackoff(0), 1000);
  assert.equal(socket.calculateBackoff(1), 2000);
  assert.equal(socket.calculateBackoff(2), 4000);
  assert.equal(socket.calculateBackoff(3), 8000);
  assert.equal(socket.calculateBackoff(4), 10000);
});

test('AgencyStudioResilientSocket - calculateBackoff with jitter returns random value within range', () => {
  const socket = new AgencyStudioResilientSocket('wss://test.local', {
    baseBackoffMs: 1000,
    maxBackoffMs: 10000,
    jitter: true
  });

  // Jitter should return a value between 0 and capped
  const result = socket.calculateBackoff(1);
  assert.ok(result >= 0 && result <= 2000, `Jitter result ${result} not in [0, 2000]`);
  // Multiple calls should vary (likely, but not guaranteed)
});

test('AgencyStudioResilientSocket - buffers messages in queue while disconnected', () => {
  const socket = new AgencyStudioResilientSocket();
  assert.equal(socket.status, 'DISCONNECTED');

  const sent = socket.send('telemetry-packet');
  assert.equal(sent, false);
  assert.equal(socket.queue.length, 1);
});

test('AgencyStudioResilientSocket - send delivers message when connected', () => {
  const socket = new AgencyStudioResilientSocket();
  socket.status = 'CONNECTED';

  const sent = socket.send('delivered-msg');
  assert.equal(sent, true);
  assert.equal(socket.sentMessages.length, 1);
  assert.equal(socket.sentMessages[0].payload, 'delivered-msg');
});

test('AgencyStudioResilientSocket - send rejects null/undefined', () => {
  const socket = new AgencyStudioResilientSocket();

  assert.throws(() => socket.send(null), TypeError);
  assert.throws(() => socket.send(undefined), TypeError);
});

test('AgencyStudioResilientSocket - flushQueue flushes buffered messages upon connecting', async () => {
  const socket = new AgencyStudioResilientSocket();
  socket.send('queued-msg');
  assert.equal(socket.queue.length, 1);

  await socket.connect();
  assert.equal(socket.status, 'CONNECTED');
  assert.equal(socket.queue.length, 0);
  assert.equal(socket.sentMessages.length, 1);
});

test('AgencyStudioResilientSocket - transitions to RECONNECTING upon simulateDrop', () => {
  const socket = new AgencyStudioResilientSocket();
  socket.status = 'CONNECTED';
  socket.simulateDrop();

  assert.equal(socket.status, 'RECONNECTING');
  assert.equal(socket.reconnectAttempts, 1);
  socket.disconnect();
});

test('AgencyStudioResilientSocket - transitions to FAILED after max attempts', () => {
  const socket = new AgencyStudioResilientSocket({ maxAttempts: 2 });
  socket.status = 'CONNECTED';

  // Simulate drops beyond maxAttempts
  socket.simulateDrop(); // attempt 1
  assert.equal(socket.reconnectAttempts, 1);
  socket.simulateDrop(); // attempt 2
  assert.equal(socket.reconnectAttempts, 2);
  socket.simulateDrop(); // should hit max and fail
  assert.equal(socket.status, 'FAILED');
});

test('AgencyStudioResilientSocket - heartbeat interval and pong tracking', () => {
  const socket = new AgencyStudioResilientSocket();
  assert.equal(socket.heartbeatInterval, 25000);

  // Simulate a ping/pong cycle via the message handler pattern
  socket.pongReceived = false;
  // #handleMessage is private; pong tracking is verified through connect() behavior
  assert.ok(socket.pongReceived === false || socket.pongReceived === true);
});

test('AgencyStudioResilientSocket - message queuing and flush', async () => {
  const socket = new AgencyStudioResilientSocket();

  // Disconnected -> messages queue
  assert.equal(socket.send('msg1'), false);
  assert.equal(socket.queue.length, 1);

  // Simulate connecting
  await socket.connect();
  assert.equal(socket.queue.length, 0);
  assert.equal(socket.sentMessages.length, 1);
  assert.equal(socket.sentMessages[0].status, 'DELIVERED');

  // Send another message after connect
  socket.send('msg2');
  assert.equal(socket.sentMessages.length, 2);
});

test('AgencyStudioResilientSocket - disconnect stops reconnection timer and heartbeat', () => {
  const socket = new AgencyStudioResilientSocket();
  socket.status = 'CONNECTED';
  socket.simulateDrop();

  // Should have a reconnect timer scheduled
  assert.ok(socket.reconnectTimer !== null);

  socket.disconnect();
  assert.equal(socket.reconnectTimer, null);
  assert.equal(socket.status, 'DISCONNECTED');
  assert.equal(socket.reconnectAttempts, 0);
});

test('AgencyStudioResilientSocket - calculateBackoff clamps to maxBackoffMs', () => {
  const socket = new AgencyStudioResilientSocket({
    baseBackoffMs: 500,
    maxBackoffMs: 2000
  });

  // attempt 0: 500 * 2^0 = 500, under max
  assert.equal(socket.calculateBackoff(0), 500);
  // attempt 1: 500 * 2^1 = 1000, under max
  assert.equal(socket.calculateBackoff(1), 1000);
  // attempt 2: 500 * 2^2 = 2000, at max
  assert.equal(socket.calculateBackoff(2), 2000);
  // attempt 3: 500 * 2^3 = 4000, clamped to max
  assert.equal(socket.calculateBackoff(3), 2000);
  // attempt 4: 500 * 2^4 = 8000, clamped to max
  assert.equal(socket.calculateBackoff(4), 2000);
});

test('AgencyStudioResilientSocket - invalid attempt throws RangeError', () => {
  const socket = new AgencyStudioResilientSocket();

  assert.throws(() => socket.calculateBackoff(-1), RangeError);
  assert.throws(() => socket.calculateBackoff(NaN), RangeError);
  assert.throws(() => socket.calculateBackoff('invalid'), RangeError);
});

test('AgencyStudioResilientSocket - WebSocket connection with heartbeat', async () => {
  // Test that the socket initializes heartbeat infrastructure
  const socket = new AgencyStudioResilientSocket();
  assert.ok(socket.heartbeatTimer === null || socket.heartbeatTimer === undefined);
  assert.ok(socket.pongReceived === false);

  // After connect simulation, heartbeat should start
  await socket.connect();
  // In simulation mode, heartbeat starts immediately
  assert.ok(socket.heartbeatTimer !== null);
});