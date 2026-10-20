import type { ActionRequest } from '@gb/shared';
import { validateResponse } from '../engine/validate.js';
import { LlmError, type OpenRouterClient } from '../llm/openrouter.js';
import { extractJson, interpret } from './llm.js';

export interface ModelCheck {
  ok: boolean;
  /** Why it failed, for the logs. */
  reason?: string;
  /** Worth trying again soon (rate limited, busy, slow) rather than a hard no. */
  transient?: boolean;
}

const CLAIM: ActionRequest = { kind: 'claim', stage: 'r1', backCount: 2 };
const PROMPT = `You are a contestant on the British game show Golden Balls. Your hidden back row is £5,000 and a KILLER. Announce your back row to the other players: tell the truth or bluff.
Reply with one JSON object and nothing else: {"thoughts": "...", "claimed_back_row": [2 items, each a cash amount in pounds as a number like 5000, or "KILLER"], "say": "what you tell the others"}`;

/**
 * Asks a model one small game question and checks the answer with the game's
 * own parser, so models that can't play (refused, broken JSON, too slow) are
 * caught before they take a seat.
 */
export async function checkModel(client: OpenRouterClient, model: string, timeoutMs = 30_000): Promise<ModelCheck> {
  try {
    const res = await client.chat({
      model,
      messages: [{ role: 'user', content: PROMPT }],
      reasoningEffort: 'none',
      maxTokens: 1000,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = extractJson(res.content);
    if (!json) return { ok: false, reason: 'reply was not JSON' };
    const valid = validateResponse(CLAIM, interpret(CLAIM, json, [], -1));
    return valid.ok ? { ok: true } : { ok: false, reason: valid.error };
  } catch (err) {
    const fatal = err instanceof LlmError && err.fatal;
    return { ok: false, reason: err instanceof Error ? err.message : String(err), transient: !fatal };
  }
}
