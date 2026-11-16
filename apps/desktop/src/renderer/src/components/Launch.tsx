import { useState, type ReactNode } from 'react';
import { request } from '../lib/engine.ts';
import { errorText } from '../lib/library.ts';
import { useUi } from '../lib/ui.tsx';

/**
 * Lance une app. Au premier lancement d'une app de l'autre, une confirmation s'affiche :
 * Binôme garantit que le programme n'a pas changé en route, pas ce qu'il fait.
 */
export function useLaunch(peerName: string): { launch: (id: string, name: string) => Promise<void>; dialog: ReactNode } {
  const ui = useUi();
  const [ask, setAsk] = useState<{ id: string; name: string } | null>(null);

  const run = async (id: string, name: string, trust: boolean) => {
    try {
      const r = await request({ req: 'lib.launch', app: id, trust });
      if (r === 'trust') setAsk({ id, name });
      else if (r === 'running') ui.toast(`${name} est déjà lancé`);
      else ui.toast(`${name} se lance`);
    } catch (err) {
      ui.toast(errorText(err, 'Lancement impossible'));
    }
  };

  const dialog = ask && (
    <div className="modal-backdrop" onClick={() => setAsk(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="trust-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="trust-title">Premier lancement de {ask.name}</h2>
        <p className="secondary">
          Ce programme vient de {peerName}. Binôme a vérifié qu’il est arrivé tel que {peerName} l’a publié, pas ce qu’il
          fait. Lance-le si tu lui fais confiance.
        </p>
        <div className="actions modal-actions">
          <button className="btn" onClick={() => setAsk(null)}>
            Annuler
          </button>
          <button
            className="btn btn-primary"
            autoFocus
            onClick={() => {
              const a = ask;
              setAsk(null);
              void run(a.id, a.name, true);
            }}
          >
            Lancer
          </button>
        </div>
      </div>
    </div>
  );

  return { launch: (id, name) => run(id, name, false), dialog };
}
