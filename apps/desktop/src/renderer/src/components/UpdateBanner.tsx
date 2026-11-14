import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../main/updater.ts';
import { api } from '../lib/engine.ts';

/** Bandeau discret en bas de la barre latérale : visible seulement pendant une mise à jour. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });
  useEffect(() => api().onUpdate(setStatus), []);

  if (status.state === 'downloading') {
    return (
      <div className="update">
        <div className="update-text">Mise à jour {status.version}</div>
        <div className="bar" role="progressbar" aria-valuenow={status.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="bar-fill" style={{ transform: `scaleX(${status.percent / 100})` }} />
        </div>
      </div>
    );
  }
  if (status.state === 'ready') {
    return (
      <div className="update">
        <div className="update-text">Version {status.version} prête</div>
        <button className="btn btn-small btn-primary" onClick={() => void api().installUpdate()}>
          Redémarrer
        </button>
      </div>
    );
  }
  return null;
}
