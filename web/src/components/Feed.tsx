import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { claimIsTruthful, formatMoney, type Ball as BallT, type GameEvent, type PlayerInfo } from '@gb/shared';
import { SEAT_COLORS } from '../lib/gameState';
import { Ball } from './Ball';

interface Props {
  events: GameEvent[];
  players: PlayerInfo[];
  showThoughts: boolean;
  reveal: boolean;
  viewerSeat?: number;
  /** Who's working on a move right now (live games only). */
  activity?: { seats: number[]; action: string | null };
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

export function Feed({ events, players, showThoughts, reveal, viewerSeat, activity }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Keep scrolled to the newest line unless the reader has scrolled up.
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, showThoughts, activity?.seats.length]);

  const backRows = new Map<string, BallT[]>();
  for (const e of events) if (e.type === 'back_row') backRows.set(`${e.stage}:${e.seat}`, e.back);

  const name = (seat: number) => players[seat]?.name ?? `Player ${seat + 1}`;
  const color = (seat: number) => ({ '--seat': SEAT_COLORS[seat % SEAT_COLORS.length] }) as CSSProperties;
  const who = (seat: number) => (
    <span className="feed__who" style={color(seat)}>
      {name(seat)}
    </span>
  );

  const items: ReactNode[] = [];
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
            <div key={key} className="feed__private">
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
          <div key={key} className="feed__line" style={color(e.seat)}>
            {who(e.seat)}
            <div className="feed__claim">
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
            </div>
            {e.say && <p className="feed__say">“{e.say}”</p>}
          </div>,
        );
        break;
      }
      case 'speech':
        items.push(
          <div key={key} className="feed__line" style={color(e.seat)}>
            {who(e.seat)}
            {e.to !== undefined && (
              <>
                <span className="feed__arrow" aria-label="to">
                  {' '}
                  →{' '}
                </span>
                {who(e.to)}
              </>
            )}
            <p className="feed__say">“{e.say}”</p>
          </div>,
        );
        break;
      case 'chat_started':
        items.push(
          <div key={key} className="feed__floor">
            {e.stage === 'final' ? 'Split or Steal talks' : 'Open floor'} · {Math.round(e.durationMs / 1000)} seconds
          </div>,
        );
        break;
      case 'chat_pass':
        items.push(
          <div key={key} className="feed__muted feed__small">
            {name(e.seat)} has nothing to add.
          </div>,
        );
        break;
      case 'chat_ended':
        items.push(
          <div key={key} className="feed__muted feed__small">
            {CHAT_END_TEXT[e.reason]}
          </div>,
        );
        break;
      case 'thoughts':
        if (showThoughts) items.push(<Thought key={key} event={e} who={who(e.seat)} style={color(e.seat)} />);
        break;
      case 'votes_revealed':
        items.push(
          <div key={key} className="feed__votes">
            <div className="feed__votes-title">The votes</div>
            <ul>
              {e.votes.map((v) => (
                <li key={v.seat}>
                  {who(v.seat)} voted for {who(v.target)}
                </li>
              ))}
            </ul>
          </div>,
        );
        break;
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
              <div key={d.seat}>
                {who(d.seat)} chose to eliminate {who(d.target)}
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
      case 'bin_or_win_started':
        items.push(
          <div key={key} className="feed__divider">
            Bin or Win
          </div>,
        );
        break;
      case 'ball_picked':
        items.push(
          <div key={key} className="feed__line feed__pick" style={color(e.seat)}>
            <div>
              {who(e.seat)} {e.action === 'bin' ? 'bins' : 'wins'} ball {e.index + 1}: <Ball ball={e.ball} size="xs" />
              {e.action === 'win' && <span className="feed__jackpot">Jackpot {formatMoney(e.jackpot)}</span>}
            </div>
            {e.say && <p className="feed__say">“{e.say}”</p>}
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
          <div key={key} className="feed__system">
            {who(e.seat)} has made their choice.
          </div>,
        );
        break;
      case 'final_reveal':
        items.push(
          <div key={key} className={`feed__reveal feed__reveal--${e.outcome}`}>
            {e.choices.map((c) => (
              <div key={c.seat}>
                {who(c.seat)} chose <strong className={`choice choice--${c.choice}`}>{c.choice.toUpperCase()}</strong>
              </div>
            ))}
          </div>,
        );
        break;
      case 'agent_error':
        items.push(
          <div key={key} className="feed__error" title={e.message}>
            {who(e.seat)} fumbled while {ACTION_LABELS[e.action] ?? e.action}. The host stepped in. <span className="feed__muted">({e.message})</span>
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
        items.push(
          <div key={key} className="feed__muted">
            Paused while {who(e.seat)} is away.
          </div>,
        );
        break;
      case 'resumed':
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
      {items}
      {activity && activity.seats.length > 0 && (
        <div className="feed__typing" aria-live="off">
          {activity.seats.map((s) => name(s)).join(', ')} {activity.seats.length === 1 ? 'is' : 'are'}{' '}
          {activity.action === 'chat' ? 'typing' : 'thinking'}
          <span className="feed__dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </div>
      )}
    </div>
  );
}

function Thought({ event, who, style }: { event: Extract<GameEvent, { type: 'thoughts' }>; who: ReactNode; style: CSSProperties }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="feed__thought" style={style}>
      <div className="feed__thought-head">
        <span aria-hidden>💭</span> {who} <span className="feed__muted">thinking while {ACTION_LABELS[event.action] ?? event.action}</span>
        {event.usage && (
          <span className="feed__muted feed__usage">
            {(event.usage.latencyMs / 1000).toFixed(1)}s · ${event.usage.costUsd.toFixed(4)}
          </span>
        )}
      </div>
      {event.thoughts && <p className="feed__thought-text">{event.thoughts}</p>}
      {event.reasoning && (
        <div className="feed__reasoning">
          <button type="button" className="linklike" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Show'} model's native reasoning ({event.reasoning.length.toLocaleString()} chars)
          </button>
          {open && <pre className="feed__reasoning-text">{event.reasoning}</pre>}
        </div>
      )}
    </div>
  );
}
