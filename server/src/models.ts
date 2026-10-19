import type { ModelOption } from '@gb/shared';
import { labelFromId, type CatalogModel, type OpenRouterClient } from './llm/openrouter.js';

const CACHE_MS = 60 * 60_000;
/** After a failed fetch, wait this long before trying again. */
const RETRY_MS = 60_000;

/** Labs whose newest model gets suggested, in the order they're shown. */
const LABS = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'meta-llama', 'mistralai', 'qwen', 'moonshotai', 'z-ai'];
/**
 * Suggested models stay mid-priced (USD per 1M tokens), so a typical game
 * costs well under a dollar. Anything can still be picked by hand.
 */
const MAX_PROMPT_PRICE = 3;
const MAX_COMPLETION_PRICE = 15;
const MIN_CONTEXT = 32_000;
/** Specialised models that wouldn't make good contestants. */
const NOT_FOR_CHAT = /guard|embed|moderation|audio|image|tts|search|rerank|ocr|:(extended|online|nitro|floor|thinking)$/i;

/**
 * Picks the models to suggest: the ids in FEATURED_MODELS if set, otherwise
 * the newest mid-priced chat model from each major lab. Recomputed from the
 * live catalogue, so suggestions keep up as new models launch.
 */
export function pickFeatured(models: CatalogModel[], configured: string[]): string[] {
  if (configured.length) return configured.filter((id) => models.some((m) => m.id === id));
  const picks: string[] = [];
  for (const lab of LABS) {
    const best = models
      .filter(
        (m) =>
          m.id.startsWith(`${lab}/`) &&
          !m.free &&
          m.textChat &&
          !NOT_FOR_CHAT.test(m.id) &&
          (m.contextLength ?? 0) >= MIN_CONTEXT &&
          m.promptPrice !== undefined &&
          m.promptPrice > 0 &&
          m.promptPrice <= MAX_PROMPT_PRICE &&
          (m.completionPrice ?? Infinity) <= MAX_COMPLETION_PRICE,
      )
      .sort((a, b) => b.created - a.created)[0];
    if (best) picks.push(best.id);
  }
  return picks;
}

/** OpenRouter's model list, cached, with the featured models first. */
export class ModelCatalog {
  private cache: { at: number; models: ModelOption[] } | null = null;
  private failedAt = 0;
  private inflight: Promise<ModelOption[]> | null = null;

  constructor(
    private readonly client: OpenRouterClient | null,
    /** From FEATURED_MODELS; empty = pick automatically. */
    private readonly configured: string[],
    private readonly log: { warn: (obj: unknown, msg: string) => void },
  ) {}

  async list(): Promise<ModelOption[]> {
    if (!this.client) return [];
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.models;
    if (Date.now() - this.failedAt < RETRY_MS) return this.fallback();
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Best label we have for an id, without waiting on the network. */
  label(id: string): string {
    return this.cache?.models.find((m) => m.id === id)?.name ?? labelFromId(id);
  }

  private async load(): Promise<ModelOption[]> {
    try {
      const all = await this.client!.listModels();
      const featured = pickFeatured(all, this.configured);
      const rank = new Map(featured.map((id, i) => [id, i]));
      const models = all
        .map(({ created: _created, textChat: _textChat, ...m }): ModelOption => ({ ...m, featured: rank.has(m.id) }))
        .sort((a, b) => {
          if (a.featured !== b.featured) return a.featured ? -1 : 1;
          if (a.featured) return rank.get(a.id)! - rank.get(b.id)!;
          return a.name.localeCompare(b.name);
        });
      this.cache = { at: Date.now(), models };
      return models;
    } catch (err) {
      this.log.warn({ err }, 'Could not fetch the OpenRouter model list');
      this.failedAt = Date.now();
      return this.fallback();
    }
  }

  /** Without the live list, offer the configured featured models (if any) as-is. */
  private fallback(): ModelOption[] {
    return this.configured.map((id) => ({ id, name: labelFromId(id), featured: true, ...(id.endsWith(':free') ? { free: true } : {}) }));
  }
}
