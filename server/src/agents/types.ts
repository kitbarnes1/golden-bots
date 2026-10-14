import type {
  ActionRequest,
  Ball,
  ClaimValue,
  GameEvent,
  GameOptions,
  PlayerInfo,
  Stage,
  Usage,
} from '@gb/shared';

/** Everything a contestant is allowed to know when asked to act. */
export interface AgentContext {
  seat: number;
  players: PlayerInfo[];
  activeSeats: number[];
  stage: Stage;
  options: GameOptions;
  /** Your own balls in the current elimination round (empty after round 2). */
  myFront: Ball[];
  myBack: Ball[];
  /** Front rows of all active players in the current elimination round. */
  fronts: Record<number, Ball[]>;
  /** Back-row claims made so far in the current elimination round. */
  claims: Record<number, ClaimValue[]>;
  /** Bin or Win board: null = still face down. */
  board?: { slots: (Ball | null)[]; jackpot: number; won: Ball[]; binned: Ball[] };
  jackpot?: number;
  /** Every event this seat is allowed to see, in order (including its own private notes). */
  events: GameEvent[];
}

export interface AgentResult {
  /** Untrusted until it has passed validateResponse. */
  response: unknown;
  thoughts?: string;
  reasoning?: string;
  usage?: Usage;
  /** Set when a human didn't answer in time and autopilot acted instead. */
  timedOut?: boolean;
}

export interface ActMeta {
  requestId: string;
  signal: AbortSignal;
}

export interface Agent {
  /** Humans get an awaiting_input event before act() is called. */
  readonly interactive?: boolean;
  act(request: ActionRequest, ctx: AgentContext, meta: ActMeta): Promise<AgentResult>;
}

/** Thrown by agents that failed but still spent money doing so. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly usage?: Usage,
    readonly reasoning?: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
