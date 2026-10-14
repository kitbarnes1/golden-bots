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
  appUrl: string;
  appName: string;
  timeoutMs: number;
  maxRetries: number;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/** Minimal OpenRouter client (OpenAI-compatible chat completions). */
export class OpenRouterClient {
  constructor(private readonly opts: OpenRouterOptions) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      'Content-Type': 'application/json',
      // Optional attribution headers recognised by OpenRouter.
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
    if (req.reasoningEffort && req.reasoningEffort !== 'none') {
      body.reasoning = { effort: req.reasoningEffort };
    }

    let attempt = 0;
    for (;;) {
      const started = Date.now();
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      try {
        const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new OpenRouterError(`OpenRouter ${res.status}: ${summariseError(text)}`, res.status);
          if (RETRYABLE.has(res.status) && attempt < this.opts.maxRetries) {
            await backoff(attempt++, res.headers.get('retry-after'), req.signal);
            continue;
          }
          throw err;
        }
        const json = JSON.parse(text) as {
          error?: { message?: string; code?: number };
          choices?: { message?: { content?: string | null; reasoning?: string | null }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };
        if (json.error) {
          const status = json.error.code;
          if (status && RETRYABLE.has(status) && attempt < this.opts.maxRetries) {
            await backoff(attempt++, null, req.signal);
            continue;
          }
          throw new OpenRouterError(`OpenRouter error: ${json.error.message ?? 'unknown'}`, status);
        }
        const message = json.choices?.[0]?.message;
        const usage: Usage = {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          costUsd: json.usage?.cost ?? 0,
          latencyMs: Date.now() - started,
        };
        return {
          content: message?.content ?? '',
          ...(message?.reasoning ? { reasoning: message.reasoning } : {}),
          usage,
        };
      } catch (err) {
        if (req.signal?.aborted) throw err;
        if (err instanceof OpenRouterError) throw err;
        // Network error or timeout.
        if (attempt < this.opts.maxRetries) {
          await backoff(attempt++, null, req.signal);
          continue;
        }
        const reason = timeout.aborted ? `timed out after ${this.opts.timeoutMs}ms` : String(err);
        throw new OpenRouterError(`Request to OpenRouter failed: ${reason}`);
      }
    }
  }

  async listModels(): Promise<ModelOption[]> {
    const res = await fetch(`${this.opts.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new OpenRouterError(`Could not list models (${res.status})`, res.status);
    const json = (await res.json()) as { data?: RawModel[] };
    return (json.data ?? []).map((m) => {
      const prompt = Number(m.pricing?.prompt);
      const completion = Number(m.pricing?.completion);
      return {
        id: m.id,
        name: cleanModelName(m.name ?? m.id),
        featured: false,
        ...(Number.isFinite(prompt) ? { promptPrice: prompt * 1e6 } : {}),
        ...(Number.isFinite(completion) ? { completionPrice: completion * 1e6 } : {}),
        ...(m.context_length ? { contextLength: m.context_length } : {}),
        supportsReasoning: m.supported_parameters?.includes('reasoning') ?? false,
      };
    });
  }
}

/** "Anthropic: Claude Sonnet 4.5" -> "Claude Sonnet 4.5" */
export function cleanModelName(name: string): string {
  const i = name.indexOf(': ');
  return i > 0 ? name.slice(i + 2) : name;
}

/** Fallback label from an id: "openai/gpt-5-mini" -> "gpt-5-mini" */
export function labelFromId(id: string): string {
  return id.split('/').pop()!.replace(/:.*$/, '');
}

function summariseError(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } };
    if (json.error?.message) return json.error.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

async function backoff(attempt: number, retryAfter: string | null, signal?: AbortSignal): Promise<void> {
  const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const ms = Number.isFinite(fromHeader) ? Math.min(fromHeader, 30_000) : 1000 * 2 ** attempt + Math.random() * 500;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
