// Bibliothèque : jeux et apps publiés par l'un, installés par l'autre.
//
// Publier fige une version : chaque fichier est découpé en blocs FastCDC, compressés un par un
// (zstd) dans le magasin, et la page (nom, médias, liste des fichiers…) est signée.
// Installer récupère la liste des fichiers, puis seulement les blocs absents : ceux d'une version
// déjà installée sont relus sur le disque. Les blocs reçus quittent le magasin une fois installés.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open as openFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fromB64, releaseBytes, toB64, type AppCategory, type LibIdea, type LibMedia, type LibRelease, type PeerMessage } from '@binome/protocol';
import type {
  AchievementView,
  LibAppDetail,
  LibAppView,
  LibBugView,
  LibIdeaView,
  LibJobView,
  LibNoticeKind,
  LibraryView,
  MediaView,
  PlayingView,
  PublishForm,
  WrappedView,
} from '../api.ts';
import type { Identity } from '../crypto/identity.ts';
import { verifySignature } from '../crypto/identity.ts';
import { LIBRARY_MIGRATIONS, openDb, tx, type Db } from '../db/index.ts';
import { sha256, type ChunkRef } from '../sync/chunker.ts';
import { keyOf, safeRelPath, toAbs, toRel } from '../sync/paths.ts';
import { DiscordPresence } from './discord.ts';
import { LibExchange, type LibPipe } from './fetch.ts';
import { ACHIEVEMENTS, emptyStats, levelOf, monthOf, monthRange, nightSession, XP, type StatKey, type Stats } from './fun.ts';
import { decodePackage, encodePackage, HEX64, LibStore, mediaName, MEDIA_TYPES, type PkgFile } from './store.ts';

export interface LibrarySettings {
  /** Dossier d'installation choisi, null : celui par défaut. */
  dir: string | null;
  autoUpdate: boolean;
  discordClientId: string;
}

export const defaultLibrarySettings = (): LibrarySettings => ({ dir: null, autoUpdate: true, discordClientId: '' });

export function normalizeLibrarySettings(raw: Partial<LibrarySettings> | undefined): LibrarySettings {
  return {
    dir: typeof raw?.dir === 'string' && isAbsolute(raw.dir) ? raw.dir : null,
    autoUpdate: raw?.autoUpdate !== false,
    discordClientId: typeof raw?.discordClientId === 'string' ? raw.discordClientId.trim().slice(0, 32) : '',
  };
}

export interface PeerInfo {
  device: string;
  pub: Uint8Array;
  name: string;
}

export interface LibraryOptions {
  /** Dossier de données de l'app : library.sqlite et library/. */
  dataDir: string;
  /** Dossier d'installation par défaut. */
  defaultDir: string;
  device: string;
  identity: Identity;
  peer(): PeerInfo | null;
  myName(): string;
  settings: LibrarySettings;
  saveSettings(): void;
  changed(): void;
  notify(kind: LibNoticeKind, title: string, body: string, app?: string): void;
}

const HEX32 = /^[0-9a-f]{32}$/;
const CATEGORIES = new Set<AppCategory>(['game', 'tool', 'bot', 'site', 'other']);
const MAX_PACKAGE_LIST = 64 * 1024 * 1024;
const MAX_FILES = 200_000;
const MB = 1024 * 1024;
const LIMITS = { icon: 4 * MB, banner: 12 * MB, image: 12 * MB, video: 400 * MB, shot: 3 * MB };
const TEST_MS = 60_000;
const SKIP_NAMES = new Set(['.git', 'desktop.ini', 'thumbs.db', '.ds_store']);
const STAGING = '.binome-tmp';

interface AppRow {
  id: string;
  mine: number;
  release: string;
  sig: string;
  source: string | null;
  removed: number;
  first_seen: number;
}

interface InstallRow {
  app: string;
  version: string;
  files: string;
  dir: string;
  at: number;
  trusted: number;
}

interface BugRow {
  id: string;
  app: string;
  version: string;
  mine: number;
  text: string;
  shot: string | null;
  at: number;
  status: string;
  sent: number;
  seen: number;
}

interface IdeaRow {
  id: string;
  kind: string;
  text: string;
  by: string;
  status: string;
  app: string | null;
  updated_at: number;
  deleted: number;
}

const clip = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '';
const oneLine = (s: unknown, max: number): string => clip(s, max).replace(/\s+/g, ' ').trim();

function isMedia(m: unknown, image = false): m is LibMedia {
  if (!m || typeof m !== 'object') return false;
  const x = m as LibMedia;
  return (
    typeof x.h === 'string' &&
    HEX64.test(x.h) &&
    typeof x.s === 'number' &&
    x.s > 0 &&
    x.s <= LIMITS.video &&
    MEDIA_TYPES.has(x.type) &&
    (!image || x.type.startsWith('image/'))
  );
}

/** Page reçue : bien formée et dans les limites. Les champs inconnus sont laissés de côté. */
export function cleanRelease(raw: unknown): LibRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.app !== 'string' || !HEX32.test(r.app)) return null;
  if (typeof r.files !== 'string' || !HEX64.test(r.files)) return null;
  const name = oneLine(r.name, 60);
  const version = oneLine(r.version, 32);
  if (!name || !version || !CATEGORIES.has(r.category as AppCategory)) return null;
  if (typeof r.size !== 'number' || typeof r.count !== 'number' || typeof r.at !== 'number') return null;
  if (r.icon !== null && !isMedia(r.icon, true)) return null;
  if (r.banner !== null && !isMedia(r.banner, true)) return null;
  if (!Array.isArray(r.gallery) || r.gallery.length > 12 || !r.gallery.every((m) => isMedia(m))) return null;
  const exe = r.exe === null ? null : safeRelPath(r.exe);
  if (r.exe !== null && !exe) return null;
  return {
    app: r.app,
    version,
    name,
    category: r.category as AppCategory,
    tags: Array.isArray(r.tags) ? r.tags.map((t) => oneLine(t, 24)).filter(Boolean).slice(0, 8) : [],
    description: clip(r.description, 20_000),
    requirements: clip(r.requirements, 2_000),
    notes: clip(r.notes, 10_000),
    exe,
    icon: (r.icon as LibMedia | null) ?? null,
    banner: (r.banner as LibMedia | null) ?? null,
    gallery: r.gallery as LibMedia[],
    files: r.files,
    size: r.size,
    count: r.count,
    at: r.at,
    ...(r.via === 'claude' ? { via: 'claude' as const } : {}),
  };
}

function cleanIdea(raw: unknown): LibIdea | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  if (typeof i.id !== 'string' || !HEX32.test(i.id) || typeof i.by !== 'string' || typeof i.updatedAt !== 'number') return null;
  if (i.kind !== 'idea' && i.kind !== 'wish') return null;
  const status = i.status === 'doing' || i.status === 'done' ? i.status : 'open';
  return {
    id: i.id,
    kind: i.kind,
    text: clip(i.text, 500).trim(),
    by: i.by.slice(0, 24),
    status,
    app: typeof i.app === 'string' && HEX32.test(i.app) ? i.app : null,
    updatedAt: i.updatedAt,
    ...(i.deleted === 1 ? { deleted: 1 as const } : {}),
  };
}

/** Nom du dossier d'installation : « Soul Bladyes-3f9a1c ». */
function folderName(r: LibRelease): string {
  const base = r.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/[. ]+$/, '').trim() || 'app';
  return `${base.slice(0, 40)}-${r.app.slice(0, 6)}`;
}

function media(m: LibMedia | null): MediaView | null {
  const name = m ? mediaName(m) : null;
  return m && name ? { name, type: m.type } : null;
}

/** Fichiers d'un dossier, chemins relatifs. */
async function walk(root: string): Promise<{ rel: string; abs: string; size: number }[]> {
  const out: { rel: string; abs: string; size: number }[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_NAMES.has(e.name.toLowerCase())) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await visit(abs);
      else if (e.isFile()) {
        const rel = safeRelPath(toRel(root, abs));
        if (!rel) continue;
        const st = await stat(abs).catch(() => null);
        if (st) out.push({ rel, abs, size: st.size });
        if (out.length > MAX_FILES) throw new Error(`Plus de ${MAX_FILES} fichiers : trop pour un paquet`);
      }
    }
  };
  await visit(root);
  return out;
}

/** Exécutable de lancement deviné : le seul .exe à la racine, sinon celui qui porte le nom de l'app. */
function guessExe(files: string[], name: string): string | null {
  const exes = files.filter((f) => /\.(exe|bat|cmd)$/i.test(f) && !/unins|setup|crash|redist/i.test(f));
  const top = exes.filter((f) => !f.includes('/'));
  if (top.length === 1) return top[0]!;
  const simple = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return exes.find((f) => basename(f).toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(simple)) ?? top[0] ?? exes[0] ?? null;
}

interface Job {
  view: LibJobView;
}

export class Library {
  private readonly db: Db;
  readonly store: LibStore;
  readonly exchange: LibExchange;
  private readonly q;
  private send: ((m: PeerMessage) => boolean) | null = null;
  private stats: Stats = emptyStats();
  private settings: LibrarySettings;
  private jobs = new Map<string, Job>();
  private installQueue: Promise<void> = Promise.resolve();
  private running = new Map<string, { child: ChildProcess; start: number; name: string }>();
  private peerPlaying: PlayingView | null = null;
  private peerXp: number | null = null;
  private testIn: LibraryView['testIn'] = null;
  private testOut: LibraryView['testOut'] = null;
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastProgress = 0;
  private counts: { updates: number; unseenBugs: number } | null = null;
  private readonly discord: DiscordPresence;
  private stopped = false;
  revision = 0;

  constructor(private readonly opts: LibraryOptions) {
    const dir = join(opts.dataDir, 'library');
    this.db = openDb(join(opts.dataDir, 'library.sqlite'), LIBRARY_MIGRATIONS);
    this.store = new LibStore(this.db, dir, join(dir, 'media'));
    this.exchange = new LibExchange(this.store);
    this.exchange.onSent = (n) => this.noteBytes(n);
    this.settings = opts.settings;
    const db = this.db;
    this.q = {
      app: db.prepare('SELECT * FROM apps WHERE id = ?'),
      apps: db.prepare('SELECT * FROM apps'),
      myApps: db.prepare('SELECT * FROM apps WHERE mine = 1 AND removed = 0'),
      putApp: db.prepare(
        `INSERT INTO apps (id, mine, release, sig, source, removed, first_seen) VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET release = excluded.release, sig = excluded.sig, source = COALESCE(excluded.source, apps.source), removed = 0`,
      ),
      setRemoved: db.prepare('UPDATE apps SET removed = 1 WHERE id = ?'),
      dropApp: db.prepare('DELETE FROM apps WHERE id = ?'),
      putRelease: db.prepare('INSERT OR REPLACE INTO releases (app, version, at, notes) VALUES (?, ?, ?, ?)'),
      releases: db.prepare('SELECT version, at, notes FROM releases WHERE app = ? ORDER BY at DESC'),
      install: db.prepare('SELECT * FROM installs WHERE app = ?'),
      installs: db.prepare('SELECT * FROM installs'),
      putInstall: db.prepare(
        `INSERT INTO installs (app, version, files, dir, at, trusted) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(app) DO UPDATE SET version = excluded.version, files = excluded.files, dir = excluded.dir, at = excluded.at`,
      ),
      trust: db.prepare('UPDATE installs SET trusted = 1 WHERE app = ?'),
      dropInstall: db.prepare('DELETE FROM installs WHERE app = ?'),
      play: db.prepare('SELECT ms, launches, last FROM play WHERE app = ?'),
      plays: db.prepare('SELECT app, ms, last FROM play'),
      addPlay: db.prepare(
        `INSERT INTO play (app, ms, launches, last) VALUES (?, ?, ?, ?)
         ON CONFLICT(app) DO UPDATE SET ms = play.ms + excluded.ms, launches = play.launches + excluded.launches, last = excluded.last`,
      ),
      review: db.prepare('SELECT * FROM reviews WHERE app = ? AND by = ?'),
      reviews: db.prepare('SELECT * FROM reviews WHERE app = ? ORDER BY at DESC'),
      allReviews: db.prepare('SELECT app, stars, by FROM reviews'),
      myReviews: db.prepare('SELECT * FROM reviews WHERE by = ?'),
      putReview: db.prepare('INSERT OR REPLACE INTO reviews (app, by, stars, text, at, sent) VALUES (?, ?, ?, ?, ?, ?)'),
      dropReview: db.prepare('DELETE FROM reviews WHERE app = ? AND by = ?'),
      reviewSent: db.prepare('UPDATE reviews SET sent = 1 WHERE app = ? AND by = ?'),
      bug: db.prepare('SELECT * FROM bugs WHERE id = ?'),
      bugs: db.prepare('SELECT * FROM bugs WHERE app = ? ORDER BY at DESC'),
      allBugs: db.prepare('SELECT * FROM bugs'),
      pendingBugs: db.prepare('SELECT * FROM bugs WHERE mine = 1 AND sent = 0'),
      putBug: db.prepare('INSERT OR IGNORE INTO bugs (id, app, version, mine, text, shot, at, status, sent, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      bugSent: db.prepare('UPDATE bugs SET sent = 1 WHERE id = ?'),
      bugStatus: db.prepare('UPDATE bugs SET status = ? WHERE id = ?'),
      bugsSeen: db.prepare('UPDATE bugs SET seen = 1 WHERE mine = 0 AND seen = 0'),
      unseenBugs: db.prepare('SELECT COUNT(*) AS n FROM bugs WHERE mine = 0 AND seen = 0'),
      idea: db.prepare('SELECT * FROM ideas WHERE id = ?'),
      ideas: db.prepare('SELECT * FROM ideas WHERE deleted = 0 ORDER BY updated_at DESC'),
      allIdeas: db.prepare('SELECT * FROM ideas'),
      putIdea: db.prepare('INSERT OR REPLACE INTO ideas (id, kind, text, by, status, app, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      stats: db.prepare('SELECT key, value FROM stats'),
      putStat: db.prepare('INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)'),
      achievements: db.prepare('SELECT id, at FROM achievements'),
      unlock: db.prepare('INSERT OR IGNORE INTO achievements (id, at) VALUES (?, ?)'),
      event: db.prepare('INSERT INTO events (at, kind, app, n) VALUES (?, ?, ?, ?)'),
      eventsIn: db.prepare('SELECT at, kind, app, n FROM events WHERE at >= ? AND at < ?'),
      firstEvent: db.prepare('SELECT MIN(at) AS at FROM events'),
    };
    for (const row of this.q.stats.all() as { key: StatKey; value: number }[]) {
      if (row.key in this.stats) this.stats[row.key] = row.value;
    }
    this.discord = new DiscordPresence(() => this.opts.changed());
    this.discord.configure(this.settings.discordClientId);
  }

  // ─── État ─────────────────────────────────────────────────────────────

  private bump(): void {
    this.revision++;
    this.counts = null;
    this.opts.changed();
  }

  dir(): string {
    return this.settings.dir ?? this.opts.defaultDir;
  }

  view(): LibraryView {
    if (!this.counts) {
      let updates = 0;
      for (const i of this.q.installs.all() as unknown as InstallRow[]) {
        const app = this.q.app.get(i.app) as AppRow | undefined;
        if (app && app.mine === 0 && !app.removed && this.release(app).version !== i.version) updates++;
      }
      this.counts = { updates, unseenBugs: (this.q.unseenBugs.get() as { n: number }).n };
    }
    const first = [...this.running.entries()][0];
    return {
      revision: this.revision,
      dir: this.dir(),
      autoUpdate: this.settings.autoUpdate,
      jobs: [...this.jobs.values()].map((j) => ({ ...j.view })),
      ...this.counts,
      playing: first ? { app: first[0], name: first[1].name, since: first[1].start } : null,
      peerPlaying: this.peerPlaying,
      level: { xp: this.stats.xp, ...levelOf(this.stats.xp) },
      peerLevel: this.peerXp === null ? null : levelOf(this.peerXp).level,
      testIn: this.testIn,
      testOut: this.testOut,
      discord: { clientId: this.settings.discordClientId, status: this.discord.status },
    };
  }

  busy(): boolean {
    return this.exchange.busy() || this.jobs.size > 0;
  }

  private release(row: AppRow): LibRelease {
    return JSON.parse(row.release) as LibRelease;
  }

  private authorName(mine: boolean): string {
    return mine ? this.opts.myName() : (this.opts.peer()?.name ?? 'ton binôme');
  }

  private nameOfDevice(device: string): string {
    return device === this.opts.device ? this.opts.myName() : (this.opts.peer()?.name ?? 'ton binôme');
  }

  // ─── Liaison ──────────────────────────────────────────────────────────

  attach(pipe: LibPipe): void {
    this.send = (m) => pipe.send(m);
    this.exchange.attach(pipe);
    const mine = this.q.myApps.all() as unknown as AppRow[];
    pipe.send({ t: 'lib.catalog', apps: mine.map((a) => a.id) });
    for (const a of mine) pipe.send({ t: 'lib.release', release: this.release(a), sig: a.sig });
    const ideas = (this.q.allIdeas.all() as unknown as IdeaRow[]).map((r) => this.ideaMsg(r));
    for (let i = 0; i < ideas.length; i += 50) pipe.send({ t: 'lib.ideas', ideas: ideas.slice(i, i + 50) });
    for (const r of this.q.myReviews.all(this.opts.device) as { app: string; stars: number; text: string; at: number }[]) {
      pipe.send({ t: 'lib.review', app: r.app, stars: r.stars, text: r.text, at: r.at });
      this.q.reviewSent.run(r.app, this.opts.device);
    }
    for (const b of this.q.pendingBugs.all() as unknown as BugRow[]) this.sendBug(b);
    pipe.send({ t: 'lib.level', xp: this.stats.xp });
    const playing = this.view().playing;
    if (playing) pipe.send({ t: 'lib.playing', app: playing.app, name: playing.name, since: playing.since });
  }

  detach(): void {
    this.send = null;
    this.exchange.detach();
    if (this.peerPlaying || this.testIn) {
      this.peerPlaying = null;
      this.testIn = null;
      this.opts.changed();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.exchange.stop();
    this.flushBytes();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.discord.close();
    // Les jeux lancés continuent : leur temps de jeu en cours est noté maintenant.
    for (const [app, r] of this.running) this.endSession(app, r.start, r.name);
    this.running.clear();
    await this.installQueue.catch(() => {});
    this.store.close();
    this.db.close();
  }

  piece(hash: Buffer, offset: number, total: number, bytes: Uint8Array): void {
    this.exchange.piece(hash, offset, total, bytes);
  }

  handle(msg: PeerMessage): void {
    switch (msg.t) {
      case 'lib.wantManifest':
      case 'lib.manifest':
      case 'lib.noManifest':
      case 'lib.wantChunks':
      case 'lib.noChunk':
        return this.exchange.handle(msg);
      case 'lib.catalog':
        return this.onCatalog(msg.apps);
      case 'lib.release':
        return this.onRelease(msg.release, msg.sig);
      case 'lib.remove':
        return this.onRemove(msg.app);
      case 'lib.review':
        return this.onReview(msg);
      case 'lib.bug':
        return this.onBug(msg);
      case 'lib.bug.ack':
        this.q.bugSent.run(String(msg.id));
        return;
      case 'lib.bug.status': {
        const b = this.q.bug.get(String(msg.id)) as BugRow | undefined;
        if (!b || b.mine !== 1 || (msg.status !== 'open' && msg.status !== 'fixed')) return;
        this.q.bugStatus.run(msg.status, b.id);
        return this.bump();
      }
      case 'lib.test':
        return this.onTest(msg);
      case 'lib.test.reply': {
        if (!this.testOut || this.testOut.id !== msg.id || (msg.answer !== 'yes' && msg.answer !== 'no')) return;
        this.testOut = { ...this.testOut, answer: msg.answer };
        const who = this.opts.peer()?.name ?? 'Ton binôme';
        this.opts.notify(
          'testReply',
          msg.answer === 'yes' ? `${who} teste ${this.testOut.name}` : `${who} ne peut pas tester maintenant`,
          '',
          this.testOut.app,
        );
        this.opts.changed();
        return;
      }
      case 'lib.ideas':
        return this.onIdeas(msg.ideas);
      case 'lib.playing': {
        const app = typeof msg.app === 'string' && HEX32.test(msg.app) ? msg.app : null;
        this.peerPlaying = app
          ? { app, name: oneLine(msg.name, 60) || 'un jeu', since: typeof msg.since === 'number' ? msg.since : Date.now() }
          : null;
        this.opts.changed();
        return;
      }
      case 'lib.level':
        if (typeof msg.xp === 'number' && msg.xp >= 0) {
          this.peerXp = Math.floor(msg.xp);
          this.opts.changed();
        }
        return;
    }
  }

  // ─── Pages reçues ─────────────────────────────────────────────────────

  private onCatalog(apps: unknown): void {
    if (!Array.isArray(apps)) return;
    const keep = new Set(apps.filter((a): a is string => typeof a === 'string'));
    for (const row of this.q.apps.all() as unknown as AppRow[]) {
      if (row.mine === 1 || keep.has(row.id)) continue;
      this.onRemove(row.id);
    }
  }

  private onRemove(app: unknown): void {
    if (typeof app !== 'string') return;
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row || row.mine === 1) return;
    // Une app installée reste jouable, marquée « retirée ».
    if (this.q.install.get(app)) this.q.setRemoved.run(app);
    else this.q.dropApp.run(app);
    this.bump();
  }

  private onRelease(raw: unknown, sig: unknown): void {
    const peer = this.opts.peer();
    if (!peer || typeof sig !== 'string') return;
    // Signature vérifiée sur la page telle qu'elle est arrivée.
    if (!raw || typeof raw !== 'object' || !verifySignature(peer.pub, releaseBytes(raw as LibRelease), fromB64(sig))) return;
    const r = cleanRelease(raw);
    if (!r) return;
    const existing = this.q.app.get(r.app) as AppRow | undefined;
    if (existing?.mine === 1) return;
    const before = existing ? this.release(existing) : null;
    const changed = !before || before.version !== r.version || before.at !== r.at || existing?.removed === 1;
    if (!changed) {
      void this.fetchMedia(r);
      return;
    }
    tx(this.db, () => {
      this.q.putApp.run(r.app, 0, JSON.stringify(r), sig, null, Date.now());
      this.q.putRelease.run(r.app, r.version, r.at, r.notes);
    });
    this.bump();
    void this.fetchMedia(r);

    const who = peer.name;
    const install = this.q.install.get(r.app) as InstallRow | undefined;
    if (!before) this.opts.notify('new', `${who} a publié ${r.name}`, `Version ${r.version}`, r.app);
    else if (install && install.version !== r.version) {
      const auto = this.settings.autoUpdate && !this.running.has(r.app);
      this.opts.notify('update', `Mise à jour de ${r.name}`, auto ? `Version ${r.version}, téléchargement en cours` : `Version ${r.version} disponible`, r.app);
      if (auto) this.install(r.app).catch(() => {});
    }
  }

  /** Icône, bannière et galerie : récupérées en tâche de fond, une à la fois. */
  private mediaQueue: Promise<void> = Promise.resolve();
  private fetchMedia(r: LibRelease): Promise<void> {
    const all = [r.icon, r.banner, ...r.gallery].filter((m): m is LibMedia => m !== null);
    this.mediaQueue = this.mediaQueue.then(async () => {
      let got = false;
      for (const m of all) {
        if (this.stopped || !this.exchange.connected) return;
        if (await this.store.hasMediaFile(m)) continue;
        try {
          const chunks = await this.exchange.manifest(m.h);
          if (chunks.reduce((n, c) => n + c.size, 0) !== m.s) continue;
          await this.exchange.fetch(new Map(chunks.map((c) => [c.hash.toString('hex'), c.size])));
          await this.store.writeMedia(m);
          got = true;
        } catch (err) {
          console.error('média :', err instanceof Error ? err.message : err);
        }
      }
      if (got) this.bump();
    });
    return this.mediaQueue;
  }

  // ─── Listes et pages ──────────────────────────────────────────────────

  list(): LibAppView[] {
    const plays = new Map((this.q.plays.all() as { app: string; ms: number; last: number | null }[]).map((p) => [p.app, p]));
    const installs = new Map((this.q.installs.all() as unknown as InstallRow[]).map((i) => [i.app, i]));
    const ratings = new Map<string, number>();
    for (const r of this.q.allReviews.all() as { app: string; stars: number; by: string }[]) ratings.set(r.app, r.stars);
    return (this.q.apps.all() as unknown as AppRow[]).map((row) => this.appView(row, installs.get(row.id), plays.get(row.id), ratings.get(row.id)));
  }

  private appView(row: AppRow, install: InstallRow | undefined, play: { ms: number; last: number | null } | undefined, rating: number | undefined): LibAppView {
    const r = this.release(row);
    const mine = row.mine === 1;
    const installed = mine ? r.version : (install?.version ?? null);
    return {
      id: row.id,
      name: r.name,
      category: r.category,
      tags: r.tags,
      mine,
      author: this.authorName(mine),
      version: r.version,
      size: r.size,
      at: r.at,
      icon: media(r.icon),
      banner: media(r.banner),
      installed,
      update: !mine && !!install && install.version !== r.version && row.removed === 0,
      playMs: play?.ms ?? 0,
      lastPlayed: play?.last ?? null,
      rating: rating ?? null,
      removed: row.removed === 1,
      running: this.running.has(row.id),
      canLaunch: !!r.exe && (mine ? !!row.source : !!install),
    };
  }

  detail(app: string): LibAppDetail {
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row) throw new Error('App introuvable');
    const r = this.release(row);
    const install = this.q.install.get(app) as InstallRow | undefined;
    const play = this.q.play.get(app) as { ms: number; launches: number; last: number | null } | undefined;
    const reviews = (this.q.reviews.all(app) as { by: string; stars: number; text: string; at: number }[]).map((x) => ({
      by: this.nameOfDevice(x.by),
      mine: x.by === this.opts.device,
      stars: x.stars,
      text: x.text,
      at: x.at,
    }));
    const base = this.appView(row, install, play, reviews[0]?.stars);
    return {
      ...base,
      description: r.description,
      requirements: r.requirements,
      notes: r.notes,
      exe: r.exe,
      gallery: r.gallery.map(media).filter((m): m is MediaView => m !== null),
      count: r.count,
      releases: this.q.releases.all(app) as { version: string; at: number; notes: string }[],
      reviews,
      bugs: (this.q.bugs.all(app) as unknown as BugRow[]).map((b) => this.bugView(b)),
      installDir: install?.dir ?? null,
      trusted: install?.trusted === 1,
      via: r.via === 'claude',
      source: row.source,
      launches: play?.launches ?? 0,
    };
  }

  private bugView(b: BugRow): LibBugView {
    const shot = b.shot ? (JSON.parse(b.shot) as LibMedia) : null;
    return {
      id: b.id,
      app: b.app,
      version: b.version,
      mine: b.mine === 1,
      by: this.authorName(b.mine === 1),
      text: b.text,
      shot: media(shot),
      at: b.at,
      status: b.status === 'fixed' ? 'fixed' : 'open',
    };
  }

  // ─── Publier ──────────────────────────────────────────────────────────

  async publish(form: PublishForm, via?: 'claude'): Promise<{ app: string }> {
    const existing = form.app ? (this.q.app.get(form.app) as AppRow | undefined) : undefined;
    if (form.app && existing?.mine !== 1) throw new Error('Tu ne peux mettre à jour que tes propres apps');
    const prev = existing ? this.release(existing) : null;
    const name = oneLine(form.name, 60);
    const version = oneLine(form.version, 32);
    if (!name) throw new Error('Donne un nom');
    if (!version) throw new Error('Donne un numéro de version');
    if (!CATEGORIES.has(form.category)) throw new Error('Catégorie inconnue');
    if (prev && prev.version === version) throw new Error(`La version ${version} est déjà publiée : change le numéro`);
    const source = form.source ?? existing?.source ?? null;
    if (!source || !isAbsolute(source)) throw new Error('Choisis le dossier ou l’exe à publier');
    const st = await stat(source).catch(() => null);
    if (!st) throw new Error(`Introuvable : ${source}`);
    const app = existing?.id ?? randomBytes(16).toString('hex');
    if (this.jobs.has(app)) throw new Error('Publication déjà en cours');

    const files = st.isDirectory()
      ? await walk(source)
      : [{ rel: safeRelPath(basename(source)) ?? 'app.exe', abs: source, size: st.size }];
    if (files.length === 0) throw new Error('Le dossier est vide');
    const total = files.reduce((n, f) => n + f.size, 0);
    const job: Job = { view: { app, name, kind: 'publish', phase: 'preparing', bytes: 0, total } };
    this.jobs.set(app, job);
    this.opts.changed();

    try {
      const pkg: PkgFile[] = [];
      for (const f of files) {
        const r = await this.store.addFile(f.abs);
        pkg.push({ path: f.rel, hash: r.hash, size: r.size, chunks: r.chunks });
        job.view.bytes += f.size;
        this.progress();
      }
      const paths = pkg.map((f) => f.path);
      let exe: string | null;
      if (form.exe === undefined) exe = prev?.exe && paths.includes(prev.exe) ? prev.exe : guessExe(paths, name);
      else if (form.exe === null) exe = null;
      else {
        exe = safeRelPath(form.exe.replace(/\\/g, '/'));
        if (!exe || !paths.some((p) => keyOf(p) === keyOf(exe!))) throw new Error(`Exécutable absent du paquet : ${form.exe}`);
        exe = paths.find((p) => keyOf(p) === keyOf(exe!))!;
      }

      const pick = async (path: string | null | undefined, keep: LibMedia | null, max: number, image: boolean): Promise<LibMedia | null> => {
        if (path === undefined) return keep;
        if (path === null) return null;
        const m = await this.store.addMedia(path, max);
        if (image && !m.type.startsWith('image/')) throw new Error(`Une image est attendue : ${path}`);
        return m;
      };
      const icon = await pick(form.icon, prev?.icon ?? null, LIMITS.icon, true);
      const banner = await pick(form.banner, prev?.banner ?? null, LIMITS.banner, true);
      let gallery = prev?.gallery ?? [];
      if (form.gallery !== undefined) {
        gallery = [];
        for (const p of form.gallery.slice(0, 12)) {
          const isVideo = /\.(mp4|webm|m4v)$/i.test(p);
          gallery.push(await this.store.addMedia(p, isVideo ? LIMITS.video : LIMITS.image));
        }
      }

      const filesHash = this.store.putBlob(encodePackage(pkg));
      const release: LibRelease = {
        app,
        version,
        name,
        category: form.category,
        tags: form.tags.map((t) => oneLine(t, 24)).filter(Boolean).slice(0, 8),
        description: clip(form.description, 20_000),
        requirements: clip(form.requirements, 2_000),
        notes: clip(form.notes, 10_000),
        exe,
        icon,
        banner,
        gallery,
        files: filesHash,
        size: pkg.reduce((n, f) => n + f.size, 0),
        count: pkg.length,
        at: Date.now(),
        ...(via ? { via } : {}),
      };
      const sig = toB64(this.opts.identity.sign(releaseBytes(release)));
      tx(this.db, () => {
        this.q.putApp.run(app, 1, JSON.stringify(release), sig, source, existing?.first_seen ?? Date.now());
        this.q.putRelease.run(app, version, release.at, release.notes);
      });
      this.send?.({ t: 'lib.release', release, sig });
      if (prev) {
        this.addStat('updates', 1);
        this.gain(XP.update, 'update', app);
      } else {
        this.addStat('published', 1);
        this.gain(XP.publish, 'publish', app);
      }
      this.jobs.delete(app);
      this.bump();
      this.collect();
      return { app };
    } catch (err) {
      this.failJob(job, err);
      throw err;
    }
  }

  /** L'auteur retire son app : elle disparaît chez l'autre (sauf si elle y est installée). */
  remove(app: string): void {
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row || row.mine !== 1) throw new Error('Tu ne peux retirer que tes propres apps');
    this.q.dropApp.run(app);
    this.send?.({ t: 'lib.remove', app });
    this.bump();
    this.collect();
  }

  // ─── Installer ────────────────────────────────────────────────────────

  /** Installe ou met à jour. Une installation à la fois ; la promesse se termine avec elle. */
  install(app: string): Promise<void> {
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row || row.mine === 1) return Promise.reject(new Error('App introuvable'));
    if (this.jobs.has(app) && this.jobs.get(app)!.view.phase !== 'failed') return Promise.reject(new Error('Déjà en cours'));
    if (this.running.has(app)) return Promise.reject(new Error('Ferme l’app avant de la mettre à jour'));
    const r = this.release(row);
    const update = !!this.q.install.get(app);
    const job: Job = { view: { app, name: r.name, kind: update ? 'update' : 'install', phase: 'preparing', bytes: 0, total: r.size } };
    this.jobs.set(app, job);
    this.opts.changed();
    const run = this.installQueue.then(() => this.runInstall(app, job));
    this.installQueue = run.catch(() => {});
    return run;
  }

  private async runInstall(app: string, job: Job): Promise<void> {
    try {
      const row = this.q.app.get(app) as AppRow | undefined;
      if (!row) throw new Error('App introuvable');
      const r = this.release(row);
      const old = this.q.install.get(app) as InstallRow | undefined;
      const dir = old?.dir ?? join(this.dir(), folderName(r));

      const list = this.store.readBlob(r.files) ?? (await this.exchange.blob(r.files, MAX_PACKAGE_LIST));
      const files = decodePackage(list);
      if (!files) throw new Error('Liste des fichiers invalide');
      const oldFiles = old ? (decodePackage(this.store.readBlob(old.files) ?? Buffer.alloc(0)) ?? []) : [];

      // Fichiers identiques déjà en place : on n'y touche pas.
      const oldByKey = new Map(oldFiles.map((f) => [keyOf(f.path), f]));
      const onDisk = new Map<string, number>();
      for (const f of oldFiles) {
        const st = await stat(toAbs(dir, f.path)).catch(() => null);
        if (st?.isFile()) onDisk.set(keyOf(f.path), st.size);
      }
      const toWrite = files.filter((f) => {
        const o = oldByKey.get(keyOf(f.path));
        return !(o && o.hash === f.hash && onDisk.get(keyOf(f.path)) === f.size);
      });

      // Blocs déjà sur le disque, dans les fichiers de la version installée.
      const local = new Map<string, { abs: string; offset: number; size: number }>();
      for (const f of oldFiles) {
        if (onDisk.get(keyOf(f.path)) !== f.size) continue;
        let offset = 0;
        for (const c of f.chunks) {
          local.set(c.hash.toString('hex'), { abs: toAbs(dir, f.path), offset, size: c.size });
          offset += c.size;
        }
      }
      const need = new Map<string, number>();
      for (const f of toWrite) for (const c of f.chunks) {
        const hex = c.hash.toString('hex');
        if (!local.has(hex) && !this.store.has(c.hash)) need.set(hex, c.size);
      }
      job.view = { ...job.view, phase: 'downloading', bytes: 0, total: [...need.values()].reduce((n, s) => n + s, 0) };
      this.opts.changed();
      await this.exchange.fetch(need, (n) => {
        job.view.bytes += n;
        this.progress();
      });

      // Tout est reconstruit à part avant de remplacer quoi que ce soit : les anciens fichiers servent de source.
      job.view = { ...job.view, phase: 'installing', bytes: 0, total: toWrite.reduce((n, f) => n + f.size, 0) };
      this.opts.changed();
      const staging = join(dir, STAGING);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const handles = new Map<string, Awaited<ReturnType<typeof openFile>>>();
      const readLocal = async (c: ChunkRef): Promise<Buffer | null> => {
        const fromStore = this.store.raw(c.hash);
        if (fromStore) return fromStore;
        const src = local.get(c.hash.toString('hex'));
        if (!src) return null;
        let fh = handles.get(src.abs);
        if (!fh) {
          fh = await openFile(src.abs, 'r');
          handles.set(src.abs, fh);
        }
        const buf = Buffer.alloc(src.size);
        const { bytesRead } = await fh.read(buf, 0, src.size, src.offset);
        return bytesRead === src.size && sha256(buf).equals(c.hash) ? buf : null;
      };
      try {
        for (let i = 0; i < toWrite.length; i++) {
          const f = toWrite[i]!;
          await this.store.assemble(f.chunks, join(staging, String(i)), f.hash, readLocal);
          job.view.bytes += f.size;
          this.progress();
        }
      } finally {
        for (const fh of handles.values()) await fh.close();
      }

      for (let i = 0; i < toWrite.length; i++) {
        const target = toAbs(dir, toWrite[i]!.path);
        await mkdir(dirname(target), { recursive: true });
        await rename(join(staging, String(i)), target);
      }
      const keep = new Set(files.map((f) => keyOf(f.path)));
      for (const f of oldFiles) if (!keep.has(keyOf(f.path))) await rm(toAbs(dir, f.path), { force: true });
      await rm(staging, { recursive: true, force: true });

      this.q.putInstall.run(app, r.version, r.files, dir, Date.now(), 0);
      this.jobs.delete(app);
      if (!old) {
        this.addStat('installs', 1);
        this.gain(XP.install, 'install', app);
      }
      this.opts.notify(old ? 'updated' : 'installed', old ? `${r.name} est à jour` : `${r.name} est installé`, `Version ${r.version}`, app);
      this.bump();
      this.collect();
    } catch (err) {
      this.failJob(job, err);
      throw err;
    }
  }

  async uninstall(app: string): Promise<void> {
    const install = this.q.install.get(app) as InstallRow | undefined;
    if (!install) return;
    if (this.running.has(app)) throw new Error('Ferme l’app avant de la désinstaller');
    if (this.jobs.has(app) && this.jobs.get(app)!.view.phase !== 'failed') throw new Error('Installation en cours');
    // Garde-fou : on ne supprime qu'un dossier créé par Binôme pour cette app.
    if (isAbsolute(install.dir) && basename(install.dir).endsWith(`-${app.slice(0, 6)}`)) {
      await rm(install.dir, { recursive: true, force: true });
    }
    this.q.dropInstall.run(app);
    const row = this.q.app.get(app) as AppRow | undefined;
    if (row?.removed === 1) this.q.dropApp.run(app);
    this.jobs.delete(app);
    this.bump();
    this.collect();
  }

  private failJob(job: Job, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    job.view = { ...job.view, phase: 'failed', error: message };
    this.opts.changed();
  }

  dismissJob(app: string): void {
    if (this.jobs.get(app)?.view.phase === 'failed') {
      this.jobs.delete(app);
      this.opts.changed();
    }
  }

  /** Au plus 10 rafraîchissements par seconde pendant un transfert. */
  private progress(): void {
    const now = Date.now();
    if (now - this.lastProgress < 100) return;
    this.lastProgress = now;
    this.opts.changed();
  }

  /** Ramasse-miettes : garde ce que l'on publie, les listes de fichiers, les médias à servir. */
  private collect(): void {
    if ([...this.jobs.values()].some((j) => j.view.phase !== 'failed')) return;
    const roots = new Set<string>();
    for (const row of this.q.apps.all() as unknown as AppRow[]) {
      const r = this.release(row);
      roots.add(r.files);
      if (row.mine !== 1) continue;
      for (const m of [r.icon, r.banner, ...r.gallery]) if (m) roots.add(m.h);
      for (const f of decodePackage(this.store.readBlob(r.files) ?? Buffer.alloc(0)) ?? []) roots.add(f.hash);
    }
    for (const i of this.q.installs.all() as unknown as InstallRow[]) roots.add(i.files);
    for (const b of this.q.allBugs.all() as unknown as BugRow[]) {
      if (b.mine === 1 && b.shot) roots.add((JSON.parse(b.shot) as LibMedia).h);
    }
    this.store.gc(roots);
  }

  // ─── Lancer ───────────────────────────────────────────────────────────

  async launch(app: string, trust: boolean): Promise<'started' | 'trust' | 'running'> {
    if (this.running.has(app)) return 'running';
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row) throw new Error('App introuvable');
    const r = this.release(row);
    if (!r.exe) throw new Error('Pas d’exécutable de lancement pour cette app');
    let exe: string;
    if (row.mine === 1) {
      if (!row.source) throw new Error('Dossier publié introuvable');
      const st = await stat(row.source).catch(() => null);
      exe = st?.isDirectory() ? toAbs(row.source, r.exe) : row.source;
    } else {
      const install = this.q.install.get(app) as InstallRow | undefined;
      if (!install) throw new Error('Installe l’app d’abord');
      if (!install.trusted) {
        if (!trust) return 'trust';
        this.q.trust.run(app);
      }
      exe = toAbs(install.dir, r.exe);
    }
    if (!(await stat(exe).catch(() => null))?.isFile()) throw new Error(`Exécutable introuvable : ${exe}`);

    const ext = extname(exe).toLowerCase();
    const child =
      ext === '.exe'
        ? spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: 'ignore' })
        : ext === '.bat' || ext === '.cmd'
          ? spawn('cmd.exe', ['/c', exe], { cwd: dirname(exe), detached: true, stdio: 'ignore', windowsHide: true })
          : spawn('explorer.exe', [exe], { detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const start = Date.now();
    this.running.set(app, { child, start, name: r.name });
    this.q.addPlay.run(app, 0, 1, start);
    child.once('exit', () => {
      if (!this.running.delete(app)) return;
      this.endSession(app, start, r.name);
      this.playingChanged();
    });
    this.playingChanged();
    this.bump();
    return 'started';
  }

  private endSession(app: string, start: number, _name: string): void {
    const end = Date.now();
    const ms = Math.max(0, end - start);
    this.q.addPlay.run(app, ms, 0, end);
    this.q.event.run(start, 'play', app, ms);
    this.addStat('play_ms', ms);
    if (ms > this.stats.longest_ms) this.setStat('longest_ms', ms);
    if (nightSession(start, end)) {
      this.q.event.run(start, 'night', app, 1);
      this.setStat('night', 1);
    }
    const xp = Math.floor(ms / 600_000) * XP.play10;
    if (xp) this.gain(xp, 'play', app);
    else this.checkAchievements();
    if (!this.stopped) this.bump();
  }

  private playingChanged(): void {
    const p = this.view().playing;
    this.send?.({ t: 'lib.playing', app: p?.app ?? null, ...(p ? { name: p.name, since: p.since } : {}) });
    this.discord.set(p ? { details: p.name, state: 'Lancé depuis Binôme', start: p.since } : null);
    this.opts.changed();
  }

  // ─── Avis, bugs, tests ────────────────────────────────────────────────

  review(app: string, stars: number, text: string): void {
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row || row.mine === 1) throw new Error('Tu peux noter les apps de ton binôme');
    const s = Math.round(stars);
    if (s < 0 || s > 5) throw new Error('Note de 1 à 5');
    const clean = clip(text, 2000).trim();
    const at = Date.now();
    const had = this.q.review.get(app, this.opts.device);
    if (s === 0) this.q.dropReview.run(app, this.opts.device);
    else this.q.putReview.run(app, this.opts.device, s, clean, at, 0);
    if (this.send?.({ t: 'lib.review', app, stars: s, text: clean, at })) this.q.reviewSent.run(app, this.opts.device);
    if (!had && s > 0) {
      this.addStat('reviews', 1);
      this.gain(XP.review, 'review', app);
    }
    this.bump();
  }

  private onReview(msg: Extract<PeerMessage, { t: 'lib.review' }>): void {
    const peer = this.opts.peer();
    const row = typeof msg.app === 'string' ? (this.q.app.get(msg.app) as AppRow | undefined) : undefined;
    if (!peer || !row || row.mine !== 1 || typeof msg.stars !== 'number' || typeof msg.at !== 'number') return;
    const stars = Math.round(msg.stars);
    const text = clip(msg.text, 2000);
    const old = this.q.review.get(row.id, peer.device) as { stars: number; text: string; at: number } | undefined;
    if (old && old.at === msg.at) return;
    if (stars <= 0 || stars > 5) {
      this.q.dropReview.run(row.id, peer.device);
    } else {
      this.q.putReview.run(row.id, peer.device, stars, text, msg.at, 1);
      this.opts.notify('review', `${peer.name} a noté ${this.release(row).name}`, `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}${text ? ` · ${text.slice(0, 120)}` : ''}`, row.id);
    }
    this.bump();
  }

  async bug(app: string, text: string, shot: string | null): Promise<void> {
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row || row.mine === 1) throw new Error('Les rapports vont à l’auteur de l’app');
    const clean = clip(text, 4000).trim();
    if (!clean) throw new Error('Décris le bug');
    let m: LibMedia | null = null;
    if (shot) {
      const buf = Buffer.from(shot, 'base64');
      if (buf.length > LIMITS.shot) throw new Error('Capture trop lourde');
      m = this.store.addMediaBuffer(buf);
      if (!m || !m.type.startsWith('image/')) throw new Error('Capture illisible');
      await this.store.writeMedia(m);
    }
    const r = this.release(row);
    const b: BugRow = {
      id: randomBytes(16).toString('hex'),
      app,
      version: (this.q.install.get(app) as InstallRow | undefined)?.version ?? r.version,
      mine: 1,
      text: clean,
      shot: m ? JSON.stringify(m) : null,
      at: Date.now(),
      status: 'open',
      sent: 0,
      seen: 1,
    };
    this.q.putBug.run(b.id, b.app, b.version, 1, b.text, b.shot, b.at, b.status, 0, 1);
    this.sendBug(b);
    this.addStat('bugs', 1);
    this.gain(XP.bug, 'bug', app);
    this.bump();
  }

  private sendBug(b: BugRow): void {
    this.send?.({ t: 'lib.bug', id: b.id, app: b.app, version: b.version, text: b.text, shot: b.shot ? (JSON.parse(b.shot) as LibMedia) : null, at: b.at });
  }

  private onBug(msg: Extract<PeerMessage, { t: 'lib.bug' }>): void {
    const row = typeof msg.app === 'string' ? (this.q.app.get(msg.app) as AppRow | undefined) : undefined;
    if (typeof msg.id !== 'string' || !HEX32.test(msg.id)) return;
    // Accusé de réception même pour un doublon : l'autre arrête de le renvoyer.
    this.send?.({ t: 'lib.bug.ack', id: msg.id });
    if (!row || row.mine !== 1 || this.q.bug.get(msg.id)) return;
    const shot = msg.shot && isMedia(msg.shot, true) && msg.shot.s <= LIMITS.shot ? msg.shot : null;
    const text = clip(msg.text, 4000);
    this.q.putBug.run(msg.id, row.id, oneLine(msg.version, 32), 0, text, shot ? JSON.stringify(shot) : null, typeof msg.at === 'number' ? msg.at : Date.now(), 'open', 1, 0);
    const name = this.release(row).name;
    this.opts.notify('bug', `Bug signalé sur ${name}`, text.slice(0, 160), row.id);
    this.bump();
    if (shot) {
      void (async () => {
        try {
          await this.exchange.blob(shot.h, LIMITS.shot);
          await this.store.writeMedia(shot);
          this.bump();
        } catch (err) {
          console.error('capture :', err instanceof Error ? err.message : err);
        }
      })();
    }
  }

  setBugStatus(id: string, status: 'open' | 'fixed'): void {
    const b = this.q.bug.get(id) as BugRow | undefined;
    if (!b || b.mine === 1) throw new Error('Seul l’auteur de l’app change l’état d’un rapport');
    this.q.bugStatus.run(status, id);
    this.send?.({ t: 'lib.bug.status', id, status });
    this.bump();
  }

  markBugsSeen(): void {
    this.q.bugsSeen.run();
    this.bump();
  }

  test(app: string): 'sent' | 'offline' {
    const row = this.q.app.get(app) as AppRow | undefined;
    if (!row || row.mine !== 1) throw new Error('« Teste mon jeu ! » marche sur tes propres apps');
    const r = this.release(row);
    const id = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + TEST_MS;
    if (!this.send?.({ t: 'lib.test', id, app, version: r.version, expiresAt })) return 'offline';
    this.testOut = { id, app, name: r.name, expiresAt, answer: null };
    this.addStat('tests_sent', 1);
    this.gain(XP.testSent, 'test', app);
    setTimeout(() => {
      if (this.testOut?.id !== id) return;
      this.testOut = null;
      this.opts.changed();
    }, TEST_MS + 15_000).unref?.();
    this.opts.changed();
    return 'sent';
  }

  private onTest(msg: Extract<PeerMessage, { t: 'lib.test' }>): void {
    const row = typeof msg.app === 'string' ? (this.q.app.get(msg.app) as AppRow | undefined) : undefined;
    if (!row || row.mine === 1 || typeof msg.id !== 'string' || !HEX32.test(msg.id)) return;
    // L'horloge de l'autre peut être décalée : au plus une minute à partir de maintenant.
    const expiresAt = Math.min(Date.now() + TEST_MS, typeof msg.expiresAt === 'number' ? msg.expiresAt : 0);
    if (expiresAt <= Date.now()) return;
    const r = this.release(row);
    this.testIn = { id: msg.id, app: row.id, name: r.name, version: oneLine(msg.version, 32), expiresAt };
    const who = this.opts.peer()?.name ?? 'Ton binôme';
    this.opts.notify('test', `${who} : « Teste mon jeu ! »`, `${r.name}, version ${this.testIn.version}`, row.id);
    setTimeout(() => {
      if (this.testIn?.id !== msg.id) return;
      this.testIn = null;
      this.opts.changed();
    }, expiresAt - Date.now()).unref?.();
    this.opts.changed();
  }

  testReply(id: string, answer: 'yes' | 'no'): void {
    if (!this.testIn || this.testIn.id !== id) return;
    this.send?.({ t: 'lib.test.reply', id, answer });
    if (answer === 'yes') {
      this.addStat('tests_yes', 1);
      this.gain(XP.testYes, 'test', this.testIn.app);
    }
    this.testIn = null;
    this.opts.changed();
  }

  // ─── Idées et wishlist ────────────────────────────────────────────────

  private ideaMsg(r: IdeaRow): LibIdea {
    return {
      id: r.id,
      kind: r.kind === 'wish' ? 'wish' : 'idea',
      text: r.text,
      by: r.by,
      status: r.status === 'doing' || r.status === 'done' ? r.status : 'open',
      app: r.app,
      updatedAt: r.updated_at,
      ...(r.deleted ? { deleted: 1 as const } : {}),
    };
  }

  ideas(): LibIdeaView[] {
    const names = new Map((this.q.apps.all() as unknown as AppRow[]).map((a) => [a.id, this.release(a).name]));
    return (this.q.ideas.all() as unknown as IdeaRow[]).map((r) => ({
      id: r.id,
      kind: r.kind === 'wish' ? 'wish' : 'idea',
      text: r.text,
      by: this.nameOfDevice(r.by),
      mine: r.by === this.opts.device,
      status: r.status === 'doing' || r.status === 'done' ? r.status : 'open',
      app: r.app,
      appName: r.app ? (names.get(r.app) ?? null) : null,
      updatedAt: r.updated_at,
    }));
  }

  saveIdea(input: { id?: string; kind: 'idea' | 'wish'; text: string; status?: 'open' | 'doing' | 'done'; app?: string | null }): LibIdeaView {
    const old = input.id ? (this.q.idea.get(input.id) as IdeaRow | undefined) : undefined;
    if (input.id && !old) throw new Error('Idée introuvable');
    const text = clip(input.text ?? old?.text, 500).trim();
    if (!text) throw new Error('Écris l’idée');
    const idea: LibIdea = {
      id: old?.id ?? randomBytes(16).toString('hex'),
      kind: input.kind === 'wish' ? 'wish' : 'idea',
      text,
      by: old?.by ?? this.opts.device,
      status: input.status ?? (old?.status as LibIdea['status'] | undefined) ?? 'open',
      app: input.app === undefined ? (old?.app ?? null) : input.app && HEX32.test(input.app) ? input.app : null,
      updatedAt: Math.max(Date.now(), (old?.updated_at ?? 0) + 1),
    };
    this.storeIdea(idea);
    this.send?.({ t: 'lib.ideas', ideas: [idea] });
    if (!old) {
      this.addStat('ideas', 1);
      this.gain(XP.idea, 'idea', idea.app);
    }
    this.bump();
    return this.ideas().find((i) => i.id === idea.id)!;
  }

  deleteIdea(id: string): void {
    const old = this.q.idea.get(id) as IdeaRow | undefined;
    if (!old) return;
    const idea = { ...this.ideaMsg(old), deleted: 1 as const, updatedAt: Math.max(Date.now(), old.updated_at + 1) };
    this.storeIdea(idea);
    this.send?.({ t: 'lib.ideas', ideas: [idea] });
    this.bump();
  }

  private storeIdea(i: LibIdea): void {
    this.q.putIdea.run(i.id, i.kind, i.text, i.by, i.status, i.app, i.updatedAt, i.deleted ? 1 : 0);
  }

  private onIdeas(list: unknown): void {
    if (!Array.isArray(list)) return;
    let changed = false;
    for (const raw of list.slice(0, 200)) {
      const i = cleanIdea(raw);
      if (!i) continue;
      const old = this.q.idea.get(i.id) as IdeaRow | undefined;
      if (old && old.updated_at >= i.updatedAt) continue;
      this.storeIdea(i);
      changed = true;
    }
    if (changed) this.bump();
  }

  // ─── Statistiques, XP, succès ─────────────────────────────────────────

  /** Un fichier est arrivé chez l'autre. */
  noteFileSent(): void {
    this.addStat('files_sent', 1);
    this.q.event.run(Date.now(), 'file', null, 1);
    this.gain(XP.fileSent, 'file', null);
  }

  /** Octets de fichiers envoyés : additionnés en mémoire, écrits toutes les 10 s. */
  noteBytes(n: number): void {
    this.pendingBytes += n;
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.flushBytes();
    }, 10_000);
    this.flushTimer.unref?.();
  }

  private flushBytes(): void {
    const n = this.pendingBytes;
    if (!n) return;
    this.pendingBytes = 0;
    const GB = 1024 ** 3;
    const before = Math.floor(this.stats.bytes_sent / GB);
    this.addStat('bytes_sent', n);
    this.q.event.run(Date.now(), 'bytes', null, n);
    const gb = Math.floor(this.stats.bytes_sent / GB) - before;
    if (gb > 0) this.gain(gb * XP.gigabyte, 'bytes', null);
    else this.checkAchievements();
  }

  private addStat(key: StatKey, n: number): void {
    this.setStat(key, this.stats[key] + n);
  }

  private setStat(key: StatKey, v: number): void {
    this.stats[key] = v;
    this.q.putStat.run(key, v);
  }

  private gain(xp: number, why: string, app: string | null): void {
    if (xp > 0) {
      const before = levelOf(this.stats.xp).level;
      this.addStat('xp', xp);
      this.q.event.run(Date.now(), 'xp', app, xp);
      const after = levelOf(this.stats.xp).level;
      if (after > before) {
        this.opts.notify('level', `Niveau ${after}`, why === 'achievement' ? '' : 'Nouveau thème peut-être débloqué dans Paramètres', undefined);
        this.send?.({ t: 'lib.level', xp: this.stats.xp });
      }
    }
    if (why !== 'achievement') this.checkAchievements();
    this.opts.changed();
  }

  private checkAchievements(): void {
    const have = new Set((this.q.achievements.all() as { id: string }[]).map((a) => a.id));
    for (const a of ACHIEVEMENTS) {
      if (have.has(a.id) || !a.done(this.stats)) continue;
      const at = Date.now();
      this.q.unlock.run(a.id, at);
      this.q.event.run(at, 'achievement', a.id, 0);
      this.opts.notify('achievement', `Succès : ${a.title}`, `+${a.xp} XP`, undefined);
      this.gain(a.xp, 'achievement', null);
    }
  }

  achievements(): AchievementView[] {
    const at = new Map((this.q.achievements.all() as { id: string; at: number }[]).map((a) => [a.id, a.at]));
    return ACHIEVEMENTS.map((a) => ({ id: a.id, title: a.title, hint: a.hint, xp: a.xp, at: at.get(a.id) ?? null }));
  }

  wrapped(month?: string): WrappedView {
    const now = Date.now();
    const m = month && monthRange(month) ? month : monthOf(now);
    const range = monthRange(m)!;
    const rows = this.q.eventsIn.all(range.from, range.to) as { at: number; kind: string; app: string | null; n: number }[];
    const apps = new Map((this.q.apps.all() as unknown as AppRow[]).map((a) => [a.id, this.release(a)]));
    const play = new Map<string, number>();
    const w: WrappedView = {
      month: m,
      months: [],
      playMs: 0,
      sessions: 0,
      nights: 0,
      top: [],
      filesSent: 0,
      bytesSent: 0,
      published: 0,
      updates: 0,
      reviews: 0,
      bugs: 0,
      ideas: 0,
      xp: 0,
      achievements: [],
    };
    for (const e of rows) {
      if (e.kind === 'play' && e.app) {
        w.playMs += e.n;
        w.sessions++;
        play.set(e.app, (play.get(e.app) ?? 0) + e.n);
      } else if (e.kind === 'night') w.nights++;
      else if (e.kind === 'file') w.filesSent += e.n;
      else if (e.kind === 'bytes') w.bytesSent += e.n;
      else if (e.kind === 'xp') w.xp += e.n;
      else if (e.kind === 'achievement' && e.app) {
        const a = ACHIEVEMENTS.find((x) => x.id === e.app);
        if (a) w.achievements.push({ title: a.title, at: e.at });
      }
    }
    // Publications, avis, bugs, idées : comptés depuis leurs tables.
    for (const row of this.q.myApps.all() as unknown as AppRow[]) {
      const versions = this.q.releases.all(row.id) as { at: number }[];
      versions.forEach((v, i) => {
        if (v.at < range.from || v.at >= range.to) return;
        // Triées de la plus récente à la plus ancienne : la dernière est la première publication.
        if (i === versions.length - 1) w.published++;
        else w.updates++;
      });
    }
    for (const r of this.q.myReviews.all(this.opts.device) as { at: number }[]) if (r.at >= range.from && r.at < range.to) w.reviews++;
    for (const b of this.q.allBugs.all() as unknown as BugRow[]) if (b.mine === 1 && b.at >= range.from && b.at < range.to) w.bugs++;
    for (const i of this.q.allIdeas.all() as unknown as IdeaRow[]) if (i.by === this.opts.device && i.kind === 'idea' && i.updated_at >= range.from && i.updated_at < range.to && !i.deleted) w.ideas++;
    w.top = [...play.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([app, ms]) => ({ app, name: apps.get(app)?.name ?? 'App retirée', ms, icon: media(apps.get(app)?.icon ?? null) }));
    // Mois disponibles : du premier événement à maintenant.
    const first = (this.q.firstEvent.get() as { at: number | null }).at ?? now;
    const d = new Date(now);
    for (let i = 0; i < 24; i++) {
      const t = new Date(d.getFullYear(), d.getMonth() - i, 1).getTime();
      if (t < new Date(new Date(first).getFullYear(), new Date(first).getMonth(), 1).getTime()) break;
      w.months.push(monthOf(t));
    }
    if (!w.months.includes(m)) w.months.unshift(m);
    return w;
  }

  // ─── Réglages ─────────────────────────────────────────────────────────

  configure(patch: { dir?: string; autoUpdate?: boolean; discordClientId?: string }): void {
    if (patch.dir !== undefined) {
      if (patch.dir && !isAbsolute(patch.dir)) throw new Error('Dossier invalide');
      this.settings.dir = patch.dir || null;
    }
    if (patch.autoUpdate !== undefined) this.settings.autoUpdate = patch.autoUpdate === true;
    if (patch.discordClientId !== undefined) {
      this.settings.discordClientId = String(patch.discordClientId).trim().slice(0, 32);
      this.discord.configure(this.settings.discordClientId);
      const p = this.view().playing;
      if (p) this.discord.set({ details: p.name, state: 'Lancé depuis Binôme', start: p.since });
    }
    this.opts.saveSettings();
    this.opts.changed();
  }

  get librarySettings(): LibrarySettings {
    return { ...this.settings };
  }

  /** Pour Claude : apps par nom ou identifiant. */
  find(nameOrId: string): { id: string; mine: boolean; name: string } | null {
    const all = (this.q.apps.all() as unknown as AppRow[]).map((a) => ({ id: a.id, mine: a.mine === 1, name: this.release(a).name }));
    const q = nameOrId.trim().toLowerCase();
    return all.find((a) => a.id === q) ?? all.find((a) => a.name.toLowerCase() === q) ?? all.find((a) => a.name.toLowerCase().includes(q)) ?? null;
  }
}
