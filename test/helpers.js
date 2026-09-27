import { createApp } from '../src/app.js';
import { ApiError } from '../src/lib/errors.js';

export const BLINK = 'void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() {}\n';

export function testConfig(overrides = {}) {
  return {
    maxSourceBytes: 256 * 1024,
    maxFiles: 20,
    allowedFqbns: [],
    rateLimitPerMinute: 1000,
    trustProxy: 0,
    corsOrigins: [],
    ...overrides,
  };
}

/** Fake arduino-cli: records jobs and returns canned results. */
export function fakeCli(behavior = {}) {
  const jobs = [];
  return {
    jobs,
    async compile(job) {
      jobs.push(job);
      if (behavior.compile) return behavior.compile(job);
      const data = Buffer.from(':00000001FF\n');
      return {
        success: true,
        fqbn: job.fqbn,
        durationMs: 5,
        format: job.format ?? 'hex',
        fileName: `sketch.ino.${job.format ?? 'hex'}`,
        sizeBytes: data.length,
        sha256: 'abc123',
        memory: [{ name: 'text', size: 924, maxSize: 32256 }],
        compilerOutput: '',
        data,
      };
    },
    async listBoards() {
      if (behavior.unavailable) throw new ApiError(503, 'COMPILER_UNAVAILABLE', 'missing');
      return [
        { name: 'Arduino Uno', fqbn: 'arduino:avr:uno', platform: 'arduino:avr' },
        { name: 'Arduino Nano', fqbn: 'arduino:avr:nano', platform: 'arduino:avr' },
      ];
    },
    async version() {
      if (behavior.unavailable) throw new ApiError(503, 'COMPILER_UNAVAILABLE', 'missing');
      return '1.2.2';
    },
    queueStats: () => ({ active: 0, queued: 0, maxActive: 2, maxQueued: 20 }),
  };
}

export function makeApp({ cli = fakeCli(), config = testConfig() } = {}) {
  return { app: createApp({ cli, config }), cli };
}
