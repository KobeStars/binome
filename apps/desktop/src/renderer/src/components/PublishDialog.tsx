import { useState } from 'react';
import { File, Folder, ImagePlus, X } from 'lucide-react';
import type { AppCategoryView, EngineState, LibAppDetail, PublishForm } from '../../../engine/api.ts';
import { api, request } from '../lib/engine.ts';
import { bytes } from '../lib/format.ts';
import { CATEGORIES, CATEGORY_LABEL, errorText, jobLabel, jobRatio } from '../lib/library.ts';
import { Markdown } from '../lib/markdown.tsx';

const name = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Version suivante proposée : 1.2.3 → 1.2.4, 0.9 → 0.10. */
function nextVersion(v: string): string {
  const m = /^(.*?)(\d+)([^\d]*)$/.exec(v);
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : '';
}

/** Publier une app, ou une nouvelle version (`app` donné). */
export function PublishDialog({
  state,
  app,
  onClose,
  onDone,
}: {
  state: EngineState;
  app?: LibAppDetail;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [title, setTitle] = useState(app?.name ?? '');
  const [version, setVersion] = useState(app ? nextVersion(app.version) : '1.0');
  const [category, setCategory] = useState<AppCategoryView>(app?.category ?? 'game');
  const [tags, setTags] = useState(app?.tags.join(', ') ?? '');
  const [exe, setExe] = useState(app?.exe ?? '');
  const [icon, setIcon] = useState<string | null | undefined>(undefined);
  const [banner, setBanner] = useState<string | null | undefined>(undefined);
  const [gallery, setGallery] = useState<string[] | undefined>(undefined);
  const [description, setDescription] = useState(app?.description ?? '');
  const [requirements, setRequirements] = useState(app?.requirements ?? '');
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const job = state.library.jobs.find((j) => j.kind === 'publish' && (app ? j.app === app.id : true));
  const peer = state.peer?.name ?? 'ton binôme';

  const pickOne = async (kind: 'image') => (await api().pickFile(kind))[0] ?? null;

  const submit = async () => {
    setError('');
    if (!app && !source) return setError('Choisis le dossier ou l’exe à publier');
    setBusy(true);
    const form: PublishForm = {
      ...(app ? { app: app.id } : {}),
      ...(source ? { source } : {}),
      ...(exe.trim() !== (app?.exe ?? '') ? { exe: exe.trim() || undefined } : {}),
      name: title,
      category,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      description,
      requirements,
      notes,
      version,
      ...(icon !== undefined ? { icon } : {}),
      ...(banner !== undefined ? { banner } : {}),
      ...(gallery !== undefined ? { gallery } : {}),
    };
    try {
      const r = await request({ req: 'lib.publish', form });
      onDone(r.app);
    } catch (err) {
      setError(errorText(err, 'Publication impossible'));
      setBusy(false);
    }
  };

  const media = (label: string, value: string | null | undefined, kept: boolean, set: (v: string | null) => void) => (
    <div className="pick-row">
      <span className="pick-label">{label}</span>
      <span className="pick-value">{value ? name(value) : value === null ? 'Aucune' : kept ? 'Celle de la version actuelle' : 'Aucune'}</span>
      <button className="btn btn-small" disabled={busy} onClick={async () => { const p = await pickOne('image'); if (p) set(p); }}>
        <ImagePlus size={16} strokeWidth={1.5} />
        Choisir
      </button>
      {(value || (kept && value === undefined)) && (
        <button className="icon-btn" aria-label={`Retirer ${label.toLowerCase()}`} disabled={busy} onClick={() => set(null)}>
          <X size={16} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="publish-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="publish-title">{app ? `Nouvelle version de ${app.name}` : 'Publier un jeu ou une app'}</h2>
        <p className="secondary">
          La version est figée à la publication : {peer} installe exactement ces fichiers, compressés et vérifiés à
          l’arrivée.
        </p>

        <div className="publish-form">
          <div className="field">
            <span>Fichiers</span>
            <div className="actions">
              <button className="btn btn-small" disabled={busy} onClick={async () => { const p = await api().pickFolder(); if (p) setSource(p); }}>
                <Folder size={16} strokeWidth={1.5} />
                Un dossier
              </button>
              <button className="btn btn-small" disabled={busy} onClick={async () => { const p = (await api().pickFile('source-file'))[0]; if (p) setSource(p); }}>
                <File size={16} strokeWidth={1.5} />
                Un exe
              </button>
              <span className="path mono muted" title={source ?? app?.source ?? ''}>
                {source ?? (app?.source ? `Même source : ${app.source}` : 'Rien de choisi')}
              </span>
            </div>
          </div>

          <div className="field-pair">
            <label className="field">
              <span>Nom</span>
              <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
            </label>
            <label className="field field-narrow">
              <span>Version</span>
              <input className="mono" value={version} maxLength={32} onChange={(e) => setVersion(e.target.value)} disabled={busy} />
            </label>
          </div>

          <div className="field">
            <span>Catégorie</span>
            <div className="segmented" role="radiogroup" aria-label="Catégorie">
              {CATEGORIES.map((c) => (
                <button key={c} role="radio" aria-checked={category === c} disabled={busy} onClick={() => setCategory(c)}>
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          </div>

          <div className="field-pair">
            <label className="field">
              <span>Tags, séparés par des virgules</span>
              <input value={tags} placeholder="coop, pixel art" onChange={(e) => setTags(e.target.value)} disabled={busy} />
            </label>
            <label className="field">
              <span>Exe de lancement</span>
              <input className="mono" value={exe} placeholder="Deviné si vide" onChange={(e) => setExe(e.target.value)} disabled={busy} />
            </label>
          </div>

          {media('Icône', icon, !!app?.icon, setIcon)}
          {media('Bannière', banner, !!app?.banner, setBanner)}
          <div className="pick-row">
            <span className="pick-label">Galerie</span>
            <span className="pick-value">
              {gallery ? (gallery.length ? gallery.map(name).join(', ') : 'Vide') : app?.gallery.length ? `${app.gallery.length} média(s) de la version actuelle` : 'Vide'}
            </span>
            <button
              className="btn btn-small"
              disabled={busy}
              onClick={async () => {
                const p = await api().pickFile('media', true);
                if (p.length) setGallery([...(gallery ?? []), ...p].slice(0, 12));
              }}
            >
              <ImagePlus size={16} strokeWidth={1.5} />
              Ajouter
            </button>
            {(gallery?.length || (!gallery && app?.gallery.length)) ? (
              <button className="icon-btn" aria-label="Vider la galerie" disabled={busy} onClick={() => setGallery([])}>
                <X size={16} strokeWidth={1.5} />
              </button>
            ) : null}
          </div>

          <div className="field">
            <span className="field-head">
              Description, en Markdown
              <button className="link" onClick={() => setPreview(!preview)}>
                {preview ? 'Modifier' : 'Aperçu'}
              </button>
            </span>
            {preview ? (
              <div className="md-preview">{description.trim() ? <Markdown text={description} /> : <p className="muted">Rien à afficher</p>}</div>
            ) : (
              <textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} placeholder="# Mon jeu&#10;Ce qu’il faut savoir avant de lancer…" />
            )}
          </div>

          <div className="field-pair">
            <label className="field">
              <span>Configuration requise</span>
              <textarea rows={3} value={requirements} onChange={(e) => setRequirements(e.target.value)} disabled={busy} placeholder="Windows 10, 8 Go de mémoire" />
            </label>
            <label className="field">
              <span>Notes de version</span>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} placeholder={app ? 'Ce qui change' : 'Première version'} />
            </label>
          </div>
        </div>

        {busy && job && job.phase !== 'failed' && (
          <div className="publish-progress">
            <div className="transfer-line">
              <span>{jobLabel(job)}</span>
              <span className="num muted">
                {bytes(job.bytes)} sur {bytes(job.total)}
              </span>
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ transform: `scaleX(${jobRatio(job)})` }} />
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}

        <div className="actions modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !title.trim() || !version.trim()}>
            {busy ? 'Publication' : 'Publier'}
          </button>
        </div>
      </div>
    </div>
  );
}
