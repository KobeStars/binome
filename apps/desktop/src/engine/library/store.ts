// Magasin de la Bibliothèque : les blocs FastCDC y sont gardés compressés (zstd, bloc par bloc),
// et envoyés tels quels. Un « blob » est un contenu du magasin désigné par son SHA-256 :
// liste des fichiers d'un paquet, image, vidéo, capture d'écran.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { chunkBuffer, chunkFile, decodeManifest, encodeManifest, MAX_CHUNK, sha256, type ChunkRef } from '../sync/chunker.ts';
import { safeRelPath, keyOf } from '../sync/paths.ts';
import { ChunkStore } from '../sync/store.ts';
import type { Db } from '../db/index.ts';
import type { LibMedia } from '@binome/protocol';

const RAW = 0;
const ZSTD = 1;
export const HEX64 = /^[0-9a-f]{64}$/;

/** Bloc tel qu'il est stocké et envoyé : un octet de mode, puis les données (compressées si ça vaut le coup). */
export function packChunk(raw: Uint8Array): Buffer {
  const z = zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 3 } });
  if (z.length < raw.length * 0.97) return Buffer.concat([Buffer.from([ZSTD]), z]);
  return Buffer.concat([Buffer.from([RAW]), raw]);
}

/** Bloc d'origine, ou null si les données sont invalides. Jamais plus de MAX_CHUNK octets décompressés. */
export function unpackChunk(stored: Uint8Array): Buffer | null {
  if (stored.length < 1) return null;
  const body = stored.subarray(1);
  if (stored[0] === RAW) return body.length <= MAX_CHUNK ? Buffer.from(body) : null;
  if (stored[0] !== ZSTD) return null;
  try {
    return zstdDecompressSync(body, { maxOutputLength: MAX_CHUNK });
  } catch {
    return null;
  }
}

/** Un fichier d'un paquet. */
export interface PkgFile {
  path: string;
  hash: string;
  size: number;
  chunks: ChunkRef[];
}

/** Liste des fichiers d'un paquet, en JSON : chemin, hash, taille, blocs (manifeste en base64). */
export function encodePackage(files: PkgFile[]): Buffer {
  return Buffer.from(
    JSON.stringify({ v: 1, files: files.map((f) => [f.path, f.hash, f.size, encodeManifest(f.chunks).toString('base64')]) }),
  );
}

/** Liste reçue : chemins sûrs et sans doublon, tailles cohérentes. Null sinon. */
export function decodePackage(raw: Uint8Array): PkgFile[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    return null;
  }
  const list = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(list) || list.length > 200_000) return null;
  const seen = new Set<string>();
  const out: PkgFile[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    const [p, h, s, c] = row as unknown[];
    const path = safeRelPath(p);
    if (!path || typeof h !== 'string' || !HEX64.test(h) || typeof s !== 'number' || typeof c !== 'string') return null;
    if (seen.has(keyOf(path))) return null;
    seen.add(keyOf(path));
    const chunks = decodeManifest(Buffer.from(c, 'base64'));
    if (!chunks || chunks.reduce((n, x) => n + x.size, 0) !== s) return null;
    out.push({ path, hash: h, size: s, chunks });
  }
  return out;
}

const MEDIA_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export const MEDIA_TYPES = new Set(Object.keys(MEDIA_EXT));

/** Type d'une image ou d'une vidéo, d'après ses premiers octets. */
export function sniffMedia(head: Buffer): string | null {
  if (head.length > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length > 8 && head.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (head.length > 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length > 6 && head.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (head.length > 12 && head.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (head.length > 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

/** Nom du fichier d'un média dans le dossier des médias, servi par binome://media/. */
export function mediaName(m: LibMedia): string | null {
  const ext = MEDIA_EXT[m.type];
  return ext && HEX64.test(m.h) ? `${m.h}.${ext}` : null;
}

export class LibStore {
  readonly chunks: ChunkStore;

  constructor(
    db: Db,
    dir: string,
    readonly mediaDir: string,
  ) {
    this.chunks = new ChunkStore(db, join(dir, 'store'));
  }

  has(hash: Uint8Array): boolean {
    return this.chunks.has(hash);
  }

  /** Bloc tel qu'il est stocké (à envoyer), ou null. */
  stored(hash: Uint8Array): Buffer | null {
    return this.chunks.get(hash);
  }

  raw(hash: Uint8Array): Buffer | null {
    const s = this.chunks.get(hash);
    return s ? unpackChunk(s) : null;
  }

  putRaw(hash: Uint8Array, raw: Uint8Array): void {
    if (!this.chunks.has(hash)) this.chunks.put(hash, packChunk(raw));
  }

  /** Bloc reçu : vérifié avant d'entrer. Faux si les données ne correspondent pas au hash. */
  putStored(hash: Buffer, stored: Uint8Array): boolean {
    const raw = unpackChunk(stored);
    if (!raw || !sha256(raw).equals(hash)) return false;
    if (!this.chunks.has(hash)) this.chunks.put(hash, Buffer.from(stored));
    return true;
  }

  manifest(hash: string): ChunkRef[] | null {
    return this.chunks.getManifest(hash);
  }

  putManifest(hash: string, chunks: ChunkRef[]): void {
    this.chunks.putManifest(hash, chunks);
  }

  /** Ajoute un fichier du disque au magasin. */
  async addFile(path: string): Promise<{ hash: string; size: number; chunks: ChunkRef[] }> {
    const r = await chunkFile(path, (hash, data) => this.putRaw(hash, data));
    this.putManifest(r.hash, r.chunks);
    return r;
  }

  /** Ajoute un contenu en mémoire, renvoie son hash. */
  putBlob(data: Uint8Array): string {
    const chunks = chunkBuffer(data);
    let off = 0;
    for (const c of chunks) {
      this.putRaw(c.hash, data.subarray(off, off + c.size));
      off += c.size;
    }
    const hash = sha256(data).toString('hex');
    this.putManifest(hash, chunks);
    return hash;
  }

  /** Blob entier en mémoire, vérifié. Null s'il manque un bloc. */
  readBlob(hash: string): Buffer | null {
    const m = this.manifest(hash);
    if (!m) return null;
    const parts: Buffer[] = [];
    for (const c of m) {
      const raw = this.raw(c.hash);
      if (!raw || raw.length !== c.size) return null;
      parts.push(raw);
    }
    const all = Buffer.concat(parts);
    return sha256(all).toString('hex') === hash ? all : null;
  }

  /** Blocs d'un manifeste qui manquent au magasin. */
  missing(chunks: ChunkRef[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const c of chunks) if (!this.has(c.hash)) out.set(c.hash.toString('hex'), c.size);
    return out;
  }

  /** Média de ce PC (publication, capture) : dans le magasin et dans le dossier des médias. */
  async addMedia(path: string, maxBytes: number): Promise<LibMedia> {
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new Error(`Fichier introuvable : ${path}`);
    if (st.size > maxBytes) throw new Error(`Fichier trop lourd : ${path}`);
    const fh = await open(path, 'r');
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    await fh.close();
    const type = sniffMedia(head);
    if (!type) throw new Error(`Format non pris en charge (PNG, JPEG, WebP, GIF, MP4, WebM) : ${path}`);
    const r = await this.addFile(path);
    const media = { h: r.hash, s: r.size, type };
    await mkdir(this.mediaDir, { recursive: true });
    await copyFile(path, join(this.mediaDir, mediaName(media)!));
    return media;
  }

  addMediaBuffer(data: Buffer): LibMedia | null {
    const type = sniffMedia(data.subarray(0, 16));
    if (!type) return null;
    return { h: this.putBlob(data), s: data.length, type };
  }

  async hasMediaFile(m: LibMedia): Promise<boolean> {
    const name = mediaName(m);
    if (!name) return false;
    const st = await stat(join(this.mediaDir, name)).catch(() => null);
    return st?.size === m.s;
  }

  /** Écrit un média du magasin dans le dossier des médias. */
  async writeMedia(m: LibMedia): Promise<void> {
    const name = mediaName(m);
    const chunks = this.manifest(m.h);
    if (!name || !chunks) throw new Error('Média absent du magasin');
    await mkdir(this.mediaDir, { recursive: true });
    const tmp = join(this.mediaDir, `${name}.part`);
    await this.assemble(chunks, tmp, m.h, (c) => this.raw(c.hash));
    await rename(tmp, join(this.mediaDir, name));
  }

  /** Reconstruit un fichier bloc par bloc, en vérifiant son hash. */
  async assemble(chunks: ChunkRef[], out: string, expected: string, read: (c: ChunkRef) => Buffer | null | Promise<Buffer | null>): Promise<void> {
    const ws = createWriteStream(out);
    const hash = createHash('sha256');
    try {
      for (const c of chunks) {
        const data = await read(c);
        if (!data || data.length !== c.size) throw new Error('Bloc absent');
        hash.update(data);
        if (!ws.write(data)) await once(ws, 'drain');
      }
      ws.end();
      await once(ws, 'finish');
    } catch (err) {
      ws.destroy();
      await rm(out, { force: true });
      throw err;
    }
    if (hash.digest('hex') !== expected) {
      await rm(out, { force: true });
      throw new Error('Fichier reconstruit abîmé');
    }
  }

  /** Garde les blobs et fichiers de `roots` et les blocs qu'ils utilisent ; le reste part. */
  gc(roots: Set<string>): { chunks: number; bytes: number } {
    return this.chunks.gc(roots, 0);
  }

  bytes(): number {
    return this.chunks.liveBytes();
  }

  close(): void {
    this.chunks.close();
  }
}
