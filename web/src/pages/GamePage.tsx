import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatMoney, type GameEvent } from '@gb/shared';
import { ActionPanel } from '../components/ActionPanel';
import { BinOrWinBoard } from '../components/BinOrWinBoard';
import { Feed } from '../components/Feed';
import { FinalStage } from '../components/FinalStage';
import { ChatBox, FloorBanner } from '../components/OpenFloor';
import { Podium } from '../components/Podium';
import { api, ApiError, prefs } from '../lib/api';
import { buildView, STAGE_LABELS } from '../lib/gameState';
import { useGame } from '../lib/useGame';

/** Events that don't change anything on screen, so replays skip straight past them. */
const SILENT = new Set<GameEvent['type']>(['awaiting_input', 'input_received', 'vote_cast', 'chat_pass']);

function replayDelay(e: GameEvent, speed: number): number {
  const text =
    e.type === 'speech' || e.type === 'claim' ? e.say : e.type === 'host' ? e.text : e.type === 'thoughts' ? (e.thoughts ?? '') : '';
  return Math.min(6000, 700 + text.length * 22) / speed;
}

export function GamePage() {
  const { id = '' } = useParams();
  const game = useGame(id);
  const { detail, events } = game;

  const [showThoughts, setShowThoughts] = useState(() => prefs.get('thoughts', true));
  const [reveal, setReveal] = useState(() => prefs.get('reveal', false));
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const shown = useMemo(() => (cursor === null ? events : events.slice(0, cursor)), [events, cursor]);
  const view = useMemo(() => buildView(shown), [shown]);

  // Replay ticker.
  useEffect(() => {
    if (!playing || cursor === null) return;
    if (cursor >= events.length) {
      setPlaying(false);
      setCursor(null);
      return;
    }
    let next = cursor;
    while (next < events.length && (SILENT.has(events[next]!.type) || (!showThoughts && events[next]!.type === 'thoughts'))) {
      next++;
    }
    const e = events[next];
    const t = setTimeout(() => setCursor(next + 1), e ? replayDelay(e, speed) : 0);
    return () => clearTimeout(t);
  }, [playing, cursor, events, speed, showThoughts]);

  if (game.error) {
    return (
      <div className="page">
        <p className="error">Couldn't load this game: {game.error}</p>
        <Link to="/">Back to the studio</Link>
      </div>
    );
  }
  if (!detail) return <div className="page loading">Loading…</div>;

  const viewer = detail.viewer;
  const live = game.status === 'running';
  const replaying = cursor !== null;
  const mySeat = viewer.seat;
  const myAwaiting = !replaying && view.awaiting && view.awaiting.seat === mySeat ? view.awaiting : undefined;
  const thinking = live && !replaying ? game.waitingOn : [];
  const votingOpen = view.seats.some((s) => s.voted) && !view.votes;
  const cost = events.reduce((sum, e) => sum + (e.type === 'thoughts' ? (e.usage?.costUsd ?? 0) : 0), 0);

  const submit = async (response: unknown) => {
    if (!myAwaiting) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.act(id, myAwaiting.requestId, response);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!confirm('Stop this game? It will be marked as abandoned.')) return;
    try {
      await api.abort(id);
    } catch (err) {
      alert(err instanceof ApiError && err.status === 401 ? 'Unlock with the admin password on the home page first.' : String(err));
    }
  };

  return (
    <div className="page game">
      <div className="game__bar">
        <div className="game__title">
          <span className={`pill pill--${game.status}`}>{live ? 'Live' : game.status}</span>
          <h1>{STAGE_LABELS[view.stage]}</h1>
          {!detail.ranked && <span className="tag">practice</span>}
        </div>
        <div className="game__controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={showThoughts}
              onChange={(e) => {
                setShowThoughts(e.target.checked);
                prefs.set('thoughts', e.target.checked);
              }}
            />
            Show thoughts
          </label>
          <label className="toggle" title={viewer.omniscient ? '' : 'Hidden while a human is playing'}>
            <input
              type="checkbox"
              checked={reveal && viewer.omniscient}
              disabled={!viewer.omniscient}
              onChange={(e) => {
                setReveal(e.target.checked);
                prefs.set('reveal', e.target.checked);
              }}
            />
            Reveal hidden balls
          </label>
          {!live && (
            <span className="replay">
              {replaying ? (
                <>
                  <button className="btn btn--small" onClick={() => setPlaying((p) => !p)}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
                    {[0.5, 1, 2, 4].map((s) => (
                      <option key={s} value={s}>
                        {s}×
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn--small"
                    onClick={() => {
                      setPlaying(false);
                      setCursor(null);
                    }}
                  >
                    Skip to end
                  </button>
                </>
              ) : (
                <button
                  className="btn btn--small"
                  onClick={() => {
                    setCursor(1);
                    setPlaying(true);
                  }}
                >
                  ▶ Replay
                </button>
              )}
            </span>
          )}
          {live && (
            <button className="btn btn--small btn--ghost" onClick={stop}>
              Stop game
            </button>
          )}
        </div>
      </div>

      {!viewer.omniscient && (
        <p className="notice">
          A human is playing, so hidden balls and the AIs' private thoughts stay secret until the game ends.
          {mySeat !== undefined && ' You can see your own back row.'}
        </p>
      )}
      {live && !game.connected && <p className="notice">Reconnecting to the live game…</p>}

      <div className="game__layout">
        <div className="game__stage">
          {view.floor && <FloorBanner floor={view.floor} skewMs={game.clockSkewMs} live={live && !replaying} />}
          {(view.stage === 'intro' || view.stage === 'r1' || view.stage === 'r2') && (
            <div className="podiums">
              {view.seats.map((s) => (
                <Podium
                  key={s.info.seat}
                  seat={s}
                  reveal={reveal && viewer.omniscient}
                  isYou={s.info.seat === mySeat}
                  thinking={thinking.includes(s.info.seat)}
                  votingOpen={votingOpen}
                />
              ))}
            </div>
          )}

          {view.stage === 'bow' && view.board && (
            <BinOrWinBoard
              board={view.board}
              seats={view.seats}
              {...(myAwaiting?.request.kind === 'pick'
                ? {
                    picking: {
                      action: myAwaiting.request.action,
                      onPick: (index: number) => void submit({ index }),
                      busy,
                    },
                  }
                : {})}
            />
          )}

          {(view.stage === 'final' || view.stage === 'over') && view.final && (
            <FinalStage
              final={view.final}
              seats={view.seats}
              thinking={thinking}
              {...(myAwaiting?.request.kind === 'final_choice'
                ? { choosing: { onChoose: (choice: 'split' | 'steal') => void submit({ choice }), busy } }
                : {})}
            />
          )}

          {view.stage === 'over' && <Summary view={view} />}
          {view.error && <p className="error">The game stopped: {view.error}</p>}

          {myAwaiting && (
            <ActionPanel
              request={myAwaiting.request}
              players={view.players}
              myBack={mySeat !== undefined ? (view.seats[mySeat]?.back ?? null) : null}
              busy={busy}
              error={actionError}
              onSubmit={(r) => void submit(r)}
            />
          )}

          {live && !replaying && view.floor && mySeat !== undefined && view.floor.participants.includes(mySeat) && (
            <ChatBox gameId={id} floor={view.floor} mySeat={mySeat} players={view.players} skewMs={game.clockSkewMs} />
          )}

          <div className="game__meta">
            {viewer.omniscient && detail.players.some((p) => p.kind === 'ai') && (
              <span>
                API cost{live ? ' so far' : ''}: ${cost.toFixed(4)}
              </span>
            )}
            <span>Seed {detail.options.seed}</span>
            <span>{new Date(detail.createdAt).toLocaleString('en-GB')}</span>
          </div>
        </div>

        <aside className="game__feed">
          <Feed
            events={shown}
            players={view.players}
            showThoughts={showThoughts}
            reveal={reveal && viewer.omniscient}
            {...(mySeat !== undefined ? { viewerSeat: mySeat } : {})}
            {...(live && !replaying ? { activity: { seats: game.waitingOn, action: game.waitingAction } } : {})}
          />
        </aside>
      </div>
    </div>
  );
}

function Summary({ view }: { view: ReturnType<typeof buildView> }) {
  return (
    <section className="summary">
      <h2>Results</h2>
      <ol>
        {[...view.seats]
          .sort((a, b) => (b.winnings ?? -1) - (a.winnings ?? -1))
          .map((s) => (
            <li key={s.info.seat}>
              <strong>{s.info.name}</strong>{' '}
              {s.eliminatedStage
                ? `eliminated in round ${s.eliminatedStage === 'r1' ? 1 : 2}`
                : `chose ${s.finalChoice?.toUpperCase()} and won ${formatMoney(s.winnings ?? 0)}`}
            </li>
          ))}
      </ol>
      <Link className="btn btn--gold" to="/">
        Play again
      </Link>
    </section>
  );
}
