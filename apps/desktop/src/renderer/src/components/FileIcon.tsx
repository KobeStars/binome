import { File, FileAudio, FileImage, FileText, FileVideo } from 'lucide-react';
import { previewKind } from '../lib/preview.ts';

const ICONS = { image: FileImage, video: FileVideo, audio: FileAudio, text: FileText, other: File } as const;

/** Icône du type de fichier, toujours à la même taille et dans la couleur discrète. */
export function FileIcon({ path }: { path: string }) {
  const Icon = ICONS[previewKind(path)];
  return <Icon size={16} strokeWidth={1.5} className="row-icon" aria-hidden />;
}
