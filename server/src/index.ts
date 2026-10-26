import { OpenRouterKey } from './apiKey.js';
import { buildApp } from './app.js';
import { startAutoplay } from './autoplay.js';
import { config } from './config.js';
import { Db } from './db.js';
import { GameManager } from './games/manager.js';
import { ModelCatalog } from './models.js';
import { SecretBox } from './secretBox.js';

const db = new Db(config.databasePath);

// Fastify's logger isn't available until the app exists; the manager and
// catalog log through it once it is.
const logProxy = {
  info: (obj: unknown, msg?: string) => app.log.info(obj, msg),
  warn: (obj: unknown, msg?: string) => app.log.warn(obj, msg),
  error: (obj: unknown, msg?: string) => app.log.error(obj, msg),
};

const openRouterKey = new OpenRouterKey(config, db, new SecretBox(config.encryptionKeyPath), logProxy);
const openRouter = () => openRouterKey.client;
const catalog = new ModelCatalog(openRouter, config.featuredModels, logProxy);
const manager = new GameManager(db, config, openRouter, catalog, logProxy);
const app = await buildApp({ cfg: config, db, manager, catalog, openRouterKey });

const abandoned = db.abandonRunningGames();
if (abandoned) app.log.warn(`Marked ${abandoned} unfinished game(s) from a previous run as abandoned.`);
if (openRouterKey.unreadable) {
  app.log.warn(
    `The OpenRouter key saved on the Settings page can't be decrypted (${config.encryptionKeyPath} is missing or has changed). Add it again there.`,
  );
} else if (!openRouterKey.client) {
  app.log.warn('No OpenRouter API key: only mock players are available until one is added on the Settings page.');
}
if (!config.adminPassword) app.log.warn('ADMIN_PASSWORD is not set: anyone can start games and change the OpenRouter key.');

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
