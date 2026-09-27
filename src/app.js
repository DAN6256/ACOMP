import fs from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { cors } from './lib/cors.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { boardsRouter } from './routes/boards.js';
import { compileRouter } from './routes/compile.js';
import { healthRouter } from './routes/health.js';

export const openApiSpec = YAML.parse(fs.readFileSync(new URL('./docs/openapi.yaml', import.meta.url), 'utf8'));

/**
 * Builds the Express app. `cli` is injected so tests can use a fake compiler.
 */
export function createApp({ cli, config }) {
  const app = express();
  app.disable('x-powered-by');
  // Set TRUST_PROXY=1 only when behind a reverse proxy, so rate limiting sees the real client IP.
  // Enabling it without a proxy lets clients spoof X-Forwarded-For and dodge the limit.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Docs are mounted before helmet: swagger-ui needs inline assets that the default CSP blocks.
  app.get('/openapi.json', (req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: 'ACOMP Compile API' }));
  app.get('/', (req, res) => res.redirect('/docs'));

  app.use(cors(config.corsOrigins));
  // Allow browser apps on other origins to read responses (the default blocks them).
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // JSON escaping can roughly double the size of source code, plus room for the envelope.
  app.use(express.json({ limit: config.maxSourceBytes * 2 + 16 * 1024 }));

  app.use(healthRouter({ cli }));
  app.use('/api/v1', boardsRouter({ cli, config }));
  app.use('/api/v1', compileRouter({ cli, config }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
