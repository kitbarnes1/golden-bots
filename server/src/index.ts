import { buildApp } from './app.js';
import { startAutoplay } from './autoplay.js';
import { config } from './config.js';
import { Db } from './db.js';
import { GameManager } from './games/manager.js';
import { OpenRouterClient } from './llm/openrouter.js';
import { ModelCatalog } from './models.js';

const db = new Db(config.databasePath);

const client = config.openRouterApiKey
  ? new OpenRouterClient({
      apiKey: config.openRouterApiKey,
      baseUrl: config.openRouterBaseUrl,
      appUrl: config.publicUrl,
      appName: 'Golden Balls AI',
      timeoutMs: config.llmTimeoutMs,
      maxRetries: config.llmMaxRetries,
    })
  : null;

// Fastify's logger isn't available until the app exists; the manager and
// catalog log through it once it is.
const logProxy = {
  info: (obj: unknown, msg?: string) => app.log.info(obj, msg),
  warn: (obj: unknown, msg?: string) => app.log.warn(obj, msg),
  error: (obj: unknown, msg?: string) => app.log.error(obj, msg),
};

const catalog = new ModelCatalog(client, config.featuredModels, logProxy);
const manager = new GameManager(db, config, client, catalog, logProxy);
const app = await buildApp({ cfg: config, db, manager, catalog, hasOpenRouterKey: Boolean(client) });

const abandoned = db.abandonRunningGames();
if (abandoned) app.log.warn(`Marked ${abandoned} unfinished game(s) from a previous run as abandoned.`);
if (!client) app.log.warn('OPENROUTER_API_KEY is not set: only mock players are available.');
if (!config.adminPassword) app.log.warn('ADMIN_PASSWORD is not set: anyone can start games.');

const stopAutoplay = startAutoplay(config, manager, catalog, logProxy);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  stopAutoplay();
  await manager.shutdown();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
