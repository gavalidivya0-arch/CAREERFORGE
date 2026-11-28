/**
 * Real Estate Luxe — token bucket rate limiter & concurrency throttler.
 *
 * The module has two halves:
 *   1. `RealEstateLuxeTokenBucketRateLimiter` — a dependency-free admission
 *      controller with continuous token refill, burst capacity, a prioritized
 *      wait queue, and a concurrency cap.
 *   2. `mountRateLimiterDemo()` — progressive enhancement for
 *      rate-limiter.html. It only runs in a browser, so the engine stays fully
 *      testable under `node:test`.
 *
 * `tryConsume()` is the raw bucket primitive. `enqueue()` + `tick()` add the
 * concurrency lanes and priority queue used by the showcase.
 */

export const RATE_LIMITER_LIMITS = Object.freeze({
  capacity: 1000,
  refillPerSecond: 1000,
  maxConcurrent: 20,
  maxQueue: 100,
  idLength: 64,
  maxDurationMs: 600000,
  priority: 10
});

const DEFAULTS = Object.freeze({
  capacity: 10,
  refillPerSecond: 2,
  maxConcurrent: 3,
  maxQueue: 100
});

const EPSILON = 1e-9;

const defaultClock = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

function assertCapacity(value) {
  if (!Number.isFinite(value) || value <= 0 || value > RATE_LIMITER_LIMITS.capacity) {
    throw new RangeError(`Capacity must be greater than 0 and at most ${RATE_LIMITER_LIMITS.capacity}.`);
  }
  return value;
}

function assertRefill(value) {
  if (!Number.isFinite(value) || value <= 0 || value > RATE_LIMITER_LIMITS.refillPerSecond) {
    throw new RangeError(
      `Refill rate must be greater than 0 and at most ${RATE_LIMITER_LIMITS.refillPerSecond} tokens/s.`
    );
  }
  return value;
}

function assertConcurrency(value) {
  if (!Number.isInteger(value) || value < 1 || value > RATE_LIMITER_LIMITS.maxConcurrent) {
    throw new RangeError(`Concurrency must be an integer between 1 and ${RATE_LIMITER_LIMITS.maxConcurrent}.`);
  }
  return value;
}

function assertQueueLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > RATE_LIMITER_LIMITS.maxQueue) {
    throw new RangeError(`Queue limit must be an integer between 1 and ${RATE_LIMITER_LIMITS.maxQueue}.`);
  }
  return value;
}

function assertCost(tokens, capacity) {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new RangeError('Token cost must be a positive finite number.');
  }
  if (tokens > capacity) {
    throw new RangeError('Token cost cannot exceed the bucket capacity.');
  }
  return tokens;
}

function assertId(id) {
  if (typeof id !== 'string' || id.trim().length === 0 || id.trim().length > RATE_LIMITER_LIMITS.idLength) {
    throw new TypeError(`Request id must contain 1–${RATE_LIMITER_LIMITS.idLength} characters.`);
  }
  return id.trim();
}

function assertPriority(priority) {
  if (!Number.isInteger(priority) || Math.abs(priority) > RATE_LIMITER_LIMITS.priority) {
    throw new RangeError(`Priority must be an integer between -${RATE_LIMITER_LIMITS.priority} and ${RATE_LIMITER_LIMITS.priority}.`);
  }
  return priority;
}

function assertDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > RATE_LIMITER_LIMITS.maxDurationMs) {
    throw new RangeError(`Duration must be greater than 0 and at most ${RATE_LIMITER_LIMITS.maxDurationMs} ms.`);
  }
  return durationMs;
}

function createMetrics() {
  return {
    offered: 0,
    accepted: 0,
    throttled: 0,
    completed: 0,
    cancelled: 0,
    tokensConsumed: 0,
    peakQueue: 0
  };
}

/**
 * Token bucket with a priority wait queue and a concurrency cap.
 *
 * Refill is continuous: every millisecond adds `refillPerSecond / 1000` tokens
 * up to `capacity`. Tokens are kept as fractions so short intervals are
 * accurate, and comparisons use a tiny epsilon for floating-point safety.
 */
export class RealEstateLuxeTokenBucketRateLimiter {
  constructor(options = {}) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('Options must be an object.');
    }
    const {
      capacity = DEFAULTS.capacity,
      refillPerSecond = DEFAULTS.refillPerSecond,
      maxConcurrent = DEFAULTS.maxConcurrent,
      maxQueue = DEFAULTS.maxQueue,
      clock = defaultClock
    } = options;

    if (typeof clock !== 'function') throw new TypeError('Clock must be a function.');

    this.capacity = assertCapacity(capacity);
    this.refillPerSecond = assertRefill(refillPerSecond);
    this.maxConcurrent = assertConcurrency(maxConcurrent);
    this.maxQueue = assertQueueLimit(maxQueue);
    this.clock = clock;

    this.lastTime = this.clock();
    this.tokens = this.capacity;
    this.queue = [];
    this.active = [];
    this.sequence = 0;
    this.metrics = createMetrics();
  }

  /** Add tokens for the elapsed interval and return the current balance. */
  refill() {
    const now = this.clock();
    const elapsed = Math.max(0, now - this.lastTime);
    this.lastTime = Math.max(this.lastTime, now);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.refillPerSecond) / 1000);
    return this.tokens;
  }

  /** Current balance after refilling. */
  getAvailableTokens() {
    return this.refill();
  }

  /** Milliseconds until at least one whole token is available. */
  get nextTokenInMs() {
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /**
   * Raw bucket primitive: refill, then spend `tokens` atomically.
   * Returns `true` when admitted, `false` when the bucket is exhausted.
   */
  tryConsume(tokens = 1) {
    assertCost(tokens, this.capacity);
    this.refill();
    this.metrics.offered += 1;

    if (this.tokens + EPSILON < tokens) {
      this.metrics.throttled += 1;
      return false;
    }

    this.tokens = Math.max(0, this.tokens - tokens);
    this.metrics.accepted += 1;
    this.metrics.tokensConsumed += tokens;
    return true;
  }

  /**
   * Place a request in the priority wait queue. Higher priority starts first;
   * equal priorities keep FIFO order. Tokens are spent only when `tick()`
   * admits the request into a concurrency lane.
   */
  enqueue({ id, tokens = 1, priority = 0, durationMs = 800 } = {}) {
    const requestId = assertId(id);
    const cost = assertCost(tokens, this.capacity);
    const rank = assertPriority(priority);
    const duration = assertDuration(durationMs);
    this.refill();

    if (this.#find(requestId)) {
      throw new RangeError(`Request "${requestId}" is already in flight.`);
    }

    this.metrics.offered += 1;
    if (this.queue.length >= this.maxQueue) {
      this.metrics.throttled += 1;
      return false;
    }

    const job = {
      id: requestId,
      tokens: cost,
      priority: rank,
      durationMs: duration,
      order: this.sequence,
      enqueuedAt: this.lastTime
    };
    this.sequence += 1;

    const index = this.queue.findIndex((queued) => queued.priority < rank);
    if (index === -1) this.queue.push(job);
    else this.queue.splice(index, 0, job);

    this.metrics.peakQueue = Math.max(this.metrics.peakQueue, this.queue.length);
    return true;
  }

  /**
   * Advance the simulation: retire finished lanes, then admit the highest
   * priority affordable requests while concurrency slots remain.
   */
  tick() {
    this.refill();
    const now = this.lastTime;
    const completed = [];
    const stillActive = [];

    for (const job of this.active) {
      if (job.endsAt <= now) {
        completed.push({ ...job, completedAt: now });
        this.metrics.completed += 1;
      } else {
        stillActive.push(job);
      }
    }
    this.active = stillActive;

    const started = [];
    while (this.active.length < this.maxConcurrent && this.queue.length > 0) {
      const index = this.queue.findIndex((job) => job.tokens <= this.tokens + EPSILON);
      if (index === -1) break;

      const [job] = this.queue.splice(index, 1);
      this.tokens = Math.max(0, this.tokens - job.tokens);
      this.metrics.accepted += 1;
      this.metrics.tokensConsumed += job.tokens;

      const startedJob = {
        ...job,
        startedAt: now,
        endsAt: now + job.durationMs,
        waitMs: now - job.enqueuedAt
      };
      this.active.push(startedJob);
      started.push({ ...startedJob });
    }

    return { started, completed, tokens: this.tokens };
  }

  /** Remove a still-queued request. Active requests cannot be cancelled. */
  cancel(id) {
    const index = this.queue.findIndex((job) => job.id === id);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this.metrics.cancelled += 1;
    return true;
  }

  /**
   * Update live configuration. Capacity changes clamp the current balance;
   * lowering the queue limit lets the existing queue drain naturally.
   */
  configure(partial = {}) {
    if (partial === null || typeof partial !== 'object') {
      throw new TypeError('Configuration must be an object.');
    }
    this.refill();

    if (partial.capacity !== undefined) {
      this.capacity = assertCapacity(partial.capacity);
      this.tokens = Math.min(this.tokens, this.capacity);
    }
    if (partial.refillPerSecond !== undefined) {
      this.refillPerSecond = assertRefill(partial.refillPerSecond);
    }
    if (partial.maxConcurrent !== undefined) {
      this.maxConcurrent = assertConcurrency(partial.maxConcurrent);
    }
    if (partial.maxQueue !== undefined) {
      this.maxQueue = assertQueueLimit(partial.maxQueue);
    }
    return this.snapshot();
  }

  /** Clear the queue and lanes, refill the bucket, and zero the counters. */
  reset() {
    this.queue.length = 0;
    this.active.length = 0;
    this.tokens = this.capacity;
    this.lastTime = this.clock();
    this.sequence = 0;
    this.metrics = createMetrics();
    return this.snapshot();
  }

  /** Immutable view of the engine for rendering and assertions. */
  snapshot() {
    this.refill();
    const now = this.lastTime;
    return {
      capacity: this.capacity,
      tokens: this.tokens,
      fillRatio: this.capacity === 0 ? 0 : this.tokens / this.capacity,
      refillPerSecond: this.refillPerSecond,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      queueDepth: this.queue.length,
      activeCount: this.active.length,
      nextTokenInMs: this.nextTokenInMs,
      queue: this.queue.map((job) => ({
        ...job,
        waitedMs: Math.max(0, now - job.enqueuedAt)
      })),
      active: this.active.map((job) => ({
        ...job,
        remainingMs: Math.max(0, job.endsAt - now)
      })),
      metrics: { ...this.metrics }
    };
  }

  #find(id) {
    const requestId = id.trim();
    return this.queue.some((job) => job.id === requestId)
      || this.active.some((job) => job.id === requestId);
  }
}

// ---------------------------------------------------------------------------
// Browser UI
// ---------------------------------------------------------------------------

const STATUS_COPY = Object.freeze({
  open: { label: 'Gate open', hint: 'Admission flowing' },
  pressure: { label: 'Queue pressure', hint: 'Backlog forming' },
  throttled: { label: 'Gate throttled', hint: 'Bucket exhausted' }
});

const LOG_KINDS = Object.freeze({
  ACCEPTED: 'accepted',
  THROTTLED: 'throttled',
  QUEUED: 'queued',
  STARTED: 'started',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  CONFIG: 'config'
});

const MAX_LOG_ENTRIES = 120;
const MAX_QUEUE_ROWS = 14;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms)} ms`;
}

/**
 * Wire the engine to the standalone demo page. Returns the limiter so tests and
 * console users can drive it directly.
 */
export function mountRateLimiterDemo(root = document) {
  const $ = (id) => root.getElementById?.(id) ?? null;
  const els = {
    statusPill: $('rate-status-pill'),
    statusText: $('rate-status-text'),
    statusHint: $('rate-status-hint'),
    bucketMeter: $('bucket-meter'),
    bucketFill: $('bucket-fill'),
    bucketValue: $('bucket-value'),
    bucketMax: $('bucket-max'),
    bucketRate: $('bucket-rate'),
    bucketNext: $('bucket-next'),
    flood10: $('btn-flood-10'),
    flood25: $('btn-flood-25'),
    vip: $('btn-vip'),
    direct: $('btn-direct'),
    drain: $('btn-drain'),
    reset: $('btn-reset'),
    metricAccepted: $('metric-accepted'),
    metricThrottled: $('metric-throttled'),
    metricActive: $('metric-active'),
    metricQueue: $('metric-queue'),
    metricCompleted: $('metric-completed'),
    metricConsumed: $('metric-consumed'),
    lanes: $('active-lanes'),
    activeCount: $('active-count'),
    queueList: $('queue-list'),
    queueCount: $('queue-count'),
    log: $('event-log'),
    logCount: $('log-count'),
    clearLog: $('btn-clear-log'),
    capacity: $('config-capacity'),
    refill: $('config-refill'),
    concurrency: $('config-concurrency'),
    queueLimit: $('config-queue'),
    outCapacity: $('out-capacity'),
    outRefill: $('out-refill'),
    outConcurrency: $('out-concurrency'),
    outQueue: $('out-queue')
  };

  if (!els.bucketMeter || !els.bucketFill || !els.log || !els.queueList || !els.lanes) return null;
  if (!els.metricAccepted || !els.metricThrottled || !els.capacity) return null;
  if (!els.statusPill || !els.statusText) return null;

  const limiter = new RealEstateLuxeTokenBucketRateLimiter({
    capacity: 10,
    refillPerSecond: 2,
    maxConcurrent: 3,
    maxQueue: 12
  });

  let requestSeq = 0;
  let logSeq = 0;

  const pushLog = (kind, message, meta) => {
    const row = element('li', `log-entry log-${LOG_KINDS[kind] ?? 'config'}`);
    const head = element('div', 'log-head');
    head.append(
      element('span', 'log-badge', kind),
      element('time', 'log-time', formatClock(Date.now()))
    );
    row.append(head, element('p', 'log-message', message));
    if (meta) row.append(element('code', 'log-meta', meta));
    els.log.prepend(row);
    logSeq += 1;
    while (els.log.children.length > MAX_LOG_ENTRIES) els.log.lastElementChild.remove();
    if (els.logCount) els.logCount.textContent = `${logSeq} events`;
  };

  const submitRequest = ({ priority = 0, tokens = 1, label = 'Private viewing request' } = {}) => {
    const id = `REQ-${String(++requestSeq).padStart(4, '0')}`;
    const durationMs = 900 + Math.round(Math.random() * 1200);
    const queued = limiter.enqueue({ id, tokens, priority, durationMs });
    if (queued) {
      pushLog(
        'QUEUED',
        `${id} · ${label}`,
        `priority ${priority} · ${tokens} token${tokens === 1 ? '' : 's'} · ${formatDuration(durationMs)}`
      );
    } else {
      pushLog('THROTTLED', `${id} · queue full`, `priority ${priority} · ${tokens} tokens`);
    }
    return queued;
  };

  const flood = (count, options = {}) => {
    for (let index = 0; index < count; index += 1) submitRequest(options);
    render();
  };

  const renderBucket = (snap) => {
    const ratio = Math.max(0, Math.min(1, snap.fillRatio));
    els.bucketFill.style.setProperty('--fill', String(ratio));
    els.bucketFill.classList.toggle('is-low', ratio < 0.25);
    els.bucketMeter.setAttribute('aria-valuemax', String(snap.capacity));
    els.bucketMeter.setAttribute('aria-valuenow', snap.tokens.toFixed(2));
    if (els.bucketValue) els.bucketValue.textContent = formatTokens(snap.tokens);
    if (els.bucketMax) els.bucketMax.textContent = String(snap.capacity);
    if (els.bucketRate) els.bucketRate.textContent = String(snap.refillPerSecond);
    if (els.bucketNext) els.bucketNext.textContent = snap.nextTokenInMs === 0 ? 'ready' : formatDuration(snap.nextTokenInMs);
  };

  const renderStatus = (snap) => {
    let state = 'open';
    if (snap.tokens < 1 && snap.queueDepth > 0) state = 'throttled';
    else if (snap.tokens < 1 || snap.queueDepth > 0) state = 'pressure';

    const copy = STATUS_COPY[state];
    els.statusPill.dataset.state = state;
    els.statusPill.setAttribute('aria-label', `Admission status: ${copy.label}`);
    els.statusText.textContent = copy.label;
    els.statusHint.textContent = `${formatTokens(snap.tokens)} tokens · ${snap.queueDepth} waiting`;
  };

  const renderMetrics = (snap) => {
    const metrics = snap.metrics;
    els.metricAccepted.textContent = String(metrics.accepted);
    els.metricThrottled.textContent = String(metrics.throttled);
    els.metricActive.textContent = `${snap.activeCount}/${snap.maxConcurrent}`;
    els.metricQueue.textContent = String(snap.queueDepth);
    els.metricCompleted.textContent = String(metrics.completed);
    els.metricConsumed.textContent = formatTokens(metrics.tokensConsumed);
    if (els.activeCount) els.activeCount.textContent = `${snap.activeCount}/${snap.maxConcurrent}`;
    if (els.queueCount) els.queueCount.textContent = String(snap.queueDepth);
  };

  const renderLanes = (snap) => {
    els.lanes.replaceChildren();
    for (let index = 0; index < snap.maxConcurrent; index += 1) {
      const job = snap.active[index];
      const lane = element('div', `lane ${job ? 'is-busy' : 'is-idle'}`);
      if (!job) {
        lane.append(element('span', 'lane-index', `Lane ${index + 1}`), element('span', 'lane-idle', 'Idle'));
        els.lanes.append(lane);
        continue;
      }
      const duration = Math.max(1, job.endsAt - job.startedAt);
      const progress = Math.max(0, Math.min(1, 1 - job.remainingMs / duration));
      const head = element('div', 'lane-head');
      head.append(
        element('span', 'lane-index', `Lane ${index + 1}`),
        element('span', 'lane-remaining', formatDuration(job.remainingMs))
      );
      const track = element('div', 'lane-track');
      const fill = element('span', 'lane-fill');
      fill.style.setProperty('--progress', String(progress));
      track.append(fill);
      lane.append(head, element('strong', 'lane-id', job.id), track);
      els.lanes.append(lane);
    }
  };

  const renderQueue = (snap) => {
    els.queueList.replaceChildren();
    if (snap.queue.length === 0) {
      els.queueList.append(element('li', 'empty-state', 'No requests waiting — the queue is clear.'));
      return;
    }
    for (const job of snap.queue.slice(0, MAX_QUEUE_ROWS)) {
      const row = element('li', 'queue-row');
      const priority = element('span', `priority-chip priority-${Math.min(3, Math.max(0, job.priority))}`, `P${job.priority}`);
      const main = element('div', 'queue-main');
      main.append(
        element('strong', 'queue-id', job.id),
        element('span', 'queue-meta', `${job.tokens} token${job.tokens === 1 ? '' : 's'} · waiting ${formatDuration(job.waitedMs)}`)
      );
      row.append(priority, main, element('span', 'queue-order', `#${job.order + 1}`));
      els.queueList.append(row);
    }
    if (snap.queue.length > MAX_QUEUE_ROWS) {
      els.queueList.append(
        element('li', 'empty-state', `…and ${snap.queue.length - MAX_QUEUE_ROWS} more waiting`)
      );
    }
  };

  const render = () => {
    const snap = limiter.snapshot();
    renderBucket(snap);
    renderStatus(snap);
    renderMetrics(snap);
    renderLanes(snap);
    renderQueue(snap);
  };

  els.flood10?.addEventListener('click', () => {
    flood(10);
    pushLog('CONFIG', 'Flood simulator released 10 standard requests', 'priority 0');
    render();
  });

  els.flood25?.addEventListener('click', () => {
    flood(25);
    pushLog('CONFIG', 'Flood simulator released 25 standard requests', 'priority 0');
    render();
  });

  els.vip?.addEventListener('click', () => {
    submitRequest({ priority: 9, tokens: 2, label: 'VIP penthouse tour' });
    render();
  });

  els.direct?.addEventListener('click', () => {
    const admitted = limiter.tryConsume(1);
    pushLog(
      admitted ? 'ACCEPTED' : 'THROTTLED',
      admitted ? 'Direct request admitted instantly' : 'Direct request denied — bucket empty',
      'tryConsume(1)'
    );
    render();
  });

  els.drain?.addEventListener('click', () => {
    const drained = limiter.tryConsume(limiter.capacity);
    pushLog(
      drained ? 'ACCEPTED' : 'THROTTLED',
      drained ? 'Bucket drained to zero in one burst' : 'Drain rejected — bucket not full',
      `tryConsume(${limiter.capacity})`
    );
    render();
  });

  els.reset?.addEventListener('click', () => {
    limiter.reset();
    requestSeq = 0;
    logSeq = 0;
    els.log.replaceChildren();
    if (els.logCount) els.logCount.textContent = '0 events';
    pushLog('CONFIG', 'Engine reset — reservoir refilled and queue cleared', '');
    render();
  });

  els.clearLog?.addEventListener('click', () => {
    els.log.replaceChildren();
    logSeq = 0;
    if (els.logCount) els.logCount.textContent = '0 events';
  });

  const bindConfig = (input, output, key, format, label) => {
    if (!input) return;
    const apply = () => {
      const value = Number(input.value);
      limiter.configure({ [key]: value });
      if (output) output.textContent = format(value);
      pushLog('CONFIG', `${label} set to ${format(value)}`, 'configure()');
      render();
    };
    input.addEventListener('input', apply);
    if (output) output.textContent = format(Number(input.value));
  };

  bindConfig(els.capacity, els.outCapacity, 'capacity', (value) => `${value} tokens`, 'Capacity');
  bindConfig(els.refill, els.outRefill, 'refillPerSecond', (value) => `${value}/s`, 'Refill rate');
  bindConfig(els.concurrency, els.outConcurrency, 'maxConcurrent', (value) => `${value} lanes`, 'Concurrency');
  bindConfig(els.queueLimit, els.outQueue, 'maxQueue', (value) => `${value} slots`, 'Queue limit');

  setInterval(() => {
    const result = limiter.tick();
    for (const job of result.completed) {
      pushLog('COMPLETED', `${job.id} · lane released`, `waited ${formatDuration(job.waitMs)}`);
    }
    for (const job of result.started) {
      pushLog(
        'STARTED',
        `${job.id} · admitted to a lane`,
        `P${job.priority} · ${job.tokens} token${job.tokens === 1 ? '' : 's'} · waited ${formatDuration(job.waitMs)}`
      );
    }
    render();
  }, 150);

  render();
  pushLog(
    'CONFIG',
    `Engine ready — ${limiter.capacity} tokens, ${limiter.refillPerSecond}/s refill, ${limiter.maxConcurrent} lanes`,
    `queue limit ${limiter.maxQueue}`
  );

  setTimeout(() => {
    submitRequest({ label: 'Penthouse viewing · Beverly Hills' });
    submitRequest({ label: 'Ski chalet tour · Aspen', priority: 4 });
    submitRequest({ label: 'Villa enquiry · Côte d’Azur' });
    render();
  }, 650);

  if (typeof window !== 'undefined') window.realEstateRateLimiter = limiter;
  return limiter;
}

if (typeof document !== 'undefined') {
  const start = () => mountRateLimiterDemo();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
