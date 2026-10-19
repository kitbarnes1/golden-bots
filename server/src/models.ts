import { parseModelRef, type ModelOption, type ProviderId } from '@gb/shared';
import { labelFromId, type ChatClient } from './llm/client.js';

/** How long each provider's list is trusted. Local Ollama models change as you pull them. */
const TTL_MS: Record<ProviderId, number> = {
  openrouter: 60 * 60_000,
  huggingface: 60 * 60_000,
  ollama: 30_000,
};
/** After a failed fetch, wait this long before trying again. */
const FAILED_TTL_MS = 60_000;

/**
 * Every model the configured providers offer, merged into one list: featured
 * models first, then local Ollama models, then everything else by name.
 */
export class ModelCatalog {
  private readonly cache = new Map<ProviderId, { at: number; ttl: number; models: ModelOption[] }>();
  private readonly inflight = new Map<ProviderId, Promise<ModelOption[]>>();

  constructor(
    private readonly clients: Partial<Record<ProviderId, ChatClient>>,
    private readonly featured: string[],
    private readonly log: { warn: (obj: unknown, msg: string) => void },
  ) {}

  async list(): Promise<ModelOption[]> {
    const ids = Object.keys(this.clients) as ProviderId[];
    const lists = await Promise.all(ids.map((id) => this.listProvider(id)));
    const featuredRank = new Map(this.featured.map((id, i) => [id, i]));
    const all = lists.flat().map((m) => ({ ...m, featured: featuredRank.has(m.id) }));
    // Featured models we couldn't confirm (e.g. the list failed) are still offered.
    for (const id of this.featured) {
      const { provider } = parseModelRef(id);
      if (this.clients[provider] && !all.some((m) => m.id === id) && !this.cache.get(provider)?.models.length) {
        all.push({ id, name: this.label(id), provider, featured: true, ...(id.endsWith(':free') ? { free: true } : {}) });
      }
    }
    const group = (m: ModelOption) => (m.featured ? 0 : m.provider === 'ollama' ? 1 : 2);
    return all.sort((a, b) => {
      if (group(a) !== group(b)) return group(a) - group(b);
      if (a.featured) return featuredRank.get(a.id)! - featuredRank.get(b.id)!;
      return a.name.localeCompare(b.name);
    });
  }

  /** Best label we have for a model reference, without waiting on the network. */
  label(ref: string): string {
    const { provider, model } = parseModelRef(ref);
    return this.cache.get(provider)?.models.find((m) => m.id === ref)?.name ?? labelFromId(model);
  }

  /** USD per 1M tokens, for providers that don't report cost per call. */
  pricing(ref: string): { prompt?: number; completion?: number } | undefined {
    const { provider } = parseModelRef(ref);
    const m = this.cache.get(provider)?.models.find((x) => x.id === ref);
    if (!m || (m.promptPrice === undefined && m.completionPrice === undefined)) return undefined;
    return { ...(m.promptPrice !== undefined ? { prompt: m.promptPrice } : {}), ...(m.completionPrice !== undefined ? { completion: m.completionPrice } : {}) };
  }

  private async listProvider(id: ProviderId): Promise<ModelOption[]> {
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.models;
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.fetchProvider(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    return pending;
  }

  private async fetchProvider(id: ProviderId): Promise<ModelOption[]> {
    try {
      const models = await this.clients[id]!.listModels();
      this.cache.set(id, { at: Date.now(), ttl: TTL_MS[id], models });
      return models;
    } catch (err) {
      // Ollama not running is normal (e.g. on the server); don't make noise about it.
      if (id !== 'ollama') this.log.warn({ err }, `Could not fetch the ${id} model list`);
      this.cache.set(id, { at: Date.now(), ttl: FAILED_TTL_MS, models: [] });
      return [];
    }
  }
}
