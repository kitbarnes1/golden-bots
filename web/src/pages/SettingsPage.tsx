import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { ApiKeyStatus } from '@gb/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function SettingsPage() {
  const auth = useAuth();
  const [key, setKey] = useState<ApiKeyStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [done, setDone] = useState<'saved' | 'deleted' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = auth;

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        // The session has expired (or the password was changed).
        refresh();
        setError('Your login has expired. Log in again to change settings.');
      } else setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    },
    [refresh],
  );

  useEffect(() => {
    if (auth.canAdmin) api.apiKey().then(setKey, fail);
  }, [auth.canAdmin, fail]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    setDone(null);
    try {
      setKey(await api.saveApiKey(draft));
      setDraft('');
      setDone('saved');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirm('Delete the saved OpenRouter key? Games already running carry on, but new games can only use mock players.')) return;
    setBusy('delete');
    setError(null);
    setDone(null);
    try {
      setKey(await api.deleteApiKey());
      setDone('deleted');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  if (auth.required === null) {
    return (
      <div className="page">
        <section className="card settings__card">
          <p className="muted">Loading…</p>
        </section>
      </div>
    );
  }

  if (!auth.canAdmin) {
    return (
      <div className="page">
        <section className="card settings__card">
          <h1>Settings</h1>
          <p>Log in to change the server's settings.</p>
          <Link className="btn btn--gold" to="/login?next=/settings">
            Log in
          </Link>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="card settings__card">
        <h1>Settings</h1>
        <h2>OpenRouter API key</h2>
        <p className="muted">
          AI contestants play through <a href="https://openrouter.ai">OpenRouter</a>. Create a key at{' '}
          <a href="https://openrouter.ai/keys">openrouter.ai/keys</a>, and give it a credit limit there so a runaway game
          can't overspend.
        </p>

        {!key ? (
          !error && <p className="muted">Loading…</p>
        ) : key.source === 'environment' ? (
          <p className="notice">
            The server's <code>OPENROUTER_API_KEY</code> environment variable sets the key (ending <code>{key.last4}</code>).
            That always wins, so it can't be changed here: change the variable on the server and restart it.
          </p>
        ) : (
          <>
            <p className="notice">
              {key.set ? (
                <>
                  A key ending <code>{key.last4}</code> is saved, so AI contestants can play.
                </>
              ) : (
                'No key yet, so only the free mock players are available.'
              )}
            </p>
            <form className="settings__form" onSubmit={(e) => void save(e)}>
              <label className="field">
                <span>{key.set ? 'Replace it with another key' : 'Paste your key'}</span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-or-v1-…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  data-1p-ignore
                  data-lpignore="true"
                />
              </label>
              <div className="settings__actions">
                <button className="btn btn--gold" disabled={busy !== null || !draft.trim()}>
                  {busy === 'save' ? 'Checking with OpenRouter…' : 'Check and save'}
                </button>
                {key.set && (
                  <button type="button" className="btn btn--danger" disabled={busy !== null} onClick={() => void remove()}>
                    {busy === 'delete' ? 'Deleting…' : 'Delete key'}
                  </button>
                )}
              </div>
            </form>
            <p className="muted small">
              OpenRouter checks the key before it's saved. The server keeps it encrypted and never shows it again, not even
              here. Games already running finish with the key they started with.
            </p>
          </>
        )}

        {done === 'saved' && (
          <p className="settings__done">
            Saved. AI contestants are ready: <Link to="/">set up a game</Link>.
          </p>
        )}
        {done === 'deleted' && <p className="settings__done">Deleted. New games can only use mock players until you add a key.</p>}
        {error && <p className="error">{error}</p>}

        {auth.required === false && (
          <p className="muted small">
            This server has no <code>ADMIN_PASSWORD</code>, so anyone who can open this site can change the key and start
            games. Set one if other people can reach it.
          </p>
        )}
      </section>
    </div>
  );
}
