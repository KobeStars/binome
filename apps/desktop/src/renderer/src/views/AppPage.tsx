import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bug, Check, Download, FolderOpen, Play, RefreshCw, RotateCcw, Send, Trash2, Upload, X } from 'lucide-react';
import type { EngineState, LibAppDetail, MediaView } from '../../../engine/api.ts';
import { BugDialog } from '../components/BugDialog.tsx';
import { useLaunch } from '../components/Launch.tsx';
import { PublishDialog } from '../components/PublishDialog.tsx';
import { Stars } from '../components/Stars.tsx';
import { api, request, send } from '../lib/engine.ts';
import { ago, bytes } from '../lib/format.ts';
import { CATEGORY_LABEL, errorText, jobLabel, jobRatio, mediaUrl, playTime, useCountdown, type LibRoute } from '../lib/library.ts';
import { Markdown } from '../lib/markdown.tsx';
import { useUi } from '../lib/ui.tsx';

type Tab = 'overview' | 'gallery' | 'notes' | 'reviews' | 'bugs';

const day = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

function useDetail(id: string, revision: number): [LibAppDetail | null | undefined, () => void] {
  const [d, setD] = useState<LibAppDetail | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    request({ req: 'lib.app', app: id }).then(
      (x) => alive && setD(x),
      () => alive && setD(null),
    );
    return () => {
      alive = false;
    };
  }, [id, revision, tick]);
  return [d, () => setTick((n) => n + 1)];
}

function Lightbox({ media, onClose }: { media: MediaView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop lightbox" onClick={onClose}>
      {media.type.startsWith('video/') ? (
        <video src={mediaUrl(media)} controls autoPlay onClick={(e) => e.stopPropagation()} />
      ) : (
        <img src={mediaUrl(media)} alt="" />
      )}
    </div>
  );
}

function ReviewForm({ app, mine }: { app: LibAppDetail; mine: { stars: number; text: string } | null }) {
  const ui = useUi();
  const [stars, setStars] = useState(mine?.stars ?? 0);
  const [text, setText] = useState(mine?.text ?? '');
  const [busy, setBusy] = useState(false);
  const save = async (s: number) => {
    setBusy(true);
    try {
      await request({ req: 'lib.review', app: app.id, stars: s, text });
      ui.toast(s ? 'Avis publié' : 'Avis retiré');
      if (!s) {
        setStars(0);
        setText('');
      }
    } catch (err) {
      ui.toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card review-form">
      <div className="setting-row">
        <span>{mine ? 'Ton avis' : `Ton avis sur ${app.name}`}</span>
        <Stars value={stars} onChange={setStars} size={20} />
      </div>
      <textarea rows={3} value={text} maxLength={2000} placeholder="Ce qui t’a plu, ce qui coince" onChange={(e) => setText(e.target.value)} />
      <div className="actions">
        <button className="btn btn-small btn-primary" disabled={busy || stars === 0} onClick={() => void save(stars)}>
          {mine ? 'Mettre à jour' : 'Publier l’avis'}
        </button>
        {mine && (
          <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => void save(0)}>
            Retirer
          </button>
        )}
      </div>
    </div>
  );
}

function TestButton({ state, app }: { state: EngineState; app: LibAppDetail }) {
  const ui = useUi();
  const out = state.library.testOut?.app === app.id ? state.library.testOut : null;
  const left = useCountdown(out && !out.answer ? out.expiresAt : null);
  const peer = state.peer?.name ?? 'ton binôme';
  if (out?.answer) {
    return <span className="test-status">{out.answer === 'yes' ? `${peer} lance le test` : `${peer} ne peut pas maintenant`}</span>;
  }
  if (out && left > 0) {
    return (
      <span className="test-status">
        En attente de {peer} <span className="num">0:{String(left).padStart(2, '0')}</span>
      </span>
    );
  }
  return (
    <button
      className="btn"
      disabled={!state.route}
      title={state.route ? `Demander à ${peer} de tester tout de suite` : `${peer} est hors ligne`}
      onClick={async () => {
        const r = await request({ req: 'lib.test', app: app.id }).catch(() => 'offline' as const);
        if (r === 'offline') ui.toast(`${peer} est hors ligne`);
      }}
    >
      <Send size={16} strokeWidth={1.5} />
      Teste mon jeu !
    </button>
  );
}

export function AppPage({
  state,
  id,
  autoplay,
  back,
  setRoute,
}: {
  state: EngineState;
  id: string;
  autoplay: boolean;
  back: () => void;
  setRoute: (r: LibRoute) => void;
}) {
  const ui = useUi();
  const [d, reload] = useDetail(id, state.library.revision);
  const [tab, setTab] = useState<Tab>('overview');
  const [lightbox, setLightbox] = useState<MediaView | null>(null);
  const [bugOpen, setBugOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const peer = state.peer?.name ?? 'ton binôme';
  const { launch, dialog } = useLaunch(peer);
  const job = state.library.jobs.find((j) => j.app === id);
  const autoplayDone = useRef(false);

  // « Teste mon jeu ! » accepté : installe ou met à jour si besoin, puis lance.
  useEffect(() => {
    if (!autoplay || autoplayDone.current || !d || d.mine) return;
    if (job && job.phase !== 'failed') return;
    if (!d.installed || d.update) {
      if (!job) void request({ req: 'lib.install', app: d.id });
      return;
    }
    autoplayDone.current = true;
    void launch(d.id, d.name);
  }, [autoplay, d, job]);

  useEffect(() => {
    if (tab === 'bugs' && d?.mine && state.library.unseenBugs > 0) send({ cmd: 'lib.bugs.read' });
  }, [tab, d?.mine, state.library.unseenBugs]);

  if (d === undefined) return <section className="view" />;
  if (d === null) {
    return (
      <section className="view">
        <button className="btn btn-quiet btn-small back" onClick={back}>
          <ArrowLeft size={16} strokeWidth={1.5} />
          Bibliothèque
        </button>
        <p className="muted">Cette app n’est plus dans la Bibliothèque</p>
      </section>
    );
  }

  const act = async (fn: () => Promise<unknown>, fail: string) => {
    try {
      await fn();
    } catch (err) {
      ui.toast(errorText(err, fail));
    }
  };
  const play = d.category === 'game' ? 'Jouer' : 'Lancer';
  const myReview = d.reviews.find((r) => r.mine) ?? null;
  const rating = d.reviews.length ? d.reviews.reduce((n, r) => n + r.stars, 0) / d.reviews.length : null;
  const openBugs = d.bugs.filter((b) => b.status === 'open').length;

  let primary;
  if (job && job.phase !== 'failed') {
    primary = (
      <div className="job">
        <div className="transfer-line">
          <span>{jobLabel(job)}</span>
          <span className="num muted">{job.total ? `${Math.round(jobRatio(job) * 100)} %` : ''}</span>
        </div>
        <div className="bar">
          <div className="bar-fill" style={{ transform: `scaleX(${jobRatio(job)})` }} />
        </div>
      </div>
    );
  } else if (d.running) {
    primary = (
      <button className="btn btn-primary btn-large" disabled>
        En cours
      </button>
    );
  } else if (!d.mine && !d.installed) {
    primary = (
      <button className="btn btn-primary btn-large" disabled={!state.route} title={state.route ? undefined : `${peer} doit être en ligne`} onClick={() => void act(() => request({ req: 'lib.install', app: d.id }), 'Installation impossible')}>
        <Download size={16} strokeWidth={1.5} />
        Installer <span className="num">{bytes(d.size)}</span>
      </button>
    );
  } else if (d.update) {
    primary = (
      <button className="btn btn-primary btn-large" disabled={!state.route} onClick={() => void act(() => request({ req: 'lib.install', app: d.id }), 'Mise à jour impossible')}>
        <RefreshCw size={16} strokeWidth={1.5} />
        Mettre à jour en {d.version}
      </button>
    );
  } else if (d.canLaunch) {
    primary = (
      <button className="btn btn-primary btn-large" onClick={() => void launch(d.id, d.name)}>
        <Play size={16} strokeWidth={1.5} />
        {play}
      </button>
    );
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Aperçu' },
    { id: 'gallery', label: 'Galerie', count: d.gallery.length },
    { id: 'notes', label: 'Notes de version' },
    { id: 'reviews', label: 'Avis', count: d.reviews.length },
  ];
  if (d.mine || d.bugs.length) tabs.push({ id: 'bugs', label: 'Bugs', count: openBugs });

  return (
    <section className="view app-page">
      <button className="btn btn-quiet btn-small back" onClick={back}>
        <ArrowLeft size={16} strokeWidth={1.5} />
        Bibliothèque
      </button>

      <div className={`app-hero${d.banner ? '' : ' is-plain'}`}>
        {d.banner && <img className="app-hero-banner" src={mediaUrl(d.banner)} alt="" draggable={false} />}
      </div>
      <header className="app-head">
        <div className="app-icon">{d.icon ? <img src={mediaUrl(d.icon)} alt="" draggable={false} /> : <span>{d.name.slice(0, 1)}</span>}</div>
        <div className="head-text">
          <h1>{d.name}</h1>
          <p className="secondary">
            {CATEGORY_LABEL[d.category]} · par {d.mine ? 'toi' : d.author}
            {d.via && <span className="via">via Claude</span>}
            {d.removed && <span className="app-chip">Retiré par {d.author}</span>}
          </p>
        </div>
        <div className="head-actions app-actions">
          {d.mine && d.canLaunch && !d.running && (
            <button className="btn" onClick={() => void launch(d.id, d.name)}>
              <Play size={16} strokeWidth={1.5} />
              {play}
            </button>
          )}
          {d.mine && <TestButton state={state} app={d} />}
          {d.mine && (
            <button className="btn btn-primary btn-large" onClick={() => setUpdating(true)}>
              <Upload size={16} strokeWidth={1.5} />
              Publier une mise à jour
            </button>
          )}
          {!d.mine && primary}
        </div>
      </header>
      {job?.phase === 'failed' && (
        <div className="job-failed">
          <span className="error">{job.error}</span>
          <button className="btn btn-small" onClick={() => void act(() => request({ req: 'lib.install', app: d.id }), 'Échec')}>
            <RotateCcw size={16} strokeWidth={1.5} />
            Réessayer
          </button>
          <button className="icon-btn" aria-label="Fermer" onClick={() => send({ cmd: 'lib.job.dismiss', app: d.id })}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}
      {d.mine && job && job.phase !== 'failed' && primary}

      <div className="app-body">
        <div className="app-main">
          <div className="segmented" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                {t.count ? <span className="tab-count num">{t.count}</span> : null}
                {t.id === 'bugs' && d.mine && state.library.unseenBugs > 0 && tab !== 'bugs' && <span className="tab-dot" aria-label="nouveau" />}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div className="app-section">
              {d.description.trim() ? <Markdown text={d.description} /> : <p className="muted">Pas de description</p>}
              {d.tags.length > 0 && (
                <div className="chips">
                  {d.tags.map((t) => (
                    <span key={t} className="chip chip-static">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {d.requirements.trim() && (
                <>
                  <h2 className="section-title">Configuration requise</h2>
                  <p className="pre-line">{d.requirements}</p>
                </>
              )}
            </div>
          )}

          {tab === 'gallery' &&
            (d.gallery.length === 0 ? (
              <p className="muted app-section">Pas encore d’images ni de vidéos</p>
            ) : (
              <div className="gallery app-section">
                {d.gallery.map((m) => (
                  <button key={m.name} className="gallery-item" onClick={() => setLightbox(m)} aria-label="Agrandir">
                    {m.type.startsWith('video/') ? <video src={mediaUrl(m)} muted preload="metadata" /> : <img src={mediaUrl(m)} alt="" loading="lazy" />}
                    {m.type.startsWith('video/') && (
                      <span className="gallery-play">
                        <Play size={16} strokeWidth={1.5} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}

          {tab === 'notes' && (
            <ol className="release-notes app-section">
              {d.releases.map((r, i) => (
                <li key={r.version}>
                  <div className="release-head">
                    <span className="num">{r.version}</span>
                    {i === 0 && <span className="app-chip is-ink">Actuelle</span>}
                    <span className="muted">{day.format(r.at)}</span>
                  </div>
                  {r.notes.trim() ? <Markdown text={r.notes} /> : <p className="muted">Pas de notes</p>}
                </li>
              ))}
            </ol>
          )}

          {tab === 'reviews' && (
            <div className="app-section reviews">
              {!d.mine && <ReviewForm key={myReview?.at ?? 0} app={d} mine={myReview} />}
              {d.reviews.length === 0 ? (
                <p className="muted">{d.mine ? `${peer} n’a pas encore laissé d’avis` : 'Pas encore d’avis'}</p>
              ) : (
                <ul className="list">
                  {d.reviews.map((r) => (
                    <li key={r.by} className="review">
                      <div className="review-head">
                        <Stars value={r.stars} />
                        <span className="muted">
                          {r.mine ? 'Toi' : r.by} · {ago(r.at)}
                        </span>
                      </div>
                      {r.text && <p className="pre-line">{r.text}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === 'bugs' && (
            <div className="app-section">
              {d.bugs.length === 0 ? (
                <p className="muted">Aucun bug signalé</p>
              ) : (
                <ul className="list">
                  {d.bugs.map((b) => (
                    <li key={b.id} className={`bug${b.status === 'fixed' ? ' is-fixed' : ''}`}>
                      <div className="bug-main">
                        <div className="bug-head">
                          <span className={`app-chip${b.status === 'open' ? ' is-alert' : ''}`}>{b.status === 'open' ? 'Ouvert' : 'Corrigé'}</span>
                          <span className="muted">
                            v{b.version} · {b.mine ? 'toi' : b.by} · {ago(b.at)}
                          </span>
                        </div>
                        <p className="pre-line">{b.text}</p>
                      </div>
                      {b.shot && (
                        <button className="bug-shot" onClick={() => setLightbox(b.shot!)} aria-label="Voir la capture">
                          <img src={mediaUrl(b.shot)} alt="" loading="lazy" />
                        </button>
                      )}
                      {d.mine && (
                        <button
                          className="btn btn-small"
                          onClick={() => void act(() => request({ req: 'lib.bug.status', id: b.id, status: b.status === 'open' ? 'fixed' : 'open' }), 'Échec')}
                        >
                          {b.status === 'open' ? <Check size={16} strokeWidth={1.5} /> : <RotateCcw size={16} strokeWidth={1.5} />}
                          {b.status === 'open' ? 'Corrigé' : 'Rouvrir'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <aside className="app-side">
          <dl className="facts facts-side">
            <dt>Auteur</dt>
            <dd>{d.mine ? state.name : d.author}</dd>
            <dt>Version</dt>
            <dd className="num">{d.version}</dd>
            {!d.mine && d.installed && d.installed !== d.version && (
              <>
                <dt>Installée</dt>
                <dd className="num">{d.installed}</dd>
              </>
            )}
            <dt>Taille</dt>
            <dd className="num">{bytes(d.size)}</dd>
            <dt>Mise à jour</dt>
            <dd>{day.format(d.at)}</dd>
            <dt>{d.category === 'game' ? 'Temps de jeu' : 'Utilisation'}</dt>
            <dd>{playTime(d.playMs)}</dd>
            {rating !== null && (
              <>
                <dt>Note</dt>
                <dd>
                  <Stars value={Math.round(rating)} size={14} />
                </dd>
              </>
            )}
          </dl>
          <div className="side-actions">
            {!d.mine && (
              <button className="btn btn-small btn-quiet" onClick={() => setBugOpen(true)}>
                <Bug size={16} strokeWidth={1.5} />
                Signaler un bug
              </button>
            )}
            {(d.installDir || (d.mine && d.source)) && (
              <button className="btn btn-small btn-quiet" onClick={() => void api().openFolder(d.installDir ?? d.source!)}>
                <FolderOpen size={16} strokeWidth={1.5} />
                Ouvrir le dossier
              </button>
            )}
            {!d.mine && d.installed && (
              <button
                className="btn btn-small btn-quiet"
                disabled={d.running}
                onClick={() =>
                  void act(async () => {
                    await request({ req: 'lib.uninstall', app: d.id });
                    ui.toast(`${d.name} désinstallé`);
                    if (d.removed) back();
                  }, 'Désinstallation impossible')
                }
              >
                <Trash2 size={16} strokeWidth={1.5} />
                Désinstaller
              </button>
            )}
            {d.mine && !confirmRemove && (
              <button className="btn btn-small btn-quiet" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={16} strokeWidth={1.5} />
                Retirer de la Bibliothèque
              </button>
            )}
            {d.mine && confirmRemove && (
              <button
                className="btn btn-small btn-danger"
                onClick={() =>
                  void act(async () => {
                    await request({ req: 'lib.remove', app: d.id });
                    ui.toast(`${d.name} retiré de la Bibliothèque`);
                    back();
                  }, 'Échec')
                }
              >
                Retirer pour de bon : {peer} ne pourra plus l’installer
              </button>
            )}
          </div>
        </aside>
      </div>

      {lightbox && <Lightbox media={lightbox} onClose={() => setLightbox(null)} />}
      {bugOpen && <BugDialog app={d.id} name={d.name} author={d.author} onClose={() => setBugOpen(false)} />}
      {updating && (
        <PublishDialog
          state={state}
          app={d}
          onClose={() => setUpdating(false)}
          onDone={(appId) => {
            setUpdating(false);
            reload();
            if (appId !== d.id) setRoute({ page: 'app', id: appId });
            ui.toast('Nouvelle version publiée');
          }}
        />
      )}
      {dialog}
    </section>
  );
}
