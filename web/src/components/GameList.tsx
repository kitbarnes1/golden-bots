import { Link } from 'react-router';
import { formatMoney, type GameSummary } from '@gb/shared';

function outcome(g: GameSummary): string {
  if (g.status === 'running') return 'In progress';
  if (g.status !== 'finished') return g.status === 'abandoned' ? 'Abandoned' : 'Error';
  const finalists = g.players.filter((p) => p.reachedFinal);
  const [a, b] = finalists;
  if (!a || !b) return 'Finished';
  if (a.finalChoice === 'split' && b.finalChoice === 'split') {
    return `${a.name} & ${b.name} split ${formatMoney(g.jackpot ?? 0)}`;
  }
  if (a.finalChoice === 'steal' && b.finalChoice === 'steal') {
    return `${a.name} & ${b.name} both stole ${formatMoney(g.jackpot ?? 0)}: nobody won`;
  }
  const thief = a.finalChoice === 'steal' ? a : b;
  return `${thief.name} stole ${formatMoney(g.jackpot ?? 0)}`;
}

export function GameList({ games, onDelete }: { games: GameSummary[]; onDelete?: (id: string) => void }) {
  if (games.length === 0) return <p className="muted">No games yet.</p>;
  return (
    <ul className="gamelist">
      {games.map((g) => (
        <li key={g.id} className="gamelist__item">
          <Link to={`/game/${g.id}`} className="gamelist__link">
            <span className={`pill pill--${g.status}`}>{g.status === 'running' ? 'Live' : g.status}</span>
            <span className="gamelist__players">
              {g.players.map((p) => (
                <span key={p.seat} className={p.reachedFinal ? 'gamelist__finalist' : ''}>
                  {p.name}
                </span>
              ))}
            </span>
            <span className="gamelist__outcome">{outcome(g)}</span>
            <span className="gamelist__when">
              {new Date(g.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
              {!g.ranked && ' · practice'}
              {g.costUsd > 0 && ` · $${g.costUsd.toFixed(3)}`}
            </span>
          </Link>
          {onDelete && g.status !== 'running' && (
            <button className="btn btn--small btn--ghost" onClick={() => onDelete(g.id)} title="Delete game">
              Delete
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
