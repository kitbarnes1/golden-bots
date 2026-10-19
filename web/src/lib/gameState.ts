import type {
  ActionRequest,
  Ball,
  ClaimValue,
  FinalChoice,
  FinalOutcome,
  GameEvent,
  GameOptions,
  Payout,
  PlayerInfo,
} from '@gb/shared';

export type ViewStage = 'intro' | 'r1' | 'r2' | 'bow' | 'final' | 'over';

export interface SeatView {
  info: PlayerInfo;
  front: Ball[];
  /** Real back row, if this viewer is allowed to know it. */
  back: Ball[] | null;
  backCount: number;
  claim: ClaimValue[] | null;
  eliminatedStage: 'r1' | 'r2' | null;
  /** Back row revealed on elimination (public). */
  revealed?: { back: Ball[]; truthful: boolean };
  votesReceived: number;
  voted: boolean;
  choiceLocked: boolean;
  finalChoice?: FinalChoice;
  winnings?: number;
}

export interface BoardView {
  seats: [number, number];
  firstSeat: number;
  carried: Payout[];
  slots: (Ball | null)[];
  actions: ('bin' | 'win' | 'leftover' | null)[];
  won: Ball[];
  jackpot: number;
  done: boolean;
}

export interface FinalView {
  jackpot: number;
  seats: [number, number];
  outcome?: FinalOutcome;
  payouts?: Payout[];
}

export interface FloorView {
  stage: string;
  participants: number[];
  durationMs: number;
  /** Server clock. */
  endsAt: number;
  messages: number;
  maxMessages: number;
  /** The chat after a vote. */
  reflect: boolean;
}

export interface GameView {
  players: PlayerInfo[];
  /** An open-floor chat in progress. */
  floor?: FloorView;
  options?: GameOptions;
  seats: SeatView[];
  stage: ViewStage;
  votes?: { seat: number; target: number }[];
  board?: BoardView;
  final?: FinalView;
  awaiting?: { seat: number; requestId: string; request: ActionRequest };
  payouts?: Payout[];
  error?: string;
  /** Seat of the human everyone is waiting for, while the game is paused. */
  pausedFor?: number;
}

export function emptyView(): GameView {
  return { players: [], seats: [], stage: 'intro' };
}

/** Fold events into what the stage should show. Pure, so replays are just a slice of events. */
export function buildView(events: GameEvent[]): GameView {
  const v = emptyView();
  for (const e of events) apply(v, e);
  return v;
}

function apply(v: GameView, e: GameEvent): void {
  switch (e.type) {
    case 'game_started':
      v.players = e.players;
      v.options = e.options;
      v.seats = e.players.map((info) => ({
        info,
        front: [],
        back: null,
        backCount: 0,
        claim: null,
        eliminatedStage: null,
        votesReceived: 0,
        voted: false,
        choiceLocked: false,
      }));
      break;
    case 'round_started':
      v.stage = e.stage;
      v.votes = undefined;
      for (const s of v.seats) {
        s.claim = null;
        s.back = null;
        s.votesReceived = 0;
        s.voted = false;
        if (!s.eliminatedStage) {
          s.front = [];
          s.backCount = 0;
        }
      }
      for (const d of e.dealt) {
        const s = v.seats[d.seat]!;
        s.front = d.front;
        s.backCount = d.backCount;
      }
      break;
    case 'back_row':
      v.seats[e.seat]!.back = e.back;
      break;
    case 'claim':
      v.seats[e.seat]!.claim = e.claim;
      break;
    case 'vote_cast':
      v.seats[e.seat]!.voted = true;
      break;
    case 'votes_revealed':
      v.votes = e.votes;
      for (const { target } of e.votes) v.seats[target]!.votesReceived++;
      break;
    case 'eliminated': {
      const s = v.seats[e.seat]!;
      s.eliminatedStage = e.stage;
      s.revealed = { back: e.back, truthful: e.truthful };
      s.front = e.front;
      s.back = e.back;
      break;
    }
    case 'bin_or_win_started':
      v.stage = 'bow';
      v.board = {
        seats: e.seats,
        firstSeat: e.firstSeat,
        carried: e.carried,
        slots: Array.from({ length: e.ballCount }, () => null),
        actions: Array.from({ length: e.ballCount }, () => null),
        won: [],
        jackpot: 0,
        done: false,
      };
      for (const s of v.seats) {
        if (!s.eliminatedStage) {
          s.front = [];
          s.back = null;
          s.backCount = 0;
          s.claim = null;
        }
      }
      break;
    case 'ball_picked':
      if (v.board) {
        v.board.slots[e.index] = e.ball;
        v.board.actions[e.index] = e.action;
        if (e.action === 'win') v.board.won.push(e.ball);
        v.board.jackpot = e.jackpot;
      }
      break;
    case 'bin_or_win_finished':
      if (v.board) {
        v.board.slots[e.leftoverIndex] = e.leftover;
        v.board.actions[e.leftoverIndex] = 'leftover';
        v.board.jackpot = e.jackpot;
        v.board.done = true;
      }
      break;
    case 'final_started':
      v.stage = 'final';
      v.final = { jackpot: e.jackpot, seats: e.seats };
      break;
    case 'choice_locked':
      v.seats[e.seat]!.choiceLocked = true;
      break;
    case 'final_reveal':
      if (v.final) {
        v.final.outcome = e.outcome;
        v.final.payouts = e.payouts;
      }
      for (const c of e.choices) v.seats[c.seat]!.finalChoice = c.choice;
      for (const p of e.payouts) v.seats[p.seat]!.winnings = p.amount;
      break;
    case 'chat_started':
      v.floor = {
        stage: e.stage,
        participants: e.participants,
        durationMs: e.durationMs,
        endsAt: e.endsAt,
        messages: 0,
        maxMessages: e.maxMessages,
        reflect: e.reflect === true,
      };
      break;
    case 'speech':
      if (v.floor) v.floor.messages++;
      break;
    case 'chat_ended':
      v.floor = undefined;
      break;
    case 'game_over':
      v.stage = 'over';
      v.payouts = e.payouts;
      v.awaiting = undefined;
      break;
    case 'awaiting_input':
      v.awaiting = { seat: e.seat, requestId: e.requestId, request: e.request };
      break;
    case 'input_received':
      if (v.awaiting?.requestId === e.requestId) v.awaiting = undefined;
      break;
    case 'game_error':
      v.error = e.message;
      v.awaiting = undefined;
      v.pausedFor = undefined;
      break;
    case 'paused':
      v.pausedFor = e.seat;
      break;
    case 'resumed':
      v.pausedFor = undefined;
      // The chat clock stopped while they were away.
      if (v.floor) v.floor.endsAt += e.pausedMs;
      break;
    default:
      break;
  }
}

export const STAGE_LABELS: Record<ViewStage, string> = {
  intro: 'Welcome',
  r1: 'Round 1',
  r2: 'Round 2',
  bow: 'Bin or Win',
  final: 'Split or Steal',
  over: 'Game over',
};

/** Distinct, readable accent colours per seat. */
export const SEAT_COLORS = ['#6ec6ff', '#ff8fa3', '#9be37a', '#c9a0ff'];
