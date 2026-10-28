import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ActionRequest,
  CreateGameResponse,
  GameDetail,
  GameEvent,
  LeaderboardResponse,
  ServerInfo,
} from '@gb/shared';
import { OpenRouterKey } from '../src/apiKey.js';
import { buildApp } from '../src/app.js';
import { config, type Config } from '../src/config.js';
import { Db } from '../src/db.js';
import { GameManager } from '../src/games/manager.js';
import { ModelCatalog } from '../src/models.js';
import type { LimitOptions } from '../src/limits.js';
import { SecretBox } from '../src/secretBox.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const mocks = ['mock/honest', 'mock/bluffer', 'mock/chaos', 'mock/honest'];

let app: FastifyInstance;
let db: Db;
let manager: GameManager;

/** Tests poll fast from one address, so they get room the real limits wouldn't give. */
const ROOMY: LimitOptions = { perMinute: 1_000_000, streamsPerVisitor: 1000, streamsTotal: 1000 };

async function setup(overrides: Partial<Config> = {}, limits: LimitOptions = ROOMY) {
  const cfg: Config = { ...config, mockDelayMs: 0, voteRevealMs: 0, adminPassword: '', openRouterApiKey: '', webDist: '/nonexistent', ...overrides };
  db = new Db(':memory:');
  const openRouterKey = new OpenRouterKey(cfg, db, new SecretBox(path.join(os.tmpdir(), 'gb-api-test-unused.key')), quiet);
  const catalog = new ModelCatalog(() => null, cfg.featuredModels, quiet);
  manager = new GameManager(db, cfg, () => null, catalog, quiet);
  app = await buildApp({ cfg, db, manager, catalog, openRouterKey, logger: false, limits });
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function getGame(id: string, token?: string): Promise<GameDetail> {
  const res = await app.inject({ url: `/api/games/${id}`, headers: token ? { 'x-player-token': token } : {} });
  return res.json();
}

describe('API', () => {
  beforeEach(async () => setup());
  afterEach(async () => {
    await manager.shutdown();
    await app.close();
    db.close();
  });

  it('reports server info', async () => {
    const info: ServerInfo = (await app.inject('/api/info')).json();
    expect(info.hasOpenRouterKey).toBe(false);
    expect(info.mockStrategies.map((m) => m.id)).toContain('mock/honest');
  });

  it('plays a mock game end to end and records it (unranked)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { seats: mocks.map((model) => ({ kind: 'mock', model })) },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json<CreateGameResponse>();

    await waitFor(() => !manager.isRunning(id));
    const game = await getGame(id);
    expect(game.status).toBe('finished');
    expect(game.ranked).toBe(false);
    expect(game.viewer.omniscient).toBe(true);
    expect(game.events.at(-1)?.type).toBe('game_over');
    // AI-only games show everything, including private thoughts.
    expect(game.events.some((e) => e.type === 'thoughts')).toBe(true);
    expect(game.players.filter((p) => p.reachedFinal)).toHaveLength(2);

    const ranked: LeaderboardResponse = (await app.inject('/api/leaderboard')).json();
    expect(ranked.rows).toHaveLength(0);
    const all: LeaderboardResponse = (await app.inject('/api/leaderboard?includeUnranked=1')).json();
    expect(all.totalGames).toBe(1);
    expect(all.rows.reduce((s, r) => s + r.games, 0)).toBe(4);
    expect(all.history).toHaveLength(4);
    const honest = all.rows.find((r) => r.key === 'mock/honest')!;
    expect(honest.games).toBe(2);
    expect(honest.truthfulClaims).toBe(honest.claims);
    // Every contestant gave an exit interview, and the leaderboard counts what they said.
    expect(game.events.filter((e) => e.type === 'interview')).toHaveLength(4);
    expect(all.rows.reduce((s, r) => s + r.interviews, 0)).toBe(4);
    expect(all.rows.reduce((s, r) => s + r.sawItAsked, 0)).toBe(2);
    expect(all.rows.reduce((s, r) => s + r.planChecks, 0)).toBeGreaterThan(0);
    // Honest Abe tells the truth in interviews too, so it never "owns up" to a lie it didn't tell.
    expect(honest.ownedUp).toBe(0);
    // Everyone rated the three others, so 12 trust scores were given and 12 received, with the same total.
    const sum = (f: (r: LeaderboardResponse['rows'][number]) => number) => all.rows.reduce((s, r) => s + f(r), 0);
    expect(sum((r) => r.trustGivenScores)).toBe(12);
    expect(sum((r) => r.trustReceivedScores)).toBe(12);
    expect(sum((r) => r.trustReceivedTotal)).toBe(sum((r) => r.trustGivenTotal));
    expect(sum((r) => r.trustGivenTotal)).toBeGreaterThanOrEqual(12);
  });

  it('rejects bad lineups and AI seats without an API key', async () => {
    const three = await app.inject({ method: 'POST', url: '/api/games', payload: { seats: mocks.slice(0, 3).map((model) => ({ kind: 'mock', model })) } });
    expect(three.statusCode).toBe(400);
    const ai = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { seats: [{ kind: 'ai', model: 'openai/gpt-5' }, ...mocks.slice(1).map((model) => ({ kind: 'mock', model }))] },
    });
    expect(ai.statusCode).toBe(400);
    expect(ai.json().error).toMatch(/OPENROUTER_API_KEY/);
    const twoHumans = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { seats: [{ kind: 'human' }, { kind: 'human' }, { kind: 'mock', model: 'mock/chaos' }, { kind: 'mock', model: 'mock/chaos' }] },
    });
    expect(twoHumans.statusCode).toBe(400);
  });

  it('gives a human who leaves their name blank a proper name, not "You"', async () => {
    for (const name of [undefined, '   ', '!!!']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: {
          seats: [{ kind: 'human', ...(name === undefined ? {} : { name }) }, ...mocks.slice(1).map((model) => ({ kind: 'mock', model }))],
          options: { readAtMyPace: false },
        },
      });
      const { id, seat } = res.json<CreateGameResponse>();
      const game = await getGame(id);
      const me = game.players.find((p) => p.seat === seat)!;
      expect(me.name).toMatch(/^[A-Z][a-z]+$/); // a show-style first name
      expect(me.name).not.toBe('You');
      expect(game.players.filter((p) => p.name === me.name)).toHaveLength(1);
      manager.abort(id);
      await waitFor(() => !manager.isRunning(id));
    }
  });

  it('lets a human play, hiding everyone else’s secrets until the game ends', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: {
        seats: [{ kind: 'human', name: 'Kit' }, ...mocks.slice(1).map((model) => ({ kind: 'mock', model }))],
        options: { chatSeconds: 30, finalChatSeconds: 30 },
      },
    });
    const { id, playerToken, seat } = res.json<CreateGameResponse>();
    expect(playerToken).toBeTruthy();
    expect(seat).toBeTypeOf('number');

    const spectator = await getGame(id);
    expect(spectator.viewer).toEqual({ omniscient: false });
    expect(spectator.events.every((e) => e.vis === 'public')).toBe(true);

    let moves = 0;
    let reads = 0;
    const chatsJoined = new Set<number>();
    const headers = { 'x-player-token': playerToken! };
    while (manager.isRunning(id)) {
      const me = await getGame(id, playerToken);
      expect(me.viewer.seat).toBe(seat);
      // Reading at our own pace (on by default): the game waits until we click Continue.
      const hold = me.events.findLast((e) => e.type === 'paused' || e.type === 'resumed');
      if (hold?.type === 'paused' && hold.reason === 'reading') {
        if (reads === 0) {
          const stranger = await app.inject({ method: 'POST', url: `/api/games/${id}/continue`, headers: { 'x-player-token': 'nope' } });
          expect(stranger.statusCode).toBe(400);
        }
        const read = await app.inject({ method: 'POST', url: `/api/games/${id}/continue`, headers });
        expect(read.statusCode, read.body).toBe(200);
        reads++;
        continue;
      }
      // While still in, the human sees their own back row but nobody else's, and no thoughts.
      if (!me.events.some((e) => e.type === 'eliminated' && e.seat === seat)) {
        for (const e of me.events) {
          if (e.type === 'back_row') expect(e.seat).toBe(seat);
          expect(e.type).not.toBe('thoughts');
        }
      }
      // Join each open floor: ask an AI something directly, then say we're done.
      const opened = me.events.findLast((e) => e.type === 'chat_started' || e.type === 'chat_ended');
      if (opened?.type === 'chat_started' && opened.participants.includes(seat!) && !chatsJoined.has(opened.seq)) {
        chatsJoined.add(opened.seq);
        const ai = opened.participants.find((s) => s !== seat)!;
        const said = await app.inject({ method: 'POST', url: `/api/games/${id}/chat`, headers, payload: { text: 'What is really on your back row?', to: ai } });
        expect(said.statusCode, said.body).toBe(200);
        const done = await app.inject({ method: 'POST', url: `/api/games/${id}/chat/done`, headers });
        expect(done.statusCode, done.body).toBe(200);
        continue;
      }
      const answered = new Set(me.events.filter((e) => e.type === 'input_received').map((e) => (e as { requestId: string }).requestId));
      const pending = me.events.filter(
        (e): e is Extract<GameEvent, { type: 'awaiting_input' }> => e.type === 'awaiting_input' && !answered.has(e.requestId),
      );
      const next = pending.at(-1);
      if (!next) {
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      const response = answer(next.request, me, seat!);
      const act = await app.inject({
        method: 'POST',
        url: `/api/games/${id}/action`,
        headers: { 'x-player-token': playerToken! },
        payload: { requestId: next.requestId, response },
      });
      expect(act.statusCode, act.body).toBe(200);
      moves++;
    }
    expect(moves).toBeGreaterThanOrEqual(2); // at least a claim and a vote
    expect(reads).toBeGreaterThanOrEqual(3); // at least the other three claims
    // Nothing to read once it's over.
    expect((await app.inject({ method: 'POST', url: `/api/games/${id}/continue`, headers })).statusCode).toBe(409);
    expect(chatsJoined.size).toBeGreaterThanOrEqual(1);

    const after = await getGame(id);
    expect(after.status).toBe('finished');
    expect(after.ranked).toBe(false); // mocks were playing
    expect(after.viewer.omniscient).toBe(true);
    expect(after.events.some((e) => e.type === 'thoughts')).toBe(true);
    expect(after.players.find((p) => p.seat === seat)!.name).toBe('Kit');
    // Whoever the human spoke to answered promptly (a message already in flight may land first).
    const speeches = after.events.filter((e): e is Extract<GameEvent, { type: 'speech' }> => e.type === 'speech');
    const asked = speeches.filter((s) => s.seat === seat && s.to !== undefined);
    expect(asked.length).toBe(chatsJoined.size);
    for (const q of asked) {
      const closed = after.events.find((e) => e.seq > q.seq && e.type === 'chat_ended')!;
      const replies = speeches.filter((s) => s.seq > q.seq && s.seq < closed.seq && s.seat !== seat);
      if (replies.length > 0) expect(replies.slice(0, 2).map((s) => s.seat)).toContain(q.to);
    }
    // The leaderboard leaves humans out unless asked for.
    const board = async (q: string) => (await app.inject(`/api/leaderboard?includeUnranked=1${q}`)).json<LeaderboardResponse>();
    expect((await board('')).rows.some((r) => r.kind === 'human')).toBe(false);
    expect((await board('&includeHumans=1')).rows.some((r) => r.kind === 'human')).toBe(true);
    // Chat is rejected once the game is over.
    const late = await app.inject({ method: 'POST', url: `/api/games/${id}/chat`, headers: { 'x-player-token': playerToken! }, payload: { text: 'hi' } });
    expect(late.statusCode).toBe(409);
  });

  it('shows everything to everyone once the human player is knocked out', async () => {
    // Slow the mocks a little, or the game is over before we can look at it with the human out.
    await manager.shutdown();
    await app.close();
    db.close();
    await setup({ mockDelayMs: 30 });
    // Mocks are deterministic per seed; claiming two Killers soon gets the human voted off.
    let checked = false;
    for (let seed = 1; seed <= 10 && !checked; seed++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: {
          seats: [{ kind: 'human', name: 'Kit' }, ...mocks.slice(1).map((model) => ({ kind: 'mock', model }))],
          options: { chatSeconds: 0, finalChatSeconds: 0, readAtMyPace: false, seed },
        },
      });
      const { id, playerToken, seat } = res.json<CreateGameResponse>();
      while (manager.isRunning(id)) {
        const me = await getGame(id, playerToken);
        if (me.events.some((e) => e.type === 'eliminated' && e.seat === seat)) {
          if (!manager.isRunning(id)) break;
          expect(me.viewer).toEqual({ seat, omniscient: true });
          expect(me.events.some((e) => e.type === 'thoughts')).toBe(true);
          expect(me.events.some((e) => e.type === 'back_row' && e.seat !== seat)).toBe(true);
          expect((await getGame(id)).viewer).toEqual({ omniscient: true });
          checked = true;
          break;
        }
        const answered = new Set(me.events.filter((e) => e.type === 'input_received').map((e) => (e as { requestId: string }).requestId));
        const next = me.events.findLast(
          (e): e is Extract<GameEvent, { type: 'awaiting_input' }> => e.type === 'awaiting_input' && !answered.has(e.requestId),
        );
        if (!next) {
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        const response =
          next.request.kind === 'claim'
            ? { claim: Array.from({ length: next.request.backCount }, () => 'killer'), say: 'Killers, sorry.' }
            : answer(next.request, me, seat!);
        await app.inject({
          method: 'POST',
          url: `/api/games/${id}/action`,
          headers: { 'x-player-token': playerToken! },
          payload: { requestId: next.requestId, response },
        });
      }
      manager.abort(id);
      await waitFor(() => !manager.isRunning(id));
    }
    expect(checked).toBe(true);
  });

  it('validates human moves and rejects strangers', async () => {
    const { id, playerToken } = (
      await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: {
          seats: [{ kind: 'human', name: 'Kit' }, ...mocks.slice(1).map((model) => ({ kind: 'mock', model }))],
          options: { readAtMyPace: false },
        },
      })
    ).json<CreateGameResponse>();
    const detail = await waitForAwaiting(id, playerToken!);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/games/${id}/action`,
      headers: { 'x-player-token': playerToken! },
      payload: { requestId: detail.requestId, response: { claim: ['lots'], say: '' } },
    });
    expect(bad.statusCode).toBe(400);
    const stranger = await app.inject({
      method: 'POST',
      url: `/api/games/${id}/action`,
      headers: { 'x-player-token': 'nope' },
      payload: { requestId: detail.requestId, response: {} },
    });
    expect(stranger.statusCode).toBe(400);
    const stop = await app.inject({ method: 'POST', url: `/api/games/${id}/abort` });
    expect(stop.statusCode).toBe(200);
    await waitFor(() => !manager.isRunning(id));
    expect((await getGame(id)).status).toBe('abandoned');
  });

  it('streams a live game over SSE', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };
    await setupSlowMocks();
    const { id } = manager.createGame({ seats: mocks.map((model) => ({ kind: 'mock', model })) });
    const res = await fetch(`http://127.0.0.1:${address.port}/api/games/${id}/stream?after=-1`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text(); // stream ends when the game does
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(seqs.length).toBeGreaterThan(20);
    expect(seqs).toEqual(seqs.map((_, i) => i));
    expect(text).toContain('event: status');
    expect(text).toMatch(/event: end\ndata: \{"status":"finished"\}/);
  });

  it('sends browser security headers on every response', async () => {
    const res = await app.inject('/api/info');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect((await app.inject('/nope')).headers['x-frame-options']).toBe('DENY');
  });

  it('limits how fast one visitor can call the API, per Cloudflare visitor address', async () => {
    await manager.shutdown();
    await app.close();
    db.close();
    await setup({}, { perMinute: 3, streamsPerVisitor: 1, streamsTotal: 1 });
    const from = (ip: string) => ({ headers: { 'cf-connecting-ip': ip } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ url: '/api/info', ...from('6.6.6.6') })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    expect((await app.inject({ url: '/api/info', ...from('7.7.7.7') })).statusCode).toBe(200);
    // The health check (used by Docker) is never limited.
    expect((await app.inject({ url: '/healthz', ...from('6.6.6.6') })).statusCode).toBe(200);
  });

  it('sends plain-http visitors (via Cloudflare) to https, and asks browsers to stay there', async () => {
    await manager.shutdown();
    await app.close();
    db.close();
    await setup({ publicUrl: 'https://goldenballs.example.test' });
    const http = await app.inject({ url: '/leaderboard?x=1', headers: { 'cf-visitor': '{"scheme":"http"}' } });
    expect(http.statusCode).toBe(301);
    expect(http.headers.location).toBe('https://goldenballs.example.test/leaderboard?x=1');
    const https = await app.inject({ url: '/healthz', headers: { 'cf-visitor': '{"scheme":"https"}' } });
    expect(https.statusCode).toBe(200);
    expect(https.headers['strict-transport-security']).toBe('max-age=31536000');
    // Straight to the app (local development): no redirect.
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('needs a login to start games when a password is set; watching stays public', async () => {
    await manager.shutdown();
    await app.close();
    db.close();
    await setup({ adminPassword: 'hunter2' });
    const payload = { seats: mocks.map((model) => ({ kind: 'mock', model })) };
    expect((await app.inject({ method: 'POST', url: '/api/games', payload })).statusCode).toBe(401);
    expect((await app.inject('/api/session')).json()).toEqual({ required: true, loggedIn: false });
    // The old password header no longer works.
    expect((await app.inject({ method: 'POST', url: '/api/games', payload, headers: { 'x-admin-key': 'hunter2' } })).statusCode).toBe(401);

    const wrong = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict');
    expect((await app.inject({ url: '/api/session', headers: { cookie } })).json()).toEqual({ required: true, loggedIn: true });
    expect((await app.inject({ method: 'POST', url: '/api/games', payload, headers: { cookie } })).statusCode).toBe(201);

    const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(String(logout.headers['set-cookie'])).toMatch(/^gb_session=; .*Max-Age=0/);

    // Viewing stays public.
    expect((await app.inject('/api/leaderboard')).statusCode).toBe(200);
    expect((await app.inject('/api/games')).statusCode).toBe(200);
  });

  it('limits concurrent games', async () => {
    await manager.shutdown();
    await app.close();
    db.close();
    await setup({ maxConcurrentGames: 1, mockDelayMs: 50 });
    const payload = { seats: mocks.map((model) => ({ kind: 'mock', model })) };
    expect((await app.inject({ method: 'POST', url: '/api/games', payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/games', payload })).statusCode).toBe(429);
  });
});

async function setupSlowMocks() {
  // A little delay so the stream has to deliver events live, not just from the backlog.
  (manager as unknown as { cfg: Config }).cfg.mockDelayMs = 1;
}

async function waitForAwaiting(id: string, token: string) {
  for (let i = 0; i < 500; i++) {
    const me = await getGame(id, token);
    const e = me.events.find((x): x is Extract<GameEvent, { type: 'awaiting_input' }> => x.type === 'awaiting_input');
    if (e) return e;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('never asked for input');
}

/** A simple, valid human move for each kind of request. */
function answer(request: ActionRequest, game: GameDetail, seat: number): unknown {
  switch (request.kind) {
    case 'claim':
      return { claim: Array.from({ length: request.backCount }, () => 1000), say: 'Trust me.' };
    case 'speak':
      return { say: 'I am a human, honest.' };
    case 'vote':
    case 'tie_decide':
      return { target: request.candidates[0] };
    case 'pick':
      return { index: request.available[0] };
    case 'final_choice':
      return { choice: 'split' };
  }
  void game;
  void seat;
}
