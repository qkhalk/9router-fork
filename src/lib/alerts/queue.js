/**
 * Per-channel FIFO send queue with rate limiting and retry.
 *
 * Guarantees:
 * - `enqueue()` never blocks and never throws; draining is fire-and-forget.
 * - At least `minIntervalMs` between send STARTS (timestamp pacing).
 * - Optional second limiter `burst = { count, windowMs }` (sliding window).
 * - On a 429-ish rejection (sender throws an Error with `.retryAfterMs`),
 *   the next attempt is delayed by at least that long.
 * - Up to 3 tries total per message with backoff (1s, 3s); afterwards the
 *   message is dropped and logged via console.error.
 * - Errors marked `.noRetry = true` (e.g. "URL not allowed") are dropped
 *   immediately without retrying.
 *
 * Zero repo imports — pure, dependency-free by design so it can be unit
 * tested and reused anywhere (import-graph safety for hot paths).
 */

const RETRY_BACKOFF_MS = [1000, 3000]; // delay before try #2 and #3
const MAX_TRIES = 3;

export class SendQueue {
  /**
   * @param {(message: any) => Promise<void>} sender - async send fn; throws on failure.
   * @param {{ minIntervalMs?: number, burst?: { count: number, windowMs: number } | null }} [opts]
   */
  constructor(sender, opts = {}) {
    this._sender = sender;
    this._minIntervalMs = Math.max(0, Number(opts.minIntervalMs) || 0);
    this._burst = opts.burst && Number(opts.burst.count) > 0 ? opts.burst : null;
    this._queue = [];
    this._draining = false;
    this._generation = 0; // bumped by clear() to invalidate in-flight drains
    this._lastSendStart = 0;
    this._sendStarts = []; // sliding-window stamps for the burst limiter
    this._sleeps = new Set(); // active { timer, resolve } handles
  }

  /** Queue depth (for tests/observability). */
  pending() {
    return this._queue.length;
  }

  /**
   * Enqueue a message; never blocks, never throws. Starts draining
   * immediately (async, fire-and-forget).
   * @param {any} message
   */
  enqueue(message) {
    this._queue.push(message);
    this._kickDrain();
  }

  /**
   * Drop everything and cancel the in-flight drain (pending sleeps are
   * cleared — no dangling timers). Later enqueue() calls start a fresh drain.
   */
  clear() {
    this._queue.length = 0;
    this._generation += 1;
    this._draining = false;
    for (const s of this._sleeps) {
      clearTimeout(s.timer);
      s.resolve();
    }
    this._sleeps.clear();
  }

  _kickDrain() {
    if (this._draining) return;
    this._draining = true;
    const generation = ++this._generation;
    this._drain(generation).catch((err) => {
      // Unreachable in practice (_drain never rejects); last-resort guard so
      // a bug in a fire-and-forget drain can never crash the process.
      console.error("[alerts] queue drain crashed", err);
      if (generation === this._generation) this._draining = false;
    });
  }

  async _drain(generation) {
    try {
      while (generation === this._generation && this._queue.length > 0) {
        const message = this._queue[0];
        await this._sendWithRetry(message, generation);
        if (generation !== this._generation) return;
        this._queue.shift();
      }
    } finally {
      if (generation === this._generation) this._draining = false;
    }
  }

  /** Delay until the next send may START (min-interval + burst window). */
  _pacingDelayMs(now) {
    let delay = this._lastSendStart + this._minIntervalMs - now;
    if (this._burst) {
      const windowStart = now - this._burst.windowMs;
      this._sendStarts = this._sendStarts.filter((t) => t > windowStart);
      if (this._sendStarts.length >= this._burst.count) {
        const untilWindowFrees = this._sendStarts[0] + this._burst.windowMs - now;
        if (untilWindowFrees > delay) delay = untilWindowFrees;
      }
    }
    return delay > 0 ? delay : 0;
  }

  _markSendStart(now) {
    this._lastSendStart = now;
    if (this._burst) this._sendStarts.push(now);
  }

  async _sendWithRetry(message, generation) {
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      if (generation !== this._generation) return false;
      // Pacing applies to EVERY attempt (retries are send starts too).
      const pacingMs = this._pacingDelayMs(Date.now());
      if (pacingMs > 0) await this._sleep(pacingMs);
      if (generation !== this._generation) return false;
      this._markSendStart(Date.now());
      try {
        await this._sender(message);
        return true;
      } catch (err) {
        if (err && err.noRetry) {
          console.error("[alerts] dropped message (noRetry)", message && message.eventType, err && err.message);
          return false;
        }
        if (attempt >= MAX_TRIES) {
          console.error("[alerts] dropped message after 3 tries", message && message.eventType, err && err.message);
          return false;
        }
        const backoffMs = RETRY_BACKOFF_MS[attempt - 1] || 3000;
        const retryAfterMs = Number(err && err.retryAfterMs) || 0;
        await this._sleep(Math.max(backoffMs, retryAfterMs));
        if (generation !== this._generation) return false;
      }
    }
    return false;
  }

  /** setTimeout-based sleep; tracked so clear() can cancel every pending timer. */
  _sleep(ms) {
    return new Promise((resolve) => {
      const handle = { timer: null, resolve };
      handle.timer = setTimeout(() => {
        this._sleeps.delete(handle);
        resolve();
      }, ms);
      this._sleeps.add(handle);
    });
  }
}
