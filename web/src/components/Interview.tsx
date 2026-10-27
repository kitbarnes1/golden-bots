import type { ReactNode } from 'react';
import { DECISION_POINTS, type GameEvent } from '@gb/shared';

type InterviewEvent = Extract<GameEvent, { type: 'interview' }>;

const yesNo = (v: boolean | null | undefined) => (v === true ? 'Yes' : v === false ? 'No' : null);
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A contestant's exit interview, with their answers checked against what
 * actually happened: their real back rows, and the choice they made.
 */
export function InterviewAnswers({ event, events, who }: { event: InterviewEvent; events: GameEvent[]; who: (seat: number) => ReactNode }) {
  const a = event.answers;
  const truths = events.flatMap((e) =>
    e.type === 'eliminated' && e.seat === event.seat
      ? [e.truthful]
      : e.type === 'back_rows_revealed'
        ? e.rows.filter((r) => r.seat === event.seat).map((r) => r.truthful)
        : [],
  );
  const lied = truths.some((t) => !t);
  const reveal = events.findLast((e): e is Extract<GameEvent, { type: 'final_reveal' }> => e.type === 'final_reveal');
  const mine = reveal?.choices.find((c) => c.seat === event.seat)?.choice;
  const other = reveal?.choices.find((c) => c.seat !== event.seat);

  const rows: [ReactNode, ReactNode][] = [];
  if (event.when === 'eliminated') {
    if (a.sawItComing != null) rows.push(['Did you see it coming?', yesNo(a.sawItComing)]);
    if (a.winnerPick != null) rows.push(['Who will win the most?', who(a.winnerPick)]);
    if (a.differently) rows.push(['What would you do differently?', a.differently]);
  } else {
    if (a.planned) {
      const kept = mine && a.planned !== 'undecided' ? a.planned === mine : null;
      rows.push([
        'What were you planning at the start?',
        <>
          {upper(a.planned)}
          {kept !== null && <span className={`badge ${kept ? 'badge--truth' : 'badge--lie'}`}>{kept ? 'Stuck to it' : 'Changed their mind'}</span>}
        </>,
      ]);
    }
    if (a.decided) rows.push(['When did you make up your mind?', DECISION_POINTS[a.decided]]);
    if (a.why) rows.push([`Why ${mine ? mine.toUpperCase() : 'that'}?`, a.why]);
    if (a.trust != null) rows.push([<>How much did you trust {other ? who(other.seat) : 'the other finalist'}?</>, <Trust score={a.trust} />]);
    if (a.sameAgain != null) rows.push(['Knowing their choice, same again?', yesNo(a.sameAgain)]);
  }
  if (a.claimsTrue != null) {
    // Checked against the back rows turned over after each vote.
    const verdict =
      truths.length === 0
        ? null
        : a.claimsTrue
          ? lied
            ? { text: 'They lied', cls: 'badge--lie' }
            : { text: 'True', cls: 'badge--truth' }
          : lied
            ? { text: 'Owned up', cls: 'badge--truth' }
            : { text: 'They were true', cls: '' };
    rows.push([
      'Were your claims the truth?',
      <>
        {yesNo(a.claimsTrue)}
        {verdict && <span className={`badge ${verdict.cls}`}>{verdict.text}</span>}
      </>,
    ]);
  }

  return (
    <>
      {a.say && <p className="feed__say">“{a.say}”</p>}
      {rows.length > 0 && (
        <dl className="iv">
          {rows.map(([q, answer], i) => (
            <div key={i} className="iv__row">
              <dt>{q}</dt>
              <dd>{answer}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

function Trust({ score }: { score: number }) {
  return (
    <span className="iv__trust" aria-label={`${score} out of 5`} title={`${score} out of 5`}>
      {'●'.repeat(score)}
      <span className="iv__trust-off">{'●'.repeat(5 - score)}</span>
    </span>
  );
}
