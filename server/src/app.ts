import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type {
  CreateGameRequest,
  GameDetail,
  HumanActionRequest,
  ProviderId,
  ServerInfo,
} from '@gb/shared';
import { PROVIDERS, canSee } from '@gb/shared';
import { MOCK_STRATEGIES } from './agents/mock.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { ChatClient } from './llm/client.js';
import { GameManager, HttpError, type StreamMessage } from './games/manager.js';
import type { ModelCatalog } from './models.js';

export interface AppDeps {
  cfg: Config;
  db: Db;
  manager: GameManager;
  catalog: ModelCatalog;
  clients: Partial<Record<ProviderId, ChatClient>>;
  logger?: boolean | object;
}

const HEARTBEAT_MS = 15_000;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { cfg, db, manager, catalog } = deps;
  const app = Fastify({
    logger: deps.logger ?? {
      serializers: {
        // Player tokens ride in the query string for SSE; keep them out of the logs.
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.replace(/([?&]token=)[^&]+/, '$1[redacted]'),
        }),
      },
    },
    trustProxy: true,
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : ((err as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    const message = err instanceof Error ? err.message : String(err);
    void reply.status(status).send({ error: status >= 500 ? 'Internal server error' : message });
  });

  const requireAdmin = (req: FastifyRequest) => {
    if (!cfg.adminPassword) return;
    const given = String(req.headers['x-admin-key'] ?? '');
    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(cfg.adminPassword).digest();
    if (!timingSafeEqual(a, b)) throw new HttpError(401, 'Admin password required.');
  };

  const tokenOf = (req: FastifyRequest) => {
    const header = req.headers['x-player-token'];
    const query = (req.query as { token?: string }).token;
    return (typeof header === 'string' ? header : query) || undefined;
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/info', async (): Promise<ServerInfo> => ({
    providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, configured: Boolean(deps.clients[p.id]) })),
    requiresAdmin: Boolean(cfg.adminPassword),
    maxConcurrentGames: cfg.maxConcurrentGames,
    runningGames: manager.runningCount,
    mockStrategies: MOCK_STRATEGIES,
  }));

  app.post('/api/admin/check', async (req) => {
    requireAdmin(req);
    return { ok: true };
  });

  app.get('/api/models', async () => catalog.list());

  app.get('/api/games', async (req) => {
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const offset = Math.max(0, Number(q.offset) || 0);
    return db.listGames(limit, offset);
  });

  app.post('/api/games', async (req, reply) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as CreateGameRequest;
    const created = manager.createGame(body);
    return reply.status(201).send(created);
  });

  app.get('/api/games/:id', async (req): Promise<GameDetail> => {
    const { id } = req.params as { id: string };
    const game = db.getGame(id);
    if (!game) throw new HttpError(404, 'Game not found.');
    const viewer = manager.viewerFor(id, tokenOf(req));
    const events = db.events(id).filter((e) => canSee(e, viewer));
    return { ...game, events, viewer };
  });

  app.get('/api/games/:id/stream', (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { after?: string };
    const lastEventId = Number(req.headers['last-event-id']);
    const after = Number.isFinite(lastEventId) ? lastEventId : Number(q.after ?? -1);
    const viewer = manager.viewerFor(id, tokenOf(req));

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (msg: StreamMessage) => {
      if (msg.kind === 'event') {
        res.write(`id: ${msg.event.seq}\nevent: game\ndata: ${JSON.stringify(msg.event)}\n\n`);
      } else if (msg.kind === 'status') {
        res.write(`event: status\ndata: ${JSON.stringify(msg.status)}\n\n`);
      } else {
        res.write(`event: end\ndata: ${JSON.stringify({ status: msg.status })}\n\n`);
      }
    };

    let unsubscribe: (() => void) | null = null;
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };
    req.raw.on('close', cleanup);

    unsubscribe = manager.subscribe(id, Number.isFinite(after) ? after : -1, {
      viewer,
      send: (msg) => {
        write(msg);
        if (msg.kind === 'end') {
          cleanup();
          res.end();
        }
      },
    });
    if (!unsubscribe) {
      // Not running (finished, or from before a restart): send what's stored and close.
      const game = db.getGame(id);
      if (!game) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Game not found.' })}\n\n`);
      } else {
        for (const event of db.events(id)) {
          if (event.seq > after && canSee(event, viewer)) write({ kind: 'event', event });
        }
        write({ kind: 'end', status: game.status });
      }
      cleanup();
      res.end();
    }
  });

  app.post('/api/games/:id/action', async (req, reply) => {
    const { id } = req.params as { id: string };
    const token = tokenOf(req);
    if (!token) throw new HttpError(401, 'Missing player token.');
    const body = (req.body ?? {}) as Partial<HumanActionRequest>;
    if (typeof body.requestId !== 'string') throw new HttpError(400, 'requestId is required.');
    const result = manager.submitHumanAction(id, token, body.requestId, body.response);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    return { ok: true };
  });

  app.post('/api/games/:id/chat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const token = tokenOf(req);
    if (!token) throw new HttpError(401, 'Missing player token.');
    const body = (req.body ?? {}) as { text?: unknown; to?: unknown };
    const result = manager.postChat(id, token, body.text, body.to);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    return { ok: true };
  });

  app.post('/api/games/:id/chat/done', async (req, reply) => {
    const { id } = req.params as { id: string };
    const token = tokenOf(req);
    if (!token) throw new HttpError(401, 'Missing player token.');
    const result = manager.doneTalking(id, token);
    if (!result.ok) return reply.status(result.status).send({ error: result.error });
    return { ok: true };
  });

  app.post('/api/games/:id/abort', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    if (!manager.abort(id)) throw new HttpError(404, 'That game is not running.');
    return { ok: true };
  });

  app.delete('/api/games/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    if (manager.isRunning(id)) throw new HttpError(409, 'Stop the game before deleting it.');
    if (!db.deleteGame(id)) throw new HttpError(404, 'Game not found.');
    return { ok: true };
  });

  app.get('/api/leaderboard', async (req) => {
    const q = req.query as { includeUnranked?: string; includeHumans?: string };
    return db.leaderboard({
      includeUnranked: q.includeUnranked === '1' || q.includeUnranked === 'true',
      includeHumans: q.includeHumans !== '0' && q.includeHumans !== 'false',
    });
  });

  await serveWebApp(app, cfg.webDist);
  return app;
}

async function serveWebApp(app: FastifyInstance, webDist: string): Promise<void> {
  const index = path.join(webDist, 'index.html');
  if (!fs.existsSync(index)) {
    app.log.warn(`No web build at ${webDist}; serving the API only (use the Vite dev server for the UI).`);
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found' }));
    return;
  }
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    setHeaders: (reply, filePath) => {
      reply.header(
        'Cache-Control',
        filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  // Client-side routes fall back to index.html; unknown API routes stay 404.
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/assets/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}
