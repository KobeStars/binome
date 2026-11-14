/** Le symbole seul : deux points reliés, d'une seule couleur. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <circle cx="5" cy="10" r="3" fill="currentColor" />
      <circle cx="15" cy="10" r="3" fill="currentColor" />
      <rect x="5" y="9.25" width="10" height="1.5" fill="currentColor" />
    </svg>
  );
}
