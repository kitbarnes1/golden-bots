import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmError, OpenRouterClient, parseModel, splitReasoning } from '../src/llm/openrouter.js';
import { checkModel, type ModelCheck } from '../src/agents/check.js';
import { canPlay, ModelCatalog, pickFeatured } from '../src/models.js';

type Handler = (req: { url: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }) => {
  status?: number;
  headers?: Record<string, string>;
  json: unknown;
};

let server: http.Server;
let base = '';
let handler: Handler = () => ({ json: {} });
let requests = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests++;
      const out = handler({ url: req.url ?? '', body: raw ? JSON.parse(raw) : {}, headers: req.headers });
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...out.headers });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const reply = (content: string, extra: Record<string, unknown> = {}) => ({
  json: {
    choices: [{ message: { role: 'assistant', content, ...extra } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.002 },
  },
});

function client(extra: Partial<ConstructorParameters<typeof OpenRouterClient>[0]> = {}) {
  return new OpenRouterClient({ apiKey: 'k', baseUrl: base, appUrl: 'https://x', appName: 'GB', timeoutMs: 5000, maxRetries: 2, ...extra });
}

describe('OpenRouterClient', () => {
  it('sends the key, usage accounting and reasoning effort, and reports cost', async () => {
    let seen: { body: Record<string, unknown>; auth?: string } | undefined;
    handler = ({ body, headers }) => {
      seen = { body, auth: headers.authorization };
      return reply('{"say":"hi"}', { reasoning: 'because' });
    };
    const res = await client().chat({ model: 'a/b', messages: [], reasoningEffort: 'low' });
    expect(seen?.auth).toBe('Bearer k');
    expect(seen?.body).toMatchObject({ model: 'a/b', usage: { include: true }, reasoning: { effort: 'low' } });
    expect(res).toMatchObject({ content: '{"say":"hi"}', reasoning: 'because', usage: { costUsd: 0.002, promptTokens: 1000 } });
  });

  it('turns native reasoning off, or down to minimal for models that insist on it', async () => {
    const bodies: Record<string, unknown>[] = [];
    handler = ({ body }) => {
      bodies.push(body);
      const off = (body.reasoning as { enabled?: boolean } | undefined)?.enabled === false;
      return body.model === 'must/think' && off
        ? { status: 400, json: { error: { code: 400, message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } } }
        : reply('{"say":"hi"}');
    };
    const c = client();
    await c.chat({ model: 'can/stop', messages: [], reasoningEffort: 'none' });
    await c.chat({ model: 'must/think', messages: [], reasoningEffort: 'none' });
    await c.chat({ model: 'must/think', messages: [], reasoningEffort: 'none' });
    expect(bodies.map((b) => b.reasoning)).toEqual([
      { enabled: false },
      { enabled: false },
      { effort: 'minimal' },
      { effort: 'minimal' }, // remembered: no second 400
    ]);
  });

  it('drops a model from the catalogue once OpenRouter refuses to serve it', async () => {
    const entry = (id: string) => ({ id, name: id, created: 1, context_length: 100_000, pricing: { prompt: '0', completion: '0' } });
    handler = ({ url }) =>
      url.endsWith('/models')
        ? { json: { data: [entry('ok/model:free'), entry('agents-only/model:free')] } }
        : { status: 403, json: { error: { message: 'only available on agentic harnesses' } } };
    const c = client();
    const catalog = new ModelCatalog(c, [], { warn: () => {} });
    expect((await catalog.list()).map((m) => m.id)).toEqual(['agents-only/model:free', 'ok/model:free']);
    await c.chat({ model: 'agents-only/model:free', messages: [] }).catch(() => {});
    expect((await catalog.list()).map((m) => m.id)).toEqual(['ok/model:free']);
  });

  it('checks a model by asking it a small game question', async () => {
    const answers: Record<string, () => ReturnType<Handler>> = {
      'good/model': () => reply('{"thoughts":"bluff","claimed_back_row":[5000,"KILLER"],"say":"Five grand and a Killer."}'),
      'chatty/model': () => reply('Sure! I would say I have five thousand pounds.'),
      'refused/model': () => ({ status: 403, json: { error: { message: 'only available on agentic harnesses' } } }),
    };
    handler = ({ body }) => answers[body.model as string]!();
    const c = client({ maxRetries: 0 });
    expect(await checkModel(c, 'good/model')).toEqual({ ok: true });
    expect(await checkModel(c, 'chatty/model')).toMatchObject({ ok: false, reason: 'reply was not JSON' });
    expect(await checkModel(c, 'refused/model')).toMatchObject({ ok: false, transient: false });
  });

  it('offers only free models that pass their check, and caches the results', async () => {
    const entry = (id: string) => ({ id, name: id, created: 1, context_length: 100_000, pricing: { prompt: '0', completion: '0' } });
    handler = () => ({ json: { data: ['good:free', 'broken:free', 'busy:free'].map(entry) } });
    const checked: string[] = [];
    const check = async (_c: OpenRouterClient, id: string): Promise<ModelCheck> => {
      checked.push(id);
      if (id === 'good:free') return { ok: true };
      return id === 'busy:free' ? { ok: false, transient: true } : { ok: false };
    };
    const catalog = new ModelCatalog(client(), [], { warn: () => {} }, check);
    expect((await catalog.workingFree()).map((m) => m.id)).toEqual(['good:free']);
    // A hard failure leaves the picker; a busy model stays, to be checked again later.
    expect((await catalog.list()).map((m) => m.id)).toEqual(['busy:free', 'good:free']);
    await catalog.workingFree();
    expect(checked.sort()).toEqual(['broken:free', 'busy:free', 'good:free']);
  });

  it("doesn't wait for a slow model to finish its check", async () => {
    const entry = (id: string) => ({ id, name: id, created: 1, context_length: 100_000, pricing: { prompt: '0', completion: '0' } });
    handler = () => ({ json: { data: ['quick:free', 'slow:free'].map(entry) } });
    const check = async (_c: OpenRouterClient, id: string): Promise<ModelCheck> => {
      if (id === 'slow:free') await new Promise((r) => setTimeout(r, 2000));
      return { ok: true };
    };
    const catalog = new ModelCatalog(client(), [], { warn: () => {} }, check);
    const started = Date.now();
    expect((await catalog.workingFree(150)).map((m) => m.id)).toEqual(['quick:free']);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('pulls reasoning out of <think> tags too', () => {
    expect(splitReasoning({ content: '<think>plan {a}</think>\n{"say":"x"}' })).toEqual({ content: '{"say":"x"}', reasoning: 'plan {a}' });
    expect(splitReasoning({ content: '{}', reasoning_content: 'why' })).toEqual({ content: '{}', reasoning: 'why' });
  });

  it('treats bad keys, no credits, unknown models and the daily free limit as fatal', async () => {
    const cases: [number, string, RegExp][] = [
      [401, 'No auth credentials found', /rejected the API key/],
      [403, 'x/y is only available on agentic harnesses', /refused "x\/y"/],
      [402, 'Insufficient credits', /out of credits/],
      [404, 'No endpoints found for x/y', /doesn't have the model/],
      [429, 'Rate limit exceeded: free-models-per-day', /daily free-model limit/],
    ];
    for (const [status, message, expected] of cases) {
      requests = 0;
      handler = () => ({ status, json: { error: { message } } });
      const err = await client().chat({ model: 'x/y', messages: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).fatal).toBe(true);
      expect((err as LlmError).message).toMatch(expected);
      expect(requests).toBe(1); // no pointless retries
    }
  });

  it("retries a provider's hiccup, and doesn't stop the game if it keeps happening", async () => {
    let n = 0;
    handler = () => (++n < 2 ? { status: 400, json: { error: { message: 'Provider returned error' } } } : reply('{"ok":1}'));
    expect((await client().chat({ model: 'a/b', messages: [] })).content).toBe('{"ok":1}');

    handler = () => ({ status: 400, json: { error: { message: 'Provider returned error' } } });
    const err = (await client({ maxRetries: 1 }).chat({ model: 'a/b', messages: [] }).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.fatal).toBe(false);
  });

  it('retries ordinary rate limits and server errors', async () => {
    let n = 0;
    handler = () =>
      ++n < 3
        ? { status: n === 1 ? 429 : 503, headers: { 'retry-after': '0' }, json: { error: { message: 'slow down' } } }
        : reply('{"ok":1}');
    const res = await client().chat({ model: 'a/b', messages: [] });
    expect(res.content).toBe('{"ok":1}');
    expect(n).toBe(3);
  });

  it('gives up with a fatal error if OpenRouter stays unreachable', async () => {
    // Grab a free port, then close it so nothing is listening there.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const dead = client({ baseUrl: `http://127.0.0.1:${port}/api/v1`, maxRetries: 1 });
    const err = (await dead.chat({ model: 'a/b', messages: [] }).catch((e: unknown) => e)) as LlmError;
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/Couldn't reach OpenRouter/);
  });

  it('parses the model list', async () => {
    handler = () => ({
      json: {
        data: [
          { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B (free)', created: 1, pricing: { prompt: '0', completion: '0' } },
          {
            id: 'openai/gpt-5',
            name: 'OpenAI: GPT-5',
            created: 2,
            context_length: 400000,
            pricing: { prompt: '0.00000125', completion: '0.00001' },
            supported_parameters: ['reasoning'],
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          },
        ],
      },
    });
    const [free, gpt] = await client().listModels();
    expect(free).toMatchObject({ id: 'meta-llama/llama-3.3-70b-instruct:free', free: true });
    expect(gpt).toMatchObject({ name: 'GPT-5', promptPrice: 1.25, completionPrice: 10, supportsReasoning: true, free: false, textChat: true, created: 2 });
  });
});

describe('pickFeatured', () => {
  const model = (id: string, created: number, prompt: number, completion: number, extra: object = {}) =>
    parseModel({
      id,
      created,
      context_length: 200_000,
      pricing: { prompt: String(prompt / 1e6), completion: String(completion / 1e6) },
      ...extra,
    });
  const catalogue = [
    model('anthropic/claude-old', 1, 3, 15),
    model('anthropic/claude-new', 5, 3, 15),
    model('anthropic/claude-huge', 9, 15, 75), // too pricey to suggest
    model('openai/gpt-new', 7, 1.25, 10),
    model('openai/gpt-image', 8, 1, 1, { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
    model('openai/gpt-new:free', 9, 0, 0),
    model('google/gemini-guard', 9, 0.1, 0.1),
    model('google/gemini-flash', 6, 0.3, 2.5),
    model('somelab/unknown', 9, 1, 1),
  ];

  it('suggests the newest mid-priced chat model from each lab', () => {
    expect(pickFeatured(catalogue, [])).toEqual(['anthropic/claude-new', 'openai/gpt-new', 'google/gemini-flash']);
  });

  it('only lets chat models take a seat (no music models, classifiers or routers)', () => {
    const lyria = model('google/lyria-3-pro-preview', 9, 0, 0, {
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text', 'audio'] },
    });
    const playable = [
      lyria,
      model('nvidia/nemotron-3.5-content-safety:free', 9, 0, 0),
      model('openrouter/free', 9, 0, 0),
      model('google/gemma-4-31b-it:free', 9, 0, 0, {
        architecture: { input_modalities: ['image', 'text', 'video'], output_modalities: ['text'] },
      }),
    ].filter(canPlay);
    expect(lyria.textChat).toBe(false);
    expect(playable.map((m) => m.id)).toEqual(['google/gemma-4-31b-it:free']);
  });

  it('uses FEATURED_MODELS when set, dropping ids OpenRouter no longer lists', () => {
    expect(pickFeatured(catalogue, ['openai/gpt-new:free', 'gone/model', 'anthropic/claude-huge'])).toEqual([
      'openai/gpt-new:free',
      'anthropic/claude-huge',
    ]);
  });
});
