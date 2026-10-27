import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router';
import { GamePage } from './pages/GamePage';
import { GamesPage } from './pages/GamesPage';
import { HomePage } from './pages/HomePage';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuthProvider, useAuth } from './lib/auth';
import { useFreshBuild } from './lib/useFreshBuild';
import './styles.css';

function Layout({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  useFreshBuild();
  return (
    <>
      <header className="topbar">
        <Link to="/" className="topbar__brand">
          <span className="topbar__logo" aria-hidden />
          Golden <span className="topbar__ai">Bots</span>
        </Link>
        <nav className="topbar__nav">
          <NavLink to="/" end>
            Play
          </NavLink>
          <NavLink to="/leaderboard">Leaderboard</NavLink>
          <NavLink to="/games">Games</NavLink>
          {auth.canAdmin && <NavLink to="/settings">Settings</NavLink>}
          {auth.required &&
            (auth.loggedIn ? (
              <button type="button" className="topbar__logout" onClick={() => void auth.logout()}>
                Log out
              </button>
            ) : (
              <NavLink to="/login">Log in</NavLink>
            ))}
        </nav>
      </header>
      <main>{children}</main>
      <footer className="footer">
        A fan-made experiment inspired by a British TV game show. Not affiliated with the show or its makers. Prize money is imaginary.
      </footer>
    </>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1>Nothing here</h1>
      <Link to="/">Back to the studio</Link>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/game/:id" element={<GamePage />} />
            <Route path="/games" element={<GamesPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Layout>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
