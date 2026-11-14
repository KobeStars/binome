// Historique des versions et conflits.
// Chaque changement (local ou reçu) ajoute une ligne. On garde les 10 dernières par fichier :
// leurs blocs restent dans le magasin, une version se restaure sans réseau.

import type { Db } from '../db/index.ts';

export const VERSIONS_PER_FILE = 10;

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface Version {
  id: number;
  key: string;
  path: string;
  kind: ChangeKind;
  hash: string | null;
  size: number;
  by: string;
  at: number;
  /** 'claude' si l'action a été faite par Claude. */
  via?: 'claude' | null;
}

export interface TrashItem {
  key: string;
  path: string;
  by: string;
  deletedAt: number;
  /** Dernière version avec contenu : c'est elle qu'on restaure. */
  versionId: number;
  size: number;
}

export interface Conflict {
  id: number;
  path: string;
  aside: string;
  keptBy: string;
  asideBy: string;
  at: number;
}

export class History {
  private readonly q;
  /** Augmente à chaque écriture : l'interface sait quand rafraîchir. */
  revision = 0;

  constructor(db: Db) {
    this.q = {
      add: db.prepare('INSERT INTO versions (key, path, kind, hash, size, by, at, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      prune: db.prepare(
        'DELETE FROM versions WHERE key = ? AND id NOT IN (SELECT id FROM versions WHERE key = ? ORDER BY id DESC LIMIT ?)',
      ),
      get: db.prepare('SELECT * FROM versions WHERE id = ?'),
      ofKey: db.prepare('SELECT * FROM versions WHERE key = ? ORDER BY id DESC'),
      journal: db.prepare('SELECT * FROM versions ORDER BY id DESC LIMIT ?'),
      trash: db.prepare(`
        SELECT f.key, f.path, f.by, f.changed_at AS deletedAt, v.id AS versionId, v.size
        FROM files f
        JOIN versions v ON v.id = (
          SELECT id FROM versions WHERE key = f.key AND hash IS NOT NULL ORDER BY id DESC LIMIT 1
        )
        WHERE f.deleted = 1 AND f.changed_at >= ?
        ORDER BY f.changed_at DESC`),
      expired: db.prepare('SELECT key FROM files WHERE deleted = 1 AND changed_at < ?'),
      dropKey: db.prepare('DELETE FROM versions WHERE key = ?'),
      oldest: db.prepare(`
        SELECT v.id FROM versions v JOIN files f ON f.key = v.key
        WHERE v.hash IS NOT NULL AND (f.deleted = 1 OR v.hash IS NOT f.hash)
        ORDER BY v.at ASC LIMIT ?`),
      drop: db.prepare('DELETE FROM versions WHERE id = ?'),
      hashes: db.prepare('SELECT DISTINCT hash FROM versions WHERE hash IS NOT NULL'),
      addConflict: db.prepare(
        'INSERT INTO conflicts (path, aside, kept_by, aside_by, at) VALUES (?, ?, ?, ?, ?)',
      ),
      conflicts: db.prepare(
        'SELECT id, path, aside, kept_by AS keptBy, aside_by AS asideBy, at FROM conflicts WHERE dismissed = 0 ORDER BY id DESC LIMIT 20',
      ),
      dismiss: db.prepare('UPDATE conflicts SET dismissed = 1 WHERE id = ?'),
    };
  }

  add(v: Omit<Version, 'id' | 'at'>): void {
    this.q.add.run(v.key, v.path, v.kind, v.hash, v.size, v.by, Date.now(), v.via ?? null);
    this.q.prune.run(v.key, v.key, VERSIONS_PER_FILE);
    this.revision++;
  }

  get(id: number): Version | null {
    return (this.q.get.get(id) as Version | undefined) ?? null;
  }

  ofKey(key: string): Version[] {
    return this.q.ofKey.all(key) as unknown as Version[];
  }

  journal(limit: number): Version[] {
    return this.q.journal.all(limit) as unknown as Version[];
  }

  trash(since: number): TrashItem[] {
    return this.q.trash.all(since) as unknown as TrashItem[];
  }

  /** Oublie les versions des fichiers supprimés avant `before`. */
  expire(before: number): number {
    const keys = this.q.expired.all(before) as { key: string }[];
    for (const { key } of keys) this.q.dropKey.run(key);
    if (keys.length) this.revision++;
    return keys.length;
  }

  /** Supprime les `n` versions anciennes les plus vieilles (jamais la version actuelle d'un fichier). */
  dropOldest(n: number): number {
    const ids = this.q.oldest.all(n) as { id: number }[];
    for (const { id } of ids) this.q.drop.run(id);
    if (ids.length) this.revision++;
    return ids.length;
  }

  /** Hash de fichiers encore référencés par l'historique. */
  hashes(): string[] {
    return (this.q.hashes.all() as { hash: string }[]).map((r) => r.hash);
  }

  addConflict(c: Omit<Conflict, 'id' | 'at'>): void {
    this.q.addConflict.run(c.path, c.aside, c.keptBy, c.asideBy, Date.now());
    this.revision++;
  }

  conflicts(): Conflict[] {
    return this.q.conflicts.all() as unknown as Conflict[];
  }

  dismiss(id: number): void {
    this.q.dismiss.run(id);
    this.revision++;
  }
}
