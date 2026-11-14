export type PreviewRoot = 'shared' | 'inbox';

export interface PreviewTarget {
  root: PreviewRoot;
  /** Chemin relatif à la racine, séparateur /. */
  path: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const VIDEO = /\.(mp4|m4v|webm|mov)$/i;
const AUDIO = /\.(mp3|wav|ogg)$/i;
const TEXT = /\.(txt|md|markdown|json|csv|tsv|log|ini|cfg|conf|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|lua|sh|bat|ps1|sql)$/i;

export type PreviewKind = 'image' | 'video' | 'audio' | 'text' | 'other';

export function previewKind(path: string): PreviewKind {
  if (IMAGE.test(path)) return 'image';
  if (VIDEO.test(path)) return 'video';
  if (AUDIO.test(path)) return 'audio';
  if (TEXT.test(path)) return 'text';
  return 'other';
}

/** Adresse binome:// servie par le main, chaque segment encodé. */
export function previewUrl(t: PreviewTarget): string {
  return `binome://${t.root}/${t.path.split('/').map(encodeURIComponent).join('/')}`;
}

export function baseName(path: string): string {
  return path.split(/[\/]/).pop() ?? path;
}

/** Chemin Windows complet d'un fichier du dossier partagé. */
export function absoluteIn(folder: string, rel: string): string {
  return `${folder.replace(/[\/]+$/, '')}\${rel.split('/').join('\')}`;
}
