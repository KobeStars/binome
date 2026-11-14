/**
 * Signature de Binôme : deux points reliés par un trait.
 * `off` : l'autre est absent (trait en pointillés, point creux).
 * `pending` : en ligne mais pas encore de canal. `on` : reliés.
 * `progress` remplit le trait pendant un transfert.
 */
export function Liaison({
  state,
  progress = null,
  className = '',
}: {
  state: 'off' | 'pending' | 'on' | 'sent';
  progress?: number | null;
  className?: string;
}) {
  const fill = state === 'on' ? (progress ?? 1) : 0;
  return (
    <span className={`liaison is-${state} ${className}`} aria-hidden>
      <span className="liaison-dot" />
      <span className="liaison-line">
        <span className="liaison-fill" style={{ transform: `scaleX(${fill})` }} />
      </span>
      <span className="liaison-dot is-peer" />
    </span>
  );
}
