import { join, relative, sep } from 'node:path';

/** Dossier interne dans le dossier partagé : fichiers temporaires de reconstruction. */
export const INTERNAL_DIR = '.binome';

const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
/** Dossiers jamais synchronisés : caches régénérés par leurs outils, ou dépôts git. */
const IGNORED_DIRS = new Set(['.godot', '.git', 'node_modules']);
const IGNORED_PATTERNS = [
  /^~\$/, // fichiers verrou d'Office
  /^\.~lock\..*#$/, // LibreOffice
  /\.(tmp|temp|part|crdownload|partial|swp)$/i,
];
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Chemin relatif au dossier partagé, séparateur /. */
export function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

export function toAbs(root: string, rel: string): string {
  return join(root, ...rel.split('/'));
}

/** Clé d'index : insensible à la casse comme NTFS. */
export function keyOf(rel: string): string {
  return rel.normalize('NFC').toLowerCase();
}

/** Fichiers à ne jamais synchroniser : verrous, temporaires, métadonnées système. */
export function isIgnored(rel: string): boolean {
  const parts = rel.split('/');
  if (parts[0] === INTERNAL_DIR) return true;
  if (parts.some((p) => IGNORED_DIRS.has(p.toLowerCase()))) return true;
  const name = parts[parts.length - 1]!;
  if (IGNORED_NAMES.has(name.toLowerCase())) return true;
  return IGNORED_PATTERNS.some((re) => re.test(name));
}

/**
 * Valide un chemin reçu de l'autre appareil : relatif, sans remontée,
 * sans nom interdit sous Windows. Renvoie null s'il est dangereux.
 */
export function safeRemotePath(rel: unknown): string | null {
  const joined = safeRelPath(rel);
  return joined && !isIgnored(joined) ? joined : null;
}

/** Comme `safeRemotePath`, sans les règles du dossier partagé : sert aux paquets de la Bibliothèque. */
export function safeRelPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return null;
  if (rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[a-z]:/i.test(rel)) return null;
  const parts = rel.normalize('NFC').split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..') return null;
    if (/[<>:"|?*\u0000-\u001f]/.test(p) || /[. ]$/.test(p) || WINDOWS_RESERVED.test(p)) return null;
  }
  return parts.join('/');
}

/** « dossier/plan.psd » + « Sam » → « dossier/plan.conflit-Sam.psd ». */
export function conflictPath(rel: string, who: string): string {
  const slash = rel.lastIndexOf('/');
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const tag = `conflit-${who.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'binome'}`;
  return dot > 0 ? `${dir}${name.slice(0, dot)}.${tag}${name.slice(dot)}` : `${dir}${name}.${tag}`;
}
