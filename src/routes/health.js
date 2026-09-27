import { Router } from 'express';

export function healthRouter({ cli }) {
  const router = Router();

  router.get('/health', async (req, res) => {
    let compiler;
    try {
      compiler = { available: true, version: await cli.version() };
    } catch {
      compiler = { available: false, version: null };
    }
    res.status(compiler.available ? 200 : 503).json({
      status: compiler.available ? 'ok' : 'degraded',
      compiler,
      queue: cli.queueStats(),
    });
  });

  return router;
}
