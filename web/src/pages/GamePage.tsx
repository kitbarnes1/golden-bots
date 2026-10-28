import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { GameEvent } from '@gb/shared';
import { ActionPanel } from '../components/ActionPanel';
import { BinOrWinBoard } from '../components/BinOrWinBoard';
import { ExitInterviews, finishingOrder, outcome } from '../components/ExitInterviews';
import { Feed } from '../components/Feed';
import { FinalStage } from '../components/FinalStage';
import { ChatBox, FloorBanner } from '../components/OpenFloor';
import { Podium } from '../components/Podium';
import { RoundsReview } from '../components/RoundsReview';
import { TableStrip } from '../components/TableStrip';
import { VoteTally } from '../components/VoteTally';
import { api, ApiError, prefs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { buildView, STAGE_LABELS } from '../lib/gameState';
import { useGame } from '../lib/useGame';

/** Events that don't change anything on screen, so replays skip straight past them. */
const SILENT = new Set<GameEvent['type']>(['awaiting_input', 'input_received', 'vote_cast', 'trust', 'chat_pass', 'paused', 'resumed']);

function replayDelay(e: GameEvent, speed: number): number {
  // The same suspense as live: a pause before each vote is read out.
  if (e.type === 'vote_revealed') return (e.index === e.total - 1 ? 3000 : 2000) / speed;
  const text =
    e.type === 'speech' || e.type === 'claim'
      ? e.say
      : e.type === 'host'
        ? e.text
        : e.type === 'thoughts'
          ? (e.thoughts ?? '')
          : e.type === 'interview'
            ? [e.answers.say, e.answers.why, e.answers.differently].join(' ')
            : '';
  return Math.min(6000, 700 + text.length * 22) / speed;
}

export function GamePage() {
  const { id = '' } = useParams();
  const game = useGame(id);
  const auth = useAuth();
  const { detail, events } = game;

  const [showThoughts, setShowThoughts] = useState(() => prefs.get('thoughts', true));
  const [reveal, setReveal] = useState(() => prefs.get('reveal', false));
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<'stage' | 'rounds' | 'interviews'>('stage');

  const shown = useMemo(() => (cursor === null ? events : events.slice(0, cursor)), [events, cursor]);
  const view = useMemo(() => buildView(shown), [shown]);

  // Reading at my own pace: the pause (if any) that's waiting for me to click Continue.
  const readingSeq =
    game.status === 'running' && cursor === null && view.pause?.reason === 'reading' && view.pause.seat === detail?.viewer.seat
      ? view.pause.seq
      : undefined;
  const sentFor = useRef<number | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const readOn = async (seq: number) => {
    if (sentFor.current === seq) return;
    sentFor.current = seq;
    setReadError(null);
    try {
      await api.continueReading(id);
    } catch (err) {
      // 409: it had already moved on (a reply counts as having read it, as does another tab).
      if (err instanceof ApiError && err.status === 409) return;
      sentFor.current = null;
      setReadError(err instanceof Error ? err.message : String(err));
    }
  };
  // Space or Enter carries on too, unless you're typing something or on another control.
  // An empty chat box has nothing to send, so there they carry on as well.
  useEffect(() => {
    if (readingSeq === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.key !== ' ' && e.key !== 'Enter') || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
        if (t.value !== '') return;
      } else if (t instanceof Element && t.closest('select, button, a, [contenteditable]')) return;
      e.preventDefault();
      void readOn(readingSeq);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingSeq]);

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

  const [feedBox, setFeedBox] = useState<HTMLElement | null>(null);
  useFillScreen(feedBox);

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
  const interviewCount = shown.filter((e) => e.type === 'interview').length;
  // The Interviews tab goes away if there's nothing in it (say, a replay starting again).
  const activeTab = tab === 'interviews' && interviewCount === 0 ? 'stage' : tab;
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
      alert(err instanceof ApiError && err.status === 401 ? 'Your login has expired. Log in again to stop games.' : String(err));
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
          {live && auth.canAdmin && (
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
      {live && viewer.omniscient && mySeat !== undefined && view.seats[mySeat]?.eliminatedStage && (
        <p className="notice">You're out, so now you can see everyone's hidden balls and private thoughts.</p>
      )}
      {live && !replaying && view.pause && view.pause.seat !== mySeat && (
        <p className="notice">
          {view.pause.reason === 'reading'
            ? `${view.players[view.pause.seat]?.name ?? 'The player'} is reading at their own pace. The game carries on when they click Continue.`
            : `Paused: waiting for ${view.players[view.pause.seat]?.name ?? 'the player'} to come back.`}
        </p>
      )}
      {live && !game.connected && <p className="notice">Reconnecting to the live game…</p>}

      <div className="game__layout">
        <div className="game__stage">
          <div className="tabs" role="tablist" aria-label="Game view">
            <button type="button" role="tab" className="tabs__tab" aria-selected={activeTab === 'stage'} onClick={() => setTab('stage')}>
              {live ? 'Live' : 'Stage'}
            </button>
            <button type="button" role="tab" className="tabs__tab" aria-selected={activeTab === 'rounds'} onClick={() => setTab('rounds')}>
              Rounds
            </button>
            {interviewCount > 0 && (
              <button type="button" role="tab" className="tabs__tab" aria-selected={activeTab === 'interviews'} onClick={() => setTab('interviews')}>
                Interviews <span className="tabs__count">{interviewCount}</span>
              </button>
            )}
          </div>
          {view.floor && (
            <FloorBanner
              floor={view.floor}
              skewMs={game.clockSkewMs}
              live={live && !replaying}
              {...(view.pause ? { stoppedAt: view.pause.since } : {})}
            />
          )}
          {activeTab === 'rounds' && (
            <RoundsReview
              events={shown}
              players={view.players}
              showHidden={viewer.omniscient && (reveal || !live)}
              {...(mySeat !== undefined ? { viewerSeat: mySeat } : {})}
            />
          )}
          {activeTab === 'stage' && (view.stage === 'r1' || view.stage === 'r2') && view.voteReading && (
            <VoteTally reading={view.voteReading} seats={view.seats} />
          )}
          {activeTab === 'stage' && (view.stage === 'intro' || view.stage === 'r1' || view.stage === 'r2') && (
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

          {activeTab === 'stage' && view.stage === 'bow' && view.board && (
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

          {activeTab === 'stage' && (view.stage === 'final' || view.stage === 'over') && view.final && (
            <FinalStage
              final={view.final}
              seats={view.seats}
              thinking={thinking}
              {...(myAwaiting?.request.kind === 'final_choice'
                ? { choosing: { onChoose: (choice: 'split' | 'steal') => void submit({ choice }), busy } }
                : {})}
            />
          )}

          {activeTab === 'interviews' && <ExitInterviews view={view} events={shown} showThoughts={showThoughts} />}
          {activeTab === 'stage' && view.stage === 'over' && <Summary view={view} interviews={interviewCount} onInterviews={() => setTab('interviews')} />}
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
            <ChatBox
              gameId={id}
              floor={view.floor}
              mySeat={mySeat}
              players={view.players}
              skewMs={game.clockSkewMs}
              {...(view.pause ? { stoppedAt: view.pause.since } : {})}
            />
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

        <aside className="game__feed" ref={setFeedBox}>
          <TableStrip
            view={view}
            reveal={reveal && viewer.omniscient}
            thinking={thinking}
            {...(mySeat !== undefined ? { mySeat } : {})}
          />
          <Feed
            events={shown}
            players={view.players}
            showThoughts={showThoughts}
            reveal={reveal && viewer.omniscient}
            {...(mySeat !== undefined ? { viewerSeat: mySeat } : {})}
            {...(live && !replaying ? { activity: { seats: game.waitingOn, action: game.waitingAction } } : {})}
            {...(readingSeq !== undefined
              ? {
                  footer: (
                    <>
                      <span className="muted small">{readError ?? 'Take your time. Nothing happens until you carry on.'}</span>
                      <button type="button" className="btn btn--gold btn--small" onClick={() => void readOn(readingSeq)}>
                        Continue <kbd>Space</kbd>
                      </button>
                    </>
                  ),
                }
              : {})}
          />
        </aside>
      </div>
    </div>
  );
}

function Summary({ view, interviews, onInterviews }: { view: ReturnType<typeof buildView>; interviews: number; onInterviews: () => void }) {
  return (
    <section className="summary">
      <h2>Results</h2>
      <ol>
        {finishingOrder(view.seats).map((s) => (
          <li key={s.info.seat}>
            <strong>{s.info.name}</strong> {outcome(s)}
          </li>
        ))}
      </ol>
      <div className="summary__actions">
        <Link className="btn btn--gold" to="/">
          Play again
        </Link>
        {/* Games from before the interviews started have none. */}
        {interviews > 0 && (
          <button type="button" className="btn" onClick={onInterviews}>
            Read the exit interviews
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Keeps `--fill-top` on a sticky panel set to where it starts on screen, so CSS can make it
 * reach just to the bottom of the screen however far down the notices above have pushed it.
 * As the page scrolls it rises until it sticks under the header, growing to fill the space.
 */
function useFillScreen(el: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!el) return;
    let frame = 0;
    const fit = () => {
      frame = 0;
      const style = getComputedStyle(el);
      if (style.position !== 'sticky') return; // narrow screens lay it out another way
      const top = Math.max(el.getBoundingClientRect().top, parseFloat(style.top) || 0);
      el.style.setProperty('--fill-top', `${Math.round(top)}px`);
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    const observer = new ResizeObserver(later);
    observer.observe(el.closest('.page') ?? document.body);
    window.addEventListener('scroll', later, { passive: true });
    window.addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
    };
  }, [el]);
}
