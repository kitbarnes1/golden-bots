import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  claimIsTruthful,
  formatMoney,
  pairThoughts,
  type Ball as BallT,
  type GameEvent,
  type PlayerInfo,
  type ThoughtEvent,
} from '@gb/shared';
import { SEAT_COLORS } from '../lib/gameState';
import { Ball } from './Ball';
import { InterviewAnswers } from './Interview';
import { PlayerCard } from './PlayerCard';

interface Props {
  events: GameEvent[];
  players: PlayerInfo[];
  showThoughts: boolean;
  reveal: boolean;
  viewerSeat?: number;
  /** Who's working on a move right now (live games only). */
  activity?: { seats: number[]; action: string | null };
  /** Pinned to the bottom of the feed, under the newest line (the Continue button when reading at your own pace). */
  footer?: ReactNode;
}

const CHAT_END_TEXT = {
  time: "Time's up. The floor is closed.",
  quiet: "Everyone's said their piece. The floor is closed.",
  limit: 'That was the last message. The floor is closed.',
} as const;

const ACTION_LABELS: Record<string, string> = {
  claim: 'announcing their back row',
  speak: 'speaking',
  chat: 'chatting',
  vote: 'voting',
  tie_decide: 'breaking the tie',
  pick: 'picking a ball',
  final_choice: 'choosing split or steal',
};

export function Feed({ events, players, showThoughts, reveal, viewerSeat, activity, footer }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** The contestant whose card is open (click a name). */
  const [card, setCard] = useState<number | null>(null);
  /** Highlight one contestant's lines: everyone else's fade back. */
  const [focus, setFocus] = useState<number | null>(null);

  // Keep scrolled to the newest line unless the reader has scrolled up.
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, showThoughts, activity?.seats.length, !footer]);

  // Each private thought goes with the move it explains (votes and final choices wait for their reveal).
  const paired = useMemo(() => pairThoughts(events), [events]);
  const thoughtFor = (key: string | number) => (showThoughts ? paired.byMove.get(String(key)) : undefined);

  const backRows = new Map<string, BallT[]>();
  const readOut = new Set<string>();
  for (const e of events) {
    if (e.type === 'back_row') backRows.set(`${e.stage}:${e.seat}`, e.back);
    if (e.type === 'vote_revealed') readOut.add(e.stage);
  }

  const name = (seat: number) => players[seat]?.name ?? `Player ${seat + 1}`;
  const color = (seat: number) => ({ '--seat': SEAT_COLORS[seat % SEAT_COLORS.length] }) as CSSProperties;
  const dim = (seat: number) => (focus !== null && seat !== focus ? ' feed__dim' : '');
  const who = (seat: number) => (
    <button
      type="button"
      className="feed__who"
      style={color(seat)}
      aria-expanded={card === seat}
      title={`About ${name(seat)}: their balls, claims and votes`}
      onClick={() => setCard((c) => (c === seat ? null : seat))}
    >
      {name(seat)}
      {seat === viewerSeat && <span className="feed__muted"> (you)</span>}
    </button>
  );
  const mind = (t: ThoughtEvent | undefined) => t && <MoveThought event={t} />;

  // Who's working on a move, leaving out the viewer: they know it's their go.
  const busy = (activity?.seats ?? []).filter((s) => s !== viewerSeat);

  const items: ReactNode[] = [];
  // Pauses for the player to read at their own pace aren't news; only the ones for being away get a line.
  let reading = false;
  for (const e of events) {
    const key = e.seq;
    switch (e.type) {
      case 'host':
        items.push(
          <div key={key} className="feed__host">
            <span className="feed__host-tag">Host</span> {e.text}
          </div>,
        );
        break;
      case 'round_started':
        items.push(
          <div key={key} className="feed__divider">
            {e.stage === 'r1' ? 'Round 1' : 'Round 2'}
          </div>,
        );
        break;
      case 'back_row':
        if (e.seat === viewerSeat || reveal) {
          items.push(
            <div key={key} className={`feed__private${dim(e.seat)}`}>
              {e.seat === viewerSeat ? 'Your back row (only you can see it):' : <>{who(e.seat)} peeks at their back row:</>}
              <span className="feed__balls">
                {e.back.map((b) => (
                  <Ball key={b.id} ball={b} size="xs" />
                ))}
              </span>
            </div>,
          );
        }
        break;
      case 'claim': {
        const actual = backRows.get(`${e.stage}:${e.seat}`);
        const verdict = actual && (reveal || e.seat === viewerSeat) ? claimIsTruthful(e.claim, actual) : null;
        items.push(
          <div key={key} className={`feed__turn${dim(e.seat)}`} style={color(e.seat)}>
            <div className="feed__turn-head">
              {who(e.seat)}
              <span className="feed__claim">
                claims
                <span className="feed__balls">
                  {e.claim.map((c, i) => (
                    <Ball
                      key={i}
                      ball={c === 'killer' ? { id: `c${i}`, kind: 'killer' } : { id: `c${i}`, kind: 'cash', value: c }}
                      size="xs"
                    />
                  ))}
                </span>
                {verdict !== null && (
                  <span className={`badge ${verdict ? 'badge--truth' : 'badge--lie'}`}>{verdict ? 'True' : 'Lie'}</span>
                )}
              </span>
            </div>
            {e.say && <p className="feed__say">“{e.say}”</p>}
            {mind(thoughtFor(key))}
          </div>,
        );
        break;
      }
      case 'speech':
        items.push(
          <div key={key} className={`feed__turn${dim(e.seat)}`} style={color(e.seat)}>
            <div className="feed__turn-head">
              {who(e.seat)}
              {e.to !== undefined && (
                <>
                  <span className="feed__arrow" aria-label="to">
                    →
                  </span>
                  {who(e.to)}
                </>
              )}
            </div>
            <p className="feed__say">“{e.say}”</p>
            {mind(thoughtFor(key))}
          </div>,
        );
        break;
      case 'chat_started':
        items.push(
          <div key={key} className="feed__floor">
            {e.stage === 'final' ? 'Split or Steal talks' : e.reflect ? 'After the vote' : 'Open floor'} ·{' '}
            {Math.round(e.durationMs / 1000)} seconds
          </div>,
        );
        break;
      case 'chat_pass': {
        const t = thoughtFor(key);
        items.push(
          t ? (
            <div key={key} className={`feed__turn feed__turn--quiet${dim(e.seat)}`} style={color(e.seat)}>
              <div className="feed__turn-head">
                {who(e.seat)} <span className="feed__muted">has nothing to add.</span>
              </div>
              {mind(t)}
            </div>
          ) : (
            <div key={key} className={`feed__muted feed__small${dim(e.seat)}`}>
              {name(e.seat)} has nothing to add.
            </div>
          ),
        );
        break;
      }
      case 'chat_ended':
        items.push(
          <div key={key} className="feed__muted feed__small">
            {CHAT_END_TEXT[e.reason]}
          </div>,
        );
        break;
      case 'thoughts':
        // Most thoughts are shown with their move; these are the ones with none to sit with.
        if (showThoughts && paired.loose.has(e.seq)) {
          items.push(<Thought key={key} event={e} who={who(e.seat)} style={color(e.seat)} className={dim(e.seat)} />);
        }
        break;
      case 'vote_revealed':
        if (e.index === 0) {
          items.push(
            <div key={`${key}-title`} className="feed__votes-title">
              The votes
            </div>,
          );
        }
        items.push(
          <div key={key} className={`feed__turn feed__vote${dim(e.seat)}`} style={color(e.seat)}>
            <div className="feed__turn-head">
              <span className="feed__step">
                {e.index + 1} of {e.total}
              </span>
              {who(e.seat)} votes for {who(e.target)}
            </div>
            {mind(thoughtFor(key))}
          </div>,
        );
        break;
      case 'votes_revealed': {
        if (readOut.has(e.stage)) {
          // Already read out one at a time: just the final count.
          const counts = new Map<number, number>();
          for (const v of e.votes) counts.set(v.target, (counts.get(v.target) ?? 0) + 1);
          items.push(
            <div key={key} className="feed__system feed__count">
              Final count:{' '}
              {[...counts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([seat, n], i) => (
                  <span key={seat}>
                    {i > 0 && ' · '}
                    {who(seat)} {n}
                  </span>
                ))}
            </div>,
          );
          break;
        }
        items.push(
          <div key={key} className="feed__votes">
            <div className="feed__votes-title">The votes</div>
            {e.votes.map((v) => (
              <div key={v.seat} className={`feed__turn feed__vote${dim(v.seat)}`} style={color(v.seat)}>
                <div className="feed__turn-head">
                  {who(v.seat)} voted for {who(v.target)}
                </div>
                {mind(thoughtFor(`${key}:${v.seat}`))}
              </div>
            ))}
          </div>,
        );
        break;
      }
      case 'tie':
        items.push(
          <div key={key} className="feed__system">
            Tie between {e.tied.map((s, i) => <span key={s}>{i > 0 && ' & '}{who(s)}</span>)}
          </div>,
        );
        break;
      case 'tie_decision':
        items.push(
          <div key={key} className="feed__system">
            {e.decisions.map((d) => (
              <div key={d.seat} className={`feed__turn${dim(d.seat)}`} style={color(d.seat)}>
                <div className="feed__turn-head">
                  {who(d.seat)} chose to eliminate {who(d.target)}
                </div>
                {mind(thoughtFor(`${key}:${d.seat}`))}
              </div>
            ))}
            {e.consensus === null ? 'No agreement.' : <>Agreed: {who(e.consensus)} goes.</>}
          </div>,
        );
        break;
      case 'tie_draw':
        items.push(
          <div key={key} className="feed__system">
            {e.draws.map((d) => (
              <div key={d.seat}>
                {who(d.seat)} draws <Ball ball={d.ball} size="xs" />
              </div>
            ))}
          </div>,
        );
        break;
      case 'eliminated':
        items.push(
          <div key={key} className={`feed__elim ${e.truthful ? '' : 'feed__elim--liar'}`}>
            {who(e.seat)} is eliminated. Their back row:
            <span className="feed__balls">
              {e.back.map((b) => (
                <Ball key={b.id} ball={b} size="xs" />
              ))}
            </span>
            <strong>{e.truthful ? 'They told the truth.' : 'They were lying!'}</strong>
          </div>,
        );
        break;
      case 'back_rows_revealed':
        for (const row of e.rows) {
          items.push(
            <div key={`${key}-${row.seat}`} className={`feed__elim ${row.truthful ? '' : 'feed__elim--liar'}${dim(row.seat)}`}>
              {who(row.seat)} turns over their back row:
              <span className="feed__balls">
                {row.back.map((b) => (
                  <Ball key={b.id} ball={b} size="xs" />
                ))}
              </span>
              <strong>{row.truthful ? 'Just as they claimed.' : 'They were lying!'}</strong>
            </div>,
          );
        }
        break;
      case 'bin_or_win_started':
        items.push(
          <div key={key} className="feed__divider">
            Bin or Win
          </div>,
        );
        break;
      case 'ball_picked':
        items.push(
          <div key={key} className={`feed__turn feed__pick${dim(e.seat)}`} style={color(e.seat)}>
            <div className="feed__turn-head">
              {who(e.seat)} {e.action === 'bin' ? 'bins' : 'wins'} ball {e.index + 1}: <Ball ball={e.ball} size="xs" />
              {e.action === 'win' && <span className="feed__jackpot">Jackpot {formatMoney(e.jackpot)}</span>}
            </div>
            {e.say && <p className="feed__say">“{e.say}”</p>}
            {mind(thoughtFor(key))}
          </div>,
        );
        break;
      case 'final_started':
        items.push(
          <div key={key} className="feed__divider">
            Split or Steal · {formatMoney(e.jackpot)}
          </div>,
        );
        break;
      case 'choice_locked':
        items.push(
          <div key={key} className={`feed__system${dim(e.seat)}`}>
            {who(e.seat)} has made their choice.
          </div>,
        );
        break;
      case 'final_reveal':
        items.push(
          <div key={key} className={`feed__reveal feed__reveal--${e.outcome}`}>
            {e.choices.map((c) => (
              <div key={c.seat} className={`feed__turn${dim(c.seat)}`} style={color(c.seat)}>
                <div className="feed__turn-head">
                  {who(c.seat)} chose <strong className={`choice choice--${c.choice}`}>{c.choice.toUpperCase()}</strong>
                </div>
                {mind(thoughtFor(`${key}:${c.seat}`))}
              </div>
            ))}
          </div>,
        );
        break;
      case 'agent_error':
        items.push(
          <div key={key} className={`feed__error${dim(e.seat)}`} title={e.message}>
            {who(e.seat)} fumbled while {ACTION_LABELS[e.action] ?? e.action}. The host stepped in. <span className="feed__muted">({e.message})</span>
          </div>,
        );
        break;
      case 'interview':
        items.push(
          <div key={key} className={`feed__interview${dim(e.seat)}`} style={color(e.seat)}>
            <div className="feed__interview-head">
              <span aria-hidden>🎤</span> Exit interview: {who(e.seat)}
            </div>
            <InterviewAnswers event={e} events={events} who={who} />
          </div>,
        );
        break;
      case 'game_error':
        items.push(
          <div key={key} className="feed__error">
            Game stopped: {e.message}
          </div>,
        );
        break;
      case 'paused':
        reading = e.reason === 'reading';
        if (reading) break;
        items.push(
          <div key={key} className="feed__muted">
            Paused while {who(e.seat)} is away.
          </div>,
        );
        break;
      case 'resumed':
        if (reading) break;
        items.push(
          <div key={key} className="feed__muted">
            {who(e.seat)} is back after {Math.max(1, Math.round(e.pausedMs / 1000))}s. Play on.
          </div>,
        );
        break;
      default:
        break;
    }
  }

  return (
    <div
      className="feed"
      ref={ref}
      onScroll={(ev) => {
        const el = ev.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      aria-live="polite"
    >
      {card !== null ? (
        <PlayerCard
          seat={card}
          events={events}
          players={players}
          showHidden={reveal}
          {...(viewerSeat !== undefined ? { viewerSeat } : {})}
          highlighted={focus === card}
          onHighlight={() => setFocus((f) => (f === card ? null : card))}
          onClose={() => setCard(null)}
          who={who}
        />
      ) : (
        focus !== null && (
          <div className="feed__focus" style={color(focus)} aria-live="off">
            <span>
              Highlighting <strong>{name(focus)}</strong>
            </span>
            <button type="button" className="linklike" onClick={() => setFocus(null)}>
              Show everyone
            </button>
          </div>
        )
      )}
      {items}
      {busy.length > 0 && (
        <div className="feed__typing" aria-live="off">
          {busy.map((s) => name(s)).join(', ')} {busy.length === 1 ? 'is' : 'are'}{' '}
          {activity?.action === 'chat' ? 'typing' : 'thinking'}
          <span className="feed__dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </div>
      )}
      {footer && (
        <div className="feed__footer" aria-live="off">
          {footer}
        </div>
      )}
    </div>
  );
}

/** A thought shown on its own (no move to sit with). */
function Thought({ event, who, style, className = '' }: { event: ThoughtEvent; who: ReactNode; style: CSSProperties; className?: string }) {
  return (
    <div className={`feed__thought${className}`} style={style}>
      <div className="feed__thought-head">
        <span aria-hidden>💭</span> {who} <span className="feed__muted">thinking while {ACTION_LABELS[event.action] ?? event.action}</span>
        <Usage event={event} />
      </div>
      <ThoughtBody event={event} />
    </div>
  );
}

/** The thinking behind a move, tucked under it in the same card. */
function MoveThought({ event }: { event: ThoughtEvent }) {
  return (
    <div className="feed__mind">
      <div className="feed__mind-head">
        <span aria-hidden>💭</span> <span>Thinking</span>
        <Usage event={event} />
      </div>
      <ThoughtBody event={event} />
    </div>
  );
}

function Usage({ event }: { event: ThoughtEvent }) {
  if (!event.usage) return null;
  return (
    <span className="feed__muted feed__usage">
      {(event.usage.latencyMs / 1000).toFixed(1)}s · ${event.usage.costUsd.toFixed(4)}
    </span>
  );
}

function ThoughtBody({ event }: { event: ThoughtEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {event.thoughts && <p className="feed__thought-text">{event.thoughts}</p>}
      {event.reasoning && (
        <div className="feed__reasoning">
          <button type="button" className="linklike" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'} model's native reasoning ({event.reasoning.length.toLocaleString()} chars)
          </button>
          {open && <pre className="feed__reasoning-text">{event.reasoning}</pre>}
        </div>
      )}
    </>
  );
}
