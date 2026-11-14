import type { SyncEntry } from '@binome/protocol';
import type { Db } from '../db/index.ts';
import { keyOf } from './paths.ts';
import type { VV } from './vv.ts';

/** Une ligne de l'index : la dernière version connue d'un chemin. */
export interface FileEntry {
  key: string;
  path: string;
  hash: string | null;
  size: number;
  /** mtime local, pour détecter un fichier modifié sans le rehacher. */
  mtime: number;
  /** Date de la version chez son auteur. */
  vtime: number;
  vv: VV;
  deleted: boolean;
  by: string;
  changedAt: number;
  /** 'claude' si la version a été faite par Claude. */
  via?: 'claude' | null;
}

interface Row {
  key: string;
  path: string;
  hash: string | null;
  size: number;
  mtime: number;
  vtime: number;
  vv: string;
  deleted: number;
  by: string;
  changed_at: number;
  via: string | null;
}

function fromRow(r: Row): FileEntry {
  return {
    key: r.key,
    path: r.path,
    hash: r.hash,
    size: r.size,
    mtime: r.mtime,
    vtime: r.vtime,
    vv: JSON.parse(r.vv) as VV,
    deleted: r.deleted === 1,
    by: r.by,
    changedAt: r.changed_at,
    via: r.via === 'claude' ? 'claude' : null,
  };
}

export function toWire(e: FileEntry): SyncEntry {
  const w: SyncEntry = { p: e.path, h: e.deleted ? null : e.hash, s: e.size, v: e.vv, d: e.deleted ? 1 : 0, m: e.vtime, b: e.by };
  if (e.via === 'claude') w.c = 1;
  return w;
}

export class FileIndex {
  private readonly q;
  /** Augmente à chaque écriture : l'interface sait quand rafraîchir. */
  revision = 0;

  constructor(db: Db) {
    this.q = {
      get: db.prepare('SELECT * FROM files WHERE key = ?'),
      put: db.prepare(`
        INSERT INTO files (key, path, hash, size, mtime, vtime, vv, deleted, by, changed_at, via)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET path = excluded.path, hash = excluded.hash, size = excluded.size,
          mtime = excluded.mtime, vtime = excluded.vtime, vv = excluded.vv, deleted = excluded.deleted,
          by = excluded.by, changed_at = excluded.changed_at, via = excluded.via`),
      all: db.prepare('SELECT * FROM files'),
      live: db.prepare('SELECT * FROM files WHERE deleted = 0'),
      under: db.prepare("SELECT * FROM files WHERE deleted = 0 AND key LIKE ? ESCAPE '\\'"),
      recent: db.prepare('SELECT * FROM files ORDER BY changed_at DESC LIMIT ?'),
      stats: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM files WHERE deleted = 0'),
      clear: db.prepare('DELETE FROM files'),
    };
  }

  get(key: string): FileEntry | null {
    const r = this.q.get.get(key) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  put(e: Omit<FileEntry, 'key' | 'changedAt'> & { changedAt?: number }): FileEntry {
    const entry: FileEntry = { ...e, key: keyOf(e.path), changedAt: e.changedAt ?? Date.now() };
    this.q.put.run(
      entry.key,
      entry.path,
      entry.deleted ? null : entry.hash,
      entry.size,
      Math.round(entry.mtime),
      Math.round(entry.vtime),
      JSON.stringify(entry.vv),
      entry.deleted ? 1 : 0,
      entry.by,
      entry.changedAt,
      entry.via ?? null,
    );
    this.revision++;
    return entry;
  }

  all(): FileEntry[] {
    return (this.q.all.all() as unknown as Row[]).map(fromRow);
  }

  live(): FileEntry[] {
    return (this.q.live.all() as unknown as Row[]).map(fromRow);
  }

  /** Fichiers présents sous un dossier (clé en minuscules, sans / final). */
  under(dirKey: string): FileEntry[] {
    const escaped = dirKey.replace(/[\\%_]/g, (c) => `\\${c}`);
    return (this.q.under.all(`${escaped}/%`) as unknown as Row[]).map(fromRow);
  }

  recent(limit: number): FileEntry[] {
    return (this.q.recent.all(limit) as unknown as Row[]).map(fromRow);
  }

  stats(): { files: number; bytes: number } {
    const r = this.q.stats.get() as { n: number; bytes: number };
    return { files: r.n, bytes: r.bytes };
  }

  clear(): void {
    this.q.clear.run();
  }
}
