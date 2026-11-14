import { useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, FolderOpen, Plus, X } from 'lucide-react';
import type { EngineState, TransferView } from '../../../engine/api.ts';
import { api, send } from '../lib/engine.ts';
import { transferMeta } from '../lib/format.ts';
import { baseName, type PreviewTarget } from '../lib/preview.ts';
import { useUi } from '../lib/ui.tsx';

/** Fichier ouvrable en aperçu : reçu en direct (dossier de réception) ou par la synchro. */
function previewOf(t: TransferView): PreviewTarget | null {
  if (t.status !== 'done') return null;
  if (t.id.startsWith('sync-')) return { root: 'shared', path: t.name };
  if (t.direction === 'in' && t.path) return { root: 'inbox', path: baseName(t.path) };
  return null;
}

function Row({ t }: { t: TransferView }) {
  const ui = useUi();
  const pct = t.size > 0 ? Math.min(100, (t.bytes / t.size) * 100) : 100;
  const running = t.status !== 'done' && t.status !== 'failed';
  const target = previewOf(t);
  const Icon = t.direction === 'out' ? ArrowUp : ArrowDown;
  return (
    <li className={`transfer is-${t.status}`}>
      <Icon size={16} strokeWidth={1.5} className="row-icon" aria-label={t.direction === 'out' ? 'Envoi' : 'Réception'} />
      <div className="transfer-body">
        <div className="transfer-line">
          {target ? (
            <button className="transfer-name" onClick={() => ui.openPreview(target)}>
              {t.name}
            </button>
          ) : (
            <span className="transfer-name">{t.name}</span>
          )}
          <span className="transfer-meta">{transferMeta(t)}</span>
        </div>
        {running && (
          <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className="bar-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
        )}
      </div>
      <div className="transfer-actions">
        {running && !t.id.startsWith('sync-') && (
          <button className="icon-btn" title="Annuler" onClick={() => send({ cmd: 'transfer.cancel', id: t.id })}>
            <X size={16} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </li>
  );
}

export function Transfers({ state }: { state: EngineState }) {
  const [over, setOver] = useState(false);
  const peerName = state.peer?.name ?? 'ton binôme';
  // Les plus récents en haut.
  const list = [...state.transfers].reverse();

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map((f) => api().pathForFile(f)).filter(Boolean);
    if (paths.length) send({ cmd: 'send', paths });
  };

  return (
    <section
      className={`view drop${over ? ' is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={onDrop}
    >
      <header className="view-head">
        <div>
          <h1>Transferts</h1>
          <p className="secondary">Glisse un fichier ici pour l’envoyer à {peerName}, même hors du dossier partagé</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => void api().openInbox()}>
            <FolderOpen size={16} strokeWidth={1.5} />
            Fichiers reçus
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              const paths = await api().pickFiles();
              if (paths.length) send({ cmd: 'send', paths });
            }}
          >
            <Plus size={16} strokeWidth={1.5} />
            Envoyer
          </button>
        </div>
      </header>

      {list.length === 0 ? (
        <div className="empty">
          <p>Aucun transfert pour l’instant</p>
          <p className="muted">
            {state.route ? `Envoi direct à ${peerName}, chiffré` : `${peerName} doit être en ligne pour recevoir`}
          </p>
        </div>
      ) : (
        <ul className="list">
          {list.map((t) => (
            <Row key={t.id} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
