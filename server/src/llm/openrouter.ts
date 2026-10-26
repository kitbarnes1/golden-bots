import type { ModelOption, Usage } from '@gb/shared';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
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

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl: string;
  /** Optional attribution headers recognised by OpenRouter. */
  appUrl: string;
  appName: string;
  timeoutMs: number;
  maxRetries: number;
}

/** A model from OpenRouter's catalogue, with the extra facts used to pick featured models. */
export interface CatalogModel extends ModelOption {
  /** Unix seconds when OpenRouter added it. */
  created: number;
  /** Takes text and returns only text (not an image, audio or music model). */
  textChat: boolean;
}

/**
 * A failed model call. `fatal` means retrying (or carrying on with the game)
 * can't help: bad key, no credits, unknown model, daily free-model limit.
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
/**
 * OpenRouter's catch-all when the model's provider falls over, whatever status it
 * passes on (seen with 400 and 404): a hiccup or outage, not a bad request.
 */
const PROVIDER_HICCUP = /provider returned error/i;
const retryable = (status: number, message: string) => RETRYABLE.has(status) || PROVIDER_HICCUP.test(message);
/** After a provider keeps failing, leave the model out of new lineups for this long. */
const UNHEALTHY_MS = 10 * 60_000;

interface RawMessage {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
}

/** Minimal OpenRouter client (OpenAI-compatible chat completions). */
export class OpenRouterClient {
  /** Models that refused to switch reasoning off; they get the lowest effort instead. */
  private readonly mustReason = new Set<string>();
  /** Models OpenRouter refused (403) or doesn't know (404), so they can be left out of lineups. */
  readonly unavailable = new Set<string>();
  /** Models whose provider kept failing just now: model -> time it may be offered again. */
  private readonly unhealthyUntil = new Map<string, number>();

  /** Should this model be left out of lineups (refused, unknown, or its provider down right now)? */
  isUnavailable(model: string): boolean {
    return this.unavailable.has(model) || (this.unhealthyUntil.get(model) ?? 0) > Date.now();
  }

  constructor(private readonly opts: OpenRouterOptions) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.opts.appUrl,
      'X-Title': this.opts.appName,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 4096,
      usage: { include: true },
    };
    if (req.reasoningEffort === 'none') {
      // Off where possible: left to themselves, some models think for a minute or
      // more per move. Others can't switch it off and get the lowest effort.
      body.reasoning = this.mustReason.has(req.model) ? { effort: 'minimal' } : { enabled: false };
    } else if (req.reasoningEffort) {
      body.reasoning = { effort: req.reasoningEffort };
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
        if (attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt++, null, false), req.signal);
          continue;
        }
        // Still can't get through after several tries: no point playing on.
        if (isUnreachable(err)) throw new LlmError(`Couldn't reach OpenRouter at ${this.opts.baseUrl}.`, true);
        const reason = timeout.aborted ? `timed out after ${this.opts.timeoutMs / 1000}s` : String(err);
        throw new LlmError(`Request to OpenRouter failed: ${reason}`, false);
      }

      // OpenRouter sends headers straight away and the body once the model is done,
      // so a slow model times out here rather than in fetch().
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        if (req.signal?.aborted) throw err;
        const reason = timeout.aborted ? `timed out after ${this.opts.timeoutMs / 1000}s` : String(err);
        throw new LlmError(`${req.model} ${reason}`, false);
      }
      if (!res.ok) {
        const message = summariseError(text);
        if (res.status === 400 && /reasoning is mandatory/i.test(message) && !this.mustReason.has(req.model)) {
          this.mustReason.add(req.model);
          body.reasoning = { effort: 'minimal' };
          continue;
        }
        const fatal = fatalMessage(res.status, message, req.model);
        if (fatal && (res.status === 403 || res.status === 404)) this.unavailable.add(req.model);
        if (fatal) throw new LlmError(fatal, true, res.status);
        if (retryable(res.status, message) && attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt++, res.headers.get('retry-after'), res.status === 429), req.signal);
          continue;
        }
        if (PROVIDER_HICCUP.test(message)) this.unhealthyUntil.set(req.model, Date.now() + UNHEALTHY_MS);
        throw new LlmError(`OpenRouter ${res.status}: ${message}`, false, res.status);
      }

      const json = JSON.parse(text) as {
        error?: { message?: string; code?: number };
        choices?: { message?: RawMessage }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      if (json.error) {
        const status = json.error.code;
        const message = json.error.message ?? 'unknown error';
        const fatal = status ? fatalMessage(status, message, req.model) : null;
        if (fatal) throw new LlmError(fatal, true, status);
        if (status && retryable(status, message) && attempt < this.opts.maxRetries) {
          await sleep(backoffMs(attempt++, null, status === 429), req.signal);
          continue;
        }
        throw new LlmError(`OpenRouter error: ${message}`, false, status);
      }

      const { content, reasoning } = splitReasoning(json.choices?.[0]?.message ?? {});
      return {
        content,
        ...(reasoning ? { reasoning } : {}),
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          costUsd: json.usage?.cost ?? 0,
          latencyMs: Date.now() - started,
        },
      };
    }
  }

  async listModels(): Promise<CatalogModel[]> {
    const res = await fetch(`${this.opts.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new LlmError(`Could not list OpenRouter models (${res.status})`, false, res.status);
    const json = (await res.json()) as { data?: RawModel[] };
    return (json.data ?? []).map(parseModel);
  }
}

/**
 * Does OpenRouter accept this key? Asks its key-info endpoint, which costs nothing.
 * `status` is OpenRouter's reply when it isn't a yes, or 0 if it couldn't be reached.
 */
export async function checkApiKey(baseUrl: string, apiKey: string): Promise<{ ok: true } | { ok: false; status: number }> {
  try {
    const res = await fetch(`${baseUrl}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

interface RawModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

export function parseModel(m: RawModel): CatalogModel {
  const prompt = Number(m.pricing?.prompt);
  const completion = Number(m.pricing?.completion);
  const inputs = m.architecture?.input_modalities ?? ['text'];
  const outputs = m.architecture?.output_modalities ?? ['text'];
  return {
    id: m.id,
    name: cleanModelName(m.name ?? m.id),
    featured: false,
    free: m.id.endsWith(':free') || (prompt === 0 && completion === 0),
    ...(Number.isFinite(prompt) ? { promptPrice: prompt * 1e6 } : {}),
    ...(Number.isFinite(completion) ? { completionPrice: completion * 1e6 } : {}),
    ...(m.context_length ? { contextLength: m.context_length } : {}),
    supportsReasoning: m.supported_parameters?.includes('reasoning') ?? false,
    created: m.created ?? 0,
    // Text out only: music and image generators also return some text.
    textChat: inputs.includes('text') && outputs.length > 0 && outputs.every((o) => o === 'text'),
  };
}

/** A clear message for errors that won't fix themselves, else null. */
function fatalMessage(status: number, message: string, model: string): string | null {
  // The model's provider failing (even with a 404) isn't the model being gone: retry, then fumble.
  if (PROVIDER_HICCUP.test(message)) return null;
  if (status === 401) return `OpenRouter rejected the API key (401): ${message}`;
  // 403 is usually about the model (e.g. "only available on agentic harnesses"), not the key.
  if (status === 403) return `OpenRouter refused "${model}" (403): ${message}`;
  if (status === 402) return `OpenRouter says you're out of credits (402): ${message}`;
  if (status === 404) return `OpenRouter doesn't have the model "${model}" (404): ${message}`;
  if (status === 400) return `OpenRouter rejected the request for "${model}" (400): ${message}`;
  if (status === 429 && /per[- ]?day|daily/i.test(message)) {
    return `OpenRouter's daily free-model limit is used up (429): ${message}`;
  }
  return null;
}

/**
 * Separate a model's reasoning from its answer: OpenRouter returns it in a
 * field, but some models also wrap it in <think> tags inside the content.
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

/** Fallback label from an id: "openai/gpt-5-mini" -> "gpt-5-mini" */
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
