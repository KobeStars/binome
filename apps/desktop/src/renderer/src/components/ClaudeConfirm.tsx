import { useEffect, useRef } from 'react';
import type { EngineState } from '../../../engine/api.ts';
import { send } from '../lib/engine.ts';

/**
 * Demande de Claude en attente : restauration, envoi hors du dossier partagé.
 * Rien ne se fait sans un clic ici ; sans réponse en 2 minutes, le moteur refuse.
 */
export function ClaudeConfirm({ state }: { state: EngineState }) {
  const request = state.claude.pending[0];
  const refuse = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Le focus va sur « Refuser » : Entrée par réflexe ne doit pas tout accepter.
    if (request) refuse.current?.focus();
  }, [request?.id]);

  if (!request) return null;
  const answer = (allow: boolean) => send({ cmd: 'claude.confirm', id: request.id, allow });

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="alertdialog" aria-labelledby="claude-ask" aria-describedby="claude-ask-text">
        <h2 id="claude-ask">Claude demande ton accord</h2>
        <p id="claude-ask-text">{request.text}</p>
        <p className="muted">Sans réponse dans 2 minutes, la demande est refusée</p>
        <div className="actions modal-actions">
          <button ref={refuse} className="btn" onClick={() => answer(false)}>
            Refuser
          </button>
          <button className="btn btn-primary" onClick={() => answer(true)}>
            Autoriser
          </button>
        </div>
        {state.claude.pending.length > 1 && (
          <p className="muted">{state.claude.pending.length - 1} autre(s) demande(s) en attente</p>
        )}
      </div>
    </div>
  );
}
