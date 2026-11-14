// Contrat entre le moteur et l'interface. Les deux côtés importent ces types.

import type { Route } from './net/transport.ts';
import type { TransferView } from './transfer/direct.ts';

export type { Route, TransferView };

export type PairingState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'showing'; code: string; expiresAt: number }
  | { status: 'joining' }
  | { status: 'error'; message: string };

export interface PeerView {
  name: string;
  safetyCode: string;
  pairedAt: number;
}

export interface RecentChange {
  path: string;
  /** Prénom de l'auteur de la version. */
  by: string;
  at: number;
  deleted: boolean;
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ConflictView {
  id: number;
  path: string;
  aside: string;
  keptBy: string;
  asideBy: string;
  at: number;
}

/** Une ligne du journal ou de l'historique d'un fichier. */
export interface VersionView {
  id: number;
  path: string;
  kind: ChangeKind;
  by: string;
  at: number;
  size: number;
  /** Restaurable : la version a encore son contenu. */
  restorable: boolean;
  /** Version actuellement sur le disque. */
  current: boolean;
  /** Faite par Claude. */
  via: boolean;
}

export interface TrashView {
  path: string;
  by: string;
  deletedAt: number;
  expiresAt: number;
  versionId: number;
  size: number;
}

export interface SyncView {
  /** Dossier partagé, null tant qu'aucun n'est choisi. */
  folder: string | null;
  status: 'off' | 'scanning' | 'syncing' | 'idle';
  files: number;
  bytes: number;
  /** Fichiers en cours de réception. */
  pending: number;
  lastSync: number | null;
  recent: RecentChange[];
  conflicts: ConflictView[];
  /** Change à chaque modification de l'index ou de l'historique : signal pour rafraîchir. */
  revision: number;
  /** Taille utile du magasin (fichiers actuels, versions, corbeille). */
  storeBytes: number;
  capBytes: number;
  error?: string;
}

export interface ChatMessageView {
  id: string;
  mine: boolean;
  text: string;
  file: string | null;
  at: number;
  status: 'pending' | 'sent' | 'received' | 'read';
  via: 'claude' | null;
}

export type ToolRights = Record<string, boolean>;

export interface ClaudeView {
  enabled: boolean;
  rights: ToolRights;
  http: { enabled: boolean; port: number };
  /** Demandes de Claude qui attendent une réponse de l'utilisateur. */
  pending: { id: number; text: string }[];
  /** Change à chaque action de Claude : signal pour recharger le journal. */
  revision: number;
}

export interface ClaudeLogView {
  id: number;
  at: number;
  tool: string;
  summary: string;
  outcome: 'ok' | 'refused' | 'error';
  detail: string | null;
}

export interface ClaudeConnectView {
  /** Bloc à fusionner dans claude_desktop_config.json. */
  desktopConfig: string;
  /** Commande pour Claude Code (stdio). */
  codeCommand: string;
  /** Commande pour Claude Code en HTTP, si l'option est active. */
  httpCommand: string | null;
}

export interface EngineState {
  name: string;
  peer: PeerView | null;
  server: 'connecting' | 'online' | 'offline';
  peerOnline: boolean;
  /** `null` tant qu'aucun canal chiffré n'est ouvert avec l'autre. */
  route: Route | null;
  pairing: PairingState;
  transfers: TransferView[];
  sync: SyncView;
  chat: { unread: number; revision: number };
  claude: ClaudeView;
}

export type EngineCommand =
  | { cmd: 'setName'; name: string }
  | { cmd: 'pair.create' }
  | { cmd: 'pair.join'; code: string }
  | { cmd: 'pair.cancel' }
  | { cmd: 'unpair' }
  | { cmd: 'send'; paths: string[] }
  | { cmd: 'transfer.cancel'; id: string }
  | { cmd: 'sync.setFolder'; path: string }
  | { cmd: 'sync.setHistoryCap'; gb: number }
  | { cmd: 'conflict.dismiss'; id: number }
  | { cmd: 'chat.send'; text: string; file?: string | null }
  | { cmd: 'chat.read' }
  | { cmd: 'claude.settings'; enabled?: boolean; rights?: ToolRights; http?: { enabled: boolean; port?: number } }
  | { cmd: 'claude.confirm'; id: number; allow: boolean };

/** Questions de l'interface au moteur, avec réponse. */
export type EngineRequest =
  | { req: 'history.journal' }
  | { req: 'history.versions'; path: string }
  | { req: 'history.trash' }
  | { req: 'history.restore'; versionId: number }
  | { req: 'chat.list'; before?: number }
  | { req: 'claude.log' }
  | { req: 'claude.connect' };

export interface EngineReplies {
  'history.journal': VersionView[];
  'history.versions': VersionView[];
  'history.trash': TrashView[];
  'history.restore': null;
  'chat.list': ChatMessageView[];
  'claude.log': ClaudeLogView[];
  'claude.connect': ClaudeConnectView;
}

/** Message de l'interface vers le moteur. */
export type ToEngine = EngineCommand | { id: number; request: EngineRequest };

export type EngineEvent =
  | { ev: 'state'; state: EngineState }
  /** Pour la notification Windows, affichée par le main. */
  | { ev: 'received'; transfer: TransferView; from: string }
  /** L'autre a modifié un fichier du dossier partagé. */
  | { ev: 'changed'; path: string; kind: ChangeKind; from: string }
  | { ev: 'conflict'; path: string; aside: string }
  | { ev: 'chat'; from: string; text: string; file: string | null }
  /** Pour le main : dossier partagé (aperçus) et résumé pour l'icône de la barre des tâches. */
  | { ev: 'folder'; path: string | null }
  | { ev: 'status'; peer: string | null; online: boolean; syncing: boolean }
  /** Claude attend une confirmation : le main montre la fenêtre. */
  | { ev: 'attention'; text: string }
  | { ev: 'reply'; id: number; ok: boolean; data?: unknown; error?: string };
