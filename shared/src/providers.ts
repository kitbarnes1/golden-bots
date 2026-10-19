/**
 * Where an AI contestant's model runs. A model reference carries its provider
 * as a prefix, so one string identifies a contestant everywhere (seats,
 * database, leaderboard):
 *   "anthropic/claude-sonnet-4.5"     OpenRouter (no prefix)
 *   "hf:Qwen/Qwen2.5-72B-Instruct"    Hugging Face Inference Providers
 *   "ollama:llama3.1:8b"              Ollama, running on your own machine
 */
export type ProviderId = 'openrouter' | 'huggingface' | 'ollama';

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  prefix: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  openrouter: { id: 'openrouter', label: 'OpenRouter', prefix: '' },
  huggingface: { id: 'huggingface', label: 'Hugging Face', prefix: 'hf:' },
  ollama: { id: 'ollama', label: 'Ollama', prefix: 'ollama:' },
};

export interface ModelRef {
  provider: ProviderId;
  /** The id the provider's own API expects. */
  model: string;
}

export function parseModelRef(ref: string): ModelRef {
  if (ref.startsWith(PROVIDERS.huggingface.prefix)) {
    return { provider: 'huggingface', model: ref.slice(PROVIDERS.huggingface.prefix.length) };
  }
  if (ref.startsWith(PROVIDERS.ollama.prefix)) {
    return { provider: 'ollama', model: ref.slice(PROVIDERS.ollama.prefix.length) };
  }
  return { provider: 'openrouter', model: ref };
}

export function toModelRef(provider: ProviderId, model: string): string {
  return PROVIDERS[provider].prefix + model;
}

const ORG_SLASH_MODEL = /^[\w.-]+\/[\w.:-]+$/;
const OLLAMA_TAG = /^[\w.\-/]+(:[\w.-]+)?$/;

/** Rough shape check, before we ask the provider. */
export function isValidModelRef(ref: string): boolean {
  const { provider, model } = parseModelRef(ref);
  if (!model || model.length > 200) return false;
  return provider === 'ollama' ? OLLAMA_TAG.test(model) : ORG_SLASH_MODEL.test(model);
}
