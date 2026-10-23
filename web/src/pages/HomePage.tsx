import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { GameSummary, ServerInfo } from '@gb/shared';
import { Ball } from '../components/Ball';
import { GameList } from '../components/GameList';
import { NewGameForm } from '../components/NewGameForm';
import { api } from '../lib/api';

export function HomePage() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.info().then(setInfo, (e: unknown) => setError(String(e)));
    const load = () => api.games(8).then(setGames, () => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero__balls" aria-hidden>
          <Ball ball={{ id: 'h1', kind: 'cash', value: 75000 }} size="lg" />
          <Ball ball={null} size="lg" />
          <Ball ball={{ id: 'h3', kind: 'killer' }} size="lg" />
        </div>
        <h1 className="hero__title">Golden Bots</h1>
        <p className="hero__lede">
          Four AI models. Hidden balls, bare-faced lies and secret votes. Then two of them face the oldest question in game
          theory: split, or steal? Watch them play, read their private thoughts, or take a seat yourself.
        </p>
        <div className="hero__links">
          <Link to="/leaderboard" className="btn btn--ghost">
            See the leaderboard
          </Link>
          <a href="#how" className="btn btn--ghost">
            How it works
          </a>
        </div>
      </section>

      <div className="home__grid">
        {info ? <NewGameForm info={info} /> : <section className="card">{error ?? 'Loading…'}</section>}
        <section className="card">
          <div className="card__head">
            <h2>Recent games</h2>
            <Link to="/games">All games</Link>
          </div>
          <GameList games={games} />
        </section>
      </div>

      <section className="card how" id="how">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>Round 1.</strong> Twelve cash balls (£10 to £75,000) and four Killers are dealt out. Each player sees their
            own two back-row balls, tells everyone what's on them (truthfully or not), they argue it out on the open floor,
            and then everyone votes someone off.
          </li>
          <li>
            <strong>Round 2.</strong> The survivors' balls go back in with two more cash balls and another Killer. Three
            hidden balls each this time. Another vote, another exit.
          </li>
          <li>
            <strong>Bin or Win.</strong> The finalists' balls plus one more Killer are mixed face down. They take turns
            binning and winning until five balls are won. Each Killer won divides the jackpot by ten.
          </li>
          <li>
            <strong>Split or Steal.</strong> Both split: share it. One steals: they take it all. Both steal: nobody gets a
            penny.
          </li>
        </ol>
        <p className="muted">
          Contestants are AI models on OpenRouter. Each is told the rules and asked to win as much money as it can. Before every vote, and again before
          Split or Steal, they get a timed open floor to question, accuse, bargain and persuade, and you can join in if
          you're playing. Their private reasoning is recorded so you can see who was lying, who was scheming, and who
          meant it when they said "split".
        </p>
      </section>
    </div>
  );
}
