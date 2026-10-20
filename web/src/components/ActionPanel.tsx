import { useEffect, useMemo, useState } from 'react';
import { GOLDEN_BANK, formatMoney, type ActionRequest, type Ball, type PlayerInfo } from '@gb/shared';

interface Props {
  request: ActionRequest;
  players: PlayerInfo[];
  myBack: Ball[] | null;
  busy: boolean;
  error: string | null;
  onSubmit: (response: unknown) => void;
}

const VALUES = [...new Set(GOLDEN_BANK.map(([v]) => v))];

/** Controls for a human contestant. Ball picks and the final choice happen on the stage itself. */
export function ActionPanel({ request, players, myBack, busy, error, onSubmit }: Props) {
  const name = (seat: number) => players[seat]?.name ?? `Player ${seat + 1}`;

  return (
    <section className="action" aria-label="Your move">
      <div className="action__title">Your move</div>
      {request.kind === 'claim' && <ClaimForm backCount={request.backCount} myBack={myBack} busy={busy} onSubmit={onSubmit} />}
      {request.kind === 'speak' && <SpeakForm prompt={request.prompt} busy={busy} onSubmit={onSubmit} />}
      {(request.kind === 'vote' || request.kind === 'tie_decide') && (
        <div>
          <p>
            {request.kind === 'vote'
              ? 'Secretly vote to eliminate one player.'
              : 'You must agree who leaves. Choose one of the tied players.'}
          </p>
          <div className="action__buttons">
            {request.candidates.map((seat) => (
              <button key={seat} className="btn btn--danger" disabled={busy} onClick={() => onSubmit({ target: seat })}>
                {name(seat)}
              </button>
            ))}
          </div>
        </div>
      )}
      {request.kind === 'pick' && <p>Click a face-down ball on the board to {request.action} it.</p>}
      {request.kind === 'final_choice' && <p>Choose Split or Steal on the stage.</p>}
      {error && <p className="action__error">{error}</p>}
    </section>
  );
}

function ClaimForm({
  backCount,
  myBack,
  busy,
  onSubmit,
}: {
  backCount: number;
  myBack: Ball[] | null;
  busy: boolean;
  onSubmit: (r: unknown) => void;
}) {
  const truth = useMemo(
    () =>
      Array.from({ length: backCount }, (_, i) => {
        const b = myBack?.[i];
        return b ? (b.kind === 'killer' ? 'killer' : String(b.value)) : '1000';
      }),
    [backCount, myBack],
  );
  const [claim, setClaim] = useState<string[]>(truth);
  const [say, setSay] = useState('');
  useEffect(() => setClaim(truth), [truth]);
  const honest = claim.every((c, i) => c === truth[i]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ claim: claim.map((c) => (c === 'killer' ? 'killer' : Number(c))), say });
      }}
    >
      <p>Tell everyone what's on your back row. The values start as the truth. Change them to bluff.</p>
      <div className="action__claims">
        {claim.map((value, i) => (
          <label key={i} className="field">
            <span>Ball {i + 1}</span>
            <select value={value} onChange={(e) => setClaim((c) => c.map((v, j) => (j === i ? e.target.value : v)))}>
              <option value="killer">KILLER</option>
              {VALUES.map((v) => (
                <option key={v} value={String(v)}>
                  {formatMoney(v)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <span className={`badge ${honest ? 'badge--truth' : 'badge--lie'}`}>{honest ? 'Telling the truth' : 'Bluffing'}</span>
      </div>
      <label className="field">
        <span>What do you say? (optional)</span>
        <textarea value={say} onChange={(e) => setSay(e.target.value)} maxLength={500} rows={2} />
      </label>
      <button className="btn btn--gold" disabled={busy}>
        Announce
      </button>
    </form>
  );
}

function SpeakForm({ prompt, busy, onSubmit }: { prompt: string; busy: boolean; onSubmit: (r: unknown) => void }) {
  const [say, setSay] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (say.trim()) onSubmit({ say });
      }}
    >
      <p>{prompt}</p>
      <label className="field">
        <span>Say something to the table</span>
        <textarea value={say} onChange={(e) => setSay(e.target.value)} maxLength={500} rows={3} autoFocus />
      </label>
      <button className="btn btn--gold" disabled={busy || !say.trim()}>
        Speak
      </button>
    </form>
  );
}
