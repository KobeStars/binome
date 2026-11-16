import type { EngineState } from '../../../engine/api.ts';
import { send } from '../lib/engine.ts';
import { useCountdown } from '../lib/library.ts';

/** « Teste mon jeu ! » reçu : une minute pour répondre. Oui : installation si besoin, puis lancement. */
export function TestRequest({ state, onPlay }: { state: EngineState; onPlay: (app: string) => void }) {
  const t = state.library.testIn;
  const left = useCountdown(t?.expiresAt ?? null);
  if (!t || left <= 0) return null;
  const peer = state.peer?.name ?? 'Ton binôme';
  const reply = (answer: 'yes' | 'no') => send({ cmd: 'lib.test.reply', id: t.id, answer });
  return (
    <div className="modal-backdrop">
      <div className="modal test-request" role="alertdialog" aria-modal="true" aria-labelledby="test-title">
        <span className="test-countdown num" aria-label={`${left} secondes`}>
          {left}
        </span>
        <h2 id="test-title">{peer} te demande de tester {t.name}</h2>
        <p className="secondary">Version {t.version}. Si elle n’est pas encore là, elle s’installe d’abord.</p>
        <div className="actions modal-actions">
          <button className="btn" onClick={() => reply('no')}>
            Plus tard
          </button>
          <button
            className="btn btn-primary"
            autoFocus
            onClick={() => {
              reply('yes');
              onPlay(t.app);
            }}
          >
            Tester
          </button>
        </div>
      </div>
    </div>
  );
}
