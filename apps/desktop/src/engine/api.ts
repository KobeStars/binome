// Contrat entre le moteur et l'interface. Les deux côtés importent ces types.

import type { PeerStatus, StatusKind } from '@binome/protocol';
import type { CrashReport, CrashStatus } from './crashes.ts';
import type { WizzResult } from './profile.ts';
import type { Route } from './net/transport.ts';
import type { TransferView } from './transfer/direct.ts';

export type { CrashReport, PeerStatus, Route, StatusKind, TransferView, WizzResult };

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
  /** `wizz` : ligne d'événement, sans texte. */
  kind: 'text' | 'wizz';
}

export interface ProfileView {
  status: PeerStatus | null;
  /** Révision de l'avatar (binome://avatar/me ou /peer), 0 : pas d'avatar, initiales. */
  avatar: number;
}

export interface PeerProfileView extends ProfileView {
  /** Version de l'app de l'autre, null tant qu'on ne s'est pas parlé. */
  app: string | null;
  /** Version du protocole de l'autre : sous 2, pas de wizz ni de profil. */
  proto: number;
}

export interface CrashView {
  id: string;
  /** Plantage sur ce PC (sinon chez l'autre). */
  mine: boolean;
  at: number;
  app: string;
  kind: string;
  summary: string;
  log: string;
  status: CrashStatus;
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

// ─── Bibliothèque ──────────────────────────────────────────────────────

export interface LibJobView {
  app: string;
  name: string;
  kind: 'publish' | 'install' | 'update';
  phase: 'preparing' | 'downloading' | 'installing' | 'failed';
  bytes: number;
  total: number;
  error?: string;
}

export interface PlayingView {
  app: string;
  name: string;
  since: number;
}

export interface LevelView {
  xp: number;
  level: number;
  /** XP du niveau actuel et du suivant, pour la barre. */
  current: number;
  next: number;
}

export interface LibraryView {
  /** Change à chaque modification des pages, avis, idées… : signal pour recharger. */
  revision: number;
  /** Dossier où s'installent les jeux et apps. */
  dir: string;
  autoUpdate: boolean;
  jobs: LibJobView[];
  /** Apps installées avec une version plus récente disponible. */
  updates: number;
  /** Rapports de bug reçus pas encore lus. */
  unseenBugs: number;
  playing: PlayingView | null;
  peerPlaying: PlayingView | null;
  level: LevelView;
  peerLevel: number | null;
  /** « Teste mon jeu ! » reçu, en attente de réponse. */
  testIn: { id: string; app: string; name: string; version: string; expiresAt: number } | null;
  testOut: { id: string; app: string; name: string; expiresAt: number; answer: 'yes' | 'no' | null } | null;
  discord: { clientId: string; status: 'off' | 'connecting' | 'connected' | 'unavailable' };
}

export type AppCategoryView = 'game' | 'tool' | 'bot' | 'site' | 'other';

/** Média d'une page : `name` se lit à binome://media/<name>. */
export interface MediaView {
  name: string;
  type: string;
}

export interface LibAppView {
  id: string;
  name: string;
  category: AppCategoryView;
  tags: string[];
  mine: boolean;
  author: string;
  version: string;
  size: number;
  /** Date de la dernière version. */
  at: number;
  icon: MediaView | null;
  banner: MediaView | null;
  /** Version installée, null si absente. Pour ses propres apps : la version publiée. */
  installed: string | null;
  update: boolean;
  playMs: number;
  lastPlayed: number | null;
  /** Note de l'autre (sur ses propres apps) ou la sienne, null sans avis. */
  rating: number | null;
  removed: boolean;
  running: boolean;
  canLaunch: boolean;
}

export interface LibReviewView {
  by: string;
  mine: boolean;
  stars: number;
  text: string;
  at: number;
}

export interface LibBugView {
  id: string;
  app: string;
  version: string;
  mine: boolean;
  by: string;
  text: string;
  shot: MediaView | null;
  at: number;
  status: 'open' | 'fixed';
}

export interface LibAppDetail extends LibAppView {
  description: string;
  requirements: string;
  notes: string;
  exe: string | null;
  gallery: MediaView[];
  count: number;
  releases: { version: string; at: number; notes: string }[];
  reviews: LibReviewView[];
  bugs: LibBugView[];
  installDir: string | null;
  /** Premier lancement déjà accepté. */
  trusted: boolean;
  via: boolean;
  /** Dossier ou exe publié (ses propres apps). */
  source: string | null;
  launches: number;
}

export interface LibIdeaView {
  id: string;
  kind: 'idea' | 'wish';
  text: string;
  by: string;
  mine: boolean;
  status: 'open' | 'doing' | 'done';
  app: string | null;
  appName: string | null;
  updatedAt: number;
}

export interface AchievementView {
  id: string;
  title: string;
  hint: string;
  xp: number;
  at: number | null;
}

export interface WrappedView {
  month: string;
  /** Mois qui ont de l'activité, du plus récent au plus ancien. */
  months: string[];
  playMs: number;
  sessions: number;
  nights: number;
  top: { app: string; name: string; ms: number; icon: MediaView | null }[];
  filesSent: number;
  bytesSent: number;
  published: number;
  updates: number;
  reviews: number;
  bugs: number;
  ideas: number;
  xp: number;
  achievements: { title: string; at: number }[];
}

/** Formulaire Publier. Pour une mise à jour, un champ absent garde la valeur précédente. */
export interface PublishForm {
  /** App à mettre à jour, absent pour une nouvelle. */
  app?: string;
  /** Dossier ou exe à publier, chemin absolu. */
  source?: string;
  /** Exécutable de lancement, relatif au dossier. Absent : deviné. */
  exe?: string | null;
  name: string;
  category: AppCategoryView;
  tags: string[];
  description: string;
  requirements: string;
  notes: string;
  version: string;
  /** Chemins absolus des images et vidéos. */
  icon?: string | null;
  banner?: string | null;
  gallery?: string[];
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
  me: ProfileView;
  peerProfile: PeerProfileView;
  /** `unseen` : plantages de l'autre pas encore vus. `share` : nos rapports partent chez l'autre. */
  crashes: { unseen: number; revision: number; share: boolean };
  library: LibraryView;
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
  | { cmd: 'claude.confirm'; id: number; allow: boolean }
  /** null : pas de statut. */
  | { cmd: 'profile.status'; status: PeerStatus | null }
  /** Wizz sans réponse (depuis l'icône de la barre des tâches). */
  | { cmd: 'wizz' }
  /** Plantage constaté par le main (moteur, interface, main). */
  | { cmd: 'crash.report'; report: CrashReport }
  | { cmd: 'crash.read' }
  | { cmd: 'crash.share'; on: boolean }
  | { cmd: 'lib.test.reply'; id: string; answer: 'yes' | 'no' }
  | { cmd: 'lib.settings'; dir?: string; autoUpdate?: boolean; discordClientId?: string }
  | { cmd: 'lib.bugs.read' }
  /** Ferme une tâche en échec. */
  | { cmd: 'lib.job.dismiss'; app: string };

/** Questions de l'interface au moteur, avec réponse. */
export type EngineRequest =
  | { req: 'history.journal' }
  | { req: 'history.versions'; path: string }
  | { req: 'history.trash' }
  | { req: 'history.restore'; versionId: number }
  | { req: 'chat.list'; before?: number }
  | { req: 'claude.log' }
  | { req: 'claude.connect' }
  /** `data` : image en base64 déjà réduite par le main, null pour l'enlever. */
  | { req: 'profile.avatar'; data: string | null }
  | { req: 'wizz' }
  | { req: 'crash.list' }
  | { req: 'lib.list' }
  | { req: 'lib.app'; app: string }
  | { req: 'lib.publish'; form: PublishForm }
  | { req: 'lib.remove'; app: string }
  | { req: 'lib.install'; app: string }
  | { req: 'lib.uninstall'; app: string }
  /** `trust` : l'utilisateur a accepté le premier lancement. */
  | { req: 'lib.launch'; app: string; trust?: boolean }
  | { req: 'lib.review'; app: string; stars: number; text: string }
  /** `shot` : capture d'écran en base64 (JPEG ou PNG), null sans capture. */
  | { req: 'lib.bug'; app: string; text: string; shot: string | null }
  | { req: 'lib.bug.status'; id: string; status: 'open' | 'fixed' }
  | { req: 'lib.test'; app: string }
  | { req: 'lib.ideas' }
  | { req: 'lib.idea.save'; idea: { id?: string; kind: 'idea' | 'wish'; text: string; status?: 'open' | 'doing' | 'done'; app?: string | null } }
  | { req: 'lib.idea.delete'; id: string }
  | { req: 'lib.achievements' }
  | { req: 'lib.wrapped'; month?: string };

export interface EngineReplies {
  'history.journal': VersionView[];
  'history.versions': VersionView[];
  'history.trash': TrashView[];
  'history.restore': null;
  'chat.list': ChatMessageView[];
  'claude.log': ClaudeLogView[];
  'claude.connect': ClaudeConnectView;
  'profile.avatar': null;
  wizz: WizzResult;
  'crash.list': CrashView[];
  'lib.list': LibAppView[];
  'lib.app': LibAppDetail;
  'lib.publish': { app: string };
  'lib.remove': null;
  'lib.install': null;
  'lib.uninstall': null;
  /** `trust` : premier lancement, à confirmer. */
  'lib.launch': 'started' | 'trust' | 'running';
  'lib.review': null;
  'lib.bug': null;
  'lib.bug.status': null;
  'lib.test': 'sent' | 'offline';
  'lib.ideas': LibIdeaView[];
  'lib.idea.save': LibIdeaView;
  'lib.idea.delete': null;
  'lib.achievements': AchievementView[];
  'lib.wrapped': WrappedView;
}

/** Événement de la Bibliothèque : notification (main) et message bref (interface). */
export type LibNoticeKind =
  | 'new'
  | 'update'
  | 'updated'
  | 'installed'
  | 'review'
  | 'bug'
  | 'test'
  | 'testReply'
  | 'achievement'
  | 'level'
  | 'error';

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
  /** `peerStatus` : statut de l'autre en clair, pour l'info-bulle de l'icône. */
  | { ev: 'status'; peer: string | null; online: boolean; syncing: boolean; peerStatus: string | null }
  /** L'autre a envoyé un wizz. `quiet` : on est « Occupé », pas de secousse ni de son. */
  | { ev: 'wizz'; from: string; quiet: boolean }
  /** L'app de l'autre a planté : notification. */
  | { ev: 'peerCrash'; from: string; app: string; summary: string }
  /** Claude attend une confirmation : le main montre la fenêtre. */
  | { ev: 'attention'; text: string }
  | { ev: 'lib'; kind: LibNoticeKind; title: string; body: string; app?: string }
  | { ev: 'reply'; id: number; ok: boolean; data?: unknown; error?: string };
