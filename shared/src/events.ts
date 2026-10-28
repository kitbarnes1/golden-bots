import type {
  ActionRequest,
  Ball,
  BinOrWin,
  ClaimValue,
  FinalChoice,
  FinalOutcome,
  GameOptions,
  InterviewAnswers,
  Payout,
  PlayerInfo,
  Stage,
  VoteRating,
} from './types.js';

/** 'public' = everyone; otherwise only the listed seats (plus omniscient spectators). */
export type Visibility = 'public' | { seats: number[] };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export type GameEventBody =
  | { type: 'game_started'; players: PlayerInfo[]; options: GameOptions }
  | { type: 'host'; text: string }
  | {
      type: 'round_started';
      stage: 'r1' | 'r2';
      dealt: { seat: number; front: Ball[]; backCount: number }[];
    }
  /** Private: a player peeks at their own back row. */
  | { type: 'back_row'; stage: 'r1' | 'r2'; seat: number; back: Ball[] }
  | { type: 'claim'; stage: 'r1' | 'r2'; seat: number; claim: ClaimValue[]; say: string }
  /** to = the seat being spoken to directly, if any. */
  | { type: 'speech'; stage: Stage; seat: number; say: string; to?: number }
  | {
      type: 'chat_started';
      stage: Stage;
      participants: number[];
      durationMs: number;
      /** Server clock, ms. */
      endsAt: number;
      maxMessages: number;
      /** The chat after a vote, rather than the one before it. */
      reflect?: boolean;
    }
  | { type: 'chat_pass'; stage: Stage; seat: number }
  | { type: 'chat_ended'; stage: Stage; reason: ChatEndReason }
  /** Private: what a model was thinking when it acted. */
  | {
      type: 'thoughts';
      stage: Stage;
      seat: number;
      action: ActionRequest['kind'];
      thoughts?: string;
      reasoning?: string;
      usage?: Usage;
    }
  /** Private: with their vote, an AI says whether it believes each other player's claim, and how far it trusts them. */
  | { type: 'trust'; stage: 'r1' | 'r2'; seat: number; ratings: VoteRating[] }
  | { type: 'vote_cast'; stage: 'r1' | 'r2'; seat: number }
  /** One vote read out, as on the show: `index` of `total`, with a pause before each. `votes_revealed` follows the last. */
  | { type: 'vote_revealed'; stage: 'r1' | 'r2'; seat: number; target: number; index: number; total: number }
  | {
      type: 'votes_revealed';
      stage: 'r1' | 'r2';
      votes: { seat: number; target: number }[];
    }
  | { type: 'tie'; stage: 'r1' | 'r2'; tied: number[]; deciders: number[] }
  | {
      type: 'tie_decision';
      stage: 'r1' | 'r2';
      decisions: { seat: number; target: number }[];
      consensus: number | null;
    }
  | { type: 'tie_draw'; stage: 'r1' | 'r2'; draws: { seat: number; ball: Ball }[] }
  | {
      type: 'eliminated';
      stage: 'r1' | 'r2';
      seat: number;
      front: Ball[];
      back: Ball[];
      claim: ClaimValue[];
      truthful: boolean;
    }
  /** As on the show: once the vote is settled, the players staying in show their back rows too. */
  | {
      type: 'back_rows_revealed';
      stage: 'r1' | 'r2';
      rows: { seat: number; back: Ball[]; claim: ClaimValue[]; truthful: boolean }[];
    }
  | {
      type: 'bin_or_win_started';
      seats: [number, number];
      ballCount: number;
      carried: Payout[];
      firstSeat: number;
    }
  | {
      type: 'ball_picked';
      seat: number;
      action: BinOrWin;
      index: number;
      ball: Ball;
      jackpot: number;
      say?: string;
    }
  | { type: 'bin_or_win_finished'; jackpot: number; leftoverIndex: number; leftover: Ball }
  | { type: 'final_started'; jackpot: number; seats: [number, number] }
  | { type: 'choice_locked'; seat: number }
  | {
      type: 'final_reveal';
      choices: { seat: number; choice: FinalChoice }[];
      outcome: FinalOutcome;
      payouts: Payout[];
    }
  /** A contestant's exit interview: as they go out, or after the final. */
  | { type: 'interview'; seat: number; when: 'eliminated' | 'final'; answers: InterviewAnswers }
  | { type: 'game_over'; payouts: Payout[]; jackpot: number }
  /** Private: a human player is being asked to act. */
  | { type: 'awaiting_input'; seat: number; requestId: string; request: ActionRequest }
  | { type: 'input_received'; seat: number; requestId: string }
  | { type: 'agent_error'; seat: number; action: ActionRequest['kind']; message: string }
  /** The human in `seat` left the game page; nothing happens until they're back. */
  | { type: 'paused'; seat: number; reason?: PauseReason }
  | { type: 'resumed'; seat: number; pausedMs: number }
  | { type: 'game_error'; message: string };

export type ChatEndReason = 'time' | 'quiet' | 'limit';

/** Why a game is paused: the human player left the page, or is reading at their own pace. */
export type PauseReason = 'away' | 'reading';

export type GameEventType = GameEventBody['type'];

export type GameEvent = GameEventBody & { seq: number; ts: number; vis: Visibility };

export interface Viewer {
  /** The seat this viewer plays, if any. */
  seat?: number;
  /** Sees everything: hidden balls and every model's private thoughts. */
  omniscient: boolean;
}

export function canSee(event: { vis: Visibility }, viewer: Viewer): boolean {
  if (viewer.omniscient || event.vis === 'public') return true;
  return viewer.seat !== undefined && event.vis.seats.includes(viewer.seat);
}

/** Ephemeral, non-persisted messages pushed over the live stream. */
export type LiveStatus =
  | { type: 'status'; waitingOn: number[]; action: ActionRequest['kind'] | null }
  | { type: 'game_status'; status: string };
