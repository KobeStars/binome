// Outils exposés à Claude par le serveur MCP de Binôme.
// Partagé par le serveur stdio (processus lancé par Claude) et l'option HTTP (dans le moteur) :
// les deux ne font que transmettre l'appel au moteur, qui vérifie les droits et exécute.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_NAMES, type ToolKind, type ToolName } from './catalog.ts';

export { TOOL_NAMES, type ToolKind, type ToolName };

export interface ToolDef {
  name: ToolName;
  title: string;
  description: string;
  kind: ToolKind;
  input: z.ZodRawShape;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    title: 'Lister le dossier partagé',
    description:
      'Liste les fichiers du dossier partagé Binôme sur ce PC, avec taille, date et auteur de la dernière version. `folder` limite à un sous-dossier.',
    kind: 'read',
    input: {
      folder: z.string().optional().describe('Sous-dossier relatif, séparateur /'),
    },
  },
  {
    name: 'read_file',
    title: 'Lire un fichier',
    description:
      'Lit un fichier du dossier partagé (texte, ou image renvoyée comme image). Les gros textes sont lus par morceaux avec `offset` et `max_bytes`.',
    kind: 'read',
    input: {
      path: z.string().describe('Chemin relatif au dossier partagé, séparateur /'),
      offset: z.number().int().min(0).optional().describe('Octet de départ, 0 par défaut'),
      max_bytes: z.number().int().min(1).max(1_000_000).optional().describe('100 000 par défaut'),
    },
  },
  {
    name: 'get_history',
    title: 'Historique d’un fichier',
    description: 'Les 10 dernières versions d’un fichier : identifiant, date, auteur, taille. L’identifiant sert à restore_version.',
    kind: 'read',
    input: { path: z.string().describe('Chemin relatif au dossier partagé') },
  },
  {
    name: 'get_status',
    title: 'État de la liaison',
    description: 'Dit si l’autre personne est en ligne, par quel chemin, la dernière synchro, et les conflits en attente.',
    kind: 'read',
    input: {},
  },
  {
    name: 'get_changelog',
    title: 'Derniers changements',
    description: 'Qui a ajouté, modifié ou supprimé quoi, et quand, du plus récent au plus ancien.',
    kind: 'read',
    input: {
      limit: z.number().int().min(1).max(500).optional().describe('50 par défaut'),
      since: z.string().optional().describe('Date ISO 8601 : seulement les changements après'),
    },
  },
  {
    name: 'send_file',
    title: 'Envoyer un fichier',
    description:
      'Envoie un fichier à l’autre personne, qui le reçoit dans ses téléchargements. Un chemin relatif désigne le dossier partagé ; un chemin absolu ailleurs sur le PC demande une confirmation dans l’app.',
    kind: 'write',
    input: { path: z.string().describe('Chemin relatif au dossier partagé, ou chemin absolu') },
  },
  {
    name: 'restore_version',
    title: 'Restaurer une version',
    description:
      'Remet une version précédente d’un fichier (identifiant donné par get_history). L’utilisateur doit confirmer dans l’app ; la version restaurée part aussi chez l’autre.',
    kind: 'write',
    input: { version_id: z.number().int().describe('Identifiant de version') },
  },
  {
    name: 'send_message',
    title: 'Écrire dans le chat',
    description: 'Écrit un message dans le chat de Binôme, marqué « via Claude ». `file` cite un fichier du dossier partagé.',
    kind: 'write',
    input: {
      text: z.string().min(1).max(4000),
      file: z.string().optional().describe('Fichier cité, chemin relatif'),
    },
  },
];

export const toolKind = (name: string): ToolKind | null => TOOLS.find((t) => t.name === name)?.kind ?? null;

/** Droits par défaut : lecture autorisée, écriture désactivée. */
export function defaultRights(): Record<ToolName, boolean> {
  return Object.fromEntries(TOOLS.map((t) => [t.name, t.kind === 'read'])) as Record<ToolName, boolean>;
}

/** Contenu d'une réponse d'outil, au format MCP. */
export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Déclare les outils sur un serveur MCP. `invoke` transmet l'appel au moteur.
 * `enabled` filtre la liste : un outil désactivé dans l'app n'est pas proposé à Claude.
 */
export function registerTools(
  server: McpServer,
  invoke: (name: ToolName, args: Record<string, unknown>) => Promise<ToolResult>,
  enabled: (name: ToolName) => boolean = () => true,
): void {
  for (const t of TOOLS) {
    if (!enabled(t.name)) continue;
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { readOnlyHint: t.kind === 'read', destructiveHint: t.name === 'restore_version' },
      },
      async (args: Record<string, unknown>) => (await invoke(t.name, args ?? {})) as never,
    );
  }
}
