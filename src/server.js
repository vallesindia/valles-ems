import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { makePool, initSchema } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const pool = makePool();
await initSchema(pool);

const app = createApp({ pool, frontendDir: path.join(__dirname, '..', 'frontend') });

const server = app.listen(PORT, () => {
  console.log(`[valles-ems] listening on :${PORT} (env=${process.env.NODE_ENV || 'dev'})`);
});

function shutdown(signal) {
  console.log(`[valles-ems] ${signal} received, closing...`);
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
