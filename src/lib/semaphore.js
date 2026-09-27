import { ApiError } from './errors.js';

/**
 * Limits how many compiles run at once. Extra requests wait in a bounded queue;
 * once the queue is full, new requests are rejected with 503 so the client can retry.
 */
export class Semaphore {
  constructor(maxActive, maxQueued) {
    this.maxActive = maxActive;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.waiting = [];
  }

  async acquire() {
    if (this.active < this.maxActive) {
      this.active++;
      return;
    }
    if (this.waiting.length >= this.maxQueued) {
      throw new ApiError(503, 'SERVER_BUSY', 'Compile queue is full, retry shortly');
    }
    // The releasing caller hands its slot straight to us, so `active` is unchanged.
    await new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats() {
    return { active: this.active, queued: this.waiting.length, maxActive: this.maxActive, maxQueued: this.maxQueued };
  }
}
