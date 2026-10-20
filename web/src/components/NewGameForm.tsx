import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  DEFAULT_OPTIONS,
  ESTIMATE_RANGE,
  estimateSeatCost,
  formatUsd,
  type GameOptions,
  type ModelOption,
  type SeatSpec,
  type ServerInfo,
} from '@gb/shared';
import { api, ApiError, playerToken, prefs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ModelPicker, type PriceTier } from './ModelPicker';

interface SeatDraft {
  kind: 'ai' | 'human' | 'mock';
  model: string;
  name: string;
}

function describe(m: ModelOption | undefined, perGame: number | null): string {
  if (!m) return '';
  if (m.free) return 'Free (rate-limited)';
  if (m.promptPrice !== undefined && m.completionPrice !== undefined) {
    const price = `$${m.promptPrice.toFixed(2)} in / $${m.completionPrice.toFixed(2)} out per 1M tokens`;
    return perGame === null ? price : `about ${formatUsd(perGame)} a game · ${price}`;
  }
  return '';
}

/** The likely cost of the whole table, from each AI seat's model price and real games' token use. */
function TableCost({ costs, unknown }: { costs: number[]; unknown: number }) {
  if (!costs.length && !unknown) return null;
  const total = costs.reduce((a, c) => a + c, 0);
  const priced = costs.length > 0;
  const range =
    total > 0 ? ` (likely ${formatUsd(total * ESTIMATE_RANGE.low)} to ${formatUsd(total * ESTIMATE_RANGE.high)})` : '';
  return (
    <p className="newgame__cost" title="From each model's OpenRouter price and the tokens a seat used in real games. Long chats, reasoning and finalists' extra moves push it up.">
      {priced && total === 0 && !unknown ? (
        <>
          <strong>Free:</strong> every AI seat is a free model.
        </>
      ) : (
        <>
          <strong>Estimated cost:</strong> {priced ? `about ${formatUsd(total)}${range}` : 'unknown'}
          {unknown > 0 && `, plus ${unknown} seat${unknown === 1 ? '' : 's'} with no known price`}.
        </>
      )}
    </p>
  );
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
  const [options, setOptions] = useState<Omit<GameOptions, 'seed'>>(() => ({
    ...DEFAULT_OPTIONS,
    readAtMyPace: prefs.get('readAtMyPace', DEFAULT_OPTIONS.readAtMyPace),
  }));
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingFree, setCheckingFree] = useState(false);
  const [tier, setTier] = useState<PriceTier>('all');

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
  const aiCosts = seats.filter((s) => s.kind === 'ai' && s.model.trim()).map((s) => estimateSeatCost(all.find((m) => m.id === s.model), options));
  const knownCosts = aiCosts.filter((c): c is number => c !== null);

  const applyLineup = (pool: ModelOption[]) => {
    const picks = lineup(pool);
    // The counter lives inside the updater: React may run it twice (StrictMode).
    setSeats((prev) => {
      let n = 0;
      return prev!.map((s) => (s.kind === 'human' ? s : { kind: 'ai', model: picks[n++]!, name: '' }));
    });
  };

  // Only free models that just answered a test question, so a broken one can't stall the game.
  const freeLineup = async () => {
    setCheckingFree(true);
    setError(null);
    try {
      const working = await api.freeModels();
      if (working.length) applyLineup(working);
      else setError('No free models are answering properly right now. Try again in a few minutes.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        auth.refresh();
        setError('Log in first.');
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingFree(false);
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
      if (err instanceof ApiError && err.status === 401) {
        // The session has expired (or the password was changed).
        auth.refresh();
        setError('Your login has expired. Log in again to start a game.');
      } else setError(err instanceof Error ? err.message : String(err));
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
          {all.length} models on OpenRouter. Click a seat to search them, or paste any model id. Free models cost nothing
          but are rate-limited.
        </p>
      )}

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
                  <ModelPicker
                    value={seat.model}
                    models={all}
                    onChange={(id) => update(i, { model: id })}
                    label={`Seat ${i + 1} model`}
                    tier={tier}
                    onTier={setTier}
                  />
                  <small>{model ? describe(model, estimateSeatCost(model, options)) : seat.model ? 'Custom model id (no known price)' : ''}</small>
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

      {hasHuman && (
        <label className="toggle newgame__pace">
          <input
            type="checkbox"
            checked={options.readAtMyPace}
            onChange={(e) => {
              setOptions((o) => ({ ...o, readAtMyPace: e.target.checked }));
              prefs.set('readAtMyPace', e.target.checked);
            }}
          />
          <span>
            Read at my own pace <span className="muted small">(after each thing an AI says, the game waits for you to click Continue)</span>
          </span>
        </label>
      )}

      {canAi && (
        <div className="newgame__row">
          <button type="button" className="btn btn--ghost btn--small" onClick={() => applyLineup(featured.length >= 2 ? featured : all)}>
            🎲 Random lineup
          </button>
          {free.length > 0 && (
            <button type="button" className="btn btn--ghost btn--small" disabled={checkingFree} onClick={() => void freeLineup()}>
              {checkingFree ? 'Checking free models…' : 'Free lineup'}
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
            <span>Chat after each vote</span>
            <select value={options.reflectSeconds} onChange={(e) => setOptions((o) => ({ ...o, reflectSeconds: Number(e.target.value) }))}>
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
              <option value="none">Off (fastest)</option>
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

      <TableCost costs={knownCosts} unknown={aiCosts.length - knownCosts.length} />

      {auth.required === null ? null : !auth.canAdmin ? (
        <div className="newgame__login">
          <Link className="btn btn--gold btn--big" to="/login?next=/">
            Log in to start a game
          </Link>
          <p className="muted small">Games spend API credits, so starting one needs the admin login. Anyone can watch.</p>
        </div>
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
