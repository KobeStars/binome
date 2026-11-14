import type { EngineState, TransferView } from '../../../engine/api.ts';

const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/** 12 345 678 → « 11,8 Mo ». */
export function bytes(n: number): string {
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : number.format(v)} ${units[i]}`;
}

export function rate(n: number): string {
  return `${bytes(n)}/s`;
}

export function routeLabel(route: EngineState['route']): string {
  if (route === 'lan') return 'réseau local';
  if (route === 'internet') return 'connexion directe';
  if (route === 'relay') return 'via le relais';
  return 'connexion…';
}

export function transferMeta(t: TransferView): string {
  switch (t.status) {
    case 'preparing':
      return `${bytes(t.size)} · préparation`;
    case 'waiting':
      return t.bytes > 0 ? `${bytes(t.bytes)} sur ${bytes(t.size)} · en pause` : `${bytes(t.size)} · en attente`;
    case 'active':
      return `${bytes(t.bytes)} sur ${bytes(t.size)}${t.rate > 0 ? ` · ${rate(t.rate)}` : ''}`;
    case 'verifying':
      return `${bytes(t.size)} · vérification`;
    case 'done':
      return `${bytes(t.size)} · ${t.direction === 'in' ? 'reçu' : 'envoyé'}`;
    case 'failed':
      return t.error ?? 'Échec';
  }
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

/** « à l'instant », « il y a 5 min », « il y a 2 h », puis la date. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'à l’instant';
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `le ${dayFormat.format(at)}`;
}
