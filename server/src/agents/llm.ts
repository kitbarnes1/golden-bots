import type { ActionRequest, PlayerInfo, Usage } from '@gb/shared';
import { validateResponse } from '../engine/validate.js';
import { LlmError, type ChatMessage, type OpenRouterClient } from '../llm/openrouter.js';
import { systemPrompt, userPrompt } from './prompts.js';
import { AgentError, type ActMeta, type Agent, type AgentContext, type AgentResult } from './types.js';

export interface LlmAgentOptions {
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  maxTokens: number;
  /** Extra attempts after an unusable reply. */
  repairAttempts: number;
}

/** A contestant played by a model on OpenRouter. */
export class LlmAgent implements Agent {
  constructor(
    private readonly client: OpenRouterClient,
    private readonly model: string,
    private readonly opts: LlmAgentOptions,
  ) {}

  async act(request: ActionRequest, ctx: AgentContext, meta: ActMeta): Promise<AgentResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(ctx) },
      { role: 'user', content: userPrompt(request, ctx) },
    ];
    let usage: Usage | undefined;
    let reasoning: string | undefined;
    let lastError = 'No reply';

    for (let attempt = 0; attempt <= this.opts.repairAttempts; attempt++) {
      let result;
      try {
        result = await this.client.chat({
          model: this.model,
          messages,
          reasoningEffort: this.opts.reasoningEffort,
          maxTokens: this.opts.maxTokens,
          signal: meta.signal,
        });
      } catch (err) {
        const fatal = err instanceof LlmError && err.fatal;
        throw new AgentError(err instanceof Error ? err.message : String(err), usage, reasoning, fatal);
      }
      usage = addUsage(usage, result.usage);
      reasoning = joinText(reasoning, result.reasoning);

      const parsed = extractJson(result.content);
      if (!parsed) {
        lastError = 'Reply was not a JSON object.';
      } else {
        const response = interpret(request, parsed, ctx.players, ctx.seat);
        const valid = validateResponse(request, response);
        if (valid.ok) {
          return {
            response: valid.value,
            ...(typeof parsed.thoughts === 'string' ? { thoughts: parsed.thoughts.trim() } : {}),
            ...(reasoning ? { reasoning } : {}),
            usage,
          };
        }
        lastError = valid.error;
      }
      messages.push(
        { role: 'assistant', content: result.content || '(empty reply)' },
        {
          role: 'user',
          content: `That reply could not be used: ${lastError} Reply again with only the JSON object described above.`,
        },
      );
    }
    throw new AgentError(`Unusable reply from ${this.model}: ${lastError}`, usage, reasoning);
  }
}

/** Map the model's JSON (which uses friendly field names) onto an ActionResponse shape. */
export function interpret(
  request: ActionRequest,
  json: Record<string, unknown>,
  players: PlayerInfo[],
  self = -1,
): Record<string, unknown> {
  switch (request.kind) {
    case 'claim':
      return { claim: json.claimed_back_row ?? json.claim, say: json.say };
    case 'speak':
      return { say: json.say };
    case 'chat': {
      const others = request.participants.filter((s) => s !== self);
      return { say: json.say, pass: json.pass === true, to: resolvePlayer(json.to, others, players) ?? null };
    }
    case 'vote':
      return { target: resolvePlayer(json.vote_for ?? json.vote ?? json.target, request.candidates, players) };
    case 'tie_decide':
      return { target: resolvePlayer(json.eliminate ?? json.vote_for ?? json.target, request.candidates, players) };
    case 'pick': {
      const n = typeof json.ball === 'string' ? Number(json.ball.replace(/\D/g, '')) : json.ball;
      return { index: typeof n === 'number' ? n - 1 : undefined, say: json.say };
    }
    case 'final_choice':
      return { choice: json.choice };
    case 'interview':
      return {
        say: json.say,
        claimsTrue: json.claims_were_true,
        sawItComing: json.saw_it_coming,
        winnerPick: resolvePlayer(json.will_win, request.candidates, players),
        differently: json.would_do_differently,
        planned: json.planned_at_start,
        decided: json.decided_when,
        why: json.why,
        trust: json.trust,
        trustEach: trustByName(json.trust_each, request.others, players),
        sameAgain: json.same_again,
      };
  }
}

/**
 * {"Name": 4, ...} (or a list of { name, score }) to [{ seat, score }]. Names that don't
 * match a player are left for the check to drop.
 */
function trustByName(value: unknown, others: number[], players: PlayerInfo[]): { seat: number | undefined; score: unknown }[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pairs: [unknown, unknown][] = Array.isArray(value)
    ? value.map((v) => {
        const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
        return [o.name ?? o.player, o.score ?? o.trust];
      })
    : Object.entries(value);
  return pairs.map(([who, score]) => ({ seat: resolvePlayer(who, others, players), score }));
}

/** Match a name (or seat number) given by a model to one of the candidate seats. */
export function resolvePlayer(value: unknown, candidates: number[], players: PlayerInfo[]): number | undefined {
  if (typeof value === 'number') return candidates.includes(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const wanted = normalise(value);
  const exact = candidates.find((s) => normalise(players[s]?.name ?? '') === wanted);
  if (exact !== undefined) return exact;
  const partial = candidates.filter((s) => {
    const n = normalise(players[s]?.name ?? '');
    return n && (wanted.includes(n) || n.includes(wanted));
  });
  return partial.length === 1 ? partial[0] : undefined;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Pull the first JSON object out of a reply, tolerating code fences and chatter. */
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const value = JSON.parse(cleaned.slice(start, i + 1)) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    costUsd: a.costUsd + b.costUsd,
    latencyMs: a.latencyMs + b.latencyMs,
  };
}

function joinText(a: string | undefined, b: string | undefined): string | undefined {
  if (!b) return a;
  return a ? `${a}\n\n${b}` : b;
}
