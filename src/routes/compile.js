import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ApiError } from '../lib/errors.js';
import { parseCompileRequest } from '../lib/validation.js';

const OUTPUT_MODES = ['json', 'file'];

export function compileRouter({ cli, config }) {
  const router = Router();

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many compile requests, slow down' } }),
  });

  router.post('/compile', limiter, async (req, res) => {
    const output = req.query.output ?? 'json';
    if (!OUTPUT_MODES.includes(output)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid compile request', [`output must be one of: ${OUTPUT_MODES.join(', ')}`]);
    }
    const job = parseCompileRequest(req.body, config);
    const result = await cli.compile(job);

    if (!result.success) {
      return res.status(422).json({
        error: { code: 'COMPILE_ERROR', message: 'Sketch failed to compile', details: { compilerOutput: result.compilerOutput } },
      });
    }

    const { data, ...meta } = result;

    // Raw firmware file (?output=file or Accept: application/octet-stream); metadata travels in headers.
    const wantsFile =
      output === 'file' || req.accepts(['application/json', 'application/octet-stream']) === 'application/octet-stream';
    if (wantsFile) {
      return res
        .status(200)
        .set({
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${meta.fileName}"`,
          'X-Firmware-Format': meta.format,
          'X-Firmware-Sha256': meta.sha256,
          'X-Firmware-Fqbn': meta.fqbn,
          ...(meta.loadAddress !== null && { 'X-Firmware-Load-Address': String(meta.loadAddress) }),
        })
        .send(data);
    }

    return res.status(200).json({ ...meta, artifact: data.toString('base64') });
  });

  return router;
}
