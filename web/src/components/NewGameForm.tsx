import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { DEFAULT_OPTIONS, type GameOptions, type ModelOption, type SeatSpec, type ServerInfo } from '@gb/shared';
import { adminKey, api, ApiError, playerToken } from '../lib/api';

interface SeatDraft {
  kind: 'ai' | 'human' | 'mock';
  model: string;
  name: string;
}

function describe(m: ModelOption | undefined): string {
  if (!m) return '';
  if (m.free) return 'Free (rate-limited)';
  if (m.promptPrice !== undefined && m.completionPrice !== undefined) {
    return `$${m.promptPrice.toFixed(2)} in / $${m.completionPrice.toFixed(2)} out per 1M tokens`;
  }
  return '';
}

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Four picks, repeating only if there are fewer than four to choose from. */
function lineup(pool: ModelOption[]): string[] {
  if (pool.length === 0) return [];
  const picks = shuffled(pool).slice(0, 4).map((m) => m.id);
  while (picks.length < 4) picks.push(picks[picks.length % pool.length]!);
  return picks;
}

const CHAT_LENGTHS = [0, 30, 60, 90, 120, 180];
const formatLength = (s: number) => (s === 0 ? 'No chat' : s < 120 ? `${s} seconds` : `${s / 60} minutes`);

export function NewGameForm({ info }: { info: ServerInfo }) {
  const navigate = useNavigate();
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [seats, setSeats] = useState<SeatDraft[] | null>(null);
  const [options, setOptions] = useState<Omit<GameOptions, 'seed'>>({ ...DEFAULT_OPTIONS });
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(!info.requiresAdmin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const all = models ?? [];
  const featured = useMemo(() => all.filter((m) => m.featured), [all]);
  const free = useMemo(() => all.filter((m) => m.free), [all]);
  const canAi = info.hasOpenRouterKey;
  const defaultMock = info.mockStrategies[0]?.id ?? 'mock/honest';

  useEffect(() => {
    api
      .models()
      .then((list) => list, () => [] as ModelOption[])
      .then((list) => {
        setModels(list);
        const featuredList = list.filter((m) => m.featured);
        const picks = info.hasOpenRouterKey ? lineup(featuredList.length >= 2 ? featuredList : list) : [];
        setSeats(
          Array.from({ length: 4 }, (_, i) =>
            picks[i]
              ? { kind: 'ai', model: picks[i]!, name: '' }
              : { kind: 'mock', model: info.mockStrategies[i % info.mockStrategies.length]?.id ?? defaultMock, name: '' },
          ),
        );
      });
  }, [info.mockStrategies, info.hasOpenRouterKey, defaultMock]);

  useEffect(() => {
    if (!info.requiresAdmin || !adminKey.get()) return;
    api.checkAdmin().then(
      () => setUnlocked(true),
      () => adminKey.set(''),
    );
  }, [info.requiresAdmin]);

  if (!seats) {
    return (
      <section className="card newgame">
        <h2>Set up a game</h2>
        <p className="muted">Finding available models…</p>
      </section>
    );
  }

  const update = (i: number, patch: Partial<SeatDraft>) =>
    setSeats((prev) => prev!.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const hasHuman = seats.some((s) => s.kind === 'human');

  const applyLineup = (pool: ModelOption[]) => {
    const picks = lineup(pool);
    let n = 0;
    setSeats((prev) => prev!.map((s) => (s.kind === 'human' ? s : { kind: 'ai', model: picks[n++]!, name: '' })));
  };

  const unlock = async () => {
    adminKey.set(password);
    try {
      await api.checkAdmin();
      setUnlocked(true);
      setError(null);
    } catch {
      adminKey.set('');
      setError('That password is not right.');
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const specs: SeatSpec[] = seats.map((s) =>
        s.kind === 'human' ? { kind: 'human', name: s.name || 'You' } : { kind: s.kind, model: s.model.trim() },
      );
      const res = await api.createGame({ seats: specs, options });
      if (res.playerToken) playerToken.set(res.id, res.playerToken);
      navigate(`/game/${res.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUnlocked(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };


  return (
    <section className="card newgame">
      <h2>Set up a game</h2>
      {!canAi ? (
        <p className="notice">
          The server has no <code>OPENROUTER_API_KEY</code>, so only the free mock players are available.
        </p>
      ) : all.length === 0 ? (
        <p className="notice">Couldn't load OpenRouter's model list. You can still type a model id.</p>
      ) : (
        <p className="muted small">
          {all.length} models on OpenRouter. Type to search, or paste any model id. Models marked free cost nothing but are
          rate-limited.
        </p>
      )}

      <datalist id="model-list">
        {all.map((m) => (
          <option key={m.id} value={m.id}>
            {m.free ? `${m.name} · free` : m.name}
          </option>
        ))}
      </datalist>

      <div className="seats">
        {seats.map((seat, i) => {
          const model = all.find((m) => m.id === seat.model);
          return (
            <div className="seat" key={i}>
              <span className="seat__num">{i + 1}</span>
              <select
                value={seat.kind}
                onChange={(e) => {
                  const kind = e.target.value as SeatDraft['kind'];
                  update(i, {
                    kind,
                    model: kind === 'mock' ? defaultMock : kind === 'ai' ? ((featured[i] ?? all[i] ?? all[0])?.id ?? '') : '',
                  });
                }}
                aria-label={`Seat ${i + 1} player type`}
              >
                <option value="ai" disabled={!canAi}>
                  AI model
                </option>
                <option value="human" disabled={hasHuman && seat.kind !== 'human'}>
                  You
                </option>
                <option value="mock">Mock bot (free)</option>
              </select>
              {seat.kind === 'ai' && (
                <div className="seat__model">
                  <input
                    list="model-list"
                    value={seat.model}
                    placeholder="Search OpenRouter models, e.g. anthropic/…"
                    onChange={(e) => update(i, { model: e.target.value })}
                    aria-label={`Seat ${i + 1} model`}
                  />
                  <small>{model ? [model.name, describe(model)].filter(Boolean).join(' · ') : seat.model ? 'Custom model id' : ''}</small>
                </div>
              )}
              {seat.kind === 'human' && (
                <input
                  value={seat.name}
                  maxLength={20}
                  placeholder="Your name"
                  onChange={(e) => update(i, { name: e.target.value })}
                  aria-label="Your name"
                />
              )}
              {seat.kind === 'mock' && (
                <select value={seat.model} onChange={(e) => update(i, { model: e.target.value })} aria-label={`Seat ${i + 1} mock bot`}>
                  {info.mockStrategies.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      {canAi && (
        <div className="newgame__row">
          <button type="button" className="btn btn--ghost btn--small" onClick={() => applyLineup(featured.length >= 2 ? featured : all)}>
            🎲 Random lineup
          </button>
          {free.length > 0 && (
            <button type="button" className="btn btn--ghost btn--small" onClick={() => applyLineup(free)}>
              Free lineup
            </button>
          )}
        </div>
      )}

      <details className="newgame__options">
        <summary>Game options</summary>
        <div className="options-grid">
          <label className="field">
            <span>Open-floor chat before each vote</span>
            <select value={options.chatSeconds} onChange={(e) => setOptions((o) => ({ ...o, chatSeconds: Number(e.target.value) }))}>
              {CHAT_LENGTHS.map((s) => (
                <option key={s} value={s}>
                  {formatLength(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Chat before Split or Steal</span>
            <select
              value={options.finalChatSeconds}
              onChange={(e) => setOptions((o) => ({ ...o, finalChatSeconds: Number(e.target.value) }))}
            >
              {CHAT_LENGTHS.map((s) => (
                <option key={s} value={s}>
                  {formatLength(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Most messages per chat (caps cost)</span>
            <select
              value={options.chatMaxMessages}
              onChange={(e) => setOptions((o) => ({ ...o, chatMaxMessages: Number(e.target.value) }))}
            >
              {[6, 8, 12, 16, 24].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Native reasoning (models that support it)</span>
            <select
              value={options.reasoningEffort}
              onChange={(e) => setOptions((o) => ({ ...o, reasoningEffort: e.target.value as GameOptions['reasoningEffort'] }))}
            >
              <option value="none">Model default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High (slower, pricier)</option>
            </select>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={options.revealModelNames}
              onChange={(e) => setOptions((o) => ({ ...o, revealModelNames: e.target.checked }))}
            />
            Contestants know which model each other is
          </label>
        </div>
      </details>

      {!unlocked ? (
        <form
          className="newgame__unlock"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <label className="field">
            <span>Admin password (games cost API credits)</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn btn--gold">Unlock</button>
        </form>
      ) : (
        <button
          className="btn btn--gold btn--big"
          disabled={busy || seats.some((s) => s.kind !== 'human' && !s.model.trim())}
          onClick={() => void start()}
        >
          {busy ? 'Starting…' : hasHuman ? 'Take your seat' : 'Start the show'}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
