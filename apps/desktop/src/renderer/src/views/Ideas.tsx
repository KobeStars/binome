import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { EngineState, LibIdeaView } from '../../../engine/api.ts';
import { request } from '../lib/engine.ts';
import { ago } from '../lib/format.ts';
import { errorText } from '../lib/library.ts';
import { useUi } from '../lib/ui.tsx';
import { useLibraryList } from './Library.tsx';

type Status = LibIdeaView['status'];
const COLUMNS: { id: Status; label: string }[] = [
  { id: 'open', label: 'À faire' },
  { id: 'doing', label: 'En cours' },
  { id: 'done', label: 'Fait' },
];

/** Tableau d'idées et wishlist, communs aux deux : chacun ajoute, déplace, coche. */
export function Ideas({ state }: { state: EngineState }) {
  const ui = useUi();
  const apps = useLibraryList(state.library.revision) ?? [];
  const [ideas, setIdeas] = useState<LibIdeaView[] | null>(null);
  const [kind, setKind] = useState<'idea' | 'wish'>('idea');
  const [text, setText] = useState('');
  const [app, setApp] = useState('');
  const peer = state.peer?.name ?? 'ton binôme';

  useEffect(() => {
    let alive = true;
    request({ req: 'lib.ideas' }).then((x) => alive && setIdeas(x), () => alive && setIdeas([]));
    return () => {
      alive = false;
    };
  }, [state.library.revision]);

  const save = async (idea: { id?: string; kind: 'idea' | 'wish'; text: string; status?: Status; app?: string | null }) => {
    try {
      await request({ req: 'lib.idea.save', idea });
    } catch (err) {
      ui.toast(errorText(err));
    }
  };

  const add = async () => {
    if (!text.trim()) return;
    await save({ kind, text, app: kind === 'idea' && app ? app : null });
    setText('');
  };

  const card = (i: LibIdeaView) => (
    <li key={i.id} className="idea">
      <p className="pre-line">{i.text}</p>
      <div className="idea-foot">
        <span className="muted">
          {i.mine ? 'toi' : i.by}
          {i.appName && ` · ${i.appName}`} · {ago(i.updatedAt)}
        </span>
        <span className="idea-actions">
          {i.kind === 'idea' && (
            <select
              value={i.status}
              aria-label="État"
              onChange={(e) => void save({ id: i.id, kind: i.kind, text: i.text, status: e.target.value as Status })}
            >
              {COLUMNS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn" aria-label="Supprimer" onClick={() => void request({ req: 'lib.idea.delete', id: i.id })}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </span>
      </div>
    </li>
  );

  const wishes = (ideas ?? []).filter((i) => i.kind === 'wish');
  return (
    <div className="ideas">
      <div className="idea-new card">
        <div className="segmented" role="radiogroup" aria-label="Type">
          <button role="radio" aria-checked={kind === 'idea'} onClick={() => setKind('idea')}>
            Idée
          </button>
          <button role="radio" aria-checked={kind === 'wish'} onClick={() => setKind('wish')}>
            Wishlist
          </button>
        </div>
        <input
          value={text}
          maxLength={500}
          placeholder={kind === 'idea' ? 'Un mode coop, un boss de plus…' : 'Un jeu ou un outil que tu aimerais avoir'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        {kind === 'idea' && (
          <select value={app} onChange={(e) => setApp(e.target.value)} aria-label="App concernée">
            <option value="">Sans app</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => void add()}>
          <Plus size={16} strokeWidth={1.5} />
          Ajouter
        </button>
      </div>
      <p className="muted">Partagé avec {peer} : chacun peut déplacer ou supprimer une idée.</p>

      <div className="board">
        {COLUMNS.map((c) => {
          const items = (ideas ?? []).filter((i) => i.kind === 'idea' && i.status === c.id);
          return (
            <section key={c.id} className="board-col">
              <h2>
                {c.label} <span className="num muted">{items.length}</span>
              </h2>
              <ul>{items.map(card)}</ul>
            </section>
          );
        })}
      </div>

      <h2 className="section-title">Wishlist</h2>
      {wishes.length === 0 ? (
        <p className="muted">Rien dans la wishlist</p>
      ) : (
        <ul className="list wishlist">
          {wishes.map((w) => (
            <li key={w.id}>
              <label className="row wish">
                <input
                  type="checkbox"
                  checked={w.status === 'done'}
                  onChange={(e) => void save({ id: w.id, kind: 'wish', text: w.text, status: e.target.checked ? 'done' : 'open' })}
                />
                <span className={`row-main${w.status === 'done' ? ' is-done' : ''}`}>{w.text}</span>
                <span className="row-meta">{w.mine ? 'toi' : w.by}</span>
                <button className="icon-btn" aria-label="Supprimer" onClick={() => void request({ req: 'lib.idea.delete', id: w.id })}>
                  <X size={16} strokeWidth={1.5} />
                </button>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
