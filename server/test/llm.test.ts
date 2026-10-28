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

  it('reads the private ratings with a vote, by name, and makes unusable ones null', () => {
    const voteReq: ActionRequest = { kind: 'vote', stage: 'r1', candidates: [1, 2, 3] };
    const read = (json: Record<string, unknown>) => validateResponse(voteReq, interpret(voteReq, { vote_for: 'GPT-5', ...json }, players, 0));
    expect(
      read({ ratings: { 'GPT-5': { believe: false, trust: 2 }, gemini: { believe: 'yes', trust: '4' }, Kit: 'high', Nobody: { trust: 5 } } }),
    ).toEqual({
      ok: true,
      value: {
        kind: 'vote',
        target: 1,
        ratings: [
          { seat: 1, believes: false, trust: 2 },
          { seat: 2, believes: true, trust: 4 },
          { seat: 3, believes: null, trust: null },
        ],
      },
    });
    // A list with names works too, and a bare number is a trust score.
    expect(read({ ratings: [{ name: 'Kit', believes_claim: true }, { player: 'GPT-5', trust: 3.4 }] })).toMatchObject({
      value: { ratings: [{ seat: 1, believes: null, trust: 3 }, { seat: 2, believes: null, trust: null }, { seat: 3, believes: true, trust: null }] },
    });
    expect(read({ ratings: { Kit: 1 } })).toMatchObject({ value: { ratings: [{ seat: 1, trust: null }, { seat: 2, trust: null }, { seat: 3, trust: 1 }] } });
    // Nothing usable, or nothing at all: the vote stands, with no ratings.
    for (const ratings of [undefined, 'all fine', { 'GPT-5': { believe: 'perhaps', trust: 'very' } }, { Claude: 5 }]) {
      expect(read({ ratings })).toEqual({ ok: true, value: { kind: 'vote', target: 1 } });
    }
    // But a vote for nobody is still no vote.
    expect(validateResponse(voteReq, interpret(voteReq, { vote_for: 'Nobody', ratings: { 'GPT-5': 3 } }, players, 0)).ok).toBe(false);
  });

  it('asks a voter to rate each candidate, by name', () => {
    const vote = userPrompt({ kind: 'vote', stage: 'r1', candidates: [1, 2, 3] }, ctx);
    for (const n of ['GPT-5', 'Gemini 2.5 Pro', 'Kit']) expect(vote).toContain(`"${n}": {"believe": true or false, "trust": 1 to 5}`);
    // Not for a tie-break.
    expect(userPrompt({ kind: 'tie_decide', stage: 'r1', candidates: [1, 2] }, ctx)).not.toContain('"ratings"');
  });

  // The LLM agent checks its own reply and the engine checks it again, so a checked
  // response has to pass a second time unchanged. Interviews once didn't, and every AI
  // interview was quietly dropped.
  it('passes a checked response again unchanged', () => {
    const cases: [ActionRequest, Record<string, unknown>][] = [
      [{ kind: 'claim', stage: 'r1', backCount: 2 }, { claimed_back_row: ['£5k', 'killer'], say: 'Trust me.' }],
      [{ kind: 'speak', stage: 'final', context: 'final_reaction', prompt: 'Any last words?' }, { say: 'Hello.' }],
      [{ kind: 'chat', stage: 'r1', secondsLeft: 30, participants: [0, 1, 2] }, { say: 'GPT-5, really?', to: 'GPT-5' }],
      [{ kind: 'vote', stage: 'r1', candidates: [1, 2] }, { vote_for: 'GPT-5' }],
      [{ kind: 'vote', stage: 'r1', candidates: [1, 2] }, { vote_for: 'GPT-5', ratings: { 'GPT-5': { believe: 'no', trust: '2' } } }],
      [{ kind: 'tie_decide', stage: 'r1', candidates: [1, 2] }, { eliminate: 'Gemini 2.5 Pro' }],
      [{ kind: 'pick', action: 'win', available: [0, 4, 7] }, { ball: 5, say: 'Five.' }],
      [{ kind: 'final_choice' }, { choice: 'split' }],
      [
        { kind: 'interview', when: 'eliminated', candidates: [1, 2], others: [1, 2, 3] },
        {
          say: 'Fair enough.',
          claims_were_true: 'No, I bluffed',
          saw_it_coming: true,
          will_win: 'GPT-5',
          would_do_differently: 'Lie less.',
          trust_each: { 'GPT-5': 2, 'Gemini 2.5 Pro': '4', Kit: 5 },
        },
      ],
      [
        { kind: 'interview', when: 'final', candidates: [], opponent: 1, others: [1, 2, 3] },
        {
          say: 'Done.',
          claims_were_true: true,
          planned_at_start: 'Steal',
          decided_when: 'round 2',
          why: 'Money.',
          trust: '4',
          same_again: 'yes',
          trust_each: [{ name: 'GPT-5', score: 3 }],
        },
      ],
    ];
    for (const [request, json] of cases) {
      const once = validateResponse(request, interpret(request, json, players, 0));
      expect(once.ok, request.kind).toBe(true);
      if (once.ok) expect(validateResponse(request, once.value), request.kind).toEqual(once);
    }
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
    expect(calls[0]!.messages[0]!.content).toContain('Golden Bots');
  });

  it("doesn't ask again over unusable ratings: the vote stands without them", async () => {
    const { client, calls } = fakeClient(['{"thoughts": "Hmm", "vote_for": "GPT-5", "ratings": {"GPT-5": "sketchy"}}']);
    const agent = new LlmAgent(client, 'anthropic/claude-sonnet-4.5', { reasoningEffort: 'none', maxTokens: 1000, repairAttempts: 1 });
    const result = await agent.act({ kind: 'vote', stage: 'r1', candidates: [1, 2, 3] }, ctx, meta);
    expect(result.response).toEqual({ kind: 'vote', target: 1 });
    expect(calls).toHaveLength(1);
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
    // Big claims grow the prize; the question is whether they're believable (not "dragging it down").
    expect(sys).toContain('Big cash claims are good news');
    expect(sys).toContain('only 9 are £20,000 or more');
    expect(sys).not.toMatch(/drag/i);
    const user = userPrompt({ kind: 'claim', stage: 'r1', backCount: 2 }, ctx);
    expect(user).toContain('Your back row (only you can see): £5,000 and £10');
    expect(user).toContain('"claimed_back_row"');
  });

  it("spells out Bin or Win, including exactly what's still in the machine", () => {
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
        {
          type: 'back_rows_revealed',
          stage: 'r2',
          rows: [
            { seat: 0, back: [cash('c5', 10), killer('k3'), cash('c6', 1000)], claim: [10, 5000, 1000], truthful: false },
            { seat: 1, back: [cash('c7', 75), cash('c8', 5000), killer('k4')], claim: [75, 5000, 'killer'], truthful: true },
          ],
          seq: 2,
          ts: 0,
          vis: 'public',
        },
      ],
    };
    expect(systemPrompt(bow)).toContain('binning a KILLER is good news');
    expect(systemPrompt(bow)).toContain("Then everyone's back row is revealed");
    const user = userPrompt({ kind: 'pick', action: 'bin', available: [0, 1, 2, 4] }, bow);
    // 10 finalist balls (4 KILLERs) + the extra KILLER, less the KILLER already won.
    expect(user).toContain('£10, £20, £75, £500, £1,000, £5,000 and 4 KILLERs (4 KILLERs among 10 balls)');
    expect(user).toContain("Your old back row doesn't matter any more");
    expect(user).toContain('shared by you and GPT-5 until Split or Steal');
    expect(user).toContain('Choose a ball to BIN. It is thrown away and does not go into the jackpot');
    expect(user).toContain('GPT-5 really had £75, £5,000 and KILLER (claimed £75, £5,000 and KILLER, so told the truth)');

    // The finalists' chat after the round 2 vote says what's next, and what the machine will hold.
    const afterVote = { ...bow, stage: 'r2' as const, board: undefined };
    const chat = userPrompt({ kind: 'chat', stage: 'r2', secondsLeft: 20, participants: [0, 1], reflect: true }, afterVote);
    expect(chat).toContain('you and GPT-5 are the finalists');
    expect(chat).toContain('pure luck');
    expect(chat).toContain('It will hold £10, £20, £75, £500, £1,000, £5,000 and 5 KILLERs (5 KILLERs among 11 balls)');
    // And Split or Steal says plainly that the balls are done with.
    const final = { ...bow, stage: 'final' as const, board: undefined, jackpot: 6000 };
    expect(userPrompt({ kind: 'final_choice' }, final)).toContain('no balls are in play any more');

    // If the numbers don't add up, it says nothing rather than something wrong.
    const odd = { ...bow, board: { ...bow.board!, won: [] } };
    expect(userPrompt({ kind: 'pick', action: 'win', available: [0] }, odd)).not.toContain('still in the machine');
  });
});
