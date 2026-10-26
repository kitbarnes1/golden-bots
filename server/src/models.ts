import type { ModelOption } from '@gb/shared';
import { checkModel, type ModelCheck } from './agents/check.js';
import { labelFromId, type CatalogModel, type OpenRouterClient } from './llm/openrouter.js';

const CACHE_MS = 60 * 60_000;
/** After a failed fetch, wait this long before trying again. */
const RETRY_MS = 60_000;
/** How long a model check counts for; busy or rate-limited models get another go sooner. */
const CHECK_MS = 12 * 60 * 60_000;
const CHECK_RETRY_MS = 10 * 60_000;

/** Labs whose newest model gets suggested, in the order they're shown. */
const LABS = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'meta-llama', 'mistralai', 'qwen', 'moonshotai', 'z-ai'];
/**
 * Suggested models stay mid-priced (USD per 1M tokens), so a typical game
 * costs well under a dollar. Anything can still be picked by hand.
 */
const MAX_PROMPT_PRICE = 3;
const MAX_COMPLETION_PRICE = 15;
const MIN_CONTEXT = 32_000;
/** Can't hold a seat: classifiers, embedders, and OpenRouter's routers (a different model on every call). */
const CANNOT_PLAY = /guard|safety|moderation|embed|rerank|ocr|tts|^openrouter\//i;
/** Fine to pick by hand, but not suggested: specialised models and variants of other models. */
const NOT_SUGGESTED = /audio|image|search|:(extended|online|nitro|floor|thinking)$/i;

/** Could take a seat at the table: text in, text out, and not a classifier or router. */
export function canPlay(m: CatalogModel): boolean {
  return m.textChat && !CANNOT_PLAY.test(m.id);
}

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
          canPlay(m) &&
          !NOT_SUGGESTED.test(m.id) &&
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
  /** Results of checkModel, each good until `until`. */
  private readonly checks = new Map<string, ModelCheck & { until: number }>();
  private checking: Promise<void> | null = null;
  /** The client the checks above were made with. */
  private checkedWith: OpenRouterClient | null = null;

  constructor(
    /** The client for the current OpenRouter key (null without one). It changes when the key is saved or deleted. */
    private readonly openRouter: () => OpenRouterClient | null,
    /** From FEATURED_MODELS; empty = pick automatically. */
    private readonly configured: string[],
    private readonly log: { warn: (obj: unknown, msg: string) => void },
    private readonly check: typeof checkModel = checkModel,
  ) {}

  /** The current client. After a key change, model checks made with the old key no longer count. */
  private client(): OpenRouterClient | null {
    const client = this.openRouter();
    if (client !== this.checkedWith) {
      this.checkedWith = client;
      this.checks.clear();
      this.checking = null;
    }
    return client;
  }

  /**
   * Models that can be picked right now: the catalogue minus any OpenRouter has
   * refused to serve and any that recently failed a check.
   */
  async list(): Promise<ModelOption[]> {
    const client = this.client();
    if (!client) return [];
    const now = Date.now();
    const failed = (id: string) => {
      const c = this.checks.get(id);
      return c !== undefined && !c.ok && !c.transient && c.until > now;
    };
    return (await this.listAll(client)).filter((m) => !client.isUnavailable(m.id) && !failed(m.id));
  }

  /**
   * Free models that just answered a small game question properly, for the
   * "Free lineup". Returns once `enough` have passed or after `waitMs`, so one
   * slow model can't hold things up; checks still going finish in the background.
   */
  async workingFree(waitMs = 10_000, enough = 4): Promise<ModelOption[]> {
    if (!this.client()) return [];
    let done = false;
    void this.checkFree().finally(() => {
      done = true;
    });
    const deadline = Date.now() + waitMs;
    const passing = async () => (await this.list()).filter((m) => m.free && this.checks.get(m.id)?.ok);
    while (!done && Date.now() < deadline && (await passing()).length < enough) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return passing();
  }

  /** Check, in parallel, the free models that haven't been checked lately. Cheap to call often. */
  checkFree(): Promise<void> {
    const client = this.client();
    if (!client) return Promise.resolve();
    if (!this.checking) {
      const run: Promise<void> = (async () => {
        const stale = (await this.list()).filter((m) => m.free && !((this.checks.get(m.id)?.until ?? 0) > Date.now()));
        await this.runChecks(client, stale.map((m) => m.id));
      })().finally(() => {
        // A key change may have started a fresh round of checks meanwhile.
        if (this.checking === run) this.checking = null;
      });
      this.checking = run;
    }
    return this.checking;
  }

  private async runChecks(client: OpenRouterClient, ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const result = await this.check(client, id);
        if (client !== this.checkedWith) return; // made with a key that has since changed
        const ttl = result.ok || !result.transient ? CHECK_MS : CHECK_RETRY_MS;
        this.checks.set(id, { ...result, until: Date.now() + ttl });
        if (!result.ok) this.log.warn({ model: id, reason: result.reason }, 'Model failed its check');
      }),
    );
  }

  private async listAll(client: OpenRouterClient): Promise<ModelOption[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.models;
    if (Date.now() - this.failedAt < RETRY_MS) return this.fallback();
    this.inflight ??= this.load(client).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Best label we have for an id, without waiting on the network. */
  label(id: string): string {
    return this.cache?.models.find((m) => m.id === id)?.name ?? labelFromId(id);
  }

  private async load(client: OpenRouterClient): Promise<ModelOption[]> {
    try {
      // Only list models that can play, so "Free lineup" never draws a music model or a router.
      const all = (await client.listModels()).filter(canPlay);
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
