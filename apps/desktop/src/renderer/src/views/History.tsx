import { useEffect, useState } from 'react';
import { Copy, Eye, FilePlus, FilePen, FileX, RotateCcw } from 'lucide-react';
import type { CrashView, EngineState, TrashView, VersionView } from '../../../engine/api.ts';
import { request, send } from '../lib/engine.ts';
import { ago, bytes } from '../lib/format.ts';
import { useUi } from '../lib/ui.tsx';

export type HistoryTab = 'journal' | 'trash' | 'claude' | 'crashes';

// Les secondes départagent deux versions enregistrées dans la même minute.
const when = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const VERB = { added: 'ajouté', modified: 'modifié', deleted: 'supprimé' } as const;
const ICON = { added: FilePlus, modified: FilePen, deleted: FileX } as const;

/** Recharge une liste quand l'historique change, avec un court délai pour regrouper les rafales. */
function useLoad<T>(load: () => Promise<T>, revision: number): [T | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      load().then(
        (d) => alive && setData(d),
        () => alive && setData(null),
      );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [revision, tick]);
  return [data, () => setTick((n) => n + 1)];
}

function RestoreButton({ versionId, onDone }: { versionId: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <span className="restore">
      {error && <span className="restore-error">{error}</span>}
      <button
        className="btn btn-small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await request({ req: 'history.restore', versionId });
            onDone();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Échec');
          } finally {
            setBusy(false);
          }
        }}
      >
        <RotateCcw size={16} strokeWidth={1.5} />
        {busy ? 'Restauration' : 'Restaurer'}
      </button>
    </span>
  );
}

function Versions({ path, revision }: { path: string; revision: number }) {
  const ui = useUi();
  const [versions, reload] = useLoad(() => request({ req: 'history.versions', path }), revision);
  if (!versions) return <div className="versions muted">Chargement</div>;
  return (
    <ul className="versions">
      {versions.map((v) => (
        <li key={v.id}>
          <span className="version-when num">{when.format(v.at)}</span>
          <span className="version-meta">
            {v.kind === 'deleted' ? `supprimé par ${v.by}` : `${v.by} · ${bytes(v.size)}`}
            {v.via && <span className="via">via Claude</span>}
          </span>
          {v.current ? (
            <>
              <span className="version-current">Version actuelle</span>
              <button className="icon-btn" title="Aperçu" onClick={() => ui.openPreview({ root: 'shared', path: v.path })}>
                <Eye size={16} strokeWidth={1.5} />
              </button>
            </>
          ) : (
            v.restorable && <RestoreButton versionId={v.id} onDone={reload} />
          )}
        </li>
      ))}
    </ul>
  );
}

function Journal({ revision }: { revision: number }) {
  const [items] = useLoad(() => request({ req: 'history.journal' }), revision);
  const [open, setOpen] = useState<string | null>(null);
  if (!items) return null;
  if (items.length === 0) return <p className="muted">Aucun changement pour l’instant</p>;
  return (
    <ul className="list">
      {items.map((v: VersionView) => {
        const Icon = ICON[v.kind];
        const expanded = open === `${v.id}`;
        return (
          <li key={v.id} className={expanded ? 'is-open' : undefined}>
            <button className="row" onClick={() => setOpen(expanded ? null : `${v.id}`)} aria-expanded={expanded}>
              <Icon size={16} strokeWidth={1.5} className="row-icon" />
              <span className="row-main">{v.path}</span>
              {v.via && <span className="via">via Claude</span>}
              <span className="row-meta">
                {VERB[v.kind]} par {v.by} · {ago(v.at)}
              </span>
            </button>
            {expanded && <Versions path={v.path} revision={revision} />}
          </li>
        );
      })}
    </ul>
  );
}

function Trash({ revision }: { revision: number }) {
  const [items, reload] = useLoad(() => request({ req: 'history.trash' }), revision);
  if (!items) return null;
  if (items.length === 0) return <p className="muted">La corbeille est vide</p>;
  const now = Date.now();
  return (
    <ul className="list">
      {items.map((t: TrashView) => (
        <li key={`${t.path}-${t.deletedAt}`}>
          <div className="row">
            <FileX size={16} strokeWidth={1.5} className="row-icon" />
            <span className="row-main">{t.path}</span>
            <span className="row-meta">
              supprimé par {t.by} · {ago(t.deletedAt, now)} · encore {Math.max(1, Math.ceil((t.expiresAt - now) / 86_400_000))} j
            </span>
            <RestoreButton versionId={t.versionId} onDone={reload} />
          </div>
        </li>
      ))}
    </ul>
  );
}

const OUTCOME = { ok: 'fait', refused: 'refusé', error: 'échec' } as const;

/** Tout ce que Claude a demandé à Binôme, accepté ou non. */
function ClaudeLog({ revision }: { revision: number }) {
  const [items] = useLoad(() => request({ req: 'claude.log' }), revision);
  if (!items) return null;
  if (items.length === 0) return <p className="muted">Claude n’a encore rien demandé</p>;
  return (
    <ul className="list">
      {items.map((e) => (
        <li key={e.id}>
          <div className="row" title={e.detail ?? undefined}>
            <span className="row-main">
              <span className="mono tool-name">{e.tool}</span> {e.summary}
            </span>
            <span className={`row-meta outcome is-${e.outcome}`}>
              {OUTCOME[e.outcome]} · {ago(e.at)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

const PART = { engine: 'Moteur', renderer: 'Interface', main: 'Application' } as Record<string, string>;
const crashWhen = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Plantages de l'app, sur ce PC et chez l'autre : de quoi comprendre ce qui s'est passé. */
function Crashes({ state }: { state: EngineState }) {
  const ui = useUi();
  const [items] = useLoad(() => request({ req: 'crash.list' }), state.crashes.revision);
  const [open, setOpen] = useState<string | null>(null);
  const peer = state.peer?.name ?? 'ton binôme';

  // L'onglet est à l'écran : les plantages de l'autre sont vus.
  useEffect(() => {
    if (state.crashes.unseen > 0) send({ cmd: 'crash.read' });
  }, [state.crashes.unseen]);

  if (!items) return null;
  if (items.length === 0) return <p className="muted">Aucun plantage, ni chez toi ni chez {peer}</p>;
  return (
    <ul className="list">
      {items.map((c: CrashView) => {
        const expanded = open === c.id;
        const where = c.mine ? 'chez toi' : `chez ${peer}`;
        const sent = c.mine ? (c.status === 'sent' ? ` · envoyé à ${peer}` : c.status === 'pending' ? ' · en attente d’envoi' : '') : '';
        return (
          <li key={c.id} className={expanded ? 'is-open' : undefined}>
            <button className="row" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}>
              <span className="crash-part">{PART[c.kind] ?? c.kind}</span>
              <span className="row-main">{c.summary}</span>
              <span className="row-meta">
                {where} · version {c.app} · {ago(c.at)}
              </span>
            </button>
            {expanded && (
              <div className="crash-detail">
                <div className="crash-detail-head">
                  <span className="muted">
                    {crashWhen.format(c.at)}
                    {sent}
                  </span>
                  <button
                    className="btn btn-small btn-quiet"
                    onClick={() => {
                      const text = `Binôme ${c.app}, ${PART[c.kind] ?? c.kind}, ${crashWhen.format(c.at)}\n${c.summary}\n\n${c.log}`;
                      void navigator.clipboard.writeText(text).then(() => ui.toast('Rapport copié'));
                    }}
                  >
                    <Copy size={16} strokeWidth={1.5} />
                    Copier
                  </button>
                </div>
                <pre className="crash-log">{c.log || 'Pas de journal'}</pre>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function History({
  state,
  tab,
  setTab,
}: {
  state: EngineState;
  tab: HistoryTab;
  setTab: (tab: HistoryTab) => void;
}) {
  const revision = state.sync.revision;

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Historique</h1>
          <p className="secondary">
            {tab === 'crashes'
              ? 'Les plantages de Binôme, chez toi et chez ton binôme'
              : 'Les 10 dernières versions de chaque fichier, et les fichiers supprimés depuis moins de 30 jours'}
          </p>
        </div>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === 'journal'} onClick={() => setTab('journal')}>
            Journal
          </button>
          <button role="tab" aria-selected={tab === 'trash'} onClick={() => setTab('trash')}>
            Corbeille
          </button>
          <button role="tab" aria-selected={tab === 'claude'} onClick={() => setTab('claude')}>
            Claude
          </button>
          <button role="tab" aria-selected={tab === 'crashes'} onClick={() => setTab('crashes')}>
            Plantages
            {state.crashes.unseen > 0 && tab !== 'crashes' && <span className="tab-dot" aria-label="nouveau" />}
          </button>
        </div>
      </header>

      {tab === 'crashes' ? (
        <Crashes state={state} />
      ) : tab === 'claude' ? (
        <ClaudeLog revision={state.claude.revision} />
      ) : !state.sync.folder ? (
        <p className="muted">Choisis d’abord un dossier partagé dans Fichiers</p>
      ) : tab === 'journal' ? (
        <Journal revision={revision} />
      ) : (
        <Trash revision={revision} />
      )}
    </section>
  );
}
