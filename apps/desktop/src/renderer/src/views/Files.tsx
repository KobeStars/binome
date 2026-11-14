import { useEffect, useState } from 'react';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import type { EngineState } from '../../../engine/api.ts';
import { FileIcon } from '../components/FileIcon.tsx';
import { Liaison } from '../components/Liaison.tsx';
import { api, send } from '../lib/engine.ts';
import { ago, bytes, rate, routeLabel } from '../lib/format.ts';
import { absoluteIn, baseName } from '../lib/preview.ts';
import { useUi } from '../lib/ui.tsx';

/** Rafraîchit les « il y a 3 min » sans attendre un changement d'état. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

async function chooseFolder(): Promise<void> {
  const path = await api().pickFolder();
  if (path) send({ cmd: 'sync.setFolder', path });
}

/** Progression globale des transferts en cours, ou null s'il n'y en a pas. */
function activity(state: EngineState): { progress: number; rate: number; count: number } | null {
  const active = state.transfers.filter((t) => t.status === 'active' || t.status === 'verifying');
  if (active.length === 0) return null;
  const size = active.reduce((n, t) => n + t.size, 0);
  const done = active.reduce((n, t) => n + Math.min(t.bytes, t.size), 0);
  return { progress: size ? done / size : 0, rate: active.reduce((n, t) => n + t.rate, 0), count: active.length };
}

/**
 * Carte de liaison : toi à gauche, ton binôme à droite.
 * Le trait se remplit pendant un transfert, passe en pointillés quand l'autre est absent.
 */
function LinkCard({ state, now }: { state: EngineState; now: number }) {
  const s = state.sync;
  const peer = state.peer?.name ?? 'Ton binôme';
  const act = activity(state);
  const linkState = state.route ? 'on' : state.peerOnline ? 'pending' : 'off';

  let status: string;
  if (s.status === 'scanning') status = 'Analyse du dossier';
  else if (act) status = act.count > 1 ? `${act.count} fichiers en cours` : 'Transfert en cours';
  else if (!state.route) status = state.peerOnline ? 'Connexion' : `${peer} est hors ligne`;
  else status = s.lastSync ? `À jour, dernière synchro ${ago(s.lastSync, now)}` : 'À jour';

  const route = state.route ? routeLabel(state.route) : state.server !== 'online' ? 'serveur injoignable' : 'en attente';

  return (
    <section className="link-card" aria-label="État de la liaison">
      <div className="link-card-ends">
        <span>Toi</span>
        <span>{peer}</span>
      </div>
      <Liaison state={linkState} progress={act ? act.progress : null} />
      <div className="link-card-foot">
        <span>{status}</span>
        <span className="link-card-route">
          {act && act.rate > 0 ? `${rate(act.rate)} · ` : ''}
          {route} · {s.files} fichier{s.files > 1 ? 's' : ''} · {bytes(s.bytes)}
        </span>
      </div>
    </section>
  );
}

export function Files({ state }: { state: EngineState }) {
  const now = useNow();
  const ui = useUi();
  const s = state.sync;
  const peer = state.peer?.name ?? 'ton binôme';

  if (!s.folder) {
    return (
      <section className="view">
        <header className="view-head">
          <div>
            <h1>Fichiers</h1>
            <p className="secondary">
              Choisis le dossier à partager. Ce que tu y ajoutes, modifies ou supprimes arrive chez {peer}, et inversement.
            </p>
          </div>
        </header>
        <button className="btn btn-primary" onClick={() => void chooseFolder()}>
          Choisir un dossier
        </button>
      </section>
    );
  }

  return (
    <section className="view">
      <header className="view-head">
        <div className="head-text">
          <h1>Fichiers</h1>
          <p className="secondary path" title={s.folder}>
            {s.folder}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => void chooseFolder()}>
            Changer
          </button>
          <button className="btn btn-primary" onClick={() => void api().openFolder(s.folder!)}>
            <FolderOpen size={16} strokeWidth={1.5} />
            Ouvrir le dossier
          </button>
        </div>
      </header>

      {s.conflicts.length > 0 && (
        <ul className="conflicts">
          {s.conflicts.map((c) => (
            <li key={c.id}>
              <TriangleAlert size={16} strokeWidth={1.5} className="conflict-icon" />
              <div className="conflict-text">
                <div>Conflit sur {c.path}</div>
                <p className="muted">
                  {c.keptBy} et {c.asideBy} l’ont modifié en même temps. La version de {c.keptBy} garde le nom, celle de{' '}
                  {c.asideBy} est dans {baseName(c.aside)}
                </p>
              </div>
              <button className="btn btn-small" onClick={() => ui.openPreview({ root: 'shared', path: c.aside })}>
                Voir
              </button>
              <button className="btn btn-small btn-quiet" onClick={() => send({ cmd: 'conflict.dismiss', id: c.id })}>
                J’ai vu
              </button>
            </li>
          ))}
        </ul>
      )}

      {s.error ? <p className="error">{s.error}</p> : <LinkCard state={state} now={now} />}

      <h2 className="section-title">Derniers changements</h2>
      {s.recent.length === 0 ? (
        <p className="muted">Rien pour l’instant</p>
      ) : (
        <ul className="list">
          {s.recent.map((c) => (
            <li key={`${c.path}-${c.at}`} className={c.deleted ? 'is-deleted' : undefined}>
              {c.deleted ? (
                <div className="row">
                  <FileIcon path={c.path} />
                  <span className="row-main">{c.path}</span>
                  <span className="row-meta">
                    supprimé par {c.by} · {ago(c.at, now)}
                  </span>
                </div>
              ) : (
                <button
                  className="row"
                  onClick={() => ui.openPreview({ root: 'shared', path: c.path })}
                  onDoubleClick={() => void api().reveal(absoluteIn(s.folder!, c.path))}
                >
                  <FileIcon path={c.path} />
                  <span className="row-main">{c.path}</span>
                  <span className="row-meta">
                    {c.by} · {ago(c.at, now)}
                  </span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
