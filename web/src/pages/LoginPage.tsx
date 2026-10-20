import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../lib/api';
import { safeNext, useAuth } from '../lib/auth';

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page login">
      <section className="card login__card">
        <h1>Log in</h1>
        {auth.required === false ? (
          <p>This server has no admin password set, so there's nothing to log in to.</p>
        ) : auth.loggedIn ? (
          <>
            <p>You're logged in, so you can start, stop and delete games.</p>
            <div className="login__actions">
              <Link className="btn btn--gold" to={next}>
                Carry on
              </Link>
              <button type="button" className="btn btn--ghost" onClick={() => void auth.logout()}>
                Log out
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <p className="muted">Only needed to start, stop or delete games, which spend API credits. Anyone can watch.</p>
            <label className="field">
              <span>Admin password</span>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn btn--gold" disabled={busy || !password}>
              {busy ? 'Checking…' : 'Log in'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
