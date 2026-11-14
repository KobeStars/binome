import type { EngineState, PeerStatus, StatusKind } from '../../../engine/api.ts';

/** L'autre peut recevoir un wizz : en ligne, avec une app assez récente. */
export function canWizz(state: EngineState): boolean {
  return state.route !== null && state.peerProfile.proto >= 2;
}

export const STATUS_LABEL: Record<StatusKind, string> = {
  available: 'Disponible',
  busy: 'Occupé',
  away: 'Absent',
};

/** Messages proposés sous le champ de statut. */
export const STATUS_SUGGESTIONS: { kind: StatusKind; text: string }[] = [
  { kind: 'busy', text: 'En train de coder' },
  { kind: 'busy', text: 'En réunion' },
  { kind: 'away', text: 'AFK' },
  { kind: 'away', text: 'En pause' },
];

/** « En train de coder », sinon le libellé du type de statut. */
export function statusText(s: PeerStatus | null): string | null {
  return s ? s.text || STATUS_LABEL[s.kind] : null;
}

/** « Alex Martin » → « AM », « sam » → « S ». */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]![0], parts.at(-1)![0]] : [parts[0]?.[0]];
  return letters.filter(Boolean).join('').toUpperCase() || '?';
}

/** Teinte stable tirée du nom : la même couleur pour la même personne, sur les deux PC. */
export function hueOf(name: string): number {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
