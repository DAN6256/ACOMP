import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createArduinoCli } from './services/arduinoCli.js';

const config = loadConfig();
const cli = createArduinoCli(config);
const app = createApp({ cli, config });

const server = app.listen(config.port, () => {
  console.log(`ACOMP compile server listening on http://localhost:${config.port}`);
  console.log(`API docs: http://localhost:${config.port}/docs`);
});

cli.version().then(
  (v) => console.log(`arduino-cli ${v}`),
  () => console.warn(`WARNING: arduino-cli not found at "${config.arduinoCliPath}". /api/v1/compile will return 503.`),
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
