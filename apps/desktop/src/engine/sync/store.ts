// Magasin de blocs adressés par leur hash. Les blocs sont ajoutés à la suite dans des
// fichiers pack de 64 Mo (comme git ou restic) : NTFS gère mal des centaines de milliers
// de petits fichiers. L'emplacement de chaque bloc est dans SQLite.

import { closeSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { decodeManifest, encodeManifest, type ChunkRef } from './chunker.ts';
import type { Db } from '../db/index.ts';

const PACK_LIMIT = 64 * 1024 * 1024;

export class ChunkStore {
  private readonly fds = new Map<number, number>();
  private current: { id: number; size: number };
  private readonly q;

  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.q = {
      has: db.prepare('SELECT 1 FROM chunks WHERE hash = ?'),
      get: db.prepare('SELECT pack, offset, length FROM chunks WHERE hash = ?'),
      put: db.prepare('INSERT OR IGNORE INTO chunks (hash, pack, offset, length, created_at) VALUES (?, ?, ?, ?, ?)'),
      packSize: db.prepare('UPDATE packs SET size = ? WHERE id = ?'),
      newPack: db.prepare('INSERT INTO packs (size) VALUES (0)'),
      lastPack: db.prepare('SELECT id, size FROM packs ORDER BY id DESC LIMIT 1'),
      getManifest: db.prepare('SELECT chunks FROM manifests WHERE hash = ?'),
      putManifest: db.prepare('INSERT OR IGNORE INTO manifests (hash, chunks) VALUES (?, ?)'),
      allManifests: db.prepare('SELECT hash, chunks FROM manifests'),
      dropManifest: db.prepare('DELETE FROM manifests WHERE hash = ?'),
      allChunks: db.prepare('SELECT hash, length, created_at FROM chunks'),
      dropChunk: db.prepare('DELETE FROM chunks WHERE hash = ?'),
      liveBytes: db.prepare('SELECT COALESCE(SUM(length), 0) AS n FROM chunks'),
      packs: db.prepare(
        'SELECT p.id, p.size, COALESCE(SUM(c.length), 0) AS live FROM packs p LEFT JOIN chunks c ON c.pack = p.id GROUP BY p.id',
      ),
      inPack: db.prepare('SELECT hash, offset, length FROM chunks WHERE pack = ?'),
      move: db.prepare('UPDATE chunks SET pack = ?, offset = ? WHERE hash = ?'),
      dropPack: db.prepare('DELETE FROM packs WHERE id = ?'),
    };
    const last = this.q.lastPack.get() as { id: number; size: number } | undefined;
    this.current = last ?? this.createPack();
  }

  private createPack(): { id: number; size: number } {
    const r = this.q.newPack.run();
    return { id: Number(r.lastInsertRowid), size: 0 };
  }

  private packPath(id: number): string {
    return join(this.dir, `pack-${String(id).padStart(6, '0')}.bin`);
  }

  private fd(id: number): number {
    let fd = this.fds.get(id);
    if (fd === undefined) {
      const path = this.packPath(id);
      try {
        fd = openSync(path, 'r+');
      } catch {
        fd = openSync(path, 'w+');
      }
      this.fds.set(id, fd);
    }
    return fd;
  }

  has(hash: Uint8Array): boolean {
    return this.q.has.get(hash) !== undefined;
  }

  /** Ajoute un bloc s'il n'est pas déjà là. Le hash doit avoir été vérifié par l'appelant. */
  put(hash: Uint8Array, data: Uint8Array): void {
    if (this.has(hash)) return;
    const { pack, offset } = this.append(data);
    this.q.put.run(hash, pack, offset, data.length, Date.now());
  }

  /** Ajoute des octets au pack courant, en ouvrant un nouveau pack s'il est plein. */
  private append(data: Uint8Array): { pack: number; offset: number } {
    if (this.current.size + data.length > PACK_LIMIT && this.current.size > 0) {
      this.current = this.createPack();
    }
    const { id, size } = this.current;
    writeSync(this.fd(id), data, 0, data.length, size);
    this.current.size += data.length;
    this.q.packSize.run(this.current.size, id);
    return { pack: id, offset: size };
  }

  /** Octets des blocs encore référencés (taille utile du magasin). */
  liveBytes(): number {
    return (this.q.liveBytes.get() as { n: number }).n;
  }

  /**
   * Supprime les manifestes hors de `roots` et les blocs qu'aucun manifeste restant n'utilise.
   * Un bloc récent n'est jamais supprimé : il peut appartenir à un fichier en cours d'indexation
   * dont le manifeste n'est pas encore écrit.
   */
  gc(roots: Set<string>, minAgeMs = 60 * 60 * 1000, now = Date.now()): { chunks: number; bytes: number } {
    const live = new Set<string>();
    for (const row of this.q.allManifests.all() as { hash: string; chunks: Uint8Array }[]) {
      if (!roots.has(row.hash)) {
        this.q.dropManifest.run(row.hash);
        continue;
      }
      for (const c of decodeManifest(row.chunks) ?? []) live.add(c.hash.toString('hex'));
    }
    let chunks = 0;
    let bytes = 0;
    for (const row of this.q.allChunks.all() as { hash: Uint8Array; length: number; created_at: number }[]) {
      const hex = Buffer.from(row.hash).toString('hex');
      if (live.has(hex) || row.created_at > now - minAgeMs) continue;
      this.q.dropChunk.run(row.hash);
      chunks++;
      bytes += row.length;
    }
    this.compact();
    return { chunks, bytes };
  }

  /** Réécrit les packs à moitié vides et supprime les packs vides. */
  compact(): void {
    for (const p of this.q.packs.all() as { id: number; size: number; live: number }[]) {
      if (p.id === this.current.id || p.live > p.size / 2) continue;
      for (const c of this.q.inPack.all(p.id) as { hash: Uint8Array; offset: number; length: number }[]) {
        const data = Buffer.allocUnsafe(c.length);
        readSync(this.fd(p.id), data, 0, c.length, c.offset);
        const { pack, offset } = this.append(data);
        this.q.move.run(pack, offset, c.hash);
      }
      const fd = this.fds.get(p.id);
      if (fd !== undefined) closeSync(fd);
      this.fds.delete(p.id);
      rmSync(this.packPath(p.id), { force: true });
      this.q.dropPack.run(p.id);
    }
  }

  get(hash: Uint8Array): Buffer | null {
    const row = this.q.get.get(hash) as { pack: number; offset: number; length: number } | undefined;
    if (!row) return null;
    const out = Buffer.allocUnsafe(row.length);
    const n = readSync(this.fd(row.pack), out, 0, row.length, row.offset);
    return n === row.length ? out : null;
  }

  putManifest(fileHash: string, chunks: ChunkRef[]): void {
    this.q.putManifest.run(fileHash, encodeManifest(chunks));
  }

  getManifest(fileHash: string): ChunkRef[] | null {
    const row = this.q.getManifest.get(fileHash) as { chunks: Uint8Array } | undefined;
    return row ? decodeManifest(row.chunks) : null;
  }

  close(): void {
    for (const fd of this.fds.values()) closeSync(fd);
    this.fds.clear();
  }
}
