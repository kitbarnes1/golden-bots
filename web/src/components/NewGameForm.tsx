import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { GameOptions, ModelOption, SeatSpec, ServerInfo } from '@gb/shared';
import { adminKey, api, ApiError, playerToken } from '../lib/api';

interface SeatDraft {
  kind: 'ai' | 'human' | 'mock';
  model: string;
  name: string;
}

const price = (m?: ModelOption) =>
  m?.promptPrice !== undefined && m.completionPrice !== undefined
    ? `$${m.promptPrice.toFixed(2)} in / $${m.completionPrice.toFixed(2)} out per 1M tokens`
    : '';

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function NewGameForm({ info }: { info: ServerInfo }) {
  const navigate = useNavigate();
  const [models, setModels] = useState<ModelOption[]>([]);
  const featured = useMemo(() => models.filter((m) => m.featured), [models]);
  const canAi = info.hasOpenRouterKey;
  const defaultMock = info.mockStrategies[0]?.id ?? 'mock/honest';

  const [seats, setSeats] = useState<SeatDraft[]>(() =>
    Array.from({ length: 4 }, (_, i) => ({
      kind: canAi ? 'ai' : 'mock',
      model: canAi ? '' : (info.mockStrategies[i % info.mockStrategies.length]?.id ?? defaultMock),
      name: '',
    })),
  );
  const [options, setOptions] = useState<Omit<GameOptions, 'seed'>>({
    discussionPasses: 1,
    finalDiscussionPasses: 2,
    revealModelNames: true,
    reasoningEffort: 'none',
  });
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(!info.requiresAdmin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .models()
      .then((list) => {
        setModels(list);
        // Fill empty AI seats with a varied featured lineup.
        const picks = shuffled(list.filter((m) => m.featured));
        setSeats((prev) => prev.map((s, i) => (s.kind === 'ai' && !s.model ? { ...s, model: picks[i % Math.max(1, picks.length)]?.id ?? '' } : s)));
      })
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    if (!info.requiresAdmin || !adminKey.get()) return;
    api.checkAdmin().then(
      () => setUnlocked(true),
      () => adminKey.set(''),
    );
  }, [info.requiresAdmin]);

  const update = (i: number, patch: Partial<SeatDraft>) =>
    setSeats((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const hasHuman = seats.some((s) => s.kind === 'human');

  const randomLineup = () => {
    const picks = shuffled(featured.length >= 4 ? featured : models).slice(0, 4);
    setSeats((prev) => prev.map((s, i) => (s.kind === 'ai' ? { ...s, model: picks[i]?.id ?? s.model } : s)));
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
      {!canAi && (
        <p className="notice">
          The server has no <code>OPENROUTER_API_KEY</code>, so only the offline mock players are available.
        </p>
      )}

      <datalist id="model-list">
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </datalist>

      <div className="seats">
        {seats.map((seat, i) => {
          const model = models.find((m) => m.id === seat.model);
          return (
            <div className="seat" key={i}>
              <span className="seat__num">{i + 1}</span>
              <select
                value={seat.kind}
                onChange={(e) => {
                  const kind = e.target.value as SeatDraft['kind'];
                  update(i, {
                    kind,
                    model: kind === 'mock' ? defaultMock : kind === 'ai' ? (featured[i]?.id ?? '') : '',
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
                  <small>{model ? `${model.name} · ${price(model)}` : seat.model ? 'Custom model id' : ''}</small>
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

      <div className="newgame__row">
        {canAi && models.length > 0 && (
          <button type="button" className="btn btn--ghost btn--small" onClick={randomLineup}>
            🎲 Random lineup
          </button>
        )}
      </div>

      <details className="newgame__options">
        <summary>Game options</summary>
        <div className="options-grid">
          <label className="field">
            <span>Discussion before each vote</span>
            <select
              value={options.discussionPasses}
              onChange={(e) => setOptions((o) => ({ ...o, discussionPasses: Number(e.target.value) }))}
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'None' : `${n} round${n > 1 ? 's' : ''}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Split or Steal conversation</span>
            <select
              value={options.finalDiscussionPasses}
              onChange={(e) => setOptions((o) => ({ ...o, finalDiscussionPasses: Number(e.target.value) }))}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} exchange{n > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Native reasoning (supported models)</span>
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
        <button className="btn btn--gold btn--big" disabled={busy || seats.some((s) => s.kind !== 'human' && !s.model.trim())} onClick={() => void start()}>
          {busy ? 'Starting…' : hasHuman ? 'Take your seat' : 'Start the show'}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
