import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../lib/errors.js';
import { hexToBin } from '../lib/intelHex.js';
import { Semaphore } from '../lib/semaphore.js';

// Main sketch file name. arduino-cli requires it to match its folder name.
export const SKETCH_NAME = 'sketch';

// Default preference when the client does not ask for a format.
// ESP32 produces .bin natively; AVR produces .hex, which is converted to .bin on
// request (and by default); RP2040 also produces .uf2.
export const ARTIFACT_FORMATS = ['bin', 'hex', 'uf2'];

const BOARD_ERROR_RE = /platform not installed|unknown fqbn|invalid fqbn|board .* not found|platform .* not found/i;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Wraps the arduino-cli binary. Everything the HTTP layer needs from the
 * toolchain goes through this object, so tests can swap in a fake.
 */
export function createArduinoCli(config) {
  const semaphore = new Semaphore(config.maxConcurrentCompiles, config.maxQueuedCompiles);
  // Each concurrent compile owns one slot folder. Reusing the same sketch path lets
  // arduino-cli reuse its build dir and precompiled core, which halves warm compile
  // times, and keeps disk use bounded to one build dir per slot.
  const freeSlots = Array.from({ length: config.maxConcurrentCompiles }, (_, i) => i);
  // A fixed name (not per process) so restarts reuse the same folders and the same
  // arduino-cli build dirs instead of leaving new ones behind. Leftovers from a
  // previous run are cleared once, before the first compile. Two servers sharing
  // one COMPILE_WORK_DIR would collide, so give each instance its own.
  const slotsRoot = path.join(config.workDir, 'acomp-slots');
  const slotsReady = fs.rm(slotsRoot, { recursive: true, force: true }).catch(() => {});
  let boardsCache = null;

  function run(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      // execFile (no shell), so user input can never be interpreted as a command.
      execFile(
        config.arduinoCliPath,
        args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err?.code === 'ENOENT') {
            return reject(new ApiError(503, 'COMPILER_UNAVAILABLE', 'arduino-cli is not installed on the server'));
          }
          resolve({
            stdout,
            stderr,
            exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            timedOut: Boolean(err?.killed),
          });
        },
      );
    });
  }

  async function version() {
    const r = await run(['version', '--json'], 15_000);
    const json = parseJson(r.stdout);
    return json?.VersionString ?? json?.version ?? r.stdout.trim();
  }

  async function listBoards() {
    if (boardsCache && Date.now() - boardsCache.at < 60_000) return boardsCache.boards;
    const r = await run(['board', 'listall', '--json'], 30_000);
    if (r.exitCode !== 0) throw new ApiError(502, 'COMPILER_ERROR', 'arduino-cli failed to list boards', r.stderr.trim());
    const boards = (parseJson(r.stdout)?.boards ?? [])
      .filter((b) => b.fqbn)
      .map((b) => ({ name: b.name, fqbn: b.fqbn, platform: b.platform?.metadata?.id ?? b.fqbn.split(':').slice(0, 2).join(':') }))
      .sort((a, b) => a.fqbn.localeCompare(b.fqbn));
    boardsCache = { at: Date.now(), boards };
    return boards;
  }

  /**
   * Compiles one sketch.
   * @param {{ fqbn: string, files: {name: string, content: string}[], format?: string }} job
   * @returns success result, or { success: false, compilerOutput } for code errors.
   */
  async function compile({ fqbn, files, format }) {
    return semaphore.run(async () => {
      await slotsReady;
      // The semaphore guarantees a free slot exists here.
      const slot = freeSlots.pop();
      const slotDir = path.join(slotsRoot, `slot-${slot}`);
      const sketchDir = path.join(slotDir, SKETCH_NAME);
      const outDir = path.join(slotDir, 'out');
      const started = Date.now();

      // Compiler messages contain absolute paths; show them relative to the sketch instead.
      const clean = (text) => (text ?? '').split(sketchDir + path.sep).join('').split(slotDir).join('').trim();

      try {
        // Start from empty sketch/output folders so nothing leaks between users or jobs
        // (e.g. a stale .bin from an earlier ESP32 build being returned for an AVR build).
        await fs.rm(sketchDir, { recursive: true, force: true });
        await fs.rm(outDir, { recursive: true, force: true });
        await fs.mkdir(sketchDir, { recursive: true });
        for (const f of files) await fs.writeFile(path.join(sketchDir, f.name), f.content, 'utf8');

        // No --build-path: arduino-cli then keys the build dir on the sketch path and
        // uses its shared per-board core cache (ARDUINO_BUILD_CACHE_PATH).
        const r = await run(
          ['compile', '--fqbn', fqbn, '--output-dir', outDir, '--json', sketchDir],
          config.compileTimeoutMs,
        );
        if (r.timedOut) {
          throw new ApiError(504, 'COMPILE_TIMEOUT', `Compilation exceeded ${config.compileTimeoutMs} ms`);
        }

        const json = parseJson(r.stdout);
        const compilerOutput = clean([json?.compiler_out, json?.compiler_err].filter(Boolean).join('\n'));
        const durationMs = Date.now() - started;

        if (r.exitCode !== 0 || json?.success === false) {
          const message = clean(json?.error || r.stderr) || compilerOutput;
          if (!compilerOutput && BOARD_ERROR_RE.test(message)) {
            throw new ApiError(400, 'UNKNOWN_BOARD', `Board ${fqbn} is not installed on this server`, message);
          }
          return { success: false, fqbn, durationMs, compilerOutput: compilerOutput || message };
        }

        const produced = await fs.readdir(outDir).catch(() => []);
        const native = ARTIFACT_FORMATS.filter((ext) => produced.includes(`${SKETCH_NAME}.ino.${ext}`));
        // Boards that only emit .hex (AVR, many ARM cores) get a .bin converted on the server,
        // so clients can always ask for raw bytes.
        const convertBin = !native.includes('bin') && native.includes('hex');
        const available = ARTIFACT_FORMATS.filter((ext) => native.includes(ext) || (ext === 'bin' && convertBin));
        const chosen = format ?? available[0];
        if (!chosen || !available.includes(chosen)) {
          throw new ApiError(422, 'FORMAT_UNAVAILABLE', `Board ${fqbn} did not produce a .${format ?? 'bin/.hex/.uf2'} file`, { available });
        }

        const fileName = `${SKETCH_NAME}.ino.${chosen}`;
        let data;
        let loadAddress = null;
        if (chosen === 'bin' && convertBin) {
          try {
            ({ data, loadAddress } = hexToBin(await fs.readFile(path.join(outDir, `${SKETCH_NAME}.ino.hex`))));
          } catch (err) {
            throw new ApiError(500, 'CONVERSION_FAILED', `Could not convert .hex to .bin: ${err.message}`);
          }
        } else {
          data = await fs.readFile(path.join(outDir, fileName));
        }
        const sections = json?.builder_result?.executable_sections_size ?? [];

        return {
          success: true,
          fqbn,
          durationMs,
          format: chosen,
          fileName,
          sizeBytes: data.length,
          loadAddress,
          sha256: createHash('sha256').update(data).digest('hex'),
          memory: sections.map((s) => ({ name: s.name, size: s.size, maxSize: s.max_size ?? s.maxSize ?? null })),
          compilerOutput,
          data,
        };
      } finally {
        // Remove the user's source right away; the build dir stays for the next job's cache.
        await fs.rm(sketchDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
        freeSlots.push(slot);
      }
    });
  }

  return { compile, listBoards, version, queueStats: () => semaphore.stats() };
}
