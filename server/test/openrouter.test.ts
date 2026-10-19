import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmError, OpenRouterClient, parseModel, splitReasoning } from '../src/llm/openrouter.js';
import { pickFeatured } from '../src/models.js';

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

  it('pulls reasoning out of <think> tags too', () => {
    expect(splitReasoning({ content: '<think>plan {a}</think>\n{"say":"x"}' })).toEqual({ content: '{"say":"x"}', reasoning: 'plan {a}' });
    expect(splitReasoning({ content: '{}', reasoning_content: 'why' })).toEqual({ content: '{}', reasoning: 'why' });
  });

  it('treats bad keys, no credits, unknown models and the daily free limit as fatal', async () => {
    const cases: [number, string, RegExp][] = [
      [401, 'No auth credentials found', /rejected the API key/],
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

  it('uses FEATURED_MODELS when set, dropping ids OpenRouter no longer lists', () => {
    expect(pickFeatured(catalogue, ['openai/gpt-new:free', 'gone/model', 'anthropic/claude-huge'])).toEqual([
      'openai/gpt-new:free',
      'anthropic/claude-huge',
    ]);
  });
});
