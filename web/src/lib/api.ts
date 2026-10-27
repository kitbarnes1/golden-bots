import type {
  ApiKeyStatus,
  CreateGameRequest,
  CreateGameResponse,
  GameDetail,
  GameSummary,
  LeaderboardResponse,
  ModelOption,
  ServerInfo,
} from '@gb/shared';

const tokenKey = (gameId: string) => `gb.token.${gameId}`;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode etc. Nothing to do.
  }
}

// Earlier versions kept the admin password in localStorage. Don't leave it lying around.
storageSet('gb.adminKey', null);

export const playerToken = {
  get: (gameId: string) => storageGet(tokenKey(gameId)) ?? undefined,
  set: (gameId: string, token: string) => storageSet(tokenKey(gameId), token),
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (json as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

export const api = {
  info: () => request<ServerInfo>('/api/info'),
  models: () => request<ModelOption[]>('/api/models'),
  /** Free models that just passed a quick check (admin only; can take ~30s). */
  freeModels: () => request<ModelOption[]>('/api/models/free'),
  /** Whether a login is needed to start games, and whether this browser has one (a session cookie). */
  session: () => request<{ required: boolean; loggedIn: boolean }>('/api/session'),
  login: (password: string) => request<{ ok: true }>('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  games: (limit = 30, offset = 0) => request<GameSummary[]>(`/api/games?limit=${limit}&offset=${offset}`),
  game: (id: string) => {
    const token = playerToken.get(id);
    return request<GameDetail>(`/api/games/${id}`, token ? { headers: { 'x-player-token': token } } : {});
  },
  createGame: (body: CreateGameRequest) =>
    request<CreateGameResponse>('/api/games', { method: 'POST', body: JSON.stringify(body) }),
  act: (id: string, requestId: string, response: unknown) =>
    request<{ ok: true }>(`/api/games/${id}/action`, {
      method: 'POST',
      headers: { 'x-player-token': playerToken.get(id) ?? '' },
      body: JSON.stringify({ requestId, response }),
    }),
  chat: (id: string, text: string, to: number | null) =>
    request<{ ok: true }>(`/api/games/${id}/chat`, {
      method: 'POST',
      headers: { 'x-player-token': playerToken.get(id) ?? '' },
      body: JSON.stringify({ text, to }),
    }),
  chatDone: (id: string) =>
    request<{ ok: true }>(`/api/games/${id}/chat/done`, {
      method: 'POST',
      headers: { 'x-player-token': playerToken.get(id) ?? '' },
    }),
  /** Reading at my own pace: I've read it, carry on. */
  continueReading: (id: string) =>
    request<{ ok: true }>(`/api/games/${id}/continue`, {
      method: 'POST',
      headers: { 'x-player-token': playerToken.get(id) ?? '' },
    }),
  abort: (id: string) => request<{ ok: true }>(`/api/games/${id}/abort`, { method: 'POST' }),
  remove: (id: string) => request<{ ok: true }>(`/api/games/${id}`, { method: 'DELETE' }),
  /** Admin only. Whether an OpenRouter key is set, where from, and its last 4 characters (never the key). */
  apiKey: () => request<ApiKeyStatus>('/api/settings/openrouter-key'),
  /** OpenRouter checks the key before the server saves it. */
  saveApiKey: (key: string) =>
    request<ApiKeyStatus>('/api/settings/openrouter-key', { method: 'PUT', body: JSON.stringify({ key }) }),
  deleteApiKey: () => request<ApiKeyStatus>('/api/settings/openrouter-key', { method: 'DELETE' }),
  leaderboard: (opts: { includeUnranked: boolean; includeHumans: boolean }) =>
    request<LeaderboardResponse>(
      `/api/leaderboard?includeUnranked=${opts.includeUnranked ? 1 : 0}&includeHumans=${opts.includeHumans ? 1 : 0}`,
    ),
  streamUrl: (id: string, after: number) => {
    const token = playerToken.get(id);
    return `/api/games/${id}/stream?after=${after}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  },
};

export const prefs = {
  get: (key: string, fallback: boolean) => {
    const v = storageGet(`gb.pref.${key}`);
    return v === null ? fallback : v === '1';
  },
  set: (key: string, value: boolean) => storageSet(`gb.pref.${key}`, value ? '1' : '0'),
  /** One of a fixed set of choices, falling back if the stored one isn't (or is no longer) allowed. */
  choice: <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = storageGet(`gb.pref.${key}`);
    return allowed.includes(v as T) ? (v as T) : fallback;
  },
  setChoice: (key: string, value: string) => storageSet(`gb.pref.${key}`, value),
};
