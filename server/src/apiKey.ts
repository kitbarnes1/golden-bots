import type { ApiKeyStatus } from '@gb/shared';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HttpError, type Logger } from './games/manager.js';
import { checkApiKey, OpenRouterClient } from './llm/openrouter.js';
import type { SecretBox } from './secretBox.js';

const SETTING = 'openrouter_api_key';
/** OpenRouter keys look like "sk-or-v1-" and 64 hex digits. Anything else (another service's key, say) isn't sent off to check. */
const KEY_SHAPE = /^sk-or-[\w-]{10,200}$/;

type Source = NonNullable<ApiKeyStatus['source']>;

/**
 * The OpenRouter API key: OPENROUTER_API_KEY from the environment, which always
 * wins, or one saved (encrypted) on the Settings page. Saving or deleting takes
 * effect at once: new games and the model list use `client`, while running games
 * keep the client they started with. The key itself is never returned or logged.
 */
export class OpenRouterKey {
  private current: { key: string; source: Source; client: OpenRouterClient } | null = null;
  /** A saved key couldn't be decrypted (the encryption key file is missing or has changed), so it has to be added again. */
  unreadable = false;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly log: Logger,
  ) {
    if (cfg.openRouterApiKey) {
      this.use(cfg.openRouterApiKey, 'environment');
      return;
    }
    const sealed = db.getSetting(SETTING);
    if (sealed === undefined) return;
    const key = box.open(sealed);
    if (key) this.use(key, 'app');
    else this.unreadable = true;
  }

  /** For new games and the model list; null without a key. */
  get client(): OpenRouterClient | null {
    return this.current?.client ?? null;
  }

  status(): ApiKeyStatus {
    return this.current
      ? { set: true, source: this.current.source, last4: this.current.key.slice(-4) }
      : { set: false, source: null, last4: null };
  }

  /** Check a pasted key with OpenRouter, then save it and start using it. */
  async save(raw: unknown): Promise<ApiKeyStatus> {
    this.assertChangeable();
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) throw new HttpError(400, 'Paste your OpenRouter API key.');
    if (!KEY_SHAPE.test(key)) {
      throw new HttpError(400, "That doesn't look like an OpenRouter API key. They start with sk-or- (get one at openrouter.ai/keys).");
    }
    const check = await checkApiKey(this.cfg.openRouterBaseUrl, key);
    if (!check.ok && (check.status === 401 || check.status === 403)) {
      throw new HttpError(400, "OpenRouter didn't accept that key. Check you copied all of it, and that it hasn't been disabled or deleted.");
    }
    if (!check.ok) {
      this.log.warn({ status: check.status }, 'Could not check an OpenRouter API key');
      throw new HttpError(
        502,
        check.status
          ? `OpenRouter couldn't check the key just now (error ${check.status}). Try again in a moment.`
          : "Couldn't reach OpenRouter to check the key. Try again in a moment.",
      );
    }
    this.db.setSetting(SETTING, this.box.seal(key));
    this.use(key, 'app');
    this.unreadable = false;
    this.log.info({}, 'OpenRouter API key saved on the Settings page');
    return this.status();
  }

  remove(): ApiKeyStatus {
    this.assertChangeable();
    this.db.deleteSetting(SETTING);
    this.current = null;
    this.unreadable = false;
    this.log.info({}, 'OpenRouter API key deleted on the Settings page');
    return this.status();
  }

  private assertChangeable(): void {
    if (this.cfg.openRouterApiKey) {
      throw new HttpError(
        409,
        'The key comes from the OPENROUTER_API_KEY environment variable, which always wins. Change or remove it there and restart the server.',
      );
    }
  }

  private use(key: string, source: Source): void {
    const client = new OpenRouterClient({
      apiKey: key,
      baseUrl: this.cfg.openRouterBaseUrl,
      appUrl: this.cfg.publicUrl,
      appName: 'Golden Bots',
      timeoutMs: this.cfg.llmTimeoutMs,
      maxRetries: this.cfg.llmMaxRetries,
    });
    this.current = { key, source, client };
  }
}
