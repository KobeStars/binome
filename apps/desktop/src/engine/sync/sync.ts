// Synchro du dossier partagé.
//
// Chaque côté tient un index (chemin → version) et un magasin de blocs. À la connexion,
// les deux s'envoient leur index ; ensuite chaque changement local est annoncé.
// Pour une version plus récente, le destinataire demande le manifeste, puis seulement
// les blocs absents de son magasin, reconstruit le fichier à part, vérifie son hash
// et le met en place par renommage.

import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream, mkdirSync, type Stats } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { watch, type FSWatcher } from 'chokidar';
import { encodeChunkPiece, DATA_CHUNK, type PeerMessage, type SyncEntry } from '@binome/protocol';
import { openDb, type Db } from '../db/index.ts';
import type { TransferView } from '../transfer/direct.ts';
import { chunkFile, decodeManifest, encodeManifest, sha256, type ChunkRef } from './chunker.ts';
import { FileIndex, toWire, type FileEntry } from './files.ts';
import { History, type Conflict, type TrashItem, type Version } from './history.ts';
import { KeyedLock } from './lock.ts';
import { conflictPath, INTERNAL_DIR, isIgnored, keyOf, safeRemotePath, toAbs, toRel } from './paths.ts';
import { ChunkStore } from './store.ts';
import { bump, compare, merge, parseVV, type VV } from './vv.ts';

export interface SyncPipe {
  readonly connected: boolean;
  send(msg: PeerMessage): boolean;
  sendFrame(frame: Uint8Array): void;
  drain(): Promise<void>;
}

export type SyncStatus = 'scanning' | 'syncing' | 'idle';
export type { ChangeKind } from './history.ts';
import type { ChangeKind } from './history.ts';

export interface SyncOptions {
  root: string;
  dataDir: string;
  /** Identifiant court de cet appareil dans les vecteurs de version. */
  device: string;
  nameOf(device: string): string;
  /** Quelque chose a changé : statut, compteurs, transferts. */
  onChange(): void;
  /** Un fichier a été modifié par l'autre appareil. */
  onRemoteChange(path: string, kind: ChangeKind): void;
  /** Délai de calme avant d'indexer un fichier modifié. */
  stabilityMs?: number;
  /** Conflit détecté : les deux versions sont gardées. */
  onConflict?(c: { path: string; aside: string }): void;
  /** Plafond du magasin (versions anciennes et corbeille comprises), en octets. */
  historyCapBytes?(): number;
}

/** Durée de la corbeille. */
export const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
const GC_FIRST_MS = 60_000;
const GC_EVERY_MS = 60 * 60_000;

/** Version reçue, validée. */
interface Remote {
  via: 'claude' | null;
  path: string;
  hash: string | null;
  size: number;
  vv: VV;
  deleted: boolean;
  vtime: number;
  by: string;
}

interface Job {
  key: string;
  target: string;
  remote: Remote & { hash: string };
  /** `replace` : nouvelle version du chemin. `copy` : copie de conflit à côté. */
  mode: 'replace' | 'copy';
  /** État local au moment de la décision : si il a bougé, on redécide. */
  snapshot: string;
  manifest: ChunkRef[] | null;
  missing: Map<string, number>;
  view: TransferView;
  running: boolean;
}

interface Pending {
  size: number;
  buf: Buffer | null;
  received: number;
  jobs: Set<Job>;
}

// Beaucoup de petits fichiers : chacun coûte des allers-retours, on en traite plusieurs à la fois.
const MAX_JOBS = 8;
const MAX_IN_FLIGHT = 16 * 1024 * 1024;
const HASHES_PER_REQUEST = 256;
const MANIFEST_PART = 30 * 1024;
const INDEX_BATCH = 200;
const RETRY_MS = 5_000;
const KEEP_FINISHED = 30;
/** Réanalyse de sécurité : Windows peut perdre des événements sous forte activité. */
const RESCAN_MS = 10 * 60_000;

const HEX64 = /^[0-9a-f]{64}$/;

function isBusyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

/**
 * Renommage avec quelques essais rapprochés : sous Windows, un antivirus ou l'indexation
 * garde souvent un fichier ouvert une fraction de seconde. Au-delà, l'appelant réessaie plus tard.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let wait = 50; ; wait *= 2) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (!isBusyError(err) || wait > 800) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function statOrNull(path: string): Promise<Stats | null> {
  return stat(path).catch(() => null);
}

export class Sync {
  readonly index: FileIndex;
  readonly store: ChunkStore;
  readonly history: History;
  lastSync: number | null = null;
  private scanning = true;

  private readonly db: Db;
  private readonly lock = new KeyedLock();
  private readonly jobs = new Map<string, Job>();
  private readonly pending = new Map<string, Pending>();
  private readonly manifestParts = new Map<string, { parts: string[]; resolve: (m: ChunkRef[] | null) => void }>();
  private readonly views = new Map<string, TransferView>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private serveQueue: Extract<PeerMessage, { t: 'sync.wantChunks' }>[] = [];
  private serving = false;
  private inFlight = 0;
  private pipe: SyncPipe | null = null;
  private watcher: FSWatcher | null = null;
  private scanDone!: Promise<void>;
  private stopped = false;
  private indexReceived = false;
  private rescanTimer: NodeJS.Timeout | null = null;
  private gcTimers: NodeJS.Timeout[] = [];
  /** Prochaine version d'un chemin faite par Claude (restauration demandée par Claude). */
  private readonly viaNext = new Map<string, 'claude'>();

  constructor(private readonly opts: SyncOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.db = openDb(join(opts.dataDir, 'sync.sqlite'));
    this.index = new FileIndex(this.db);
    this.store = new ChunkStore(this.db, join(opts.dataDir, 'store'));
    this.history = new History(this.db);
  }

  /** Augmente à chaque changement de l'index ou de l'historique. */
  get revision(): number {
    return this.index.revision + this.history.revision;
  }

  get status(): SyncStatus {
    if (this.scanning) return 'scanning';
    return this.jobs.size > 0 || this.serving ? 'syncing' : 'idle';
  }

  get root(): string {
    return this.opts.root;
  }

  /** Oublie l'index : à appeler quand le dossier partagé change. Le magasin est gardé. */
  resetIndex(): void {
    this.index.clear();
  }

  async start(): Promise<void> {
    await mkdir(join(this.root, INTERNAL_DIR, 'tmp'), { recursive: true });
    this.scanDone = this.scan();
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = toRel(this.root, p);
        return rel !== '' && !rel.startsWith('..') && isIgnored(rel);
      },
      awaitWriteFinish: { stabilityThreshold: this.opts.stabilityMs ?? 1500, pollInterval: 100 },
    });
    const onFile = (p: string) => void this.reindex(toRel(this.root, p));
    this.watcher.on('add', onFile).on('change', onFile).on('unlink', onFile);
    this.watcher.on('unlinkDir', (p: string) => {
      for (const e of this.index.under(keyOf(toRel(this.root, p)))) void this.reindex(e.path);
    });
    this.watcher.on('addDir', (p: string) => {
      void this.walk(toRel(this.root, p)).then(async (rels) => {
        for (const rel of rels) await this.reindex(rel);
      });
    });
    this.watcher.on('error', (err) => console.error('surveillance du dossier :', err));
    await this.scanDone;
    this.rescanTimer = setInterval(() => void this.scan(true), RESCAN_MS);
    this.gcTimers.push(
      setTimeout(() => this.runGc(), GC_FIRST_MS),
      setInterval(() => this.runGc(), GC_EVERY_MS),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.retries.values()) clearTimeout(t);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    for (const t of this.gcTimers) clearTimeout(t);
    await this.watcher?.close();
    this.detach();
    this.store.close();
    this.db.close();
  }

  stats(): { files: number; bytes: number; pending: number } {
    return { ...this.index.stats(), pending: this.jobs.size };
  }

  recent(limit = 20): FileEntry[] {
    return this.index.recent(limit);
  }

  transfers(): TransferView[] {
    return [...this.views.values()].map((v) => ({ ...v }));
  }

  /** Un transfert de synchro est en cours : le lien ne change pas de transport. */
  busy(): boolean {
    return this.jobs.size > 0 || this.serving;
  }

  // ─── Historique, corbeille, conflits ────────────────────────────────────

  journal(limit = 200): Version[] {
    return this.history.journal(limit);
  }

  versionsOf(path: string): Version[] {
    return this.history.ofKey(keyOf(path));
  }

  trash(now = Date.now()): TrashItem[] {
    return this.history.trash(now - TRASH_MS);
  }

  conflicts(): Conflict[] {
    return this.history.conflicts();
  }

  dismissConflict(id: number): void {
    this.history.dismiss(id);
    this.opts.onChange();
  }

  private recordConflict(path: string, aside: string, keptBy: string, asideBy: string): void {
    if (this.history.addConflict({ path, aside, keptBy, asideBy })) this.opts.onConflict?.({ path, aside });
  }

  /**
   * Remet une version en place (version ancienne ou fichier de la corbeille).
   * Elle devient la version actuelle, comme une modification locale, et part chez l'autre.
   */
  async restore(versionId: number, via: 'claude' | null = null): Promise<void> {
    const v = this.history.get(versionId);
    if (!v?.hash) throw new Error('Version introuvable');
    const hash = v.hash;
    const manifest = this.store.getManifest(hash);
    if (!manifest) throw new Error('Cette version n’est plus dans l’historique');
    await this.lock.run(v.key, async () => {
      const current = this.index.get(v.key);
      const path = current?.path ?? v.path;
      const tmp = join(this.root, INTERNAL_DIR, 'tmp', randomBytes(8).toString('hex'));
      try {
        await this.assemble(manifest, tmp, hash);
        const abs = toAbs(this.root, path);
        await mkdir(dirname(abs), { recursive: true });
        await renameWithRetry(tmp, abs);
      } catch (err) {
        await rm(tmp, { force: true });
        if (isBusyError(err)) throw new Error('Fichier ouvert dans une autre application');
        throw err;
      }
      if (via) this.viaNext.set(keyOf(path), via);
      await this.reindexUnlocked(path);
      this.viaNext.delete(keyOf(path));
    });
  }

  /**
   * Nettoyage : oublie la corbeille de plus de 30 jours, applique le plafond en supprimant
   * les versions anciennes les plus vieilles, puis libère les blocs inutilisés.
   */
  runGc(opts: { now?: number; minAgeMs?: number } = {}): { chunks: number; bytes: number } {
    if (this.stopped) return { chunks: 0, bytes: 0 };
    const now = opts.now ?? Date.now();
    this.history.expire(now - TRASH_MS);
    let freed = this.collect(opts.minAgeMs, now);
    const cap = this.opts.historyCapBytes?.() ?? Infinity;
    while (this.store.liveBytes() > cap && this.history.dropOldest(20) > 0) {
      const r = this.collect(opts.minAgeMs, now);
      freed = { chunks: freed.chunks + r.chunks, bytes: freed.bytes + r.bytes };
    }
    if (freed.chunks) this.opts.onChange();
    return freed;
  }

  private collect(minAgeMs: number | undefined, now: number): { chunks: number; bytes: number } {
    const roots = new Set<string>(this.history.hashes());
    for (const e of this.index.live()) if (e.hash) roots.add(e.hash);
    for (const j of this.jobs.values()) roots.add(j.remote.hash);
    return this.store.gc(roots, minAgeMs, now);
  }

  storeBytes(): number {
    return this.store.liveBytes();
  }

  // ─── Lien ───────────────────────────────────────────────────────────────

  attach(pipe: SyncPipe): void {
    this.pipe = pipe;
    this.indexReceived = false;
    void this.scanDone.then(() => {
      if (this.pipe !== pipe) return;
      this.sendIndex();
      // L'autre a pu ignorer notre index s'il n'avait pas encore de dossier : on lui redemande le sien,
      // et il renverra le nôtre à sa propre ouverture (voir sync.wantIndex).
      pipe.send({ t: 'sync.wantIndex' });
      for (const job of this.jobs.values()) void this.runJob(job);
    });
  }

  detach(): void {
    this.pipe = null;
    this.pending.clear();
    this.inFlight = 0;
    this.serveQueue = [];
    for (const w of this.manifestParts.values()) w.resolve(null);
    this.manifestParts.clear();
    for (const job of this.jobs.values()) {
      job.running = false;
      this.setView(job.view, { status: 'waiting', rate: 0 });
    }
  }

  private sendIndex(): void {
    const entries = this.index.all().map(toWire);
    for (let i = 0; i < entries.length || i === 0; i += INDEX_BATCH) {
      const batch = entries.slice(i, i + INDEX_BATCH);
      this.pipe?.send({ t: 'sync.index', entries: batch, last: i + INDEX_BATCH >= entries.length });
    }
  }

  private announce(entry: FileEntry): void {
    if (this.pipe) this.pipe.send({ t: 'sync.announce', entry: toWire(entry) });
  }

  async handle(msg: PeerMessage): Promise<void> {
    await this.scanDone;
    if (this.stopped) return;
    switch (msg.t) {
      case 'sync.index':
        for (const e of Array.isArray(msg.entries) ? msg.entries : []) await this.decide(e);
        if (msg.last) {
          this.indexReceived = true;
          this.maybeIdle();
        }
        return;
      case 'sync.wantIndex':
        return this.sendIndex();
      case 'sync.announce':
        return this.decide(msg.entry);
      case 'sync.wantManifest':
        return this.serveManifest(msg.hash);
      case 'sync.manifest':
        return this.onManifestPart(msg);
      case 'sync.noManifest':
        return this.manifestParts.get(msg.hash)?.resolve(null);
      case 'sync.wantChunks':
        this.serveQueue.push(msg);
        return void this.serve();
      case 'sync.noChunk':
        return this.onNoChunk(msg.hash);
    }
  }

  // ─── Changements locaux ─────────────────────────────────────────────────

  /** Compare le disque à l'index. `quiet` : réanalyse de fond, sans statut « Analyse ». */
  private async scan(quiet = false): Promise<void> {
    if (!quiet) this.scanning = true;
    this.opts.onChange();
    // Chemins devenus ignorés (cache .godot indexé par une version précédente) : oubliés, sans suppression chez l'autre.
    for (const e of this.index.all()) {
      if (isIgnored(e.path)) {
        this.index.remove(e.key);
        this.history.forget(e.key);
      }
    }
    const seen = new Set<string>();
    for (const rel of await this.walk('')) {
      seen.add(keyOf(rel));
      await this.reindex(rel);
    }
    for (const e of this.index.live()) if (!seen.has(e.key)) await this.reindex(e.path);
    this.scanning = false;
    this.opts.onChange();
  }

  /** Liste les fichiers d'un dossier (relatif à la racine), récursivement. */
  private async walk(relDir: string): Promise<string[]> {
    const out: string[] = [];
    const dirs = [relDir];
    while (dirs.length) {
      const dir = dirs.pop()!;
      const entries = await readdir(toAbs(this.root, dir || '.'), { withFileTypes: true }).catch(() => []);
      for (const d of entries) {
        const rel = dir ? `${dir}/${d.name}` : d.name;
        if (isIgnored(rel) || d.isSymbolicLink()) continue;
        if (d.isDirectory()) dirs.push(rel);
        else if (d.isFile()) out.push(rel);
      }
    }
    return out;
  }

  /** Met l'index à jour pour un chemin, sous verrou. */
  reindex(rel: string): Promise<void> {
    if (!rel || rel.startsWith('..') || isIgnored(rel)) return Promise.resolve();
    return this.lock.run(keyOf(rel), () => this.reindexUnlocked(rel));
  }

  private async reindexUnlocked(rel: string): Promise<void> {
    if (this.stopped) return;
    const key = keyOf(rel);
    const cur = this.index.get(key);
    const abs = toAbs(this.root, cur?.path ?? rel);
    const st = await statOrNull(abs);

    if (!st || !st.isFile()) {
      if (cur && !cur.deleted) {
        const e = this.index.put({
          ...cur,
          hash: null,
          size: 0,
          mtime: 0,
          deleted: true,
          vtime: Date.now(),
          vv: bump(cur.vv, this.opts.device),
          by: this.opts.device,
          via: null,
        });
        this.history.add({ key, path: e.path, kind: 'deleted', hash: null, size: 0, by: this.opts.device });
        this.announce(e);
        this.opts.onChange();
      }
      return;
    }

    const mtime = Math.round(st.mtimeMs);
    if (cur && !cur.deleted && cur.size === st.size && cur.mtime === mtime) return;

    let chunked;
    try {
      chunked = await chunkFile(abs, (hash, data) => this.store.put(hash, data));
    } catch (err) {
      if (isBusyError(err)) this.retryLater(`index:${key}`, () => this.reindex(rel));
      return;
    }
    // Modifié pendant la lecture : on attend qu'il se stabilise.
    const after = await statOrNull(abs);
    if (!after || after.size !== chunked.size || Math.round(after.mtimeMs) !== mtime) {
      this.retryLater(`index:${key}`, () => this.reindex(rel));
      return;
    }

    if (cur && !cur.deleted && cur.hash === chunked.hash) {
      this.index.put({ ...cur, size: chunked.size, mtime, changedAt: cur.changedAt });
      return;
    }
    this.store.putManifest(chunked.hash, chunked.chunks);
    const via = this.viaNext.get(key) ?? null;
    this.viaNext.delete(key);
    const e = this.index.put({
      via,
      path: cur?.path ?? rel,
      hash: chunked.hash,
      size: chunked.size,
      mtime,
      vtime: mtime,
      vv: bump(cur?.vv ?? {}, this.opts.device),
      deleted: false,
      by: this.opts.device,
    });
    this.history.add({
      key,
      path: e.path,
      kind: cur && !cur.deleted ? 'modified' : 'added',
      hash: chunked.hash,
      size: chunked.size,
      by: this.opts.device,
      via,
    });
    this.announce(e);
    this.opts.onChange();
  }

  // ─── Décision sur une version reçue ─────────────────────────────────────

  private parseRemote(w: SyncEntry): Remote | null {
    const path = safeRemotePath(w?.p);
    const vv = parseVV(w?.v);
    if (!path || !vv || typeof w.s !== 'number' || w.s < 0 || typeof w.b !== 'string' || w.b.length > 64) return null;
    const deleted = w.d === 1;
    if (!deleted && (typeof w.h !== 'string' || !HEX64.test(w.h))) return null;
    return {
      path,
      hash: deleted ? null : w.h,
      size: w.s,
      vv,
      deleted,
      vtime: Number(w.m) || 0,
      by: w.b,
      via: w.c === 1 ? 'claude' : null,
    };
  }

  private decide(wire: SyncEntry): Promise<void> {
    const remote = this.parseRemote(wire);
    if (!remote) return Promise.resolve();
    const key = keyOf(remote.path);
    return this.lock.run(key, async () => {
      // Un changement local pas encore indexé doit compter dans la décision.
      const before = this.index.get(key);
      if (before) await this.reindexUnlocked(before.path);
      await this.decideUnlocked(remote);
    });
  }

  private async decideUnlocked(remote: Remote): Promise<void> {
    const key = keyOf(remote.path);
    // Même version déjà en cours de téléchargement (index reçu deux fois à la connexion) : rien à redécider.
    const pending = this.jobs.get(key);
    if (pending && pending.remote.hash === remote.hash && pending.remote.by === remote.by && pending.remote.vtime === remote.vtime) {
      return;
    }
    const local = this.index.get(key);
    const me = this.opts.device;

    if (!local) {
      if (remote.deleted) {
        this.index.put({ ...remote, hash: null, mtime: 0, size: 0 });
        return;
      }
      return this.enqueue(remote as Job['remote'], remote.path, 'replace', null);
    }

    const order = compare(remote.vv, local.vv);
    if (order === 'equal') return;
    if (order === 'older') return this.announce(local);

    if (order === 'newer') {
      if (remote.deleted) return this.removeLocal(local, remote);
      if (!local.deleted && local.hash === remote.hash) {
        this.index.put({ ...local, vv: remote.vv, by: remote.by, vtime: remote.vtime, changedAt: local.changedAt });
        return;
      }
      return this.enqueue(remote as Job['remote'], local.path, 'replace', local);
    }

    // Versions concurrentes : les deux côtés ont modifié depuis la dernière synchro.
    const merged = merge(local.vv, remote.vv);
    if ((local.deleted && remote.deleted) || (!local.deleted && !remote.deleted && local.hash === remote.hash)) {
      this.index.put({ ...local, vv: merged, changedAt: local.changedAt });
      return;
    }
    if (remote.deleted) {
      // Modifié ici, supprimé là-bas : la modification gagne.
      this.announce(this.index.put({ ...local, vv: bump(merged, me), by: me }));
      return;
    }
    if (local.deleted) {
      return this.enqueue({ ...remote, vv: merged } as Job['remote'], remote.path, 'replace', local);
    }

    // Conflit. Règle identique des deux côtés : la version la plus récente chez son auteur
    // garde le nom, l'autre est gardée à côté sous le nom de son auteur.
    const remoteWins = remote.vtime > local.vtime || (remote.vtime === local.vtime && remote.by > local.by);
    if (remoteWins) {
      const aside = conflictPath(local.path, this.opts.nameOf(local.by));
      try {
        await copyFile(toAbs(this.root, local.path), toAbs(this.root, aside), constants.COPYFILE_EXCL);
      } catch (err) {
        if (isBusyError(err)) return this.retryLater(`decide:${key}`, () => this.lock.run(key, () => this.decideUnlocked(remote)));
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      void this.reindex(aside);
      this.recordConflict(local.path, aside, remote.by, local.by);
      return this.enqueue({ ...remote, vv: merged } as Job['remote'], local.path, 'replace', local);
    }
    this.index.put({ ...local, vv: merged, changedAt: local.changedAt });
    const aside = conflictPath(local.path, this.opts.nameOf(remote.by));
    this.recordConflict(local.path, aside, local.by, remote.by);
    return this.enqueue(remote as Job['remote'], aside, 'copy', null);
  }

  private async removeLocal(local: FileEntry, remote: Remote): Promise<void> {
    if (!local.deleted) {
      const abs = toAbs(this.root, local.path);
      try {
        await rm(abs, { force: true });
      } catch (err) {
        if (isBusyError(err)) return this.retryLater(`decide:${local.key}`, () => this.lock.run(local.key, () => this.decideUnlocked(remote)));
        throw err;
      }
      await this.pruneDirs(dirname(abs));
      this.history.add({ key: local.key, path: local.path, kind: 'deleted', hash: null, size: 0, by: remote.by, via: remote.via });
      this.opts.onRemoteChange(local.path, 'deleted');
    }
    // Les blocs restent dans le magasin : la version supprimée reste récupérable.
    this.index.put({ ...local, hash: null, size: 0, mtime: 0, deleted: true, vv: remote.vv, by: remote.by, vtime: remote.vtime });
    this.opts.onChange();
  }

  /** Supprime les dossiers devenus vides, jusqu'à la racine (exclue). */
  private async pruneDirs(dir: string): Promise<void> {
    while (dir.length > this.root.length && dir.startsWith(this.root)) {
      try {
        await rmdir(dir);
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }

  // ─── Téléchargement et reconstruction ──────────────────────────────────

  private enqueue(remote: Job['remote'], target: string, mode: Job['mode'], local: FileEntry | null): void {
    const key = keyOf(target);
    const existing = this.jobs.get(key);
    if (existing && existing.remote.hash === remote.hash && existing.mode === mode) {
      existing.remote = remote;
      return;
    }
    if (existing) this.dropJob(existing);
    const view: TransferView = {
      id: `sync-in-${key}`,
      direction: 'in',
      name: target,
      size: remote.size,
      bytes: 0,
      status: 'waiting',
      rate: 0,
    };
    const job: Job = {
      key,
      target,
      remote,
      mode,
      snapshot: local ? JSON.stringify([local.hash, local.vv, local.deleted]) : '',
      manifest: null,
      missing: new Map(),
      view,
      running: false,
    };
    this.jobs.set(key, job);
    this.views.set(view.id, view);
    this.opts.onChange();
    this.pump();
  }

  /** Démarre les jobs en attente, dans la limite de MAX_JOBS. */
  private pump(): void {
    let running = [...this.jobs.values()].filter((j) => j.running).length;
    for (const job of this.jobs.values()) {
      if (running >= MAX_JOBS) break;
      if (job.running) continue;
      running++;
      void this.runJob(job);
    }
    this.requestChunks();
  }

  private async runJob(job: Job): Promise<void> {
    if (job.running || this.stopped) return;
    job.running = true;
    this.setView(job.view, { status: 'active' });

    if (!job.manifest) {
      job.manifest = this.store.getManifest(job.remote.hash) ?? (await this.fetchManifest(job.remote.hash));
      if (this.jobs.get(job.key) !== job) return;
      if (!job.manifest) {
        job.running = false;
        if (this.pipe) this.dropJob(job); // l'autre n'a plus cette version : une annonce suivra
        return;
      }
      this.store.putManifest(job.remote.hash, job.manifest);
    }

    job.missing.clear();
    let have = 0;
    for (const c of job.manifest) {
      if (this.store.has(c.hash)) have += c.size;
      else job.missing.set(c.hash.toString('hex'), c.size);
    }
    this.setView(job.view, { bytes: have });
    if (job.missing.size === 0) return this.finish(job);
    this.requestChunks();
  }

  private fetchManifest(hash: string): Promise<ChunkRef[] | null> {
    if (!this.pipe) return Promise.resolve(null);
    const existing = this.manifestParts.get(hash);
    if (existing) {
      return new Promise((resolve) => {
        const prev = existing.resolve;
        existing.resolve = (m) => {
          prev(m);
          resolve(m);
        };
      });
    }
    return new Promise((resolve) => {
      this.manifestParts.set(hash, { parts: [], resolve });
      this.pipe?.send({ t: 'sync.wantManifest', hash });
    });
  }

  private onManifestPart(msg: Extract<PeerMessage, { t: 'sync.manifest' }>): void {
    const w = this.manifestParts.get(msg.hash);
    if (!w || msg.parts > 10_000 || msg.part >= msg.parts) return;
    w.parts[msg.part] = msg.data;
    if (w.parts.filter((p) => p !== undefined).length < msg.parts) return;
    this.manifestParts.delete(msg.hash);
    const manifest = decodeManifest(Buffer.concat(w.parts.map((p) => Buffer.from(p, 'base64'))));
    w.resolve(manifest);
  }

  /** Demande les blocs manquants, en gardant au plus MAX_IN_FLIGHT octets en route. */
  private requestChunks(): void {
    if (!this.pipe) return;
    for (const job of this.jobs.values()) {
      if (!job.running || !job.manifest) continue;
      const batch: string[] = [];
      for (const [hex, size] of job.missing) {
        if (this.inFlight >= MAX_IN_FLIGHT) break;
        const p = this.pending.get(hex);
        if (p) {
          p.jobs.add(job);
          continue;
        }
        this.pending.set(hex, { size, buf: null, received: 0, jobs: new Set([job]) });
        this.inFlight += size;
        batch.push(hex);
        if (batch.length === HASHES_PER_REQUEST) {
          this.pipe.send({ t: 'sync.wantChunks', file: job.remote.hash, path: job.target, hashes: batch.splice(0) });
        }
      }
      if (batch.length) this.pipe.send({ t: 'sync.wantChunks', file: job.remote.hash, path: job.target, hashes: batch });
    }
  }

  /** Morceau de bloc reçu. */
  chunk(hash: Buffer, offset: number, total: number, bytes: Uint8Array): void {
    const hex = hash.toString('hex');
    const p = this.pending.get(hex);
    if (!p || total !== p.size || offset + bytes.length > total) return;
    p.buf ??= Buffer.allocUnsafe(total);
    p.buf.set(bytes, offset);
    p.received += bytes.length;
    for (const job of p.jobs) this.setView(job.view, { bytes: job.view.bytes + bytes.length }, true);
    if (p.received < total) return;

    this.pending.delete(hex);
    this.inFlight -= p.size;
    if (sha256(p.buf).equals(hash)) {
      this.store.put(hash, p.buf);
      for (const job of p.jobs) {
        job.missing.delete(hex);
        if (job.missing.size === 0 && this.jobs.get(job.key) === job) void this.finish(job);
      }
    }
    // Bloc corrompu : il reste dans `missing` et sera redemandé.
    this.requestChunks();
  }

  private onNoChunk(hex: string): void {
    const p = this.pending.get(hex);
    if (!p) return;
    this.pending.delete(hex);
    this.inFlight -= p.size;
    for (const job of p.jobs) this.dropJob(job);
    this.pump();
  }

  /** Tous les blocs sont là : reconstruction, vérification, mise en place. */
  private finish(job: Job): Promise<void> {
    return this.lock.run(job.key, async () => {
      if (this.jobs.get(job.key) !== job || !job.manifest) return;
      this.setView(job.view, { status: 'verifying', rate: 0 });
      const tmp = join(this.root, INTERNAL_DIR, 'tmp', randomBytes(8).toString('hex'));

      try {
        await this.assemble(job.manifest, tmp, job.remote.hash);
      } catch (err) {
        await rm(tmp, { force: true });
        console.error('reconstruction :', err);
        this.failJob(job, 'Fichier reçu abîmé');
        return;
      }

      const abs = toAbs(this.root, job.target);
      if (job.mode === 'replace') {
        // L'état local a bougé depuis la décision : on redécide avec la version reçue.
        const local = this.index.get(job.key);
        const now = local ? JSON.stringify([local.hash, local.vv, local.deleted]) : '';
        const onDisk = local && !local.deleted ? await statOrNull(abs) : null;
        const touched = onDisk && (onDisk.size !== local!.size || Math.round(onDisk.mtimeMs) !== local!.mtime);
        if (now !== job.snapshot || touched) {
          await rm(tmp, { force: true });
          this.jobs.delete(job.key);
          if (touched) await this.reindexUnlocked(local!.path);
          await this.decideUnlocked(job.remote);
          this.afterJob();
          return;
        }
      } else if (await statOrNull(abs)) {
        // Copie de conflit déjà présente (créée par l'autre côté de la même règle).
        await rm(tmp, { force: true });
        this.completeJob(job);
        await this.reindexUnlocked(job.target);
        return;
      }

      try {
        await mkdir(dirname(abs), { recursive: true });
        await renameWithRetry(tmp, abs);
      } catch (err) {
        await rm(tmp, { force: true });
        if (isBusyError(err)) {
          // Fichier ouvert dans une autre application : on réessaie plus tard.
          this.setView(job.view, { status: 'waiting', error: 'Fichier ouvert ailleurs, nouvel essai' });
          job.running = false;
          this.retryLater(`finish:${job.key}`, () => this.finish(job));
          return;
        }
        throw err;
      }

      const existed = this.index.get(job.key);
      if (job.mode === 'replace') {
        const st = await stat(abs);
        this.index.put({
          path: job.target,
          hash: job.remote.hash,
          size: st.size,
          mtime: Math.round(st.mtimeMs),
          vtime: job.remote.vtime,
          vv: job.remote.vv,
          deleted: false,
          by: job.remote.by,
          via: job.remote.via,
        });
        const kind = existed && !existed.deleted ? 'modified' : 'added';
        this.history.add({
          key: job.key,
          path: job.target,
          kind,
          hash: job.remote.hash,
          size: st.size,
          by: job.remote.by,
          via: job.remote.via,
        });
        this.opts.onRemoteChange(job.target, kind);
      }
      this.completeJob(job);
      // Une copie de conflit devient un fichier local comme un autre.
      if (job.mode === 'copy') await this.reindexUnlocked(job.target);
    });
  }

  private async assemble(manifest: ChunkRef[], tmp: string, expected: string): Promise<void> {
    const out = createWriteStream(tmp);
    const hash = createHash('sha256');
    try {
      for (const c of manifest) {
        const data = this.store.get(c.hash);
        if (!data || data.length !== c.size) throw new Error('Bloc absent du magasin');
        hash.update(data);
        if (!out.write(data)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    } catch (err) {
      out.destroy();
      throw err;
    }
    if (hash.digest('hex') !== expected) throw new Error('Hash du fichier reconstruit incorrect');
  }

  private completeJob(job: Job): void {
    this.jobs.delete(job.key);
    this.setView(job.view, { status: 'done', bytes: job.view.size, rate: 0, error: undefined });
    this.afterJob();
  }

  private failJob(job: Job, error: string): void {
    this.jobs.delete(job.key);
    this.setView(job.view, { status: 'failed', error, rate: 0 });
    this.afterJob();
  }

  private dropJob(job: Job): void {
    this.jobs.delete(job.key);
    for (const [hex, p] of this.pending) {
      p.jobs.delete(job);
      if (p.jobs.size === 0) {
        this.pending.delete(hex);
        this.inFlight -= p.size;
      }
    }
    this.views.delete(job.view.id);
    this.afterJob();
  }

  private afterJob(): void {
    this.pruneViews();
    this.pump();
    this.maybeIdle();
    this.opts.onChange();
  }

  private maybeIdle(): void {
    if (this.jobs.size === 0 && !this.scanning && this.pipe && this.indexReceived) {
      this.lastSync = Date.now();
      this.opts.onChange();
    }
  }

  // ─── Envoi ──────────────────────────────────────────────────────────────

  private serveManifest(hash: string): void {
    if (typeof hash !== 'string' || !HEX64.test(hash)) return;
    const manifest = this.store.getManifest(hash);
    if (!manifest) return void this.pipe?.send({ t: 'sync.noManifest', hash });
    const raw = encodeManifest(manifest);
    const parts = Math.max(1, Math.ceil(raw.length / MANIFEST_PART));
    for (let i = 0; i < parts; i++) {
      const data = raw.subarray(i * MANIFEST_PART, (i + 1) * MANIFEST_PART).toString('base64');
      this.pipe?.send({ t: 'sync.manifest', hash, part: i, parts, data });
    }
  }

  private async serve(): Promise<void> {
    if (this.serving) return;
    this.serving = true;
    try {
      while (this.serveQueue.length && this.pipe) {
        const req = this.serveQueue.shift()!;
        const pipe = this.pipe;
        const path = safeRemotePath(req.path) ?? 'fichier';
        const viewId = `sync-out-${keyOf(path)}`;
        const view = this.views.get(viewId) ?? {
          id: viewId,
          direction: 'out' as const,
          name: path,
          size: 0,
          bytes: 0,
          status: 'active' as const,
          rate: 0,
        };
        this.views.set(viewId, view);
        const manifest = HEX64.test(req.file) ? this.store.getManifest(req.file) : null;
        if (manifest) view.size = manifest.reduce((n, c) => n + c.size, 0);
        this.setView(view, { status: 'active' });

        for (const hex of Array.isArray(req.hashes) ? req.hashes.slice(0, HASHES_PER_REQUEST) : []) {
          if (this.pipe !== pipe) return;
          if (typeof hex !== 'string' || !HEX64.test(hex)) continue;
          const hash = Buffer.from(hex, 'hex');
          const data = this.store.get(hash);
          if (!data) {
            pipe.send({ t: 'sync.noChunk', hash: hex });
            continue;
          }
          for (let off = 0; off < data.length; off += DATA_CHUNK) {
            await pipe.drain();
            if (this.pipe !== pipe) return;
            const piece = data.subarray(off, off + DATA_CHUNK);
            pipe.sendFrame(encodeChunkPiece(hash, off, data.length, piece));
            this.setView(view, { bytes: Math.min(view.size || Infinity, view.bytes + piece.length) }, true);
          }
        }
        if (!this.serveQueue.some((r) => r.path === req.path)) this.setView(view, { status: 'done', rate: 0 });
      }
    } finally {
      this.serving = false;
      if (this.jobs.size === 0 && this.pipe) this.lastSync = Date.now();
      this.pruneViews();
      this.opts.onChange();
    }
  }

  // ─── Divers ─────────────────────────────────────────────────────────────

  private retryLater(id: string, fn: () => Promise<void>): void {
    if (this.retries.has(id) || this.stopped) return;
    this.retries.set(
      id,
      setTimeout(() => {
        this.retries.delete(id);
        void fn();
      }, RETRY_MS),
    );
  }

  private lastTick = new Map<string, { at: number; bytes: number }>();

  private setView(view: TransferView, patch: Partial<TransferView>, progress = false): void {
    Object.assign(view, patch);
    if (progress) {
      const now = Date.now();
      const last = this.lastTick.get(view.id);
      if (last && now - last.at < 100) return;
      if (last) {
        const instant = ((view.bytes - last.bytes) * 1000) / Math.max(1, now - last.at);
        view.rate = view.rate ? view.rate * 0.7 + instant * 0.3 : instant;
      }
      this.lastTick.set(view.id, { at: now, bytes: view.bytes });
    }
    this.opts.onChange();
  }

  private pruneViews(): void {
    const finished = [...this.views.values()].filter((v) => v.status === 'done' || v.status === 'failed');
    for (const v of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.views.delete(v.id);
  }
}
