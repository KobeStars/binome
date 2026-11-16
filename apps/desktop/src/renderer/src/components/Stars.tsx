import { Star } from 'lucide-react';

/** Note de 1 à 5. Avec `onChange`, les étoiles se cliquent. */
export function Stars({ value, onChange, size = 16 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <span className={`stars${onChange ? ' is-input' : ''}`} role={onChange ? 'radiogroup' : 'img'} aria-label={`${value} sur 5`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button key={n} role="radio" aria-checked={value === n} aria-label={`${n} sur 5`} onClick={() => onChange(n)}>
            <Star size={size} strokeWidth={1.5} className={n <= value ? 'is-on' : undefined} />
          </button>
        ) : (
          <Star key={n} size={size} strokeWidth={1.5} className={n <= value ? 'is-on' : undefined} />
        ),
      )}
    </span>
  );
}
