// Vecteurs de version : un compteur par appareil. On n'utilise jamais l'heure
// pour décider qui a raison, les horloges des deux PC divergent.

export type VV = Record<string, number>;

export type Order = 'equal' | 'newer' | 'older' | 'concurrent';

/** Compare `a` à `b` : `newer` si `a` contient tout ce que `b` a vu et plus. */
export function compare(a: VV, b: VV): Order {
  let aAhead = false;
  let bAhead = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x > y) aAhead = true;
    if (y > x) bAhead = true;
  }
  if (aAhead && bAhead) return 'concurrent';
  if (aAhead) return 'newer';
  if (bAhead) return 'older';
  return 'equal';
}

export function merge(a: VV, b: VV): VV {
  const out: VV = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

export function bump(v: VV, device: string): VV {
  return { ...v, [device]: (v[device] ?? 0) + 1 };
}

export function parseVV(raw: unknown): VV | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: VV = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || k.length > 64) return null;
    out[k] = v;
  }
  return out;
}
