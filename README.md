# ACOMP Compile Server

HTTP API that compiles Arduino sketches with [`arduino-cli`](https://arduino.github.io/arduino-cli/)
and returns the firmware (`.hex` / `.bin` / `.uf2`) so the mobile app can send it to the board over BLE.

Board-agnostic: the client passes a board FQBN (`arduino:avr:uno`, `esp32:esp32:esp32c3`, ...),
and any board whose core is installed on the server works.

- Swagger UI: `http://localhost:3000/docs`
- OpenAPI spec: `http://localhost:3000/openapi.json` (source: [src/docs/openapi.yaml](src/docs/openapi.yaml))

## Quick start (Docker, recommended)

```bash
docker compose up --build
curl localhost:3000/health
```

The image installs `arduino-cli` and the `arduino:avr` core. To add more boards, change
`ARDUINO_CORES` / `ARDUINO_BOARD_URLS` in [docker-compose.yml](docker-compose.yml) and rebuild.

## Quick start (local)

1. Install Node 20+ and [arduino-cli](https://arduino.github.io/arduino-cli/latest/installation/).
2. Install a core: `arduino-cli core update-index && arduino-cli core install arduino:avr`
3. Run:

```bash
npm install
npm start               # or: node --env-file=.env src/server.js
npm test
```

> **Windows note:** avr-gcc fails with `device-specs/specs-atmega328p: No such file or directory`
> when its install path is longer than about 260 characters. Keep the Arduino data folder on a short path
> (the default `%LOCALAPPDATA%\Arduino15` is fine). Production should run in the Linux container anyway.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/compile` | Compile a sketch, get firmware back |
| `GET` | `/api/v1/boards` | Boards (FQBNs) this server can build for |
| `GET` | `/health` | Liveness + arduino-cli version + queue stats |

```bash
curl -s localhost:3000/api/v1/compile \
  -H 'Content-Type: application/json' \
  -d '{"fqbn":"arduino:avr:uno","code":"void setup(){pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,!digitalRead(13));delay(500);}"}'
```

Success (`200`): JSON with `artifact` (base64 firmware), `format`, `sizeBytes`, `loadAddress`, `sha256`, `memory`, `compilerOutput`.
Add `?output=file` (or `Accept: application/octet-stream`) to get the file itself instead, with metadata in `X-Firmware-*` headers.

**Formats** (`format` in the body):

- `bin` (default): raw bytes ready to write to flash, for every board. ESP32 produces it directly; for boards
  that only produce `.hex` (Uno, Nano, ...) the server converts it ([src/lib/intelHex.js](src/lib/intelHex.js)),
  and `loadAddress` gives the flash address of the first byte (0 for AVR).
- `hex`: Intel HEX text, as the Arduino IDE produces it.
- `uf2`: for RP2040-style boards.

So the mobile app only ever does: base64-decode `artifact` → check `sha256` → send the bytes to the board.

Errors always look like `{ "error": { "code", "message", "details?" } }`:

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `UNKNOWN_BOARD` | Bad request, or board core not installed |
| 413 | `PAYLOAD_TOO_LARGE` | Body too big |
| 422 | `COMPILE_ERROR` | Code doesn't compile; see `details.compilerOutput` |
| 422 | `FORMAT_UNAVAILABLE` | Board doesn't produce the requested format |
| 429 | `RATE_LIMITED` | Too many requests from this client |
| 503 | `SERVER_BUSY`, `COMPILER_UNAVAILABLE` | Queue full, or arduino-cli missing |
| 504 | `COMPILE_TIMEOUT` | Build took too long |
| 500 | `CONVERSION_FAILED` | Server could not convert `.hex` to `.bin` (should not happen) |

## Configuration

Environment variables (see [.env.example](.env.example)):

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `ARDUINO_CLI_PATH` | `arduino-cli` | Binary path |
| `COMPILE_WORK_DIR` | OS temp dir | Where slot folders live |
| `COMPILE_TIMEOUT_MS` | `120000` | Per-compile timeout |
| `MAX_CONCURRENT_COMPILES` | `2` | Parallel compiles (about 1 per CPU core) |
| `MAX_QUEUED_COMPILES` | `20` | Waiting requests before `503 SERVER_BUSY` |
| `MAX_SOURCE_BYTES` | `262144` | Total source size |
| `MAX_FILES` | `20` | Files per sketch, including the main `.ino` |
| `ALLOWED_FQBNS` | *(all installed)* | Comma-separated `vendor:arch:board` allowlist |
| `RATE_LIMIT_PER_MINUTE` | `30` | Compile requests per client IP |
| `TRUST_PROXY` | `0` | Set to `1` behind nginx/a load balancer |

## How it works

```
POST /compile ─> validate ─> queue (Semaphore) ─> slot N: write sketch/ ─> arduino-cli compile --json
                                                           └─> read out/sketch.ino.{bin,hex,uf2} ─> respond
```

- Compiles run through a bounded queue, `MAX_CONCURRENT_COMPILES` at a time.
- Each concurrent slot reuses the same sketch folder. That lets arduino-cli reuse its build folder
  and the per-board **precompiled core cache**. Measured on AVR: about 11 s cold, **about 4 s warm**, and the cache
  survives switching between boards. User source and output are deleted after every job.
- arduino-cli is started with `execFile` (no shell), so nothing in the request can become a shell command.

## Security

User code is only compiled, never run, but the compiler reads files, so treat input as hostile:

- **Validation** ([src/lib/validation.js](src/lib/validation.js)): FQBN and file-name patterns, size limits,
  and rejection of absolute or `..` `#include` paths, macro-computed includes, `__has_include` probes and
  assembler `.incbin`/`.include`. This is a best-effort filter. **The container is the real boundary.**
- **Container** ([docker-compose.yml](docker-compose.yml)): non-root user, read-only filesystem, all capabilities dropped,
  `no-new-privileges`, and limits on PIDs, memory and CPU. Nothing sensitive (secrets, keys) should be mounted into it.
- **Rate limiting** and a bounded queue protect against abuse.

Before going public, consider: authentication (API key or user token from the app), running each
compile in a throwaway container or gVisor sandbox, and blocking the container's outbound network.

## Project layout

```
src/
  server.js              entry point
  app.js                 Express app (routes, docs, middleware)
  config.js              env configuration
  docs/openapi.yaml      OpenAPI 3 spec (served by Swagger UI)
  routes/                compile, boards, health
  services/arduinoCli.js arduino-cli wrapper (compile, list boards, version)
  lib/                   validation, errors, semaphore
test/                    node:test + supertest (fake compiler, no arduino-cli needed)
```
