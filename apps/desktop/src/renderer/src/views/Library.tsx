import { useEffect, useMemo, useState } from 'react';
import { Play, Plus, Search } from 'lucide-react';
import type { EngineState, LibAppView } from '../../../engine/api.ts';
import { useLaunch } from '../components/Launch.tsx';
import { PublishDialog } from '../components/PublishDialog.tsx';
import { request } from '../lib/engine.ts';
import { CATEGORY_LABEL, jobRatio, mediaUrl, type LibRoute } from '../lib/library.ts';
import { Achievements } from './Achievements.tsx';
import { AppPage } from './AppPage.tsx';
import { Ideas } from './Ideas.tsx';
import { Wrapped } from './Wrapped.tsx';

type Filter = 'all' | 'games' | 'apps' | 'installed' | 'updates';
type Sort = 'recent' | 'played' | 'az';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tout' },
  { id: 'games', label: 'Jeux' },
  { id: 'apps', label: 'Apps' },
  { id: 'installed', label: 'Installés' },
  { id: 'updates', label: 'Mises à jour' },
];

const SORTS: Record<Sort, (a: LibAppView, b: LibAppView) => number> = {
  recent: (a, b) => b.at - a.at,
  played: (a, b) => b.playMs - a.playMs || (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0),
  az: (a, b) => a.name.localeCompare(b.name, 'fr'),
};

const TABS = [
  { page: 'grid', label: 'Jeux et apps' },
  { page: 'ideas', label: 'Idées' },
  { page: 'achievements', label: 'Succès' },
  { page: 'wrapped', label: 'Récap' },
] as const;

export function useLibraryList(revision: number): LibAppView[] | null {
  const [apps, setApps] = useState<LibAppView[] | null>(null);
  useEffect(() => {
    let alive = true;
    request({ req: 'lib.list' }).then(
      (a) => alive && setApps(a),
      () => alive && setApps([]),
    );
    return () => {
      alive = false;
    };
  }, [revision]);
  return apps;
}

function status(a: LibAppView): string | null {
  if (a.running) return 'En cours';
  if (a.removed) return 'Retiré';
  if (a.update) return 'Mise à jour';
  if (a.mine) return null;
  return a.installed ? 'Installé' : null;
}

function AppCard({ app, state, open, launch }: { app: LibAppView; state: EngineState; open: () => void; launch: () => void }) {
  const job = state.library.jobs.find((j) => j.app === app.id);
  const chip = status(app);
  const cover = app.banner ?? app.icon;
  return (
    <div className="app-card">
      <button className="app-card-open" onClick={open} aria-label={`Ouvrir ${app.name}`}>
        <div className={`app-cover${app.banner ? '' : ' is-icon'}`}>
          {cover ? <img src={mediaUrl(cover)} alt="" draggable={false} /> : <span className="app-cover-letter">{app.name.slice(0, 1)}</span>}
          {job && job.phase !== 'failed' && (
            <div className="app-cover-bar bar">
              <div className="bar-fill" style={{ transform: `scaleX(${jobRatio(job)})` }} />
            </div>
          )}
        </div>
        <div className="app-card-body">
          <div className="app-card-title">{app.name}</div>
          <div className="app-card-meta">
            <span>
              {CATEGORY_LABEL[app.category]} · {app.mine ? 'toi' : app.author}
            </span>
            {chip && <span className={`app-chip${app.update || app.running ? ' is-ink' : ''}`}>{chip}</span>}
          </div>
        </div>
      </button>
      {app.canLaunch && !app.running && (
        <button className="app-card-play" title={`Lancer ${app.name}`} aria-label={`Lancer ${app.name}`} onClick={launch}>
          <Play size={16} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}

function Grid({ state, setRoute }: { state: EngineState; setRoute: (r: LibRoute) => void }) {
  const apps = useLibraryList(state.library.revision);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [query, setQuery] = useState('');
  const peer = state.peer?.name ?? 'ton binôme';
  const { launch, dialog } = useLaunch(peer);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? [])
      .filter((a) => {
        if (filter === 'games' && a.category !== 'game') return false;
        if (filter === 'apps' && a.category === 'game') return false;
        if (filter === 'installed' && a.installed === null) return false;
        if (filter === 'updates' && !a.update) return false;
        return !q || a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q));
      })
      .sort(SORTS[sort]);
  }, [apps, filter, sort, query]);

  if (!apps) return null;
  if (apps.length === 0) {
    return (
      <div className="empty">
        <p>Rien dans la Bibliothèque pour l’instant</p>
        <p className="muted">Publie un jeu ou une app : {peer} pourra l’installer et y jouer.</p>
      </div>
    );
  }
  return (
    <>
      <div className="lib-toolbar">
        <label className="search">
          <Search size={16} strokeWidth={1.5} />
          <input placeholder="Rechercher" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un jeu ou une app" />
        </label>
        <div className="segmented" role="tablist" aria-label="Filtre">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id === 'updates' && state.library.updates > 0 && <span className="tab-count num">{state.library.updates}</span>}
            </button>
          ))}
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Trier">
          <option value="recent">Récents</option>
          <option value="played">Plus joués</option>
          <option value="az">A à Z</option>
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="muted">Aucun résultat</p>
      ) : (
        <div className="app-grid">
          {shown.map((a) => (
            <AppCard key={a.id} app={a} state={state} open={() => setRoute({ page: 'app', id: a.id })} launch={() => void launch(a.id, a.name)} />
          ))}
        </div>
      )}
      {dialog}
    </>
  );
}

function LevelBadge({ state, onClick }: { state: EngineState; onClick: () => void }) {
  const { level, xp, current, next } = state.library.level;
  return (
    <button className="level-badge" onClick={onClick} title={`${xp} XP`}>
      <span>Niveau {level}</span>
      <span className="bar level-bar">
        <span className="bar-fill" style={{ transform: `scaleX(${(xp - current) / Math.max(1, next - current)})` }} />
      </span>
    </button>
  );
}

export function Library({ state, route, setRoute }: { state: EngineState; route: LibRoute; setRoute: (r: LibRoute) => void }) {
  const [publishing, setPublishing] = useState(false);
  if (route.page === 'app') return <AppPage state={state} id={route.id} autoplay={route.autoplay === true} back={() => setRoute({ page: 'grid' })} setRoute={setRoute} />;

  const peer = state.peer?.name ?? 'ton binôme';
  return (
    <section className="view">
      <header className="view-head">
        <div className="head-text">
          <h1>Bibliothèque</h1>
          <p className="secondary">Les jeux et apps de toi et {peer}</p>
        </div>
        <div className="head-actions">
          <LevelBadge state={state} onClick={() => setRoute({ page: 'achievements' })} />
          <button className="btn btn-primary" onClick={() => setPublishing(true)}>
            <Plus size={16} strokeWidth={1.5} />
            Publier
          </button>
        </div>
      </header>
      <div className="segmented lib-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.page} role="tab" aria-selected={route.page === t.page} onClick={() => setRoute({ page: t.page })}>
            {t.label}
          </button>
        ))}
      </div>

      {route.page === 'grid' && <Grid state={state} setRoute={setRoute} />}
      {route.page === 'ideas' && <Ideas state={state} />}
      {route.page === 'achievements' && <Achievements state={state} />}
      {route.page === 'wrapped' && <Wrapped state={state} />}

      {publishing && (
        <PublishDialog
          state={state}
          onClose={() => setPublishing(false)}
          onDone={(id) => {
            setPublishing(false);
            setRoute({ page: 'app', id });
          }}
        />
      )}
    </section>
  );
}
