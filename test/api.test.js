import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { ApiError } from '../src/lib/errors.js';
import { BLINK, fakeCli, makeApp, testConfig } from './helpers.js';

describe('POST /api/v1/compile', () => {
  it('returns base64 firmware and metadata as JSON', async () => {
    const { app, cli } = makeApp();
    const res = await request(app).post('/api/v1/compile').send({ fqbn: 'arduino:avr:uno', code: BLINK });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.format, 'hex');
    assert.equal(Buffer.from(res.body.artifact, 'base64').toString(), ':00000001FF\n');
    assert.equal(res.body.data, undefined);
    assert.deepEqual(cli.jobs[0].files, [{ name: 'sketch.ino', content: BLINK }]);
  });

  it('returns raw bytes when the client accepts octet-stream', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/compile')
      .set('Accept', 'application/octet-stream')
      .send({ fqbn: 'arduino:avr:uno', code: BLINK })
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['x-firmware-format'], 'hex');
    assert.equal(res.headers['x-firmware-sha256'], 'abc123');
    assert.equal(res.body.toString(), ':00000001FF\n');
  });

  it('returns the firmware as a download with ?output=file', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/compile?output=file')
      .send({ fqbn: 'arduino:avr:uno', code: BLINK, format: 'hex' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-disposition'], 'attachment; filename="sketch.ino.hex"');
    assert.equal(res.body.toString(), ':00000001FF\n');
  });

  it('rejects an unknown output mode', async () => {
    const { app, cli } = makeApp();
    const res = await request(app).post('/api/v1/compile?output=zip').send({ fqbn: 'arduino:avr:uno', code: BLINK });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(cli.jobs.length, 0);
  });

  it('passes extra files, board options and format through', async () => {
    const { app, cli } = makeApp();
    const res = await request(app)
      .post('/api/v1/compile')
      .send({
        fqbn: 'arduino:avr:nano:cpu=atmega328old',
        code: '#include "util.h"\n' + BLINK,
        files: [{ name: 'util.h', content: '#pragma once\n#include <Arduino.h>\n' }],
        format: 'hex',
      });

    assert.equal(res.status, 200);
    assert.equal(cli.jobs[0].fqbn, 'arduino:avr:nano:cpu=atmega328old');
    assert.equal(cli.jobs[0].format, 'hex');
    assert.deepEqual(cli.jobs[0].files.map((f) => f.name), ['sketch.ino', 'util.h']);
  });

  it('maps compiler errors to 422 with the compiler output', async () => {
    const cli = fakeCli({
      compile: () => ({ success: false, fqbn: 'arduino:avr:uno', compilerOutput: "sketch.ino:2:1: error: 'foo' was not declared" }),
    });
    const { app } = makeApp({ cli });
    const res = await request(app).post('/api/v1/compile').send({ fqbn: 'arduino:avr:uno', code: 'foo();' });

    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'COMPILE_ERROR');
    assert.match(res.body.error.details.compilerOutput, /not declared/);
  });

  it('passes service errors (busy, timeout) through with their status', async () => {
    const cli = fakeCli({
      compile: () => {
        throw new ApiError(503, 'SERVER_BUSY', 'Compile queue is full, retry shortly');
      },
    });
    const { app } = makeApp({ cli });
    const res = await request(app).post('/api/v1/compile').send({ fqbn: 'arduino:avr:uno', code: BLINK });

    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'SERVER_BUSY');
  });

  const invalid = [
    ['missing fqbn', { code: BLINK }],
    ['malformed fqbn', { fqbn: 'uno', code: BLINK }],
    ['fqbn with shell characters', { fqbn: 'arduino:avr:uno;rm -rf /', code: BLINK }],
    ['empty code', { fqbn: 'arduino:avr:uno', code: '   ' }],
    ['unknown format', { fqbn: 'arduino:avr:uno', code: BLINK, format: 'exe' }],
    ['path traversal in file name', { fqbn: 'arduino:avr:uno', code: BLINK, files: [{ name: '../x.h', content: '' }] }],
    ['file overriding the main sketch', { fqbn: 'arduino:avr:uno', code: BLINK, files: [{ name: 'sketch.ino', content: '' }] }],
    ['absolute #include', { fqbn: 'arduino:avr:uno', code: '#include "/etc/passwd"\n' + BLINK }],
    ['Windows absolute #include', { fqbn: 'arduino:avr:uno', code: '#include <C:\\Windows\\win.ini>\n' + BLINK }],
    ['#include escaping the sketch', { fqbn: 'arduino:avr:uno', code: '#include "../../secret.h"\n' + BLINK }],
    ['computed #include', { fqbn: 'arduino:avr:uno', code: '#define P "/etc/passwd"\n#include P\n' + BLINK }],
    ['__has_include probe', { fqbn: 'arduino:avr:uno', code: '#if __has_include("/etc/shadow")\n#endif\n' + BLINK }],
    ['asm .incbin', { fqbn: 'arduino:avr:uno', code: 'asm(".incbin \\"x\\"");\n' + BLINK }],
  ];
  for (const [name, body] of invalid) {
    it(`rejects ${name} with 400`, async () => {
      const { app, cli } = makeApp();
      const res = await request(app).post('/api/v1/compile').send(body);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.equal(cli.jobs.length, 0);
    });
  }

  it('rejects source over the size limit', async () => {
    const { app } = makeApp({ config: testConfig({ maxSourceBytes: 100 }) });
    const res = await request(app).post('/api/v1/compile').send({ fqbn: 'arduino:avr:uno', code: 'x'.repeat(101) });
    assert.equal(res.status, 400);
    assert.match(res.body.error.details.join(), /exceeds 100 B/);
  });

  it('enforces the FQBN allowlist', async () => {
    const { app } = makeApp({ config: testConfig({ allowedFqbns: ['arduino:avr:uno'] }) });
    const ok = await request(app).post('/api/v1/compile').send({ fqbn: 'arduino:avr:uno', code: BLINK });
    const blocked = await request(app).post('/api/v1/compile').send({ fqbn: 'esp32:esp32:esp32', code: BLINK });
    assert.equal(ok.status, 200);
    assert.equal(blocked.status, 400);
  });

  it('returns 400 for malformed JSON', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/compile').set('Content-Type', 'application/json').send('{bad');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_JSON');
  });

  it('rate limits per client', async () => {
    const { app } = makeApp({ config: testConfig({ rateLimitPerMinute: 2 }) });
    const body = { fqbn: 'arduino:avr:uno', code: BLINK };
    await request(app).post('/api/v1/compile').send(body);
    await request(app).post('/api/v1/compile').send(body);
    const res = await request(app).post('/api/v1/compile').send(body);
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'RATE_LIMITED');
  });
});

describe('GET /api/v1/boards', () => {
  it('lists installed boards', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/boards');
    assert.equal(res.status, 200);
    assert.equal(res.body.boards.length, 2);
  });

  it('filters by the allowlist', async () => {
    const { app } = makeApp({ config: testConfig({ allowedFqbns: ['arduino:avr:uno'] }) });
    const res = await request(app).get('/api/v1/boards');
    assert.deepEqual(res.body.boards.map((b) => b.fqbn), ['arduino:avr:uno']);
  });

  it('returns 503 when arduino-cli is missing', async () => {
    const { app } = makeApp({ cli: fakeCli({ unavailable: true }) });
    const res = await request(app).get('/api/v1/boards');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'COMPILER_UNAVAILABLE');
  });
});

describe('CORS', () => {
  it('answers browser preflight requests', async () => {
    const res = await request(makeApp().app)
      .options('/api/v1/compile')
      .set('Origin', 'http://localhost:5555')
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(res.headers['access-control-allow-headers'], /Content-Type/);
  });

  it('exposes firmware headers and allows cross-origin reads', async () => {
    const res = await request(makeApp().app)
      .post('/api/v1/compile')
      .set('Origin', 'http://localhost:5555')
      .send({ fqbn: 'arduino:avr:uno', code: BLINK });
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(res.headers['access-control-expose-headers'], /X-Firmware-Sha256/);
    assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
  });

  it('only allows listed origins when CORS_ORIGINS is set', async () => {
    const { app } = makeApp({ config: testConfig({ corsOrigins: ['https://app.example.com'] }) });
    const ok = await request(app).get('/api/v1/boards').set('Origin', 'https://app.example.com');
    const other = await request(app).get('/api/v1/boards').set('Origin', 'https://evil.example');
    assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });
});

describe('system routes', () => {
  it('GET /health reports compiler status', async () => {
    const ok = await request(makeApp().app).get('/health');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.compiler.version, '1.2.2');

    const down = await request(makeApp({ cli: fakeCli({ unavailable: true }) }).app).get('/health');
    assert.equal(down.status, 503);
    assert.equal(down.body.status, 'degraded');
  });

  it('serves the OpenAPI spec and Swagger UI', async () => {
    const { app } = makeApp();
    const spec = await request(app).get('/openapi.json');
    assert.equal(spec.status, 200);
    assert.ok(spec.body.paths['/api/v1/compile'].post);
    assert.ok(spec.body.paths['/api/v1/boards'].get);

    const docs = await request(app).get('/docs/');
    assert.equal(docs.status, 200);
    assert.match(docs.text, /swagger-ui/i);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await request(makeApp().app).get('/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
