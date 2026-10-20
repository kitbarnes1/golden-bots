import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, type ActionRequest, type Ball, type PlayerInfo } from '@gb/shared';
import { extractJson, interpret, LlmAgent, resolvePlayer } from '../src/agents/llm.js';
import { parseClaimValue, validateResponse } from '../src/engine/validate.js';
import type { ChatRequest, ChatResult, OpenRouterClient } from '../src/llm/openrouter.js';
import type { AgentContext } from '../src/agents/types.js';
import { systemPrompt, userPrompt } from '../src/agents/prompts.js';

const players: PlayerInfo[] = [
  { seat: 0, name: 'Claude Sonnet 4.5', kind: 'ai', model: 'anthropic/claude-sonnet-4.5' },
  { seat: 1, name: 'GPT-5', kind: 'ai', model: 'openai/gpt-5' },
  { seat: 2, name: 'Gemini 2.5 Pro', kind: 'ai', model: 'google/gemini-2.5-pro' },
  { seat: 3, name: 'Kit', kind: 'human' },
];

const ctx: AgentContext = {
  seat: 0,
  players,
  activeSeats: [0, 1, 2, 3],
  stage: 'r1',
  options: { ...DEFAULT_OPTIONS, seed: 1 },
  myFront: [{ id: 'a', kind: 'cash', value: 500 }, { id: 'b', kind: 'killer' }],
  myBack: [{ id: 'c', kind: 'cash', value: 5000 }, { id: 'd', kind: 'cash', value: 10 }],
  fronts: {},
  claims: {},
  events: [],
};

describe('response parsing', () => {
  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('```json\n{"say": "hi"}\n```')).toEqual({ say: 'hi' });
    expect(extractJson('Sure! {"a": {"b": "}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{"broken": ')).toBeNull();
  });

  it('parses claimed ball values', () => {
    expect(parseClaimValue('£5,000')).toBe(5000);
    expect(parseClaimValue('7.5k')).toBe(7500);
    expect(parseClaimValue('KILLER')).toBe('killer');
    expect(parseClaimValue(75_001)).toBeNull();
    expect(parseClaimValue(-5)).toBeNull();
    expect(parseClaimValue('lots')).toBeNull();
  });

  it('resolves player names loosely but unambiguously', () => {
    expect(resolvePlayer('GPT-5', [1, 2, 3], players)).toBe(1);
    expect(resolvePlayer('gemini 2.5 pro', [1, 2, 3], players)).toBe(2);
    expect(resolvePlayer('Gemini', [1, 2, 3], players)).toBe(2);
    expect(resolvePlayer('Claude Sonnet 4.5', [1, 2, 3], players)).toBeUndefined();
    expect(resolvePlayer(3, [1, 2, 3], players)).toBe(3);
  });

  it('maps model JSON onto validated responses', () => {
    const claimReq: ActionRequest = { kind: 'claim', stage: 'r1', backCount: 2 };
    const claim = validateResponse(claimReq, interpret(claimReq, { claimed_back_row: [5000, 'KILLER'], say: 'Hi' }, players));
    expect(claim).toEqual({ ok: true, value: { kind: 'claim', claim: [5000, 'killer'], say: 'Hi' } });

    const wrongCount = validateResponse(claimReq, interpret(claimReq, { claimed_back_row: [5000] }, players));
    expect(wrongCount.ok).toBe(false);

    const pickReq: ActionRequest = { kind: 'pick', action: 'win', available: [0, 4, 7] };
    expect(validateResponse(pickReq, interpret(pickReq, { ball: 5 }, players))).toEqual({
      ok: true,
      value: { kind: 'pick', index: 4 },
    });
    expect(validateResponse(pickReq, interpret(pickReq, { ball: 2 }, players)).ok).toBe(false);

    const finalReq: ActionRequest = { kind: 'final_choice' };
    expect(validateResponse(finalReq, interpret(finalReq, { choice: 'STEAL' }, players))).toEqual({
      ok: true,
      value: { kind: 'final_choice', choice: 'steal' },
    });
  });
});

describe('LlmAgent', () => {
  function fakeClient(replies: string[]): { client: OpenRouterClient; calls: ChatRequest[] } {
    const calls: ChatRequest[] = [];
    const client = {
      async chat(req: ChatRequest): Promise<ChatResult> {
        calls.push(structuredClone({ ...req, signal: undefined }));
        const content = replies.shift() ?? '';
        return { content, reasoning: 'native reasoning', usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001, latencyMs: 3 } };
      },
    } as unknown as OpenRouterClient;
    return { client, calls };
  }

  const meta = { requestId: 'r', signal: new AbortController().signal };

  it('returns a validated response with thoughts, reasoning and usage', async () => {
    const { client, calls } = fakeClient(['{"thoughts": "Gemini looks weak", "vote_for": "Gemini 2.5 Pro"}']);
    const agent = new LlmAgent(client, 'anthropic/claude-sonnet-4.5', { reasoningEffort: 'low', maxTokens: 1000, repairAttempts: 1 });
    const result = await agent.act({ kind: 'vote', stage: 'r1', candidates: [1, 2, 3] }, ctx, meta);
    expect(result.response).toEqual({ kind: 'vote', target: 2 });
    expect(result.thoughts).toBe('Gemini looks weak');
    expect(result.reasoning).toBe('native reasoning');
    expect(result.usage?.costUsd).toBeCloseTo(0.001);
    expect(calls[0]!.reasoningEffort).toBe('low');
    expect(calls[0]!.messages[0]!.content).toContain('Golden Balls');
  });

  it('asks again after an unusable reply, then gives up with usage attached', async () => {
    const { client, calls } = fakeClient(['I vote for GPT', '{"vote_for": "GPT-5"}']);
    const agent = new LlmAgent(client, 'x/y', { reasoningEffort: 'none', maxTokens: 1000, repairAttempts: 1 });
    const result = await agent.act({ kind: 'vote', stage: 'r1', candidates: [1, 2, 3] }, ctx, meta);
    expect(result.response).toEqual({ kind: 'vote', target: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.at(-1)!.content).toContain('could not be used');
    expect(result.usage?.promptTokens).toBe(20);

    const bad = fakeClient(['nope', 'still nope']);
    const agent2 = new LlmAgent(bad.client, 'x/y', { reasoningEffort: 'none', maxTokens: 1000, repairAttempts: 1 });
    await expect(agent2.act({ kind: 'final_choice' }, ctx, meta)).rejects.toMatchObject({
      name: 'AgentError',
      usage: { costUsd: 0.002 },
    });
  });

  it('builds prompts that include private info only for the right player', () => {
    const sys = systemPrompt(ctx);
    expect(sys).toContain('You are Claude Sonnet 4.5');
    expect(sys).toContain('Your goal is to leave with as much money as possible');
    const user = userPrompt({ kind: 'claim', stage: 'r1', backCount: 2 }, ctx);
    expect(user).toContain('Your back row (only you can see): £5,000 and £10');
    expect(user).toContain('"claimed_back_row"');
  });

  it('spells out Bin or Win, including the KILLERs a finalist can account for', () => {
    const killer = (id: string): Ball => ({ id, kind: 'killer' });
    const cash = (id: string, value: number): Ball => ({ id, kind: 'cash', value });
    const slots: (Ball | null)[] = Array.from({ length: 11 }, () => null);
    slots[3] = killer('won');
    const bow: AgentContext = {
      ...ctx,
      stage: 'bow',
      activeSeats: [0, 1],
      myFront: [],
      myBack: [],
      board: { slots, jackpot: 0, won: [killer('won')], binned: [] },
      events: [
        {
          type: 'round_started',
          stage: 'r2',
          dealt: [
            { seat: 0, front: [killer('k1'), cash('c1', 500)], backCount: 3 },
            { seat: 1, front: [cash('c2', 20), killer('k2')], backCount: 3 },
            { seat: 2, front: [cash('c3', 50), cash('c4', 75)], backCount: 3 },
          ],
          seq: 1,
          ts: 0,
          vis: 'public',
        },
        { type: 'back_row', stage: 'r2', seat: 0, back: [cash('c5', 10), killer('k3'), cash('c6', 1000)], seq: 2, ts: 0, vis: { seats: [0] } },
      ],
    };
    expect(systemPrompt(bow)).toContain('binning a KILLER is good news');
    const user = userPrompt({ kind: 'pick', action: 'bin', available: [0, 1, 2, 4] }, bow);
    // Mine 2 + GPT-5's front 1 + the extra 1 = 4 known; 1 won already.
    expect(user).toContain('2 among your 5 balls + 1 on GPT-5\'s front row + the extra one = 4');
    expect(user).toContain('1 has come out so far, so at least 3 are still in there');
    expect(user).toContain("Your old back row doesn't matter any more");
    expect(user).toContain('shared by you and GPT-5 until Split or Steal');
    expect(user).toContain('Choose a ball to BIN. It is thrown away and does not go into the jackpot');

    // With every known KILLER out, say so plainly rather than "at least 0".
    const cleared = { ...bow, board: { ...bow.board!, won: [killer('w1'), killer('w2')], binned: [killer('b1'), killer('b2')] } };
    expect(userPrompt({ kind: 'pick', action: 'win', available: [0] }, cleared)).toContain(
      "none that you know of are left, though GPT-5's 3 hidden balls could still hold some",
    );
  });
});
