import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Suggested contestants shown first in the model picker. Any OpenRouter model
 * id works; ids that OpenRouter doesn't list are hidden automatically.
 */
const DEFAULT_FEATURED = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'x-ai/grok-4',
  'x-ai/grok-4-fast',
  'deepseek/deepseek-chat-v3.1',
  'meta-llama/llama-4-maverick',
  'mistralai/mistral-medium-3.1',
  'qwen/qwen3-235b-a22b-2507',
  'moonshotai/kimi-k2',
];

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databasePath: process.env.DATABASE_PATH ?? path.resolve(here, '../../data/golden-balls.db'),
  /** Built web app. In the Docker image it sits next to the server bundle. */
  webDist: process.env.WEB_DIST ?? path.resolve(here, '../../web/dist'),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',

  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  llmMaxTokens: int('LLM_MAX_TOKENS', 4096),
  llmTimeoutMs: int('LLM_TIMEOUT_MS', 120_000),
  llmMaxRetries: int('LLM_MAX_RETRIES', 3),
  featuredModels: list('FEATURED_MODELS', DEFAULT_FEATURED),

  /** If set, starting/stopping/deleting games requires this password. Viewing is always public. */
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  maxConcurrentGames: int('MAX_CONCURRENT_GAMES', 3),
  humanTimeoutMs: int('HUMAN_TIMEOUT_MS', 15 * 60_000),
  mockDelayMs: int('MOCK_DELAY_MS', 600),

  /** Start an all-AI game every N minutes (0 = off) to grow the leaderboard. */
  autoplayIntervalMinutes: int('AUTOPLAY_INTERVAL_MINUTES', 0),
  /** Pool of models for autoplay lineups (defaults to the featured list). */
  autoplayModels: list('AUTOPLAY_MODELS', []),
};

export type Config = typeof config;
