import type { GameDetail } from './api.js';
import { cashTotal, claimIsTruthful, claimTotal } from './balls.js';
import type { GameEvent } from './events.js';
import { pairThoughts, type ThoughtEvent } from './thoughts.js';
import type { Ball, ClaimValue, DecisionPoint, FinalChoice, FinalOutcome, GameOptions, Stage } from './types.js';

// The public dataset: finished games turned into flat rows that load straight
// into Hugging Face `datasets`, pandas or DuckDB. Every row has every field
// (null where it doesn't apply), so each file has one schema.

/** A ball as the dataset stores it. `value` is null for a Killer. */
export interface DatasetBall {
  kind: 'cash' | 'killer';
  value: number | null;
}

export interface DatasetPlayer {
  seat: number;
  /** The name the other contestants saw ("Human" for a person). */
  name: string;
  kind: 'ai' | 'human';
  /** OpenRouter model id; null for a human. */
  model: string | null;
  model_label: string | null;
  eliminated_stage: 'r1' | 'r2' | null;
  reached_final: boolean;
  final_choice: FinalChoice | null;
  winnings: number;
  /** Back-row claims made, and how many matched the real balls. */
  claims: number;
  truthful_claims: number;
  /** Votes against them, tie-breaks included. */
  votes_received: number;
  /** Moves the game made for them after an unusable reply (or, for a human, when time ran out). */
  fallbacks: number;
  cost_usd: number;
}

export interface GameRow {
  game_id: string;
  created_at: string;
  finished_at: string | null;
  /** Model id by seat (null for a human seat). */
  models: (string | null)[];
  players: DatasetPlayer[];
  options: {
    chat_seconds: number;
    final_chat_seconds: number;
    reflect_seconds: number;
    chat_max_messages: number;
    reveal_model_names: boolean;
    reasoning_effort: GameOptions['reasoningEffort'];
    seed: number;
  };
  jackpot: number;
  outcome: FinalOutcome | null;
  finalists: number[];
  has_human: boolean;
  moves: number;
  cost_usd: number;
}

export type MoveKind = 'claim' | 'chat' | 'pass' | 'speak' | 'vote' | 'tie_decide' | 'pick' | 'final_choice' | 'interview';

/** Exit interview answers (what they said to the audience is the row's `say`). */
export interface DatasetInterview {
  when: 'eliminated' | 'final';
  claims_true: boolean | null;
  saw_it_coming: boolean | null;
  winner_pick: number | null;
  winner_pick_model: string | null;
  differently: string | null;
  planned: FinalChoice | 'undecided' | null;
  decided: DecisionPoint | null;
  why: string | null;
  trust: number | null;
  same_again: boolean | null;
}

/** An exit interview checked against what actually happened. */
export interface InterviewChecks {
  /** They made at least one false back-row claim. */
  lied: boolean;
  /**
   * Their answer to "were your claims the truth?", checked against their back rows:
   * truthful (said yes, and they were), lied_about_it (said yes, but they lied),
   * owned_up (said no, and they had lied) or false_confession (said no, but they were true).
   */
  claims_verdict: 'truthful' | 'lied_about_it' | 'owned_up' | 'false_confession' | null;
  /** Their pick for the biggest winner was right; null with no pick, or if nobody won anything. */
  winner_pick_right: boolean | null;
  final_choice: FinalChoice | null;
  /** Did what they said they planned at the start; null if undecided or no answer. */
  stuck_to_plan: boolean | null;
}

export interface MoveRow {
  game_id: string;
  /** Position in the game's event log, for ordering. */
  seq: number;
  stage: Stage;
  seat: number;
  player: string;
  kind: 'ai' | 'human';
  model: string | null;
  move: MoveKind;
  /** What they said out loud with the move. */
  say: string | null;
  /** A chat line aimed at one player. */
  to_seat: number | null;
  to_model: string | null;
  /** Chat moves: the chat after a vote, rather than before it. */
  after_vote: boolean | null;
  /** Claims: the front row everyone could see, the hidden back row, and what they said was on it. */
  front: DatasetBall[] | null;
  back: DatasetBall[] | null;
  claim: DatasetBall[] | null;
  truthful: boolean | null;
  /** Claims: cash in pounds and Killers on each row, so a lie's size and kind can be read off directly. */
  front_total: number | null;
  front_killers: number | null;
  back_total: number | null;
  back_killers: number | null;
  claim_total: number | null;
  claim_killers: number | null;
  /** Claims: 1 for the first to claim in the round, so later ones had heard the others first. */
  claim_order: number | null;
  /** Round 2 claims: their round 1 claim was shown to be false at the reveal. */
  lied_before: boolean | null;
  /** Claims: they were voted out that round (tie-breaks included), and the votes they got in its vote. */
  voted_out: boolean | null;
  votes_against: number | null;
  /** Votes and tie-breaks: who they voted out. */
  target_seat: number | null;
  target_model: string | null;
  /** Votes and tie-breaks: whether the target's claim that round was true (nobody knew until after the vote), and whether the target went out. */
  target_truthful: boolean | null;
  target_out: boolean | null;
  /** Bin or Win: which way they picked, and the ball. */
  pick: 'bin' | 'win' | null;
  ball: DatasetBall | null;
  choice: FinalChoice | null;
  /** Final choices and finalists' interviews: the other finalist, and what they chose. */
  opponent_seat: number | null;
  opponent_model: string | null;
  opponent_choice: FinalChoice | null;
  interview: DatasetInterview | null;
  interview_checks: InterviewChecks | null;
  /** The game made this move for them, after an unusable reply. */
  fallback: boolean;
  /** Private: what they were thinking, and the model's own reasoning trace if it gave one. */
  thoughts: string | null;
  reasoning: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
}

/**
 * Column types for the dataset card, so the Hugging Face viewer doesn't have to
 * guess (it can't from a column that's all null so far, such as `interview`).
 * A string is a type, `{ list }` a list, and any other object a struct.
 */
export type Feature = 'string' | 'int64' | 'float64' | 'bool' | { list: Feature } | { [field: string]: Feature };

const BALL_FEATURE = { kind: 'string', value: 'int64' } as const;

export const MOVE_FEATURES: Record<keyof MoveRow, Feature> = {
  game_id: 'string',
  seq: 'int64',
  stage: 'string',
  seat: 'int64',
  player: 'string',
  kind: 'string',
  model: 'string',
  move: 'string',
  say: 'string',
  to_seat: 'int64',
  to_model: 'string',
  after_vote: 'bool',
  front: { list: BALL_FEATURE },
  back: { list: BALL_FEATURE },
  claim: { list: BALL_FEATURE },
  truthful: 'bool',
  front_total: 'int64',
  front_killers: 'int64',
  back_total: 'int64',
  back_killers: 'int64',
  claim_total: 'int64',
  claim_killers: 'int64',
  claim_order: 'int64',
  lied_before: 'bool',
  voted_out: 'bool',
  votes_against: 'int64',
  target_seat: 'int64',
  target_model: 'string',
  target_truthful: 'bool',
  target_out: 'bool',
  pick: 'string',
  ball: BALL_FEATURE,
  choice: 'string',
  opponent_seat: 'int64',
  opponent_model: 'string',
  opponent_choice: 'string',
  interview: {
    when: 'string',
    claims_true: 'bool',
    saw_it_coming: 'bool',
    winner_pick: 'int64',
    winner_pick_model: 'string',
    differently: 'string',
    planned: 'string',
    decided: 'string',
    why: 'string',
    trust: 'int64',
    same_again: 'bool',
  } satisfies Record<keyof DatasetInterview, Feature>,
  interview_checks: {
    lied: 'bool',
    claims_verdict: 'string',
    winner_pick_right: 'bool',
    final_choice: 'string',
    stuck_to_plan: 'bool',
  } satisfies Record<keyof InterviewChecks, Feature>,
  fallback: 'bool',
  thoughts: 'string',
  reasoning: 'string',
  prompt_tokens: 'int64',
  completion_tokens: 'int64',
  cost_usd: 'float64',
  latency_ms: 'int64',
};

export const GAME_FEATURES: Record<keyof GameRow, Feature> = {
  game_id: 'string',
  created_at: 'string',
  finished_at: 'string',
  models: { list: 'string' },
  players: {
    list: {
      seat: 'int64',
      name: 'string',
      kind: 'string',
      model: 'string',
      model_label: 'string',
      eliminated_stage: 'string',
      reached_final: 'bool',
      final_choice: 'string',
      winnings: 'float64',
      claims: 'int64',
      truthful_claims: 'int64',
      votes_received: 'int64',
      fallbacks: 'int64',
      cost_usd: 'float64',
    } satisfies Record<keyof DatasetPlayer, Feature>,
  },
  options: {
    chat_seconds: 'int64',
    final_chat_seconds: 'int64',
    reflect_seconds: 'int64',
    chat_max_messages: 'int64',
    reveal_model_names: 'bool',
    reasoning_effort: 'string',
    seed: 'int64',
  } satisfies Record<keyof GameRow['options'], Feature>,
  jackpot: 'float64',
  outcome: 'string',
  finalists: { list: 'int64' },
  has_human: 'bool',
  moves: 'int64',
  cost_usd: 'float64',
};

/** The features as a dataset card's YAML writes them (`dataset_info: features:`), indented to sit under a config. */
export function featuresYaml(features: Record<string, Feature>, indent = '  '): string {
  const lines: string[] = [];
  const field = (name: string, f: Feature, pad: string) => {
    lines.push(`${pad}- name: ${name}`);
    body(f, `${pad}  `);
  };
  const body = (f: Feature, pad: string) => {
    if (typeof f === 'string') lines.push(`${pad}dtype: ${f}`);
    else if ('list' in f && Object.keys(f).length === 1) {
      const item = f.list as Feature;
      if (typeof item === 'string') lines.push(`${pad}list: ${item}`);
      else {
        lines.push(`${pad}list:`);
        for (const [n, sub] of Object.entries(item)) field(n, sub, pad);
      }
    } else {
      lines.push(`${pad}struct:`);
      for (const [n, sub] of Object.entries(f)) field(n, sub, pad);
    }
  };
  for (const [name, f] of Object.entries(features)) field(name, f, indent);
  return lines.join('\n');
}

export interface DatasetOptions {
  /** Keep games with a human player, with the human renamed "Human". Off by default. */
  includeHumans?: boolean;
}

export type DatasetResult = { game: GameRow; moves: MoveRow[] } | { skipped: string };

export const HUMAN_NAME = 'Human';

/** What the game asked for when each move was made, to tell a fallback move from a real one. */
const ASKED_FOR: Record<MoveKind, ThoughtEvent['action'][]> = {
  claim: ['claim'],
  chat: ['chat'],
  pass: ['chat'],
  speak: ['speak'],
  vote: ['vote'],
  tie_decide: ['tie_decide'],
  pick: ['pick'],
  final_choice: ['final_choice'],
  interview: ['interview'],
};

const ball = (b: Ball): DatasetBall => (b.kind === 'killer' ? { kind: 'killer', value: null } : { kind: 'cash', value: b.value });
const killers = (balls: Ball[]) => balls.filter((b) => b.kind === 'killer').length;
const claimed = (v: ClaimValue): DatasetBall => (v === 'killer' ? { kind: 'killer', value: null } : { kind: 'cash', value: v });
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Turn one game, as `GET /api/games/:id` returns it, into dataset rows: one for
 * the game and one per seat per move. Only finished games where every event can
 * be seen are kept. Games with mock players are test games and are left out, as
 * are games with a human unless `includeHumans` is set.
 */
export function datasetRows(detail: GameDetail, opts: DatasetOptions = {}): DatasetResult {
  if (detail.status !== 'finished') return { skipped: `not finished (${detail.status})` };
  if (!detail.viewer.omniscient) return { skipped: 'hidden events not visible' };
  if (detail.players.some((p) => p.kind === 'mock')) return { skipped: 'has mock players' };
  const humans = detail.players.filter((p) => p.kind === 'human');
  if (humans.length > 0 && !opts.includeHumans) return { skipped: 'has a human player' };

  const anonymise = humanScrubber(humans.map((h) => h.name));
  const text = (s: string | undefined | null) => (s ? anonymise(s) : null);
  const events = detail.events;
  const players = detail.players.map((p) => ({
    seat: p.seat,
    name: p.kind === 'human' ? HUMAN_NAME : p.name,
    kind: p.kind === 'human' ? ('human' as const) : ('ai' as const),
    model: p.kind === 'human' ? null : (p.model ?? null),
    model_label: p.kind === 'human' ? null : (p.modelLabel ?? null),
  }));
  const who = (seat: number) => players[seat]!;

  // What was dealt and what was revealed, looked up by "<stage>:<seat>", and who went out each round.
  const fronts = new Map<string, Ball[]>();
  const backs = new Map<string, Ball[]>();
  const truth = new Map<string, boolean>();
  /** Votes against each seat in each round's vote, by "<stage>:<seat>" (tie-breaks not included). */
  const roundVotes = new Map<string, number>();
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'round_started') for (const d of e.dealt) fronts.set(`${e.stage}:${d.seat}`, d.front);
    else if (e.type === 'back_row') backs.set(`${e.stage}:${e.seat}`, e.back);
    else if (e.type === 'eliminated') {
      truth.set(`${e.stage}:${e.seat}`, e.truthful);
      out.set(e.stage, e.seat);
    } else if (e.type === 'back_rows_revealed') for (const r of e.rows) truth.set(`${e.stage}:${r.seat}`, r.truthful);
    else if (e.type === 'votes_revealed') for (const v of e.votes) roundVotes.set(`${e.stage}:${v.target}`, (roundVotes.get(`${e.stage}:${v.target}`) ?? 0) + 1);
  }
  const claimsMade = new Map<string, number>();

  const { byMove } = pairThoughts(events);
  const reveal = events.findLast((e): e is Extract<GameEvent, { type: 'final_reveal' }> => e.type === 'final_reveal');
  /** The other finalist, and what they chose. */
  const opponentOf = (seat: number): Partial<MoveRow> => {
    const other = reveal?.choices.find((c) => c.seat !== seat);
    if (!reveal || !other || !reveal.choices.some((c) => c.seat === seat)) return {};
    return { opponent_seat: other.seat, opponent_model: who(other.seat).model, opponent_choice: other.choice };
  };
  const target = (stage: 'r1' | 'r2', seat: number): Partial<MoveRow> => ({
    target_seat: seat,
    target_model: who(seat).model,
    target_truthful: truth.get(`${stage}:${seat}`) ?? null,
    target_out: out.get(stage) === seat,
  });
  const payout = (seat: number) => detail.players[seat]?.winnings ?? 0;
  const topWinnings = Math.max(0, ...detail.players.map((p) => p.winnings));

  const moves: MoveRow[] = [];
  /** Seats whose last answer was unusable, and what they were asked for. */
  const failed = new Map<number, ThoughtEvent['action']>();
  let chat: { reflect: boolean } | null = null;
  /** Seats whose votes were already read out one by one this round. */
  const votesRead = new Set<string>();

  const add = (e: GameEvent, seat: number, stage: Stage, move: MoveKind, key: string, fields: Partial<MoveRow> = {}) => {
    const t = byMove.get(key);
    const p = who(seat);
    // A failed 'speak' leaves no move behind, so a failure only counts for the seat's next move.
    const asked = failed.get(seat);
    failed.delete(seat);
    const fallback = asked !== undefined && ASKED_FOR[move].includes(asked);
    moves.push({
      game_id: detail.id,
      seq: e.seq,
      stage,
      seat,
      player: p.name,
      kind: p.kind,
      model: p.model,
      move,
      say: null,
      to_seat: null,
      to_model: null,
      after_vote: null,
      front: null,
      back: null,
      claim: null,
      truthful: null,
      front_total: null,
      front_killers: null,
      back_total: null,
      back_killers: null,
      claim_total: null,
      claim_killers: null,
      claim_order: null,
      lied_before: null,
      voted_out: null,
      votes_against: null,
      target_seat: null,
      target_model: null,
      target_truthful: null,
      target_out: null,
      pick: null,
      ball: null,
      choice: null,
      opponent_seat: null,
      opponent_model: null,
      opponent_choice: null,
      interview: null,
      interview_checks: null,
      ...fields,
      fallback,
      thoughts: text(t?.thoughts),
      reasoning: text(t?.reasoning),
      prompt_tokens: t?.usage?.promptTokens ?? null,
      completion_tokens: t?.usage?.completionTokens ?? null,
      cost_usd: t?.usage?.costUsd ?? null,
      latency_ms: t?.usage?.latencyMs ?? null,
    });
  };
  const vote = (e: GameEvent, stage: 'r1' | 'r2', seat: number, voted: number, key: string) => add(e, seat, stage, 'vote', key, target(stage, voted));

  for (const e of events) {
    switch (e.type) {
      case 'agent_error':
        failed.set(e.seat, e.action);
        break;
      case 'chat_started':
        chat = { reflect: e.reflect === true };
        break;
      case 'chat_ended':
        chat = null;
        break;
      case 'claim': {
        const front = fronts.get(`${e.stage}:${e.seat}`) ?? [];
        const back = backs.get(`${e.stage}:${e.seat}`) ?? [];
        const order = (claimsMade.get(e.stage) ?? 0) + 1;
        claimsMade.set(e.stage, order);
        const before = truth.get(`r1:${e.seat}`);
        add(e, e.seat, e.stage, 'claim', `${e.seq}`, {
          say: text(e.say),
          front: front.map(ball),
          back: back.map(ball),
          claim: e.claim.map(claimed),
          truthful: truth.get(`${e.stage}:${e.seat}`) ?? claimIsTruthful(e.claim, back),
          front_total: cashTotal(front),
          front_killers: killers(front),
          back_total: cashTotal(back),
          back_killers: killers(back),
          claim_total: claimTotal(e.claim),
          claim_killers: e.claim.filter((v) => v === 'killer').length,
          claim_order: order,
          lied_before: e.stage === 'r2' && before !== undefined ? !before : null,
          voted_out: out.get(e.stage) === e.seat,
          votes_against: roundVotes.get(`${e.stage}:${e.seat}`) ?? 0,
        });
        break;
      }
      case 'speech':
        add(e, e.seat, e.stage, chat ? 'chat' : 'speak', `${e.seq}`, {
          say: text(e.say),
          to_seat: e.to ?? null,
          to_model: e.to === undefined ? null : who(e.to).model,
          after_vote: chat ? chat.reflect : null,
        });
        break;
      case 'chat_pass':
        add(e, e.seat, e.stage, 'pass', `${e.seq}`, { after_vote: chat ? chat.reflect : null });
        break;
      case 'vote_revealed':
        votesRead.add(`${e.stage}:${e.seat}`);
        vote(e, e.stage, e.seat, e.target, `${e.seq}`);
        break;
      case 'votes_revealed':
        // Games from before votes were read out one at a time only have this.
        for (const v of e.votes) if (!votesRead.has(`${e.stage}:${v.seat}`)) vote(e, e.stage, v.seat, v.target, `${e.seq}:${v.seat}`);
        break;
      case 'tie_decision':
        for (const d of e.decisions) {
          add(e, d.seat, e.stage, 'tie_decide', `${e.seq}:${d.seat}`, target(e.stage, d.target));
        }
        break;
      case 'ball_picked':
        add(e, e.seat, 'bow', 'pick', `${e.seq}`, { say: text(e.say), pick: e.action, ball: ball(e.ball) });
        break;
      case 'final_reveal':
        for (const c of e.choices) add(e, c.seat, 'final', 'final_choice', `${e.seq}:${c.seat}`, { choice: c.choice, ...opponentOf(c.seat) });
        break;
      case 'interview': {
        const a = e.answers;
        const wentOut = detail.players[e.seat]?.eliminatedStage;
        add(e, e.seat, e.when === 'final' || !wentOut ? 'final' : wentOut, 'interview', `${e.seq}`, {
          say: text(a.say),
          ...(e.when === 'final' ? opponentOf(e.seat) : {}),
          interview: {
            when: e.when,
            claims_true: a.claimsTrue ?? null,
            saw_it_coming: a.sawItComing ?? null,
            winner_pick: a.winnerPick ?? null,
            winner_pick_model: a.winnerPick == null ? null : (who(a.winnerPick)?.model ?? null),
            differently: text(a.differently),
            planned: a.planned ?? null,
            decided: a.decided ?? null,
            why: text(a.why),
            trust: a.trust ?? null,
            same_again: a.sameAgain ?? null,
          },
          interview_checks: checkInterview(e, events, reveal, payout, topWinnings),
        });
        break;
      }
      default:
        break;
    }
  }

  const count = (seat: number, test: (m: MoveRow) => boolean) => moves.filter((m) => m.seat === seat && test(m)).length;
  const votesAgainst = (seat: number) => moves.filter((m) => (m.move === 'vote' || m.move === 'tie_decide') && m.target_seat === seat).length;
  const game: GameRow = {
    game_id: detail.id,
    created_at: iso(detail.createdAt),
    finished_at: detail.finishedAt ? iso(detail.finishedAt) : null,
    models: players.map((p) => p.model),
    players: detail.players.map((s) => ({
      ...who(s.seat),
      eliminated_stage: s.eliminatedStage === 'r1' || s.eliminatedStage === 'r2' ? s.eliminatedStage : null,
      reached_final: s.reachedFinal,
      final_choice: s.finalChoice,
      winnings: s.winnings,
      claims: count(s.seat, (m) => m.move === 'claim'),
      truthful_claims: count(s.seat, (m) => m.move === 'claim' && m.truthful === true),
      votes_received: votesAgainst(s.seat),
      fallbacks: count(s.seat, (m) => m.fallback),
      cost_usd: s.costUsd,
    })),
    options: {
      chat_seconds: detail.options.chatSeconds,
      final_chat_seconds: detail.options.finalChatSeconds,
      reflect_seconds: detail.options.reflectSeconds,
      chat_max_messages: detail.options.chatMaxMessages,
      reveal_model_names: detail.options.revealModelNames,
      reasoning_effort: detail.options.reasoningEffort,
      seed: detail.options.seed,
    },
    jackpot: detail.jackpot ?? 0,
    outcome: reveal?.outcome ?? null,
    finalists: reveal ? reveal.choices.map((c) => c.seat) : [],
    has_human: humans.length > 0,
    moves: moves.length,
    cost_usd: detail.costUsd,
  };
  return { game, moves };
}

/** Check an exit interview against the back rows turned over after each vote, and the final. */
function checkInterview(
  e: Extract<GameEvent, { type: 'interview' }>,
  events: GameEvent[],
  reveal: Extract<GameEvent, { type: 'final_reveal' }> | undefined,
  payout: (seat: number) => number,
  topWinnings: number,
): InterviewChecks {
  const a = e.answers;
  const truths = events.flatMap((x) =>
    x.type === 'eliminated' && x.seat === e.seat
      ? [x.truthful]
      : x.type === 'back_rows_revealed'
        ? x.rows.filter((r) => r.seat === e.seat).map((r) => r.truthful)
        : [],
  );
  const lied = truths.some((t) => !t);
  const choice = reveal?.choices.find((c) => c.seat === e.seat)?.choice ?? null;
  const plan = a.planned === 'split' || a.planned === 'steal' ? a.planned : null;
  return {
    lied,
    claims_verdict:
      a.claimsTrue == null || truths.length === 0
        ? null
        : a.claimsTrue
          ? lied
            ? 'lied_about_it'
            : 'truthful'
          : lied
            ? 'owned_up'
            : 'false_confession',
    winner_pick_right: a.winnerPick == null || topWinnings <= 0 ? null : payout(a.winnerPick) === topWinnings,
    final_choice: choice,
    stuck_to_plan: plan && choice ? plan === choice : null,
  };
}

/** Swap a human player's name for "Human" wherever the models wrote it. */
function humanScrubber(names: string[]): (s: string) => string {
  // A name that's also an everyday word ("You") would mangle sentences, so it stays.
  const usable = names.filter((n) => n.trim().length > 1 && !COMMON_WORDS.has(n.trim().toLowerCase()));
  if (usable.length === 0) return (s) => s;
  const escaped = usable.map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  return (s) => s.replace(pattern, HUMAN_NAME);
}

const COMMON_WORDS = new Set(['you', 'me', 'i', 'we', 'player', 'human', 'host']);

export interface ModelStanding {
  model: string;
  label: string;
  games: number;
  finals: number;
  totalWinnings: number;
  avgWinnings: number;
  claims: number;
  truthfulClaims: number;
  splits: number;
  steals: number;
  votesReceived: number;
}

/** A leaderboard by model, added up from dataset game rows. Humans aren't on it. */
export function modelStandings(games: GameRow[]): ModelStanding[] {
  const rows = new Map<string, ModelStanding>();
  for (const g of games) {
    for (const p of g.players) {
      if (!p.model) continue;
      let r = rows.get(p.model);
      if (!r) {
        r = { model: p.model, label: p.model_label ?? p.model, games: 0, finals: 0, totalWinnings: 0, avgWinnings: 0, claims: 0, truthfulClaims: 0, splits: 0, steals: 0, votesReceived: 0 };
        rows.set(p.model, r);
      }
      r.games++;
      if (p.reached_final) r.finals++;
      r.totalWinnings += p.winnings;
      r.claims += p.claims;
      r.truthfulClaims += p.truthful_claims;
      if (p.final_choice === 'split') r.splits++;
      if (p.final_choice === 'steal') r.steals++;
      r.votesReceived += p.votes_received;
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, avgWinnings: r.totalWinnings / r.games }))
    .sort((a, b) => b.avgWinnings - a.avgWinnings || b.games - a.games || a.label.localeCompare(b.label));
}
