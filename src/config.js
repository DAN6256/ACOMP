import os from 'node:os';

function positiveInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig() {
  return {
    port: positiveInt('PORT', 3000),
    arduinoCliPath: process.env.ARDUINO_CLI_PATH || 'arduino-cli',
    // Where per-request sketch/build directories are created (and deleted afterwards).
    workDir: process.env.COMPILE_WORK_DIR || os.tmpdir(),
    compileTimeoutMs: positiveInt('COMPILE_TIMEOUT_MS', 120_000),
    maxConcurrentCompiles: positiveInt('MAX_CONCURRENT_COMPILES', 2),
    maxQueuedCompiles: positiveInt('MAX_QUEUED_COMPILES', 20),
    maxSourceBytes: positiveInt('MAX_SOURCE_BYTES', 256 * 1024),
    maxFiles: positiveInt('MAX_FILES', 20),
    // Empty = any FQBN whose core is installed on the server.
    allowedFqbns: list('ALLOWED_FQBNS'),
    rateLimitPerMinute: positiveInt('RATE_LIMIT_PER_MINUTE', 30),
    // Number of reverse-proxy hops to trust for the client IP (0 = none).
    trustProxy: Number.parseInt(process.env.TRUST_PROXY ?? '0', 10) || 0,
  };
}
