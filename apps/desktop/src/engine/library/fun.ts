// Succès, XP et niveaux. Tout est local : chacun gagne son XP sur son PC, l'autre ne voit que le niveau.

export type StatKey =
  | 'files_sent'
  | 'bytes_sent'
  | 'published'
  | 'updates'
  | 'reviews'
  | 'bugs'
  | 'ideas'
  | 'installs'
  | 'tests_yes'
  | 'tests_sent'
  | 'play_ms'
  | 'longest_ms'
  | 'night'
  | 'xp';

export type Stats = Record<StatKey, number>;

export const emptyStats = (): Stats => ({
  files_sent: 0,
  bytes_sent: 0,
  published: 0,
  updates: 0,
  reviews: 0,
  bugs: 0,
  ideas: 0,
  installs: 0,
  tests_yes: 0,
  tests_sent: 0,
  play_ms: 0,
  longest_ms: 0,
  night: 0,
  xp: 0,
});

const GB = 1024 ** 3;
const HOUR = 3_600_000;

export interface Achievement {
  id: string;
  title: string;
  hint: string;
  xp: number;
  done(s: Stats): boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_file', title: 'Premier fichier envoyé', hint: 'Envoyer un fichier à ton binôme', xp: 20, done: (s) => s.files_sent >= 1 },
  { id: 'shared_10gb', title: '10 Go partagés', hint: 'Envoyer 10 Go au total', xp: 150, done: (s) => s.bytes_sent >= 10 * GB },
  { id: 'night_owl', title: 'Noctambule', hint: 'Jouer après 2 h du matin', xp: 40, done: (s) => s.night >= 1 },
  { id: 'first_publish', title: 'Première publication', hint: 'Publier un jeu ou une app', xp: 50, done: (s) => s.published >= 1 },
  { id: 'patch_day', title: 'Patch day', hint: 'Publier une mise à jour', xp: 30, done: (s) => s.updates >= 1 },
  { id: 'critic', title: 'Critique', hint: 'Laisser un premier avis', xp: 20, done: (s) => s.reviews >= 1 },
  { id: 'bug_hunter', title: 'Chasseur de bugs', hint: 'Signaler 5 bugs', xp: 60, done: (s) => s.bugs >= 5 },
  { id: 'tester', title: 'Testeur', hint: 'Répondre oui à « Teste mon jeu ! »', xp: 30, done: (s) => s.tests_yes >= 1 },
  { id: 'ideas', title: 'Boîte à idées', hint: 'Proposer 5 idées', xp: 30, done: (s) => s.ideas >= 5 },
  { id: 'marathon', title: 'Marathon', hint: 'Jouer 3 h d’affilée', xp: 60, done: (s) => s.longest_ms >= 3 * HOUR },
  { id: 'collector', title: 'Collection', hint: 'Installer 5 jeux ou apps', xp: 40, done: (s) => s.installs >= 5 },
  { id: 'hundred_hours', title: '100 heures', hint: 'Jouer 100 h au total', xp: 200, done: (s) => s.play_ms >= 100 * HOUR },
];

/** XP par action. */
export const XP = {
  publish: 100,
  update: 50,
  review: 30,
  bug: 25,
  idea: 10,
  install: 10,
  testYes: 20,
  testSent: 5,
  fileSent: 2,
  /** Par Go envoyé. */
  gigabyte: 25,
  /** Par tranche de 10 minutes de jeu. */
  play10: 2,
} as const;

/** XP pour atteindre le niveau n : 100, 300, 600, 1000… (100 × n(n-1)/2). */
export const xpForLevel = (n: number): number => (100 * n * (n - 1)) / 2;

export function levelOf(xp: number): { level: number; current: number; next: number } {
  const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * Math.max(0, xp)) / 100)) / 2));
  return { level, current: xpForLevel(level), next: xpForLevel(level + 1) };
}

/** Accents de l'interface, débloqués avec le niveau. */
export const THEMES = [
  { id: 'encre', name: 'Encre', level: 1 },
  { id: 'menthe', name: 'Menthe', level: 3 },
  { id: 'ambre', name: 'Ambre', level: 5 },
  { id: 'corail', name: 'Corail', level: 8 },
  { id: 'glacier', name: 'Glacier', level: 12 },
] as const;

/** La séance [start, end] passe-t-elle entre 2 h et 5 h du matin (heure locale) ? */
export function nightSession(start: number, end: number): boolean {
  for (let t = start; t <= end; t += 10 * 60_000) {
    const h = new Date(t).getHours();
    if (h >= 2 && h < 5) return true;
  }
  const h = new Date(end).getHours();
  return h >= 2 && h < 5;
}

/** Bornes d'un mois « 2026-11 » en heure locale. */
export function monthRange(month: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return null;
  return { from: new Date(y, mo, 1).getTime(), to: new Date(y, mo + 1, 1).getTime() };
}

export function monthOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
