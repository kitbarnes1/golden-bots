import type { ModelOption } from '@gb/shared';
import { labelFromId, type OpenRouterClient } from './llm/openrouter.js';

const CACHE_MS = 60 * 60_000;

/** OpenRouter's model list, cached, with our featured models first. */
export class ModelCatalog {
  private cache: { at: number; models: ModelOption[] } | null = null;
  private inflight: Promise<ModelOption[]> | null = null;

  constructor(
    private readonly client: OpenRouterClient | null,
    private readonly featured: string[],
    private readonly log: { warn: (obj: unknown, msg: string) => void },
  ) {}

  async list(): Promise<ModelOption[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.models;
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
    if (!this.client) return this.featuredOnly();
    try {
      const all = await this.client.listModels();
      const featured = new Set(this.featured);
      const models = all
        .map((m) => ({ ...m, featured: featured.has(m.id) }))
        .sort((a, b) => {
          if (a.featured !== b.featured) return a.featured ? -1 : 1;
          if (a.featured) return this.featured.indexOf(a.id) - this.featured.indexOf(b.id);
          return a.name.localeCompare(b.name);
        });
      this.cache = { at: Date.now(), models };
      return models;
    } catch (err) {
      this.log.warn({ err }, 'Could not fetch the OpenRouter model list; using featured models only');
      return this.featuredOnly();
    }
  }

  private featuredOnly(): ModelOption[] {
    return this.featured.map((id) => ({ id, name: labelFromId(id), featured: true }));
  }
}
