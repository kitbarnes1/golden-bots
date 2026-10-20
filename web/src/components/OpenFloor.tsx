import { useEffect, useState } from 'react';
import type { PlayerInfo } from '@gb/shared';
import { api } from '../lib/api';
import type { FloorView } from '../lib/gameState';

/** Seconds left on the server's clock, ticking. */
function secondsLeft(endsAt: number, skewMs: number): number {
  return Math.max(0, Math.ceil((endsAt - (Date.now() + skewMs)) / 1000));
}

/** stoppedAt = when the game was paused (server clock): the chat clock stands still from then until it resumes. */
function useSecondsLeft(endsAt: number, skewMs: number, stoppedAt?: number): number {
  const [left, setLeft] = useState(() => secondsLeft(endsAt, skewMs));
  useEffect(() => {
    if (stoppedAt !== undefined) {
      setLeft(Math.max(0, Math.ceil((endsAt - stoppedAt) / 1000)));
      return;
    }
    setLeft(secondsLeft(endsAt, skewMs));
    const t = setInterval(() => setLeft(secondsLeft(endsAt, skewMs)), 250);
    return () => clearInterval(t);
  }, [endsAt, skewMs, stoppedAt]);
  return left;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** "Open floor · 0:42 left" banner shown to everyone while contestants talk. */
export function FloorBanner({ floor, skewMs, live, stoppedAt }: { floor: FloorView; skewMs: number; live: boolean; stoppedAt?: number }) {
  const left = useSecondsLeft(floor.endsAt, skewMs, stoppedAt);
  const label = floor.stage === 'final' ? 'Split or Steal talks' : floor.reflect ? 'After the vote' : 'Open floor';
  return (
    <div className="floor-banner" role="status">
      <span className="floor-banner__dot" aria-hidden />
      <strong>{label}</strong>
      {live && (
        <span className="floor-banner__time">{stoppedAt !== undefined ? `${mmss(left)} left, paused` : left > 0 ? `${mmss(left)} left` : 'Last words…'}</span>
      )}
      <span className="floor-banner__count">
        {floor.messages} message{floor.messages === 1 ? '' : 's'}
      </span>
    </div>
  );
}

interface ChatBoxProps {
  gameId: string;
  floor: FloorView;
  mySeat: number;
  players: PlayerInfo[];
  skewMs: number;
  /** Set while the game is paused: the clock stands still. */
  stoppedAt?: number;
}

/** Lets a human contestant join the conversation at any time while the floor is open. */
export function ChatBox({ gameId, floor, mySeat, players, skewMs, stoppedAt }: ChatBoxProps) {
  const [text, setText] = useState('');
  const [to, setTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = useSecondsLeft(floor.endsAt, skewMs, stoppedAt);
  const others = floor.participants.filter((s) => s !== mySeat);

  // A new conversation starts fresh.
  useEffect(() => {
    setDone(false);
    setTo(null);
    setError(null);
  }, [floor.endsAt]);

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.chat(gameId, text.trim(), to);
      setText('');
      setDone(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      await api.chatDone(gameId);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="action chatbox" aria-label="Join the conversation">
      <div className="chatbox__head">
        <span className="action__title">Your say</span>
        <span className="chatbox__time">{stoppedAt !== undefined ? `${mmss(left)} left, paused` : left > 0 ? `${mmss(left)} left` : 'Time is up'}</span>
      </div>
      {done ? (
        <p className="muted">
          You've said your piece. The floor closes when the others are done too.{' '}
          <button type="button" className="linklike" onClick={() => setDone(false)}>
            Say something else
          </button>
        </p>
      ) : (
        <form
          className="chatbox__form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <select
            value={to ?? ''}
            onChange={(e) => setTo(e.target.value === '' ? null : Number(e.target.value))}
            aria-label="Who you're talking to"
          >
            <option value="">To everyone</option>
            {others.map((s) => (
              <option key={s} value={s}>
                To {players[s]?.name}
              </option>
            ))}
          </select>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={400}
            placeholder={to === null ? 'Persuade, accuse, make a deal…' : `Ask ${players[to]?.name} something…`}
            aria-label="Your message"
            autoFocus
          />
          <button className="btn btn--gold" disabled={busy || !text.trim() || left === 0}>
            Send
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void finish()}>
            I'm done talking
          </button>
        </form>
      )}
      {error && <p className="action__error">{error}</p>}
    </section>
  );
}
