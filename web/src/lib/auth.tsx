import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

interface AuthState {
  /** Whether the server needs a login to start games; null until it has said. */
  required: boolean | null;
  loggedIn: boolean;
}

interface Auth extends AuthState {
  /** May this visitor start, stop and delete games? */
  canAdmin: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-ask the server, e.g. after a request came back 401 (the session expired). */
  refresh: () => void;
}

const AuthContext = createContext<Auth | null>(null);

/** The admin login lives in an HttpOnly cookie; this just tracks whether we have one. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ required: null, loggedIn: false });

  const refresh = useCallback(() => {
    api.session().then(setState, () => setState({ required: true, loggedIn: false }));
  }, []);
  useEffect(refresh, [refresh]);

  const login = useCallback(async (password: string) => {
    await api.login(password);
    setState({ required: true, loggedIn: true });
  }, []);
  const logout = useCallback(async () => {
    await api.logout();
    setState((s) => ({ ...s, loggedIn: false }));
  }, []);

  const value = useMemo<Auth>(
    () => ({ ...state, canAdmin: state.required === false || state.loggedIn, login, logout, refresh }),
    [state, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth needs an AuthProvider');
  return auth;
}

/** Where to go after logging in: only paths on this site, so the link can't send anyone elsewhere. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}
