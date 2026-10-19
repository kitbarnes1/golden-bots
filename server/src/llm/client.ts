import { PROVIDERS, toModelRef, type ModelOption, type ProviderId, type Usage } from '@gb/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  /** The provider's own model id (no prefix). */
  model: string;
  messages: ChatMessage[];
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  usage: Usage;
}

export interface ChatClientOptions {
  provider: ProviderId;
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  /** USD per million tokens, for providers that don't report cost themselves. */
  pricing?: (model: string) => { prompt?: number; completion?: number } | undefined;
}

/**
 * A failed model call. `fatal` means retrying (or carrying on with the game)
 * can't help: bad key, no credits, unknown model, daily limit, provider down.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

interface RawMessage {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
}

/**
 * One client for every provider: OpenRouter, Hugging Face's router and Ollama
 * all speak the OpenAI chat-completions dialect.
 */
export class ChatClient {
  readonly label: string;

  constructor(private readonly opts: ChatClientOptions) {
    this.label = PROVIDERS[opts.provider].label;
  }

  get provider(): ProviderId {
    return this.opts.provider;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...this.opts.extraHeaders,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const isOpenRouter = this.opts.provider === 'openrouter';
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 4096,
    };
    if (isOpenRouter) {
      body.usage = { include: true };
      if (req.reasoningEffort && req.reasoningEffort !== 'none') body.reasoning = { effort: req.reasoningEffort };
    }

    let attempt = 0;
    for (;;) {
      const started = Date.now();
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (isUnreachable(err)) {
          throw new LlmError(`Couldn't reach ${this.label} at ${this.opts.baseUrl}. Is it running?`, true);
        }
        if (attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt++, null, false), req.signal);
          continue;
        }
        const reason = timeout.aborted ? `timed out after ${this.opts.timeoutMs / 1000}s` : String(err);
        throw new LlmError(`Request to ${this.label} failed: ${reason}`, false);
      }

      const text = await res.text();
      if (!res.ok) {
        const message = summariseError(text);
        const fatal = this.fatalMessage(res.status, message, req.model);
        if (fatal) throw new LlmError(fatal, true, res.status);
        if (RETRYABLE.has(res.status) && attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt++, res.headers.get('retry-after'), res.status === 429), req.signal);
          continue;
        }
        throw new LlmError(`${this.label} ${res.status}: ${message}`, false, res.status);
      }

      const json = JSON.parse(text) as {
        error?: { message?: string; code?: number };
        choices?: { message?: RawMessage }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      if (json.error) {
        const status = json.error.code;
        const message = json.error.message ?? 'unknown error';
        const fatal = status ? this.fatalMessage(status, message, req.model) : null;
        if (fatal) throw new LlmError(fatal, true, status);
        if (status && RETRYABLE.has(status) && attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt++, null, status === 429), req.signal);
          continue;
        }
        throw new LlmError(`${this.label} error: ${message}`, false, status);
      }

      const message = json.choices?.[0]?.message ?? {};
      const { content, reasoning } = splitReasoning(message);
      const promptTokens = json.usage?.prompt_tokens ?? 0;
      const completionTokens = json.usage?.completion_tokens ?? 0;
      return {
        content,
        ...(reasoning ? { reasoning } : {}),
        usage: {
          promptTokens,
          completionTokens,
          costUsd: json.usage?.cost ?? this.estimateCost(req.model, promptTokens, completionTokens),
          latencyMs: Date.now() - started,
        },
      };
    }
  }

  /** A clear message for errors that won't fix themselves, else null. */
  private fatalMessage(status: number, message: string, model: string): string | null {
    const where = this.label;
    if (status === 401 || status === 403) return `${where} rejected the API key (${status}): ${message}`;
    if (status === 402) return `${where} says you're out of credits (402): ${message}`;
    if (status === 404) return `${where} doesn't have the model "${model}" (404): ${message}`;
    if (status === 400) return `${where} rejected the request for "${model}" (400): ${message}`;
    if (status === 429 && /per[- ]?day|daily/i.test(message)) {
      return `${where} daily limit reached (429): ${message}`;
    }
    return null;
  }

  private estimateCost(model: string, promptTokens: number, completionTokens: number): number {
    const price = this.opts.pricing?.(toModelRef(this.opts.provider, model));
    if (!price) return 0;
    return ((price.prompt ?? 0) * promptTokens + (price.completion ?? 0) * completionTokens) / 1e6;
  }

  async listModels(): Promise<ModelOption[]> {
    const url = `${this.opts.baseUrl}/models`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(this.opts.provider === 'ollama' ? 3000 : 20_000) });
    } catch (err) {
      throw new LlmError(`Couldn't reach ${this.label} at ${this.opts.baseUrl}: ${String(err)}`, true);
    }
    if (!res.ok) throw new LlmError(`Could not list ${this.label} models (${res.status})`, false, res.status);
    const json = (await res.json()) as { data?: unknown[] };
    const data = Array.isArray(json.data) ? json.data : [];
    switch (this.opts.provider) {
      case 'openrouter':
        return data.map((m) => parseOpenRouterModel(m as RawOpenRouterModel));
      case 'huggingface':
        return data.flatMap((m) => parseHuggingFaceModel(m as RawHfModel));
      case 'ollama':
        return data.flatMap((m) => {
          const id = (m as { id?: string }).id;
          return id
            ? [{ id: toModelRef('ollama', id), name: id, provider: 'ollama' as const, featured: false, free: true, promptPrice: 0, completionPrice: 0 }]
            : [];
        });
    }
  }
}

interface RawOpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

function parseOpenRouterModel(m: RawOpenRouterModel): ModelOption {
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  return {
    id: m.id,
    name: cleanModelName(m.name ?? m.id),
    provider: 'openrouter',
    featured: false,
    free: m.id.endsWith(':free') || (prompt === 0 && completion === 0),
    ...(Number.isFinite(prompt) ? { promptPrice: prompt * 1e6 } : {}),
    ...(Number.isFinite(completion) ? { completionPrice: completion * 1e6 } : {}),
    ...(m.context_length ? { contextLength: m.context_length } : {}),
    supportsReasoning: m.supported_parameters?.includes('reasoning') ?? false,
  };
}

interface RawHfModel {
  id?: string;
  providers?: { status?: string; context_length?: number; pricing?: { input?: number; output?: number } }[];
}

/** Hugging Face's router lists each model with the providers serving it (prices in USD per 1M tokens). */
function parseHuggingFaceModel(m: RawHfModel): ModelOption[] {
  if (!m.id) return [];
  const live = (m.providers ?? []).filter((p) => !p.status || p.status === 'live');
  if (m.providers && live.length === 0) return [];
  const priced = live
    .filter((p) => typeof p.pricing?.input === 'number' && typeof p.pricing?.output === 'number')
    .sort((a, b) => a.pricing!.input! + a.pricing!.output! - (b.pricing!.input! + b.pricing!.output!));
  const cheapest = priced[0];
  const context = live.find((p) => p.context_length)?.context_length;
  return [
    {
      id: toModelRef('huggingface', m.id),
      name: m.id.split('/').pop() ?? m.id,
      provider: 'huggingface',
      featured: false,
      ...(cheapest ? { promptPrice: cheapest.pricing!.input!, completionPrice: cheapest.pricing!.output! } : {}),
      ...(context ? { contextLength: context } : {}),
    },
  ];
}

/**
 * Separate a model's reasoning from its answer: some providers return it in a
 * field, some models wrap it in <think> tags inside the content.
 */
export function splitReasoning(message: RawMessage): { content: string; reasoning?: string } {
  let content = message.content ?? '';
  const parts: string[] = [];
  const field = message.reasoning ?? message.reasoning_content;
  if (field) parts.push(field);
  content = content.replace(/<think>([\s\S]*?)(<\/think>|$)/gi, (_, inner: string) => {
    if (inner.trim()) parts.push(inner.trim());
    return '';
  });
  return { content: content.trim(), ...(parts.length ? { reasoning: parts.join('\n\n') } : {}) };
}

/** "Anthropic: Claude Sonnet 4.5" -> "Claude Sonnet 4.5" */
export function cleanModelName(name: string): string {
  const i = name.indexOf(': ');
  return i > 0 ? name.slice(i + 2) : name;
}

/** Fallback label from a model id: "openai/gpt-5-mini" -> "gpt-5-mini", "llama3.1:8b" stays. */
export function labelFromId(id: string): string {
  const last = id.split('/').pop()!;
  return last.endsWith(':free') ? last.replace(/:free$/, ' (free)') : last;
}

function summariseError(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof json.error === 'string') return json.error;
    if (json.error?.message) return json.error.message;
    if (json.message) return json.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

function isUnreachable(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

/** Rate limits get a longer wait than server hiccups. */
function backoffMs(attempt: number, retryAfter: string | null, rateLimited: boolean): number {
  const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(fromHeader)) return Math.min(Math.max(fromHeader, 500), 60_000);
  const base = rateLimited ? 5000 : 1000;
  return Math.min(base * 2 ** attempt, 60_000) + Math.random() * 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
