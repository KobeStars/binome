import { useEffect, useState, type CSSProperties } from 'react';
import type { StatusKind } from '../../../engine/api.ts';
import { hueOf, initials } from '../lib/profile.ts';

/**
 * Photo de profil (binome://avatar/me ou /peer), ou initiales sur une teinte tirée du nom.
 * `rev` change à chaque nouvelle photo : l'image est rechargée.
 * `status` : pastille de présence en bas à droite.
 */
export function Avatar({
  who,
  rev,
  name,
  size = 28,
  status,
}: {
  who: 'me' | 'peer';
  rev: number;
  name: string;
  size?: number;
  status?: StatusKind | 'offline' | null;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [rev]);
  const style = { '--avatar': `${size}px`, '--hue': hueOf(name) } as CSSProperties;
  return (
    <span className="avatar" style={style} aria-hidden>
      {rev > 0 && !broken ? (
        <img src={`binome://avatar/${who}?r=${rev}`} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className="avatar-initials">{initials(name)}</span>
      )}
      {status && <span className={`avatar-status is-${status}`} />}
    </span>
  );
}
