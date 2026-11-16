// Préférences d'affichage propres à ce PC : sons, animations, accent de couleur.
// Gardées dans le navigateur de l'app ; l'accent ne s'applique que s'il est débloqué.

import { useEffect, useState } from 'react';

export const ACCENTS = [
  { id: 'encre', name: 'Encre', level: 1, color: '#4a86ff' },
  { id: 'menthe', name: 'Menthe', level: 3, color: '#3fbf8f' },
  { id: 'ambre', name: 'Ambre', level: 5, color: '#e0a03c' },
  { id: 'corail', name: 'Corail', level: 8, color: '#ef6f5e' },
  { id: 'glacier', name: 'Glacier', level: 12, color: '#7cc4e8' },
] as const;

export type AccentId = (typeof ACCENTS)[number]['id'];

export interface Fx {
  sounds: boolean;
  motion: boolean;
  accent: AccentId;
}

const KEY = 'binome:fx';
const listeners = new Set<(fx: Fx) => void>();

function load(): Fx {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Fx>;
    return {
      sounds: raw.sounds !== false,
      motion: raw.motion !== false,
      accent: ACCENTS.some((a) => a.id === raw.accent) ? raw.accent! : 'encre',
    };
  } catch {
    return { sounds: true, motion: true, accent: 'encre' };
  }
}

let current = load();

export function getFx(): Fx {
  return current;
}

export function setFx(patch: Partial<Fx>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // stockage indisponible : réglage gardé jusqu'à la fermeture
  }
  for (const fn of listeners) fn(current);
}

export function useFx(): Fx {
  const [fx, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return fx;
}

/** Applique l'accent (s'il est débloqué au niveau `level`) et le réglage des animations. */
export function applyFx(fx: Fx, level: number): void {
  const accent = ACCENTS.find((a) => a.id === fx.accent && a.level <= level) ?? ACCENTS[0];
  const root = document.documentElement;
  root.dataset.accent = accent.id;
  root.dataset.motion = fx.motion ? 'on' : 'off';
}

let ctx: AudioContext | null = null;

const TUNES = {
  /** Succès débloqué : deux notes qui montent. */
  achievement: [
    [0, 660],
    [0.09, 990],
  ],
  level: [
    [0, 523],
    [0.08, 659],
    [0.16, 784],
    [0.24, 1047],
  ],
  done: [[0, 740]],
  test: [
    [0, 880],
    [0.12, 880],
    [0.24, 1175],
  ],
} as const;

/** Son bref synthétisé, si les sons sont activés. */
export function play(tune: keyof typeof TUNES): void {
  if (!current.sounds) return;
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    for (const [start, freq] of TUNES[tune]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.06, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.24);
    }
  } catch {
    // pas de sortie audio
  }
}
