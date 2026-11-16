import { useEffect, useState } from 'react';
import type { AppCategoryView, LibJobView, MediaView } from '../../../engine/api.ts';

export type LibRoute =
  | { page: 'grid' }
  | { page: 'app'; id: string; autoplay?: boolean }
  | { page: 'ideas' }
  | { page: 'achievements' }
  | { page: 'wrapped' };

export const CATEGORY_LABEL: Record<AppCategoryView, string> = {
  game: 'Jeu',
  tool: 'Outil',
  bot: 'Bot',
  site: 'Site',
  other: 'Autre',
};

export const CATEGORIES = Object.keys(CATEGORY_LABEL) as AppCategoryView[];

export const mediaUrl = (m: MediaView): string => `binome://media/${m.name}`;

/** 5 400 000 → « 1 h 30 », 600 000 → « 10 min ». */
export function playTime(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return ms > 0 ? 'moins d’une minute' : 'jamais lancé';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

export function jobLabel(j: LibJobView): string {
  if (j.phase === 'failed') return j.error ?? 'Échec';
  if (j.kind === 'publish') return j.phase === 'preparing' ? 'Compression des fichiers' : 'Publication';
  if (j.phase === 'preparing') return 'Préparation';
  if (j.phase === 'downloading') return j.kind === 'update' ? 'Téléchargement des fichiers modifiés' : 'Téléchargement';
  return 'Installation';
}

export const jobRatio = (j: LibJobView): number => (j.total > 0 ? Math.min(1, j.bytes / j.total) : j.phase === 'installing' ? 1 : 0);

/** Secondes restantes jusqu'à `until`, rafraîchies chaque seconde. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

/** Message d'une erreur du moteur ou du main. */
export function errorText(err: unknown, fallback = 'Échec'): string {
  const raw = err instanceof Error ? err.message : '';
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') || fallback;
}
