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
  /** Finals where they told the other finalist they'd split (read from the chat before the reveal), and how many of those they split in. */
  splitPromises: number;
  promisesKept: number;
  claims: number;
  truthfulClaims: number;
  votesReceived: number;
  invalidResponses: number;
  costUsd: number;
  lastPlayed: number;
  /** Exit interviews given. The pairs below are "asked" and "how many said so", for rates. */
  interviews: number;
  /** Interviews after a false back-row claim, and how many owned up to lying. */
  liedInterviews: number;
  ownedUp: number;
  /** Knocked out and asked "did you see it coming?", and the yeses. */
  sawItAsked: number;
  sawItComing: number;
  /** Picks for the biggest winner (in games where someone won money), and the right ones. */
  winnerPicks: number;
  winnerRight: number;
  /** Finalists who said what they planned at the start, and how many planned to steal. */
  plansGiven: number;
  plannedSteal: number;
  /** Finalists who planned to split or steal, and how many did what they planned. */
  planChecks: number;
  stuckToPlan: number;
  /** "Knowing what they chose, would you choose the same again?", and the yeses. */
  againAsked: number;
  sameAgain: number;
  /** Trust scores (1 to 5) given to the other finalist in Split or Steal: how many, and their total. */
  trustScores: number;
  trustTotal: number;
  /** Trust scores (1 to 5) they gave every other player in their exit interviews: how many, and their total. */
  trustGivenScores: number;
  trustGivenTotal: number;
  /** Trust scores the other players gave them in theirs. */
  trustReceivedScores: number;
  trustReceivedTotal: number;
  /** For AI models: who made it, where, whether the weights are open, and when it came out. */
  facts?: ModelFacts;
  /** For a group of contestants (by creator, country...): the ones in it. */
  members?: string[];
}

export interface ModelFacts {
  /** The creator's id: the first part of the model id, e.g. "openai". */
  lab: string;
  labName: string;
  /** Where the creator is based; null if we don't know. */
  country: string | null;
  /** Published weights (OpenRouter lists a Hugging Face repo); null if the model isn't in the catalogue. */
  openWeights: boolean | null;
  /** When OpenRouter added it (ms since 1970); null if unknown. */
  released: number | null;
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
  /** The weights are published (OpenRouter lists a Hugging Face repo for it). */
  openWeights?: boolean;
  /** When OpenRouter added it, ms since 1970. */
  released?: number;
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
