// Liste des outils de Claude, sans dépendance : l'interface l'importe pour les réglages.

export const TOOL_NAMES = [
  'list_files',
  'read_file',
  'get_history',
  'get_status',
  'get_changelog',
  'send_file',
  'restore_version',
  'send_message',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
export type ToolKind = 'read' | 'write';

export const CATALOG: Record<ToolName, { title: string; kind: ToolKind; hint: string }> = {
  list_files: { title: 'Lister le dossier partagé', kind: 'read', hint: 'Noms, tailles, auteurs' },
  read_file: { title: 'Lire un fichier', kind: 'read', hint: 'Textes et images du dossier partagé' },
  get_history: { title: 'Historique d’un fichier', kind: 'read', hint: 'Les 10 dernières versions' },
  get_status: { title: 'État de la liaison', kind: 'read', hint: 'En ligne, dernière synchro, conflits' },
  get_changelog: { title: 'Derniers changements', kind: 'read', hint: 'Qui a modifié quoi, et quand' },
  send_file: { title: 'Envoyer un fichier', kind: 'write', hint: 'Hors du dossier partagé : confirmation demandée' },
  restore_version: { title: 'Restaurer une version', kind: 'write', hint: 'Toujours avec ta confirmation' },
  send_message: { title: 'Écrire dans le chat', kind: 'write', hint: 'Marqué « via Claude »' },
};
