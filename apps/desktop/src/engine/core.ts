import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PEER_PROTOCOL_VERSION, toB64, type Inner } from '@binome/protocol';
import type {
  EngineCommand,
  EngineEvent,
  EngineReplies,
  EngineRequest,
  EngineState,
  SyncView,
  VersionView,
} from './api.ts';
import type { Identity } from './crypto/identity.ts';
import { Link, type LinkOptions } from './net/link.ts';
import { SignalingClient } from './net/signaling.ts';
import { authenticate, createPairing, joinPairing, PairingError, type PeerRecord } from './pairing/index.ts';
import { Chat } from './chat.ts';
import { ClaudeBridge, ClaudeLog, normalizeClaudeSettings, type ClaudeSettings } from './claude.ts';
import { runTool } from './claude-tools.ts';
import type { ToolName } from '../claude/tools.ts';
import { APP_MIGRATIONS, openDb, type Db } from './db/index.ts';
import { Sync, TRASH_MS, type SyncPipe } from './sync/sync.ts';
import type { Version } from './sync/history.ts';
import { DirectTransfers, type Pipe } from './transfer/direct.ts';

export interface EngineConfig {
  /** Dossier des données de l'app : peer.json, settings.json. */
  dataDir: string;
  /** Où arrivent les fichiers envoyés en direct. */
  inboxDir: string;
  signalingUrl: string;
  identity: Identity;
  defaultName: string;
  link?: LinkOptions;
  /** Délai de calme avant d'indexer un fichier modifié (tests : plus court). */
  syncStabilityMs?: number;
  /** Exécutable et script du serveur MCP, pour la config affichée à l'utilisateur. */
  mcp?: { exe?: string; script?: string };
  /** Tests : réponse automatique aux confirmations demandées par Claude. */
  autoConfirm?: (text: string) => boolean;
}

interface Settings {
  name: string;
  folder?: string | null;
  /** Plafond du magasin en Go. */
  historyCapGb?: number;
  claude?: Partial<ClaudeSettings>;
}

const DEFAULT_CAP_GB = 20;
const GB = 1024 ** 3;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Écrit dans un fichier temporaire puis renomme : jamais de fichier à moitié écrit. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

/** `child` est `parent` ou un de ses sous-dossiers. Sûr entre deux lecteurs. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class Engine {
  private state: EngineState;
  private peer: PeerRecord | null = null;
  private sig: SignalingClient | null = null;
  private link: Link | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private pairingRun = 0;
  private emitScheduled = false;
  /** Faux tant que les réglages ne sont pas lus : pas d'état partiel envoyé à l'interface. */
  ready = false;
  readonly transfers: DirectTransfers;
  private sync: Sync | null = null;
  private syncError: string | undefined;
  private folder: string | null = null;
  private capGb = DEFAULT_CAP_GB;
  private appDb: Db | null = null;
  private chat: Chat | null = null;
  private lastStatus = '';
  private claudeSettings: ClaudeSettings = normalizeClaudeSettings(undefined);
  private claudeLog: ClaudeLog | null = null;
  private bridge: ClaudeBridge | null = null;
  private confirms = new Map<number, { text: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  private nextConfirm = 1;
  /** Identifiant court de cet appareil dans les vecteurs de version. */
  private readonly device: string;

  constructor(
    private readonly cfg: EngineConfig,
    private readonly emit: (event: EngineEvent) => void,
  ) {
    this.state = {
      name: cfg.defaultName,
      peer: null,
      server: 'connecting',
      peerOnline: false,
      route: null,
      pairing: { status: 'idle' },
      transfers: [],
      sync: {
        folder: null,
        status: 'off',
        files: 0,
        bytes: 0,
        pending: 0,
        lastSync: null,
        recent: [],
        conflicts: [],
        revision: 0,
        storeBytes: 0,
        capBytes: DEFAULT_CAP_GB * GB,
      },
      chat: { unread: 0, revision: 0 },
      claude: { enabled: false, rights: {}, http: { enabled: false, port: 0 }, pending: [], revision: 0 },
    };
    this.device = toB64(cfg.identity.publicKey).slice(0, 12);
    this.transfers = new DirectTransfers(
      cfg.inboxDir,
      () => this.patch({}),
      (transfer) => this.emit({ ev: 'received', transfer, from: this.peer?.peerName ?? '' }),
    );
  }

  get snapshot(): EngineState {
    return {
      ...this.state,
      transfers: [...this.transfers.list(), ...(this.sync?.transfers() ?? [])],
      sync: this.syncView(),
      chat: { unread: this.chat?.unread ?? 0, revision: this.chat?.revision ?? 0 },
      claude: {
        enabled: this.claudeSettings.enabled,
        rights: { ...this.claudeSettings.rights },
        http: { ...this.claudeSettings.http },
        pending: [...this.confirms].map(([id, c]) => ({ id, text: c.text })),
        revision: this.claudeLog?.revision ?? 0,
      },
    };
  }

  private syncView(): SyncView {
    const s = this.sync;
    const capBytes = this.capGb * GB;
    if (!s) {
      return {
        folder: this.folder,
        status: 'off',
        files: 0,
        bytes: 0,
        pending: 0,
        lastSync: null,
        recent: [],
        conflicts: [],
        revision: 0,
        storeBytes: 0,
        capBytes,
        error: this.syncError,
      };
    }
    return {
      folder: this.folder,
      status: s.status,
      ...s.stats(),
      lastSync: s.lastSync,
      recent: s.recent(20).map((e) => ({ path: e.path, by: this.nameOf(e.by), at: e.changedAt, deleted: e.deleted })),
      conflicts: s.conflicts().map((c) => ({ ...c, keptBy: this.nameOf(c.keptBy), asideBy: this.nameOf(c.asideBy) })),
      revision: s.revision,
      storeBytes: s.storeBytes(),
      capBytes,
      error: this.syncError,
    };
  }

  private nameOf(device: string): string {
    return device === this.device ? this.state.name : (this.peer?.peerName ?? 'binome');
  }

  async start(): Promise<void> {
    await mkdir(this.cfg.dataDir, { recursive: true });
    const settings = await readJson<Settings>(join(this.cfg.dataDir, 'settings.json'));
    this.peer = await readJson<PeerRecord>(join(this.cfg.dataDir, 'peer.json'));
    this.ready = true;
    this.capGb = settings?.historyCapGb ?? DEFAULT_CAP_GB;
    this.appDb = openDb(join(this.cfg.dataDir, 'app.sqlite'), APP_MIGRATIONS);
    this.chat = new Chat(
      this.appDb,
      (m) => this.emit({ ev: 'chat', from: this.peer?.peerName ?? '', text: m.text, file: m.file }),
      () => this.patch({}),
    );
    this.claudeSettings = normalizeClaudeSettings(settings?.claude);
    this.claudeLog = new ClaudeLog(this.appDb);
    this.bridge = new ClaudeBridge({
      dataDir: this.cfg.dataDir,
      settings: () => this.claudeSettings,
      exec: (tool, args) => this.claudeExec(tool, args),
      log: this.claudeLog,
      onActivity: () => this.patch({}),
    });
    await this.bridge.start().catch((err: unknown) => console.error('pont Claude :', err));
    this.patch({ name: settings?.name ?? this.cfg.defaultName, peer: this.peerView() });
    if (settings?.folder) await this.startSync(settings.folder, false);
    else this.emit({ ev: 'folder', path: null });
    void this.serverLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.link?.stop();
    this.sig?.close();
    this.wake?.();
    await this.bridge?.stop();
    for (const c of this.confirms.values()) c.resolve(false);
    await this.sync?.stop();
    this.sync = null;
    this.appDb?.close();
    this.appDb = null;
  }

  private async saveSettings(): Promise<void> {
    await writeJson(join(this.cfg.dataDir, 'settings.json'), {
      name: this.state.name,
      folder: this.folder,
      historyCapGb: this.capGb,
      claude: this.claudeSettings,
    } satisfies Settings);
  }

  /** Démarre la synchro sur `folder`. `changed` : nouveau dossier, l'ancien index ne vaut plus. */
  private async startSync(folder: string, changed: boolean): Promise<void> {
    const root = resolve(folder);
    const st = await stat(root).catch(() => null);
    const insideData = isInside(root, this.cfg.dataDir) || isInside(this.cfg.dataDir, root);
    if (!st?.isDirectory() || insideData) {
      this.syncError = st?.isDirectory() ? 'Ce dossier contient les données de l’app' : 'Dossier introuvable';
      this.folder = root;
      this.patch({});
      return;
    }
    await this.sync?.stop();
    this.syncError = undefined;
    this.folder = root;
    const sync = new Sync({
      root,
      dataDir: this.cfg.dataDir,
      device: this.device,
      nameOf: (d) => this.nameOf(d),
      onChange: () => this.patch({}),
      onRemoteChange: (path, kind) => this.emit({ ev: 'changed', path, kind, from: this.peer?.peerName ?? '' }),
      onConflict: ({ path, aside }) => this.emit({ ev: 'conflict', path, aside }),
      historyCapBytes: () => this.capGb * GB,
      stabilityMs: this.cfg.syncStabilityMs,
    });
    if (changed) sync.resetIndex();
    this.sync = sync;
    this.emit({ ev: 'folder', path: root });
    this.patch({});
    await sync.start();
    if (this.link?.route) sync.attach(this.syncPipe(this.link));
  }

  private syncPipe(link: Link): SyncPipe {
    return {
      get connected() {
        return link.route !== null;
      },
      send: (m) => link.send(m),
      sendFrame: (f) => link.sendFrame(f),
      drain: () => link.drain(),
    };
  }

  async command(c: EngineCommand): Promise<void> {
    switch (c.cmd) {
      case 'setName': {
        const name = c.name.trim().slice(0, 40);
        if (!name) return;
        // L'état d'abord : une commande qui suit (pair.create) doit voir le nouveau nom.
        this.patch({ name });
        this.link?.send({ t: 'hello', v: PEER_PROTOCOL_VERSION, name });
        await this.saveSettings();
        return;
      }
      case 'sync.setHistoryCap': {
        if (!Number.isFinite(c.gb) || c.gb < 1 || c.gb > 10_000) return;
        this.capGb = Math.round(c.gb);
        await this.saveSettings();
        this.sync?.runGc();
        this.patch({});
        return;
      }
      case 'conflict.dismiss':
        return this.sync?.dismissConflict(c.id);
      case 'chat.send':
        if (typeof c.text === 'string' && c.text.trim()) this.chat?.write(c.text, c.file ?? null);
        return;
      case 'chat.read':
        return this.chat?.markRead();
      case 'claude.settings': {
        const next = normalizeClaudeSettings({
          ...this.claudeSettings,
          ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
          rights: { ...this.claudeSettings.rights, ...(c.rights ?? {}) },
          http: c.http ? { ...this.claudeSettings.http, ...c.http } : this.claudeSettings.http,
        });
        this.claudeSettings = next;
        await this.saveSettings();
        await this.bridge?.applySettings();
        this.patch({});
        return;
      }
      case 'claude.confirm': {
        const pending = this.confirms.get(c.id);
        pending?.resolve(c.allow === true);
        return;
      }
      case 'sync.setFolder': {
        if (!c.path || resolve(c.path) === this.folder) return;
        await this.startSync(c.path, true);
        if (!this.syncError) await this.saveSettings();
        return;
      }
      case 'pair.create':
        return this.startPairing((sig, me, run) =>
          createPairing(sig, me, (code, expiresAt) => {
            if (run === this.pairingRun) this.patch({ pairing: { status: 'showing', code, expiresAt } });
          }),
        );
      case 'pair.join':
        return this.startPairing((sig, me) => joinPairing(sig, me, c.code), 'joining');
      case 'pair.cancel':
        this.pairingRun++;
        if (this.sig?.isOpen) this.sig.send({ t: 'pair.fail', reason: 'cancelled' });
        this.patch({ pairing: { status: 'idle' } });
        return;
      case 'unpair':
        this.peer = null;
        await rm(join(this.cfg.dataDir, 'peer.json'), { force: true });
        this.link?.stop();
        this.link = null;
        this.patch({ peer: null, peerOnline: false, route: null });
        // Reconnexion sans authentification : on quitte le salon.
        this.sig?.close();
        return;
      case 'send':
        for (const path of c.paths) await this.transfers.send(path).catch(() => {});
        return;
      case 'transfer.cancel':
        return this.transfers.cancel(c.id);
    }
  }

  /** Répond à une question de l'interface. */
  async request<R extends EngineRequest>(r: R): Promise<EngineReplies[R['req']]> {
    if (r.req === 'chat.list') return (this.chat?.page(r.before) ?? []) as unknown as EngineReplies[R['req']];
    if (r.req === 'claude.log') return (this.claudeLog?.list() ?? []) as unknown as EngineReplies[R['req']];
    if (r.req === 'claude.connect') return this.claudeConnect() as unknown as EngineReplies[R['req']];
    const sync = this.sync;
    if (!sync) throw new Error('Aucun dossier partagé');
    const reply = (v: unknown) => v as EngineReplies[R['req']];
    switch (r.req) {
      case 'history.journal':
        return reply(this.versionViews(sync.journal(200), sync));
      case 'history.versions':
        return reply(this.versionViews(sync.versionsOf(r.path), sync));
      case 'history.trash':
        return reply(
          sync.trash().map((t) => ({
            path: t.path,
            by: this.nameOf(t.by),
            deletedAt: t.deletedAt,
            expiresAt: t.deletedAt + TRASH_MS,
            versionId: t.versionId,
            size: t.size,
          })),
        );
      case 'history.restore':
        await sync.restore(r.versionId);
        return reply(null);
    }
    throw new Error('Requête inconnue');
  }

  private versionViews(versions: Version[], sync: Sync): VersionView[] {
    // Une version restaurée a le même contenu qu'une plus ancienne : seule la plus récente est « actuelle ».
    const currentKeys = new Set<string>();
    return versions.map((v) => {
      const file = sync.index.get(v.key);
      const isCurrent = v.hash !== null && !!file && !file.deleted && file.hash === v.hash && !currentKeys.has(v.key);
      if (isCurrent) currentKeys.add(v.key);
      return {
        id: v.id,
        path: v.path,
        kind: v.kind,
        by: this.nameOf(v.by),
        at: v.at,
        size: v.size,
        restorable: v.hash !== null,
        current: isCurrent,
        via: v.via === 'claude',
      };
    });
  }

  /** Outil appelé par Claude, après vérification des droits par le pont. */
  private claudeExec(tool: ToolName, args: Record<string, unknown>) {
    return runTool(
      {
        sync: this.sync,
        chat: this.chat,
        transfers: this.transfers,
        state: this.snapshot,
        nameOf: (d) => this.nameOf(d),
        confirm: (text) => this.confirm(text),
      },
      tool,
      args,
    );
  }

  /**
   * Demande à l'utilisateur d'accepter une action de Claude. Sans réponse en 2 minutes : refus.
   * Le main met la fenêtre au premier plan.
   */
  private confirm(text: string): Promise<boolean> {
    if (this.cfg.autoConfirm) return Promise.resolve(this.cfg.autoConfirm(text));
    const id = this.nextConfirm++;
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        const c = this.confirms.get(id);
        if (!c) return;
        clearTimeout(c.timer);
        this.confirms.delete(id);
        this.patch({});
        resolve(ok);
      };
      this.confirms.set(id, { text, resolve: finish, timer: setTimeout(() => finish(false), 120_000) });
      this.patch({});
      this.emit({ ev: 'attention', text });
    });
  }

  /** Blocs de config à coller dans Claude Desktop ou Claude Code. */
  private claudeConnect() {
    const exe = this.cfg.mcp?.exe ?? process.execPath;
    // Dans l'app installée, le script est sorti de l'archive asar (voir electron-builder).
    const script = (this.cfg.mcp?.script ?? join(import.meta.dirname, 'mcp.mjs')).replace(
      /app\.asar([\\/])/,
      'app.asar.unpacked$1',
    );
    const desktopConfig = JSON.stringify(
      {
        mcpServers: {
          binome: {
            command: exe,
            args: [script, '--data', this.cfg.dataDir],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          },
        },
      },
      null,
      2,
    );
    const q = (s: string) => `"${s}"`;
    const codeCommand = `claude mcp add binome --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${q(exe)} ${q(script)} --data ${q(this.cfg.dataDir)}`;
    const { http } = this.claudeSettings;
    const token = this.bridgeToken();
    const httpCommand =
      http.enabled && token
        ? `claude mcp add --transport http binome http://127.0.0.1:${http.port}/mcp --header ${q(`Authorization: Bearer ${token}`)}`
        : null;
    return { desktopConfig, codeCommand, httpCommand };
  }

  private bridgeToken(): string | null {
    try {
      return readFileSync(join(this.cfg.dataDir, 'claude-token'), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  private async startPairing(
    run: (sig: SignalingClient, me: { identity: Identity; name: string }, run: number) => Promise<PeerRecord>,
    status: 'creating' | 'joining' = 'creating',
  ): Promise<void> {
    const sig = this.sig;
    if (!sig?.isOpen) {
      this.patch({ pairing: { status: 'error', message: 'Pas de connexion au serveur' } });
      return;
    }
    const id = ++this.pairingRun;
    this.patch({ pairing: { status } });
    try {
      const record = await run(sig, { identity: this.cfg.identity, name: this.state.name }, id);
      if (id !== this.pairingRun) return;
      await this.paired(sig, record);
    } catch (err) {
      if (id !== this.pairingRun) return;
      const message = err instanceof PairingError ? err.message : 'Appairage impossible';
      this.patch({ pairing: { status: 'error', message } });
    }
  }

  private async paired(sig: SignalingClient, record: PeerRecord): Promise<void> {
    this.peer = record;
    await writeJson(join(this.cfg.dataDir, 'peer.json'), record);
    this.patch({ peer: this.peerView(), pairing: { status: 'idle' } });
    this.link?.stop();
    await this.joinRoom(sig);
  }

  private peerView(): EngineState['peer'] {
    if (!this.peer) return null;
    return { name: this.peer.peerName, safetyCode: this.peer.safetyCode, pairedAt: this.peer.pairedAt };
  }

  /** Connexion au serveur avec reconnexion : 1 s, 2 s, 4 s… jusqu'à 30 s. */
  private async serverLoop(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      const sig = new SignalingClient(this.cfg.signalingUrl);
      this.patch({ server: 'connecting' });
      try {
        await sig.connect();
        this.sig = sig;
        delay = 1000;
        this.patch({ server: 'online' });
        if (this.peer) await this.joinRoom(sig);
        await new Promise<void>((resolve) => sig.onClose(resolve));
      } catch {
        sig.close();
      }
      if (this.sig === sig) this.sig = null;
      this.link?.stop();
      this.link = null;
      this.transfers.detach();
      this.sync?.detach();
      this.chat?.detach();
      this.patch({ server: 'offline', peerOnline: false, route: null });
      if (this.state.pairing.status !== 'idle' && this.state.pairing.status !== 'error') {
        this.pairingRun++;
        this.patch({ pairing: { status: 'error', message: 'Connexion au serveur perdue' } });
      }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay + Math.random() * 500);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async joinRoom(sig: SignalingClient): Promise<void> {
    const peer = this.peer;
    if (!peer) return;

    // Les écouteurs sont branchés avant l'authentification : le serveur peut envoyer
    // `presence` juste derrière `auth.ok`, dans le même paquet.
    sig.on('presence', (m) => this.patch({ peerOnline: m.online }));
    const link: Link = new Link(
      sig,
      this.cfg.identity,
      peer.peerPub,
      {
        route: (route) => {
          if (this.link !== link) return;
          this.patch({ route });
          if (route) {
            link.send({ t: 'hello', v: PEER_PROTOCOL_VERSION, name: this.state.name });
            this.transfers.attach(pipe);
            this.sync?.attach(this.syncPipe(link));
            this.chat?.attach((m) => link.send(m));
          } else {
            this.transfers.detach();
            this.sync?.detach();
            this.chat?.detach();
          }
        },
        message: (inner) => this.onPeerMessage(inner),
      },
      { ...this.cfg.link, isBusy: () => this.transfers.busy() || (this.sync?.busy() ?? false) },
    );
    const pipe: Pipe = {
      get connected() {
        return link.route !== null;
      },
      send: (m) => link.send(m),
      sendData: (id, offset, bytes) => link.sendData(id, offset, bytes),
      drain: () => link.drain(),
    };
    this.link = link;

    const peerOnline = await authenticate(sig, this.cfg.identity, peer);
    if (peerOnline) this.patch({ peerOnline });
    link.start(peerOnline);
  }

  private onPeerMessage(inner: Inner): void {
    if (inner.kind === 'data') return this.transfers.data(inner.id, inner.offset, inner.bytes);
    if (inner.kind === 'chunk') return this.sync?.chunk(inner.hash, inner.offset, inner.total, inner.bytes);
    const msg = inner.msg;
    if (msg.t === 'chat' || msg.t === 'chat.ack') return this.chat?.handle(msg);
    if (msg.t.startsWith('sync.')) {
      void this.sync?.handle(msg).catch((err: unknown) => console.error('synchro :', err));
      return;
    }
    if (msg.t === 'hello') {
      const name = String(msg.name).slice(0, 40);
      if (this.peer && name && name !== this.peer.peerName) {
        this.peer = { ...this.peer, peerName: name };
        void writeJson(join(this.cfg.dataDir, 'peer.json'), this.peer);
        this.patch({ peer: this.peerView() });
      }
      return;
    }
    this.transfers.handle(msg);
  }

  /** Regroupe les changements d'un même tour de boucle en un seul événement. */
  private patch(changes: Partial<EngineState>): void {
    Object.assign(this.state, changes);
    if (!this.ready || this.emitScheduled) return;
    this.emitScheduled = true;
    setImmediate(() => {
      this.emitScheduled = false;
      const state = this.snapshot;
      this.emit({ ev: 'state', state });
      // Résumé pour l'icône de la barre des tâches, seulement quand il change.
      const status = {
        peer: state.peer?.name ?? null,
        online: state.route !== null,
        syncing: state.sync.status === 'syncing' || state.sync.status === 'scanning',
      };
      const key = JSON.stringify(status);
      if (key !== this.lastStatus) {
        this.lastStatus = key;
        this.emit({ ev: 'status', ...status });
      }
    });
  }
}
