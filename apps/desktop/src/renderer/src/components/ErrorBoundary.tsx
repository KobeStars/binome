import { Component, type ErrorInfo, type ReactNode } from 'react';
import { api } from '../lib/engine.ts';

/**
 * Une erreur dans l'interface laisserait une fenêtre vide : on affiche de quoi recharger,
 * et le main enregistre un rapport de plantage (envoyé à l'autre si c'est permis).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void api()
      .reportCrash({ message: error.message || String(error), stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` })
      .catch(() => {});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crashed">
        <h1>L’interface a planté</h1>
        <p className="secondary">
          La synchro continue en arrière-plan. Le rapport est dans Historique, onglet Plantages.
        </p>
        <pre className="crashed-detail">{this.state.error.message}</pre>
        <button className="btn btn-primary" onClick={() => location.reload()}>
          Recharger
        </button>
      </div>
    );
  }
}
