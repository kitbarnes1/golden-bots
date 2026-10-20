import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { CreateGameRequest, GameDetail, HumanActionRequest, ServerInfo } from '@gb/shared';
import { canSee } from '@gb/shared';
import { MOCK_STRATEGIES } from './agents/mock.js';
import { AdminAuth } from './auth.js';
import { clientIp, RequestLimiter, type LimitOptions } from './limits.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { GameManager, HttpError, type StreamMessage } from './games/manager.js';
import type { ModelCatalog } from './models.js';

export interface AppDeps {
  cfg: Config;
  db: Db;
  manager: GameManager;
  catalog: ModelCatalog;
  hasOpenRouterKey: boolean;
  logger?: boolean | object;
  /** Request and stream caps (tests use small ones). */
  limits?: LimitOptions;
}

/**
 * Browser-side defences. The page loads only its own script (no inline code),
 * so script-src can be strict; styles allow inline for React's style attributes,
 * plus Google Fonts.
 */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

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

  // Behind Cloudflare, send plain-http visitors to https so the login never travels
  // unencrypted, and tell browsers to stick to https from then on.
  const httpsBase = cfg.publicUrl.startsWith('https://') ? cfg.publicUrl.replace(/\/+$/, '') : null;
  app.addHook('onRequest', async (req, reply) => {
    if (httpsBase && /"scheme":"http"/.test(String(req.headers['cf-visitor'] ?? ''))) {
      return reply.redirect(`${httpsBase}${req.url}`, 301);
    }
  });
  app.addHook('onSend', async (req, reply) => {
    if (/"scheme":"https"/.test(String(req.headers['cf-visitor'] ?? ''))) {
      void reply.header('strict-transport-security', 'max-age=31536000');
    }
    void reply.headers(SECURITY_HEADERS);
  });

  // One busy or hostile client shouldn't be able to swamp a small server.
  const limiter = new RequestLimiter(deps.limits);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !limiter.allow(clientIp(req))) {
      return reply.status(429).header('retry-after', '60').send({ error: 'Too many requests. Try again in a minute.' });
    }
  });

  const auth = new AdminAuth(cfg.adminPassword);
  const requireAdmin = (req: FastifyRequest) => {
    if (!auth.isLoggedIn(req)) throw new HttpError(401, 'Log in to do that.');
  };

  const tokenOf = (req: FastifyRequest) => {
    const header = req.headers['x-player-token'];
    const query = (req.query as { token?: string }).token;
    return (typeof header === 'string' ? header : query) || undefined;
  };

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/info', async (): Promise<ServerInfo> => ({
    hasOpenRouterKey: deps.hasOpenRouterKey,
    requiresAdmin: Boolean(cfg.adminPassword),
    maxConcurrentGames: cfg.maxConcurrentGames,
    runningGames: manager.runningCount,
    mockStrategies: MOCK_STRATEGIES,
  }));

  app.get('/api/session', async (req) => {
    const loggedIn = auth.isLoggedIn(req);
    // Someone who can start games is here: get the free models checked before they ask.
    if (loggedIn && auth.required) void catalog.checkFree();
    return { required: auth.required, loggedIn };
  });

  app.post('/api/login', async (req, reply) => {
    const result = auth.login(req, (req.body as { password?: unknown } | undefined)?.password);
    if (result.ok) {
      void catalog.checkFree();
      return reply.header('set-cookie', result.cookie).send({ ok: true });
    }
    // Slow down guessing scripts a little more.
    await new Promise((r) => setTimeout(r, 400));
    if (result.retryAfterSec) void reply.header('retry-after', String(result.retryAfterSec));
    return reply.status(result.status).send({ error: result.error });
  });

  app.post('/api/logout', async (req, reply) => reply.header('set-cookie', auth.logoutCookie(req)).send({ ok: true }));

  app.get('/api/models', async () => catalog.list());

  // Admin only: checking models spends requests from the daily free-model allowance.
  app.get('/api/models/free', async (req) => {
    requireAdmin(req);
    return catalog.workingFree();
  });

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
    const release = limiter.openStream(clientIp(req));
    if (!release) {
      return reply.status(429).header('retry-after', '60').send({ error: 'Too many live streams open. Close some tabs and try again.' });
    }

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
      release();
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
      // Humans are left out unless asked for: the leaderboard is about the models.
      includeHumans: q.includeHumans === '1' || q.includeHumans === 'true',
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
