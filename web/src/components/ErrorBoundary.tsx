import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

/**
 * If a page breaks while drawing, show a message and a way out instead of a
 * blank screen. Give it a `key` that changes with the page, so moving on clears it.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page failed to draw', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page" role="alert">
        <h1>Something went wrong</h1>
        <p>This page hit a problem and couldn't be shown. Reloading usually fixes it.</p>
        <p className="muted small">{error.message}</p>
        <div className="login__actions">
          <button type="button" className="btn btn--gold" onClick={() => window.location.reload()}>
            Reload the page
          </button>
          <a className="btn btn--ghost" href="/">
            Back to the studio
          </a>
        </div>
      </div>
    );
  }
}
