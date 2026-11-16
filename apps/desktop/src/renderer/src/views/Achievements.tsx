import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import type { AchievementView, EngineState } from '../../../engine/api.ts';
import { request } from '../lib/engine.ts';
import { ACCENTS } from '../lib/fx.ts';

const day = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });

export function Achievements({ state }: { state: EngineState }) {
  const [items, setItems] = useState<AchievementView[] | null>(null);
  const { level, xp, current, next } = state.library.level;
  const peer = state.peer?.name ?? 'ton binôme';

  useEffect(() => {
    let alive = true;
    request({ req: 'lib.achievements' }).then((x) => alive && setItems(x), () => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [state.library.revision, xp]);

  const nextTheme = ACCENTS.find((a) => a.level > level);
  const unlocked = items?.filter((a) => a.at !== null).length ?? 0;
  return (
    <div className="achievements">
      <div className="card level-card">
        <div className="level-big">
          <span className="muted">Niveau</span>
          <span className="num level-number">{level}</span>
        </div>
        <div className="level-detail">
          <div className="transfer-line">
            <span className="num">{xp} XP</span>
            <span className="muted num">encore {next - xp} pour le niveau {level + 1}</span>
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ transform: `scaleX(${(xp - current) / Math.max(1, next - current)})` }} />
          </div>
          <p className="muted">
            {nextTheme ? `Thème ${nextTheme.name} au niveau ${nextTheme.level}` : 'Tous les thèmes sont débloqués'}
            {state.library.peerLevel !== null && ` · ${peer} est niveau ${state.library.peerLevel}`}
          </p>
        </div>
      </div>

      <h2 className="section-title">
        Succès <span className="num muted">{unlocked} sur {items?.length ?? 0}</span>
      </h2>
      <ul className="achievement-grid">
        {(items ?? []).map((a) => (
          <li key={a.id} className={`achievement${a.at ? ' is-done' : ''}`}>
            <div className="achievement-head">
              <span>{a.title}</span>
              {a.at ? <span className="num muted">+{a.xp} XP</span> : <Lock size={16} strokeWidth={1.5} aria-label="À débloquer" />}
            </div>
            <p className="muted">{a.at ? `Débloqué le ${day.format(a.at)}` : a.hint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
