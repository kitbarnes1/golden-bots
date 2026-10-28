import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  datasetRows,
  featuresYaml,
  GAME_FEATURES,
  modelStandings,
  MOVE_FEATURES,
  type GameDetail,
  type GameEvent,
  type GameEventBody,
  type MoveRow,
} from '@gb/shared';

/** A real AI-only game from the live site, as `GET /api/games/:id` returned it. */
const sample = (): GameDetail => JSON.parse(readFileSync(new URL('./fixtures/sample-game.json', import.meta.url), 'utf8')) as GameDetail;

function rows(detail: GameDetail, opts = {}) {
  const result = datasetRows(detail, opts);
  if ('skipped' in result) throw new Error(`skipped: ${result.skipped}`);
  return result;
}
const ofMove = (moves: MoveRow[], move: MoveRow['move']) => moves.filter((m) => m.move === move);

/** Add events to the end of a game, numbered on from the last one. */
function append(detail: GameDetail, ...bodies: GameEventBody[]): GameDetail {
  const last = detail.events.at(-1)!;
  const events = bodies.map((b, i) => ({ ...b, seq: last.seq + 1 + i, ts: last.ts + i, vis: 'public' }) as GameEvent);
  return { ...detail, events: [...detail.events, ...events] };
}

describe('datasetRows', () => {
  it('makes one row per seat per move, each with the thinking behind it', () => {
    const { game, moves } = rows(sample());
    expect(ofMove(moves, 'claim')).toHaveLength(7);
    expect(ofMove(moves, 'vote')).toHaveLength(7); // read out one by one, and not counted again from the summary
    expect(ofMove(moves, 'chat')).toHaveLength(27);
    expect(ofMove(moves, 'speak')).toHaveLength(2); // the finalists' reactions
    expect(ofMove(moves, 'pass')).toHaveLength(4);
    expect(ofMove(moves, 'pick')).toHaveLength(10);
    expect(ofMove(moves, 'final_choice')).toHaveLength(2);
    expect(game.moves).toBe(moves.length);

    // Every thought in the game sits with a move, and only one.
    const thoughts = sample().events.filter((e) => e.type === 'thoughts');
    expect(moves.filter((m) => m.thoughts)).toHaveLength(thoughts.length);
    expect(new Set(moves.map((m) => m.thoughts)).size).toBe(thoughts.length);
    for (const m of moves) {
      expect(m.thoughts).not.toBeNull();
      expect(m.prompt_tokens).toBeGreaterThan(0);
    }
    expect(moves.map((m) => m.seq)).toEqual([...moves.map((m) => m.seq)].sort((a, b) => a - b));
  });

  it('puts each claim next to the real back row', () => {
    const { moves } = rows(sample());
    const [glm] = ofMove(moves, 'claim');
    expect(glm).toMatchObject({
      stage: 'r1',
      seat: 0,
      model: 'z-ai/glm-5.3-prime',
      front: [
        { kind: 'cash', value: 200 },
        { kind: 'cash', value: 10000 },
      ],
      back: [
        { kind: 'cash', value: 2000 },
        { kind: 'killer', value: null },
      ],
      claim: [
        { kind: 'cash', value: 20000 },
        { kind: 'cash', value: 5000 },
      ],
      truthful: false,
    });
    expect(glm!.say).toMatch(/£20,000/);
    expect(glm!.thoughts).toMatch(/KILLER and £2,000 hidden/);
    // The circumstances of the lie, ready to group by: it hid a Killer and added £23,000.
    expect(glm).toMatchObject({
      front_total: 10200,
      front_killers: 0,
      back_total: 2000,
      back_killers: 1,
      claim_total: 25000,
      claim_killers: 0,
      claim_order: 1,
      lied_before: null,
      voted_out: false,
      votes_against: 0,
    });
    const gpt = ofMove(moves, 'claim').find((c) => c.seat === 3)!;
    expect(gpt).toMatchObject({ claim_order: 4, voted_out: true, votes_against: 3 });
    // Everyone lied in round 1, and everyone knew it by round 2.
    expect(ofMove(moves, 'claim').filter((c) => c.stage === 'r2').map((c) => c.lied_before)).toEqual([true, true, true]);
    // Round 2 has three balls on the back row.
    expect(ofMove(moves, 'claim').filter((c) => c.stage === 'r2').every((c) => c.back!.length === 3)).toBe(true);
  });

  it('records votes, chat, picks and the final', () => {
    const { moves } = rows(sample());
    const r1 = ofMove(moves, 'vote').filter((v) => v.stage === 'r1');
    expect(r1.map((v) => [v.seat, v.target_seat]).sort()).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 2],
    ]);
    expect(r1.find((v) => v.seat === 3)).toMatchObject({ target_model: 'x-ai/grok-4.7', target_truthful: false, target_out: false });
    expect(r1.filter((v) => v.target_seat === 3).every((v) => v.target_out && v.target_truthful === false)).toBe(true);

    const chats = ofMove(moves, 'chat');
    expect(chats.filter((c) => c.to_seat !== null)).toHaveLength(16);
    expect(chats.filter((c) => c.to_seat !== null).every((c) => c.to_model === rows(sample()).game.models[c.to_seat!])).toBe(true);
    expect(chats.filter((c) => c.to_seat === null).every((c) => c.to_model === null)).toBe(true);
    expect(chats.some((c) => c.after_vote)).toBe(true);
    expect(ofMove(moves, 'speak').every((s) => s.stage === 'final' && s.after_vote === null)).toBe(true);

    const [first] = ofMove(moves, 'pick');
    expect(first).toMatchObject({ stage: 'bow', seat: 0, pick: 'bin', ball: { kind: 'killer', value: null } });

    expect(ofMove(moves, 'final_choice').map((m) => [m.seat, m.choice, m.opponent_model, m.opponent_choice])).toEqual([
      [0, 'steal', 'meta-llama/llama-4-maverick', 'split'],
      [1, 'split', 'z-ai/glm-5.3-prime', 'steal'],
    ]);
    // Only the final has an opponent.
    expect(moves.filter((m) => m.opponent_seat !== null).every((m) => m.move === 'final_choice')).toBe(true);
  });

  it('sums up the game', () => {
    const { game } = rows(sample());
    expect(game).toMatchObject({
      game_id: '36dfda6e-9df0-412c-8ec0-cf0df9b957b4',
      models: ['z-ai/glm-5.3-prime', 'meta-llama/llama-4-maverick', 'x-ai/grok-4.7', 'openai/gpt-6.1-terra-pro'],
      jackpot: 20020,
      outcome: 'one_steal',
      finalists: [0, 1],
      has_human: false,
      created_at: '2026-10-27T19:56:46.092Z',
    });
    expect(game.options).toMatchObject({ chat_seconds: 60, reasoning_effort: 'none', seed: 1133364286 });
    expect(game.players.map((p) => [p.eliminated_stage, p.winnings, p.claims, p.truthful_claims])).toEqual([
      [null, 20020, 2, 0],
      [null, 0, 2, 0],
      ['r2', 0, 2, 0],
      ['r1', 0, 1, 0],
    ]);
    expect(game.players.map((p) => p.votes_received)).toEqual([1, 0, 3, 3]);
  });

  it('pairs votes in games from before they were read out one at a time', () => {
    const old = sample();
    old.events = old.events.filter((e) => e.type !== 'vote_revealed');
    const votes = ofMove(rows(old).moves, 'vote');
    expect(votes).toHaveLength(7);
    expect(votes.every((v) => v.thoughts)).toBe(true);
  });

  it('marks moves the game made after an unusable reply', () => {
    const detail = sample();
    const claim = detail.events.findIndex((e) => e.type === 'claim' && e.seat === 2);
    detail.events.splice(claim, 0, { type: 'agent_error', seat: 2, action: 'claim', message: 'Reply was not a JSON object.', seq: -1, ts: 0, vis: 'public' });
    const { game, moves } = rows(detail);
    expect(ofMove(moves, 'claim').map((c) => c.fallback)).toEqual([false, false, true, false, false, false, false]);
    expect(moves.filter((m) => m.fallback)).toHaveLength(1);
    expect(game.players[2]!.fallbacks).toBe(1);
  });

  it('checks exit interviews against what happened', () => {
    const detail = append(
      sample(),
      // Knocked out in round 1 after a false claim, owns up, and backs the eventual winner.
      { type: 'interview', seat: 3, when: 'eliminated', answers: { say: 'I bluffed.', claimsTrue: false, sawItComing: true, winnerPick: 0, differently: 'Hide the Killer better.' } },
      // Says it told the truth, and planned to split; it lied and stole.
      { type: 'interview', seat: 0, when: 'final', answers: { say: 'No regrets.', claimsTrue: true, planned: 'split', decided: 'final_chat', why: 'Upside.', trust: 4, sameAgain: true } },
    );
    const interviews = ofMove(rows(detail).moves, 'interview');
    expect(interviews).toHaveLength(2);
    expect(interviews[0]).toMatchObject({
      stage: 'r1',
      seat: 3,
      say: 'I bluffed.',
      thoughts: null,
      opponent_seat: null,
      interview: { when: 'eliminated', claims_true: false, saw_it_coming: true, winner_pick: 0, winner_pick_model: 'z-ai/glm-5.3-prime', differently: 'Hide the Killer better.', planned: null, trust: null },
      interview_checks: { lied: true, claims_verdict: 'owned_up', winner_pick_right: true, final_choice: null, stuck_to_plan: null },
    });
    // A finalist's trust score sits next to who it was about, and what they really did.
    expect(interviews[1]).toMatchObject({
      stage: 'final',
      seat: 0,
      opponent_seat: 1,
      opponent_model: 'meta-llama/llama-4-maverick',
      opponent_choice: 'split',
      interview: { when: 'final', claims_true: true, planned: 'split', decided: 'final_chat', why: 'Upside.', trust: 4, same_again: true, winner_pick: null },
      interview_checks: { lied: true, claims_verdict: 'lied_about_it', winner_pick_right: null, final_choice: 'steal', stuck_to_plan: false },
    });
  });

  it('keeps how much each interviewee trusted the others, and averages it per player', () => {
    const detail = append(
      sample(),
      {
        type: 'interview',
        seat: 3,
        when: 'eliminated',
        answers: { say: 'Gone.', claimsTrue: true, trustEach: [{ seat: 0, score: 1 }, { seat: 1, score: 4 }, { seat: 2, score: 5 }] },
      },
      { type: 'interview', seat: 0, when: 'final', answers: { say: 'Done.', claimsTrue: true, trust: 2, trustEach: [{ seat: 1, score: 2 }, { seat: 3, score: 3 }] } },
    );
    const { game, moves } = rows(detail);
    const [out, finalist] = ofMove(moves, 'interview');
    expect(out!.interview!.trust_each).toEqual([
      { seat: 0, model: detail.players[0]!.model, score: 1, truthful: false },
      { seat: 1, model: detail.players[1]!.model, score: 4, truthful: false },
      { seat: 2, model: detail.players[2]!.model, score: 5, truthful: false },
    ]);
    // Split or Steal trust stays separate from trust over the game.
    expect(finalist!.interview).toMatchObject({ trust: 2, trust_each: [{ seat: 1, score: 2 }, { seat: 3, score: 3 }] });
    expect(game.players.map((p) => [p.trust_given, p.trust_received])).toEqual([
      [2.5, 1],
      [null, 3],
      [null, 5],
      [3.33, 3],
    ]);
  });

  it('keeps the thinking behind an interview answer', () => {
    const detail = append(
      sample(),
      { type: 'thoughts', stage: 'final', seat: 0, action: 'interview', thoughts: "Say I was honest; nobody can check now.", vis: { seats: [0] } } as GameEventBody,
      { type: 'interview', seat: 0, when: 'final', answers: { say: 'I played it straight.', claimsTrue: true } },
    );
    const [interview] = ofMove(rows(detail).moves, 'interview');
    expect(interview).toMatchObject({ thoughts: 'Say I was honest; nobody can check now.', interview_checks: { claims_verdict: 'lied_about_it' } });
  });

  it('leaves out games with a human, or includes them with the human anonymised', () => {
    const detail = sample();
    const human = { seat: 3, name: 'Kit', kind: 'human' as const };
    detail.hasHuman = true;
    detail.players[3] = { ...detail.players[3]!, ...human, model: undefined, modelLabel: undefined, costUsd: 0 };
    for (const e of detail.events) if (e.type === 'game_started') e.players[3] = human;
    detail.events = detail.events.filter((e) => !(e.type === 'thoughts' && e.seat === 3));
    for (const e of detail.events) if (e.type === 'speech' && e.seat === 0) e.say = `Kit, you're bluffing. ${e.say}`;

    expect(datasetRows(detail)).toEqual({ skipped: 'has a human player' });

    const { game, moves } = rows(detail, { includeHumans: true });
    expect(JSON.stringify({ game, moves })).not.toMatch(/Kit/);
    expect(game.has_human).toBe(true);
    expect(game.models[3]).toBeNull();
    expect(game.players[3]).toMatchObject({ name: 'Human', kind: 'human', model: null, model_label: null });
    const said = moves.filter((m) => m.seat === 3);
    expect(said.length).toBeGreaterThan(0);
    expect(said.every((m) => m.player === 'Human' && m.kind === 'human' && m.thoughts === null)).toBe(true);
    expect(moves.find((m) => m.seat === 0 && m.move === 'chat')!.say).toMatch(/^Human, you're bluffing\./);
  });

  it('skips unfinished games and games with mock players', () => {
    expect(datasetRows({ ...sample(), status: 'running' })).toEqual({ skipped: 'not finished (running)' });
    const mock = sample();
    mock.players[1] = { ...mock.players[1]!, kind: 'mock', model: 'mock/honest' };
    expect(datasetRows(mock)).toEqual({ skipped: 'has mock players' });
    expect(datasetRows({ ...sample(), viewer: { omniscient: false } })).toEqual({ skipped: 'hidden events not visible' });
  });
});

describe('a real game with exit interviews and a tie-break', () => {
  const detail = (): GameDetail => JSON.parse(readFileSync(new URL('./fixtures/game-with-interviews.json', import.meta.url), 'utf8')) as GameDetail;

  it('checks every interview, and ties trust scores to the other finalist', () => {
    const { moves } = rows(detail());
    const interviews = ofMove(moves, 'interview');
    expect(interviews.map((i) => [i.seat, i.interview!.when, i.interview_checks!.claims_verdict])).toEqual([
      [3, 'eliminated', 'owned_up'],
      [2, 'eliminated', 'owned_up'],
      [1, 'final', 'owned_up'],
      [0, 'final', 'owned_up'],
    ]);
    expect(interviews[0]).toMatchObject({ stage: 'r1', interview: { winner_pick: 2, winner_pick_model: 'dots-studio/dots-3-note-preview:free' }, interview_checks: { winner_pick_right: false } });
    // Planned to steal and trusted the other finalist 1 out of 5, but split at the last moment.
    expect(interviews[2]).toMatchObject({
      model: 'nvidia/nemotron-3.5-lightning:free',
      opponent_model: 'nvidia/nemotron-3.5-super-vl:free',
      opponent_choice: 'split',
      interview: { planned: 'steal', decided: 'last_moment', trust: 1 },
      interview_checks: { final_choice: 'split', stuck_to_plan: false },
    });
  });

  it('puts each private rating next to whether that player’s claims were really true', () => {
    const d = append(
      detail(),
      // With its round 1 vote, seat 1 believed seat 0, doubted seat 3, and said nothing usable about seat 2.
      { type: 'trust', stage: 'r1', seat: 1, ratings: [{ seat: 0, believes: true, trust: 4 }, { seat: 2, believes: null, trust: null }, { seat: 3, believes: false, trust: 1 }] },
      // In round 2 seat 0 told the truth and seat 2 lied; seat 1 believed them both.
      { type: 'trust', stage: 'r2', seat: 1, ratings: [{ seat: 0, believes: true, trust: 4 }, { seat: 2, believes: true, trust: 3 }] },
    );
    // Everyone lied in round 1 of this game; say seat 0 hadn't.
    const r1 = d.events.find((e): e is Extract<GameEvent, { type: 'back_rows_revealed' }> => e.type === 'back_rows_revealed' && e.stage === 'r1')!;
    r1.rows.find((r) => r.seat === 0)!.truthful = true;
    // And the two knocked out rated everyone else over the game.
    for (const e of d.events) {
      if (e.type === 'interview' && e.when === 'eliminated') e.answers.trustEach = [0, 1, 2, 3].filter((s) => s !== e.seat).map((seat) => ({ seat, score: 3 }));
    }

    const { moves } = rows(d);
    const votes = ofMove(moves, 'vote');
    expect(votes.find((v) => v.stage === 'r1' && v.seat === 1)!.ratings).toEqual([
      { seat: 0, model: 'nvidia/nemotron-3.5-super-vl:free', believed: true, trust: 4, truthful: true },
      { seat: 2, model: 'dots-studio/dots-3-note-preview:free', believed: null, trust: null, truthful: false },
      { seat: 3, model: 'nvidia/nemotron-3-ultra-550b-a55b:free', believed: false, trust: 1, truthful: false },
    ]);
    expect(votes.find((v) => v.stage === 'r2' && v.seat === 1)!.ratings).toEqual([
      { seat: 0, model: 'nvidia/nemotron-3.5-super-vl:free', believed: true, trust: 4, truthful: true },
      { seat: 2, model: 'dots-studio/dots-3-note-preview:free', believed: true, trust: 3, truthful: false },
    ]);
    // Each vote keeps its own ratings: the others gave none, and tie-breaks aren't rated.
    expect(moves.filter((m) => m.ratings).map((m) => [m.move, m.stage, m.seat])).toEqual([
      ['vote', 'r1', 1],
      ['vote', 'r2', 1],
    ]);
    // Trust over the game sits next to whether everything each player claimed, in the rounds the interviewee played, was true.
    const out = ofMove(moves, 'interview').filter((i) => i.interview!.when === 'eliminated');
    expect(out.map((i) => [i.seat, i.interview!.trust_each!.map((t) => [t.seat, t.truthful])])).toEqual([
      [3, [[0, true], [1, false], [2, false]]], // out in round 1: seat 0 had told the truth so far
      [2, [[0, true], [1, false], [3, false]]], // out in round 2: and again
    ]);
    // Games from before the ratings have none.
    expect(rows(sample()).moves.every((m) => m.ratings === null)).toBe(true);
  });

  it('records the tie-break, and who lied before', () => {
    const { moves } = rows(detail());
    const ties = ofMove(moves, 'tie_decide');
    expect(ties.map((t) => [t.seat, t.target_seat, t.target_out, t.target_truthful])).toEqual([
      [1, 3, true, false],
      [2, 3, true, false],
    ]);
    const r1 = ofMove(moves, 'claim').filter((c) => c.stage === 'r1');
    // Tied on two votes each; the tie-break sent seat 3 home.
    expect(r1.map((c) => [c.seat, c.votes_against, c.voted_out])).toEqual([
      [0, 2, false],
      [1, 0, false],
      [2, 0, false],
      [3, 2, true],
    ]);
    // Seat 0 lied in round 1 and told the truth in round 2.
    expect(ofMove(moves, 'claim').find((c) => c.stage === 'r2' && c.seat === 0)).toMatchObject({ lied_before: true, truthful: true });
  });
});

describe('the dataset card schema', () => {
  it('lists every column, in the order the rows have them', () => {
    const { game, moves } = rows(sample());
    expect(Object.keys(MOVE_FEATURES)).toEqual(Object.keys(moves[0]!));
    expect(Object.keys(GAME_FEATURES)).toEqual(Object.keys(game));
    expect(Object.keys((GAME_FEATURES.players as { list: object }).list)).toEqual(Object.keys(game.players[0]!));
    const rated = rows(append(sample(), { type: 'trust', stage: 'r1', seat: 0, ratings: [{ seat: 1, believes: true, trust: 3 }] })).moves.find((m) => m.ratings)!;
    expect(Object.keys((MOVE_FEATURES.ratings as { list: object }).list)).toEqual(Object.keys(rated.ratings![0]!));
  });

  it('writes the YAML the way Hugging Face does', () => {
    expect(featuresYaml({ seat: 'int64', back: { list: { kind: 'string' } }, models: { list: 'string' }, checks: { lied: 'bool' } })).toBe(
      [
        '  - name: seat',
        '    dtype: int64',
        '  - name: back',
        '    list:',
        '    - name: kind',
        '      dtype: string',
        '  - name: models',
        '    list: string',
        '  - name: checks',
        '    struct:',
        '    - name: lied',
        '      dtype: bool',
      ].join('\n'),
    );
  });
});

describe('modelStandings', () => {
  it('adds up each model across games', () => {
    const { game } = rows(sample());
    const standings = modelStandings([game, game]);
    expect(standings).toHaveLength(4);
    expect(standings[0]).toMatchObject({ model: 'z-ai/glm-5.3-prime', label: 'GLM 5.3 Prime', games: 2, finals: 2, totalWinnings: 40040, avgWinnings: 20020, steals: 2, claims: 4, truthfulClaims: 0 });
    expect(standings.find((s) => s.model === 'openai/gpt-6.1-terra-pro')).toMatchObject({ games: 2, finals: 0, votesReceived: 6 });
  });
});
