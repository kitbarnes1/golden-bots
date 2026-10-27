import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ApiKeyStatus, CreateGameResponse, ModelOption, ServerInfo } from '@gb/shared';
import { OpenRouterKey } from '../src/apiKey.js';
import { buildApp } from '../src/app.js';
import { config, type Config } from '../src/config.js';
import { Db } from '../src/db.js';
import { GameManager } from '../src/games/manager.js';
import type { LimitOptions } from '../src/limits.js';
import { ModelCatalog } from '../src/models.js';
import { SecretBox } from '../src/secretBox.js';

// Throwaway keys, made up for each run.
const newKey = () => `sk-or-v1-${randomBytes(32).toString('hex')}`;
const GOOD = newKey();
const OTHER = newKey();
const ENV = newKey();
const BAD = newKey();
const NOT_OPENROUTER = `sk-ant-api03-${randomBytes(32).toString('hex')}`;
const KEYS = [GOOD, OTHER, ENV, BAD, NOT_OPENROUTER];
const ACCEPTED = new Set([GOOD, OTHER, ENV]);

const MODELS = [
  { id: 'test/model', name: 'Test: Model', created: 1, context_length: 100_000, pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'test/free:free', name: 'Test: Free', created: 1, context_length: 100_000, pricing: { prompt: '0', completion: '0' } },
];
const mocks = ['mock/honest', 'mock/bluffer', 'mock/chaos'].map((model) => ({ kind: 'mock', model }));
const ROOMY: LimitOptions = { perMinute: 1_000_000, streamsPerVisitor: 1000, streamsTotal: 1000 };

/** Requests the stand-in OpenRouter got, and the key each carried. */
let seen: { route: string; key: string }[] = [];
/** Make the key-info endpoint fail like this. */
let keyEndpointFails: number | null = null;
/** While set, model calls wait for it. */
let gate: Promise<void> | null = null;

// A stand-in for OpenRouter that knows three keys and answers every move with "{}" (a fumble).
let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      const route = (req.url ?? '').replace(/^\/api\/v1/, '');
      const key = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      seen.push({ route, key });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (route === '/key') {
        if (keyEndpointFails) return send(keyEndpointFails, { error: { message: 'Service unavailable' } });
        return ACCEPTED.has(key)
          ? send(200, { data: { label: 'test', limit: null, usage: 0 } })
          : send(401, { error: { message: 'User not found.', code: 401 } });
      }
      if (route === '/models') return send(200, { data: MODELS });
      if (route === '/chat/completions') {
        if (gate) await gate;
        return send(200, { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } });
      }
      send(404, { error: { message: 'Not found' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Everything the server said back or wrote to its logs, to check none of it gives a key away. */
let responses: string[] = [];
let logged: string[] = [];
const record = (...args: unknown[]) => logged.push(args.map((a) => (a instanceof Error ? a.stack : JSON.stringify(a))).join(' '));
const log = { info: record, warn: record, error: record };

let dir: string;
let cfg: Config;
let db: Db;
let openRouterKey: OpenRouterKey;
let manager: GameManager;
let app: FastifyInstance | null = null;

/** Start the server on this test's data directory (again, to test a restart). */
async function start(overrides: Partial<Config> = {}) {
  cfg = {
    ...config,
    mockDelayMs: 0,
    voteRevealMs: 0,
    adminPassword: '',
    openRouterApiKey: '',
    openRouterBaseUrl: base,
    llmMaxRetries: 0,
    webDist: '/nonexistent',
    databasePath: path.join(dir, 'golden-balls.db'),
    encryptionKeyPath: path.join(dir, 'encryption.key'),
    ...overrides,
  };
  db = new Db(cfg.databasePath);
  openRouterKey = new OpenRouterKey(cfg, db, new SecretBox(cfg.encryptionKeyPath), log);
  const catalog = new ModelCatalog(() => openRouterKey.client, [], log);
  manager = new GameManager(db, cfg, () => openRouterKey.client, catalog, log);
  app = await buildApp({
    cfg,
    db,
    manager,
    catalog,
    openRouterKey,
    limits: ROOMY,
    logger: { level: 'trace', stream: { write: (line: string) => logged.push(line) } },
  });
}

async function stop() {
  if (!app) return;
  await manager.shutdown();
  await app.close();
  db.close();
  app = null;
}

async function call(opts: InjectOptions | string) {
  const res = await app!.inject(opts);
  responses.push(JSON.stringify(res.headers), res.body);
  return res;
}
const url = '/api/settings/openrouter-key';
const status = async (headers = {}) => (await call({ url, headers })).json<ApiKeyStatus>();
const save = (key: unknown, headers = {}) => call({ method: 'PUT', url, payload: { key }, headers });
const remove = (headers = {}) => call({ method: 'DELETE', url, headers });
const hasKey = async () => (await call('/api/info')).json<ServerInfo>().hasOpenRouterKey;
const keyChecks = () => seen.filter((s) => s.route === '/key').length;
const NONE: ApiKeyStatus = { set: false, source: null, last4: null };

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-settings-'));
  seen = [];
  responses = [];
  logged = [];
  keyEndpointFails = null;
  gate = null;
});

afterEach(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
  // Whatever the test did, no key ever came back in a response or went into a log line.
  const out = [...responses, ...logged].join('\n');
  for (const key of KEYS) {
    expect(out).not.toContain(key);
    expect(out).not.toContain(key.slice(9, -4)); // the secret part, without the prefix or the last 4
  }
});

describe('OpenRouter key settings', () => {
  it('saves, replaces and deletes a key, taking effect without a restart', async () => {
    await start();
    expect(await status()).toEqual(NONE);
    expect(await hasKey()).toBe(false);
    expect((await call('/api/models')).json()).toEqual([]);

    // Stray whitespace from copying and pasting is fine.
    const saved = await save(`  ${GOOD}\n`);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) });
    expect(seen).toContainEqual({ route: '/key', key: GOOD });
    expect(await hasKey()).toBe(true);
    expect((await call('/api/models')).json<ModelOption[]>().map((m) => m.id)).toContain('test/model');
    expect(seen).toContainEqual({ route: '/models', key: GOOD });

    expect((await save(OTHER)).json()).toEqual({ set: true, source: 'app', last4: OTHER.slice(-4) });
    expect(await status()).toEqual({ set: true, source: 'app', last4: OTHER.slice(-4) });
    // The catalogue's free-model checks go out with the new key.
    seen = [];
    await call('/api/models/free');
    expect(seen.filter((s) => s.route === '/chat/completions').map((s) => s.key)).toEqual([OTHER]);

    expect((await remove()).json()).toEqual(NONE);
    expect(await status()).toEqual(NONE);
    expect(await hasKey()).toBe(false);
    expect((await call('/api/models')).json()).toEqual([]);
    const ai = await call({ method: 'POST', url: '/api/games', payload: { seats: [{ kind: 'ai', model: 'test/model' }, ...mocks] } });
    expect(ai.statusCode).toBe(400);
    expect(ai.json().error).toMatch(/Settings page/);
    expect(db.sql.prepare('SELECT * FROM settings').all()).toHaveLength(0);
    // The logs were really captured (so the check after each test means something).
    expect(logged.join('\n')).toMatch(/OpenRouter API key saved/);
  });

  it('keeps a saved key across restarts, encrypted, with the encryption key outside the database', async () => {
    await start();
    await save(GOOD);
    const rows = db.sql.prepare('SELECT value FROM settings').all() as { value: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toMatch(/^v1:/);
    // A database backup holds neither the key nor what it's encrypted with.
    const backup = path.join(dir, 'backup.db');
    db.backupTo(backup);
    const encryptionKey = fs.readFileSync(cfg.encryptionKeyPath, 'utf8').trim();
    expect(Buffer.from(encryptionKey, 'base64')).toHaveLength(32);
    const backupBytes = fs.readFileSync(backup).toString('latin1');
    expect(backupBytes).toContain(rows[0]!.value);
    expect(backupBytes).not.toContain(GOOD.slice(9, -4));
    expect(backupBytes).not.toContain(encryptionKey);

    await stop();
    await start();
    expect(await status()).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) });
    expect(await hasKey()).toBe(true);

    // Without its encryption key (the database restored on another machine, say), the saved key can't be read...
    await stop();
    fs.renameSync(cfg.encryptionKeyPath, path.join(dir, 'moved.key'));
    await start();
    expect(openRouterKey.unreadable).toBe(true);
    expect(await status()).toEqual(NONE);
    // ...until it's pasted in again.
    expect((await save(GOOD)).statusCode).toBe(200);
    expect(openRouterKey.unreadable).toBe(false);
    expect(await status()).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) });
  });

  it('lets running games finish on the key they started with, while new games use the new one', async () => {
    await start();
    await save(GOOD);
    const lineup = {
      seats: [{ kind: 'ai', model: 'test/model' }, ...mocks],
      options: { chatSeconds: 0, reflectSeconds: 0, finalChatSeconds: 0 },
    };
    const moves = () => seen.filter((s) => s.route === '/chat/completions');

    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const first = (await call({ method: 'POST', url: '/api/games', payload: lineup })).json<CreateGameResponse>();
    await waitFor(() => moves().length > 0);
    expect((await save(OTHER)).statusCode).toBe(200);
    gate = null;
    release();
    await waitFor(() => !manager.isRunning(first.id), 15_000);
    expect(moves().length).toBeGreaterThan(1);
    expect(new Set(moves().map((s) => s.key))).toEqual(new Set([GOOD]));

    seen = [];
    const second = (await call({ method: 'POST', url: '/api/games', payload: lineup })).json<CreateGameResponse>();
    await waitFor(() => moves().length > 0);
    expect(moves()[0]!.key).toBe(OTHER);
    manager.abort(second.id);
  });

  it('always uses OPENROUTER_API_KEY from the environment when it is set, and won’t change it', async () => {
    // A key saved on the Settings page, then the server restarted with the variable set.
    await start();
    await save(GOOD);
    await stop();
    await start({ openRouterApiKey: ENV });
    const fromEnv = { set: true, source: 'environment', last4: ENV.slice(-4) };
    expect(await status()).toEqual(fromEnv);
    await call('/api/models');
    expect(seen.filter((s) => s.route === '/models').at(-1)?.key).toBe(ENV);

    const checks = keyChecks();
    const replace = await save(OTHER);
    expect(replace.statusCode).toBe(409);
    expect(replace.json().error).toMatch(/OPENROUTER_API_KEY environment variable/);
    expect((await remove()).statusCode).toBe(409);
    expect(keyChecks()).toBe(checks); // the new key wasn't even sent off to check
    expect(await status()).toEqual(fromEnv);
    expect(db.sql.prepare('SELECT * FROM settings').all()).toHaveLength(1);

    // Without the variable, the saved key is back.
    await stop();
    await start();
    expect(await status()).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) });
  });

  it('rejects a key OpenRouter won’t accept, or one that isn’t an OpenRouter key, with a clear message', async () => {
    await start();
    const bad = await save(BAD);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/OpenRouter didn't accept that key/);
    expect(await status()).toEqual(NONE);
    expect(fs.existsSync(cfg.encryptionKeyPath)).toBe(false); // nothing was saved

    await save(GOOD);
    expect((await save(BAD)).statusCode).toBe(400);
    expect(await status()).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) }); // the working key stays

    const checks = keyChecks();
    const other = await save(NOT_OPENROUTER);
    expect(other.statusCode).toBe(400);
    expect(other.json().error).toMatch(/doesn't look like an OpenRouter API key/);
    expect((await save('')).json().error).toMatch(/Paste your OpenRouter API key/);
    expect((await save(42)).statusCode).toBe(400);
    expect(keyChecks()).toBe(checks); // none of those went to OpenRouter

    keyEndpointFails = 503;
    const down = await save(OTHER);
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toMatch(/couldn't check the key just now \(error 503\)/);
    expect(await status()).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) });
  });

  it('says so when OpenRouter can’t be reached to check a key', { timeout: 15_000 }, async () => {
    await start({ openRouterBaseUrl: 'http://127.0.0.1:1/api/v1' });
    const res = await save(GOOD);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Couldn't reach OpenRouter/);
    expect(await status()).toEqual(NONE);
  });

  it('doesn’t echo a key back from a malformed request', async () => {
    await start();
    const broken = await call({ method: 'PUT', url, headers: { 'content-type': 'application/json' }, payload: `{"key": "${GOOD}"` });
    expect(broken.statusCode).toBe(400);
    const plain = await call({ method: 'PUT', url, headers: { 'content-type': 'text/plain' }, payload: GOOD });
    expect(plain.statusCode).toBe(400);
    expect(await status()).toEqual(NONE);
  });

  it('only lets the admin see or change the key', async () => {
    await start({ adminPassword: 'hunter2' });
    expect((await call(url)).statusCode).toBe(401);
    expect((await save(GOOD)).statusCode).toBe(401);
    expect((await remove()).statusCode).toBe(401);
    expect(keyChecks()).toBe(0); // not even checked
    expect(await hasKey()).toBe(false);

    const login = await call({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await save(GOOD, { cookie })).json()).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) });
    expect(await status({ cookie })).toEqual({ set: true, source: 'app', last4: GOOD.slice(-4) });
    expect((await remove({ cookie })).json()).toEqual(NONE);
  });
});

describe('SecretBox', () => {
  it('opens only what it sealed, with its own key', () => {
    const box = new SecretBox(path.join(dir, 'box.key'));
    const sealed = box.seal('a secret');
    expect(sealed).not.toContain('a secret');
    expect(box.open(sealed)).toBe('a secret');
    expect(box.seal('a secret')).not.toBe(sealed); // a fresh IV every time

    const [version, iv, tag, data] = sealed.split(':');
    const tampered = Buffer.from(data!, 'base64');
    tampered.writeUInt8(tampered.readUInt8(0) ^ 1, 0);
    expect(box.open([version, iv, tag, tampered.toString('base64')].join(':'))).toBeNull();
    expect(new SecretBox(path.join(dir, 'other.key')).open(sealed)).toBeNull();
  });
});
