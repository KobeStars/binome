import { useEffect, useState } from 'react';
import type { EngineState, WrappedView } from '../../../engine/api.ts';
import { request } from '../lib/engine.ts';
import { bytes } from '../lib/format.ts';
import { mediaUrl, playTime } from '../lib/library.ts';

const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  const s = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(y!, mo! - 1, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Récap du mois : temps de jeu, jeux préférés, ce qui a été partagé et débloqué. */
export function Wrapped({ state }: { state: EngineState }) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [w, setW] = useState<WrappedView | null>(null);

  useEffect(() => {
    let alive = true;
    request({ req: 'lib.wrapped', month }).then((x) => alive && setW(x), () => alive && setW(null));
    return () => {
      alive = false;
    };
  }, [month, state.library.revision]);

  if (!w) return null;
  const top = w.top[0];
  const max = Math.max(1, ...w.top.map((t) => t.ms));
  const stats: [string, string][] = [
    ['Séances', String(w.sessions)],
    ['Fichiers envoyés', String(w.filesSent)],
    ['Données partagées', bytes(w.bytesSent)],
    ['XP gagnée', String(w.xp)],
    ['Publications', String(w.published + w.updates)],
    ['Avis laissés', String(w.reviews)],
    ['Bugs signalés', String(w.bugs)],
    ['Idées', String(w.ideas)],
  ];

  return (
    <div className="wrapped">
      <div className="wrapped-hero card">
        <div className="wrapped-hero-head">
          <select value={w.month} onChange={(e) => setMonth(e.target.value)} aria-label="Mois">
            {w.months.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </select>
        </div>
        <p className="secondary">Temps de jeu</p>
        <p className="wrapped-big num">{playTime(w.playMs)}</p>
        <p className="secondary">
          {top ? `Surtout sur ${top.name}` : 'Aucune partie lancée depuis Binôme ce mois-ci'}
          {w.nights > 0 && ` · ${w.nights} séance${w.nights > 1 ? 's' : ''} après 2 h du matin`}
        </p>
      </div>

      <div className="wrapped-stats">
        {stats.map(([label, value]) => (
          <div key={label} className="card wrapped-stat">
            <span className="muted">{label}</span>
            <span className="num wrapped-value">{value}</span>
          </div>
        ))}
      </div>

      {w.top.length > 0 && (
        <>
          <h2 className="section-title">Les plus joués</h2>
          <ol className="list wrapped-top">
            {w.top.map((t, i) => (
              <li key={t.app} className="row">
                <span className="num muted">{i + 1}</span>
                <span className="wrapped-icon">{t.icon ? <img src={mediaUrl(t.icon)} alt="" /> : t.name.slice(0, 1)}</span>
                <span className="row-main">{t.name}</span>
                <span className="wrapped-bar bar">
                  <span className="bar-fill" style={{ transform: `scaleX(${t.ms / max})` }} />
                </span>
                <span className="row-meta num">{playTime(t.ms)}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {w.achievements.length > 0 && (
        <>
          <h2 className="section-title">Succès débloqués</h2>
          <div className="chips">
            {w.achievements.map((a) => (
              <span key={a.title} className="chip chip-static">
                {a.title}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
