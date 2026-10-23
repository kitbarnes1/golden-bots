import type { GameEvent } from './events.js';
import type { FinalChoice, GameOptions, GameStatus, PlayerInfo, PlayerKind, Stage } from './types.js';

export interface SeatSpec {
  kind: PlayerKind;
  /** OpenRouter model id for 'ai', strategy id for 'mock'. */
  model?: string;
  /** Display name for a human player. */
  name?: string;
}

export interface CreateGameRequest {
  seats: SeatSpec[];
  options?: Partial<GameOptions>;
}

export interface CreateGameResponse {
  id: string;
  /** Present when a human seat was created: send it back to act and to see your own hidden balls. */
  playerToken?: string;
  seat?: number;
}

export interface GamePlayerSummary extends PlayerInfo {
  eliminatedStage: Stage | null;
  reachedFinal: boolean;
  finalChoice: FinalChoice | null;
  winnings: number;
  costUsd: number;
}

export interface GameSummary {
  id: string;
  createdAt: number;
  finishedAt: number | null;
  status: GameStatus;
  hasHuman: boolean;
  ranked: boolean;
  jackpot: number | null;
  costUsd: number;
  players: GamePlayerSummary[];
}

export interface GameDetail extends GameSummary {
  options: GameOptions;
  events: GameEvent[];
  viewer: { seat?: number; omniscient: boolean };
}

export interface LeaderboardRow {
  /** Model id for AI, "human:<name>" for people, mock strategy id for mocks. */
  key: string;
  label: string;
  kind: PlayerKind;
  games: number;
  finals: number;
  totalWinnings: number;
  avgWinnings: number;
  bestWin: number;
  r1Eliminations: number;
  r2Eliminations: number;
  splits: number;
  steals: number;
  /** Final outcomes from this player's point of view. */
  sharedPots: number;
  stoleWins: number;
  gotStolenFrom: number;
  mutualSteals: number;
  claims: number;
  truthfulClaims: number;
  votesReceived: number;
  invalidResponses: number;
  costUsd: number;
  lastPlayed: number;
}

export interface LeaderboardHistoryPoint {
  gameId: string;
  finishedAt: number;
  key: string;
  winnings: number;
}

export interface LeaderboardResponse {
  rows: LeaderboardRow[];
  history: LeaderboardHistoryPoint[];
  totalGames: number;
}

export interface ModelOption {
  /** OpenRouter model id, e.g. "anthropic/claude-sonnet-4.5". */
  id: string;
  name: string;
  /** Suggested in the picker and used for random lineups and autoplay. */
  featured: boolean;
  /** No charge to use (OpenRouter ":free" models, which are rate-limited). */
  free?: boolean;
  /** USD per million tokens, when known. */
  promptPrice?: number;
  completionPrice?: number;
  contextLength?: number;
  supportsReasoning?: boolean;
}

export interface MockStrategy {
  id: string;
  name: string;
  description: string;
}

export interface ServerInfo {
  hasOpenRouterKey: boolean;
  requiresAdmin: boolean;
  maxConcurrentGames: number;
  runningGames: number;
  mockStrategies: MockStrategy[];
}

/** The OpenRouter API key, as the Settings page sees it. The key itself never leaves the server. */
export interface ApiKeyStatus {
  /** A key is set, so AI contestants can play. */
  set: boolean;
  /** The server's OPENROUTER_API_KEY environment variable (which always wins), or saved on the Settings page. */
  source: 'environment' | 'app' | null;
  /** Its last 4 characters, to tell keys apart. */
  last4: string | null;
}

export interface HumanActionRequest {
  requestId: string;
  response: unknown;
}
