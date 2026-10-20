import type { ModelOption } from './api.js';
import type { GameOptions } from './types.js';

/**
 * Tokens one AI seat uses in a game with the default options, measured over
 * eight real games (October 2026): 42k-100k input, 2k-10k output. Input
 * dominates because every move sends the game so far; about half of it is
 * the open-floor chats.
 */
export const SEAT_TOKENS = { input: 75_000, output: 4_000, chatShare: 0.5 } as const;
/** How far real games strayed either side of the average. */
export const ESTIMATE_RANGE = { low: 0.55, high: 1.4 } as const;
/** Native reasoning adds hidden output tokens on models that support it (rough). */
const REASONING_OUTPUT = { none: 1, low: 3, medium: 6, high: 10 } as const;

type CostOptions = Pick<GameOptions, 'chatSeconds' | 'reflectSeconds' | 'finalChatSeconds' | 'chatMaxMessages' | 'reasoningEffort'>;

/**
 * Chat volume relative to the defaults: the message cap scales every chat;
 * turning one off removes its share (before-vote chats are the biggest part).
 */
function chatScale(o: CostOptions): number {
  const parts = (o.chatSeconds > 0 ? 0.55 : 0) + (o.reflectSeconds > 0 ? 0.2 : 0) + (o.finalChatSeconds > 0 ? 0.25 : 0);
  return (o.chatMaxMessages / 12) * parts;
}

/** Likely USD cost of one seat for a game, or null when the model's price isn't known. */
export function estimateSeatCost(model: ModelOption | undefined, options: CostOptions): number | null {
  if (!model) return null;
  if (model.free) return 0;
  if (model.promptPrice === undefined || model.completionPrice === undefined) return null;
  const scale = 1 - SEAT_TOKENS.chatShare + SEAT_TOKENS.chatShare * chatScale(options);
  const reasoning = model.supportsReasoning ? REASONING_OUTPUT[options.reasoningEffort] : 1;
  const input = SEAT_TOKENS.input * scale;
  const output = SEAT_TOKENS.output * scale * reasoning;
  return (input * model.promptPrice + output * model.completionPrice) / 1_000_000;
}

/** "$0.21", "$0.004", "under $0.001" */
export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.001) return 'under $0.001';
  if (v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}
