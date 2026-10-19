import type { ProviderId } from '@gb/shared';
import { buildApp } from './app.js';
import { startAutoplay } from './autoplay.js';
import { config } from './config.js';
import { Db } from './db.js';
import { GameManager } from './games/manager.js';
import { ChatClient } from './llm/client.js';
import { ModelCatalog } from './models.js';

const db = new Db(config.databasePath);

// Fastify's logger isn't available until the app exists; the manager and
// catalog log through it once it is.
const logProxy = {
  info: (obj: unknown, msg?: string) => app.log.info(obj, msg),
  warn: (obj: unknown, msg?: string) => app.log.warn(obj, msg),
  error: (obj: unknown, msg?: string) => app.log.error(obj, msg),
};

const common = { timeoutMs: config.llmTimeoutMs, maxRetries: config.llmMaxRetries };
const pricing = (ref: string) => catalog.pricing(ref);
const clients: Partial<Record<ProviderId, ChatClient>> = {};
if (config.openRouterApiKey) {
  clients.openrouter = new ChatClient({
    provider: 'openrouter',
    baseUrl: config.openRouterBaseUrl,
    apiKey: config.openRouterApiKey,
    // Optional attribution headers recognised by OpenRouter.
    extraHeaders: { 'HTTP-Referer': config.publicUrl, 'X-Title': 'Golden Balls AI' },
    ...common,
  });
}
if (config.hfToken) {
  clients.huggingface = new ChatClient({
    provider: 'huggingface',
    baseUrl: config.hfBaseUrl,
    apiKey: config.hfToken,
    pricing,
    ...common,
  });
}
if (config.ollamaBaseUrl) {
  clients.ollama = new ChatClient({
    provider: 'ollama',
    baseUrl: `${config.ollamaBaseUrl.replace(/\/+$/, '')}/v1`,
    ...common,
    // Local models can be slow, and there's nothing to rate-limit us.
    timeoutMs: Math.max(config.llmTimeoutMs, 300_000),
  });
}

const catalog = new ModelCatalog(clients, config.featuredModels, logProxy);
const manager = new GameManager(db, config, clients, catalog, logProxy);
const app = await buildApp({ cfg: config, db, manager, catalog, clients });

const abandoned = db.abandonRunningGames();
if (abandoned) app.log.warn(`Marked ${abandoned} unfinished game(s) from a previous run as abandoned.`);
if (!clients.openrouter && !clients.huggingface) {
  app.log.warn('No OPENROUTER_API_KEY or HF_TOKEN: only Ollama (if running) and mock players are available.');
}
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
