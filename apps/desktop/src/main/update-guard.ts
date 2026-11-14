// Garde-fou des mises à jour : retient les versions lancées sur ce PC, celles qui ont tourné
// sans problème, et repère une version qui plante en boucle pour proposer d'en revenir.
// Logique pure, sans Electron : testée par tests/update-guard.test.ts.

export type Channel = 'stable' | 'beta';

export interface Boot {
  version: string;
  at: number;
  /** A tourné assez longtemps sans boucle de plantages. */
  healthy: boolean;
  /** Fermée normalement (Quitter, arrêt de Windows). */
  clean: boolean;
}

export interface GuardState {
  channel: Channel;
  /** Versions lancées sur ce PC, de la plus ancienne à la plus récente. */
  versions: string[];
  /** Versions qui ont tourné sans problème. */
  healthy: string[];
  boots: Boot[];
  /** Versions dont on est revenu : la mise à jour automatique ne les réinstalle pas. */
  skip: string[];
  /** Versions pour lesquelles l'utilisateur a choisi de rester malgré les plantages. */
  keep: string[];
}

/** Une version devient « saine » après 5 minutes sans boucle de plantages. */
export const HEALTHY_AFTER_MS = 5 * 60_000;
export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASHES_FOR_ROLLBACK = 3;
const KEEP_VERSIONS = 10;
const KEEP_BOOTS = 10;

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function emptyGuard(): GuardState {
  return { channel: 'stable', versions: [], healthy: [], boots: [], skip: [], keep: [] };
}

const versionList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && VERSION_RE.test(x)).slice(-KEEP_VERSIONS) : [];

/** Lit un état enregistré, en ignorant tout ce qui est abîmé. */
export function normalizeGuard(raw: unknown): GuardState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const boots = Array.isArray(s.boots)
    ? s.boots
        .filter(
          (b): b is Boot =>
            !!b && typeof b === 'object' && typeof (b as Boot).version === 'string' && typeof (b as Boot).at === 'number',
        )
        .map((b) => ({ version: b.version, at: b.at, healthy: b.healthy === true, clean: b.clean === true }))
        .slice(-KEEP_BOOTS)
    : [];
  return {
    channel: s.channel === 'beta' ? 'beta' : 'stable',
    versions: versionList(s.versions),
    healthy: versionList(s.healthy),
    boots,
    skip: versionList(s.skip),
    keep: versionList(s.keep),
  };
}

/** Nouveau lancement de `version`. */
export function recordBoot(s: GuardState, version: string, now: number): GuardState {
  const versions =
    s.versions.at(-1) === version ? s.versions : [...s.versions.filter((v) => v !== version), version].slice(-KEEP_VERSIONS);
  const boots = [...s.boots, { version, at: now, healthy: false, clean: false }].slice(-KEEP_BOOTS);
  return { ...s, versions, boots };
}

function updateLastBoot(s: GuardState, version: string, patch: Partial<Boot>): Boot[] {
  const last = s.boots.at(-1);
  if (!last || last.version !== version) return s.boots;
  return [...s.boots.slice(0, -1), { ...last, ...patch }];
}

export function markHealthy(s: GuardState, version: string): GuardState {
  const healthy = s.healthy.includes(version) ? s.healthy : [...s.healthy, version].slice(-KEEP_VERSIONS);
  return { ...s, healthy, boots: updateLastBoot(s, version, { healthy: true }) };
}

/** Fermeture normale : ce lancement ne compte pas comme un plantage. */
export function markClean(s: GuardState, version: string): GuardState {
  return { ...s, boots: updateLastBoot(s, version, { clean: true }) };
}

/** Version vers laquelle revenir : la dernière version saine lancée avant celle-ci. */
export function previousVersion(s: GuardState, current: string): string | null {
  for (let i = s.versions.length - 1; i >= 0; i--) {
    const v = s.versions[i]!;
    if (v !== current && s.healthy.includes(v)) return v;
  }
  return null;
}

/**
 * Proposer de revenir en arrière ? Seulement pour une version pas encore saine, que l'utilisateur
 * n'a pas choisi de garder, s'il existe une version saine avant elle, et si elle plante en boucle :
 * 3 plantages en 10 minutes, ou ses 2 lancements précédents interrompus avant d'être sains.
 */
export function crashLooping(s: GuardState, current: string, crashes: number[], now: number): boolean {
  if (s.healthy.includes(current) || s.keep.includes(current) || !previousVersion(s, current)) return false;
  if (crashes.filter((t) => now - t <= CRASH_WINDOW_MS).length >= CRASHES_FOR_ROLLBACK) return true;
  const prior = s.boots.slice(0, -1).filter((b) => b.version === current).slice(-2);
  return prior.length === 2 && prior.every((b) => !b.healthy && !b.clean);
}

/** Saine maintenant ? Lancée depuis 5 minutes, sans boucle de plantages. */
export function becameHealthy(bootAt: number, crashes: number[], now: number): boolean {
  return now - bootAt >= HEALTHY_AFTER_MS && crashes.filter((t) => now - t <= CRASH_WINDOW_MS).length < CRASHES_FOR_ROLLBACK;
}

/** On revient de `bad` : elle ne doit pas se réinstaller toute seule. */
export function skipVersion(s: GuardState, bad: string): GuardState {
  return s.skip.includes(bad) ? s : { ...s, skip: [...s.skip, bad].slice(-KEEP_VERSIONS) };
}

export function unskipVersion(s: GuardState, version: string): GuardState {
  return { ...s, skip: s.skip.filter((v) => v !== version) };
}

export function keepVersion(s: GuardState, version: string): GuardState {
  return s.keep.includes(version) ? s : { ...s, keep: [...s.keep, version].slice(-KEEP_VERSIONS) };
}

/** Version de test (bêta) : « 0.2.0-beta.1 ». */
export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/** Dépôt de publication lu dans app-update.yml (écrit par electron-builder). */
export function parsePublishRepo(yml: string): { owner: string; repo: string } | null {
  const field = (name: string) => new RegExp(`^${name}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm').exec(yml)?.[1] ?? null;
  const owner = field('owner');
  const repo = field('repo');
  if (field('provider') !== 'github' || !owner || !repo) return null;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}
