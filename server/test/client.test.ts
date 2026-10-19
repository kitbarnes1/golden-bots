import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidModelRef, parseModelRef, toModelRef } from '@gb/shared';
import { ChatClient, LlmError, splitReasoning } from '../src/llm/client.js';

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
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const reply = (content: string, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  json: { choices: [{ message: { role: 'assistant', content, ...extra } }], usage: { prompt_tokens: 1000, completion_tokens: 100, ...usage } },
});

function client(provider: 'openrouter' | 'huggingface' | 'ollama', extra: Partial<ConstructorParameters<typeof ChatClient>[0]> = {}) {
  return new ChatClient({ provider, baseUrl: base, apiKey: 'k', timeoutMs: 5000, maxRetries: 2, ...extra });
}

describe('model references', () => {
  it('parses provider prefixes', () => {
    expect(parseModelRef('anthropic/claude-sonnet-4.5')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
    expect(parseModelRef('hf:Qwen/Qwen2.5-72B-Instruct')).toEqual({ provider: 'huggingface', model: 'Qwen/Qwen2.5-72B-Instruct' });
    expect(parseModelRef('ollama:llama3.1:8b')).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
    expect(toModelRef('ollama', 'qwen3:8b')).toBe('ollama:qwen3:8b');
  });

  it('validates shapes per provider', () => {
    expect(isValidModelRef('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(isValidModelRef('hf:deepseek-ai/DeepSeek-V3:fastest')).toBe(true);
    expect(isValidModelRef('ollama:llama3.1:8b')).toBe(true);
    expect(isValidModelRef('ollama:gemma3')).toBe(true);
    expect(isValidModelRef('gpt-5')).toBe(false);
    expect(isValidModelRef('hf:')).toBe(false);
    expect(isValidModelRef('ollama:bad model')).toBe(false);
  });
});

describe('ChatClient', () => {
  it('sends OpenRouter extras only to OpenRouter', async () => {
    const seen: Record<string, unknown>[] = [];
    handler = ({ body }) => {
      seen.push(body);
      return reply('{"say":"hi"}', {}, { cost: 0.002 });
    };
    const or = await client('openrouter').chat({ model: 'a/b', messages: [], reasoningEffort: 'low' });
    expect(or.usage.costUsd).toBe(0.002);
    expect(seen[0]).toMatchObject({ usage: { include: true }, reasoning: { effort: 'low' } });
    await client('ollama').chat({ model: 'llama3.1:8b', messages: [], reasoningEffort: 'low' });
    expect(seen[1]).not.toHaveProperty('usage');
    expect(seen[1]).not.toHaveProperty('reasoning');
  });

  it('estimates cost from list prices when the provider does not report it', async () => {
    handler = () => reply('{}');
    const hf = client('huggingface', { pricing: (ref) => (ref === 'hf:a/b' ? { prompt: 2, completion: 10 } : undefined) });
    const res = await hf.chat({ model: 'a/b', messages: [] });
    expect(res.usage.costUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6);
    expect((await client('ollama').chat({ model: 'x', messages: [] })).usage.costUsd).toBe(0);
  });

  it('pulls reasoning out of fields and <think> tags', async () => {
    expect(splitReasoning({ content: '<think>plan {a}</think>\n{"say":"x"}' })).toEqual({ content: '{"say":"x"}', reasoning: 'plan {a}' });
    expect(splitReasoning({ content: '{}', reasoning_content: 'why' })).toEqual({ content: '{}', reasoning: 'why' });
    handler = () => reply('<think>hmm</think>{"say":"hello"}', { reasoning: 'native' });
    const res = await client('huggingface').chat({ model: 'a/b', messages: [] });
    expect(res.content).toBe('{"say":"hello"}');
    expect(res.reasoning).toBe('native\n\nhmm');
  });

  it('treats bad keys, no credits, unknown models and daily limits as fatal', async () => {
    const cases: [number, string, RegExp][] = [
      [401, 'Invalid credentials', /rejected the API key/],
      [402, 'Insufficient credits', /out of credits/],
      [404, 'No such model', /doesn't have the model/],
      [429, 'Rate limit exceeded: free-models-per-day', /daily limit/],
    ];
    for (const [status, message, expected] of cases) {
      requests = 0;
      handler = () => ({ status, json: { error: { message } } });
      const err = await client('openrouter').chat({ model: 'a/b', messages: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).fatal).toBe(true);
      expect((err as LlmError).message).toMatch(expected);
      expect(requests).toBe(1); // no pointless retries
    }
  });

  it('retries ordinary rate limits and server errors', async () => {
    let n = 0;
    handler = () => (++n < 3 ? { status: n === 1 ? 429 : 503, headers: { 'retry-after': '0' }, json: { error: { message: 'slow down' } } } : reply('{"ok":1}'));
    const res = await client('openrouter').chat({ model: 'a/b', messages: [] });
    expect(res.content).toBe('{"ok":1}');
    expect(n).toBe(3);
  });

  it('gives a clear fatal error when the provider is not running', async () => {
    // Grab a free port, then close it so nothing is listening there.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const dead = new ChatClient({ provider: 'ollama', baseUrl: `http://127.0.0.1:${port}/v1`, timeoutMs: 2000, maxRetries: 2 });
    const err = (await dead.chat({ model: 'llama3.1', messages: [] }).catch((e: unknown) => e)) as LlmError;
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/Couldn't reach Ollama/);
  });

  it('lists models from each provider in its own format', async () => {
    handler = () => ({
      json: {
        data: [
          { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B (free)', pricing: { prompt: '0', completion: '0' } },
          { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', pricing: { prompt: '0.00000125', completion: '0.00001' }, supported_parameters: ['reasoning'] },
        ],
      },
    });
    const or = await client('openrouter').listModels();
    expect(or[0]).toMatchObject({ id: 'meta-llama/llama-3.3-70b-instruct:free', free: true, provider: 'openrouter' });
    expect(or[1]).toMatchObject({ name: 'GPT-5', promptPrice: 1.25, completionPrice: 10, supportsReasoning: true, free: false });

    handler = () => ({
      json: {
        data: [
          { id: 'Qwen/Qwen2.5-72B-Instruct', providers: [{ provider: 'a', status: 'live', pricing: { input: 0.9, output: 0.9 } }, { provider: 'b', status: 'live', pricing: { input: 0.3, output: 0.4 }, context_length: 32768 }] },
          { id: 'old/model', providers: [{ provider: 'a', status: 'staging' }] },
        ],
      },
    });
    const hf = await client('huggingface').listModels();
    expect(hf).toEqual([
      { id: 'hf:Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5-72B-Instruct', provider: 'huggingface', featured: false, promptPrice: 0.3, completionPrice: 0.4, contextLength: 32768 },
    ]);

    handler = () => ({ json: { object: 'list', data: [{ id: 'llama3.1:8b', object: 'model' }] } });
    const ol = await client('ollama').listModels();
    expect(ol).toEqual([{ id: 'ollama:llama3.1:8b', name: 'llama3.1:8b', provider: 'ollama', featured: false, free: true, promptPrice: 0, completionPrice: 0 }]);
  });
});
