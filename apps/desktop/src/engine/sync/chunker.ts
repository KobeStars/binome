// Découpage FastCDC (Xia et al., 2016) : les frontières de blocs dépendent du contenu.
// Insérer un octet au début d'un fichier ne décale que le bloc touché, pas tous les suivants.
// Variante 32 bits avec normalisation niveau 2 : blocs de 16 à 256 Kio, 64 Kio en moyenne.

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export const MIN_CHUNK = 16 * 1024;
export const AVG_CHUNK = 64 * 1024;
export const MAX_CHUNK = 256 * 1024;

// 18 bits avant la taille moyenne (coupe plus rare), 14 bits après (coupe plus facile).
// Bits de poids fort : avec le décalage à gauche, ils dépendent des 32 derniers octets.
const MASK_S = 0xffffc000 >>> 0;
const MASK_L = 0xfffc0000 >>> 0;

/** Table « gear » fixe : les deux appareils doivent couper aux mêmes endroits. */
const GEAR = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = createHash('sha256').update(`binome-gear-${i}`).digest().readUInt32BE(0);
  }
  return table;
})();

/** Longueur du prochain bloc dans `buf[off, off + len)`. `len` doit couvrir MAX_CHUNK sauf en fin de fichier. */
export function cutPoint(buf: Uint8Array, off: number, len: number): number {
  if (len <= MIN_CHUNK) return len;
  const n = Math.min(len, MAX_CHUNK);
  const normal = Math.min(n, AVG_CHUNK);
  let h = 0;
  let i = MIN_CHUNK;
  for (; i < normal; i++) {
    h = ((h << 1) + GEAR[buf[off + i]!]!) >>> 0;
    if ((h & MASK_S) === 0) return i + 1;
  }
  for (; i < n; i++) {
    h = ((h << 1) + GEAR[buf[off + i]!]!) >>> 0;
    if ((h & MASK_L) === 0) return i + 1;
  }
  return n;
}

export interface ChunkRef {
  hash: Buffer;
  size: number;
}

export interface ChunkedFile {
  /** SHA-256 du fichier entier, en hexadécimal. */
  hash: string;
  size: number;
  chunks: ChunkRef[];
}

export function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Découpe un tampon en mémoire (tests, petits fichiers). */
export function chunkBuffer(data: Uint8Array): ChunkRef[] {
  const out: ChunkRef[] = [];
  for (let off = 0; off < data.length; ) {
    const len = cutPoint(data, off, data.length - off);
    out.push({ hash: sha256(data.subarray(off, off + len)), size: len });
    off += len;
  }
  return out;
}

const READ_BLOCK = 4 * 1024 * 1024;

/**
 * Découpe un fichier en flux, sans le charger en mémoire.
 * `onChunk` reçoit chaque bloc (copie) : c'est là qu'on l'ajoute au magasin.
 */
export async function chunkFile(
  path: string,
  onChunk: (hash: Buffer, data: Buffer) => void,
): Promise<ChunkedFile> {
  const file = await open(path, 'r');
  const whole = createHash('sha256');
  const chunks: ChunkRef[] = [];
  const buf = Buffer.allocUnsafe(READ_BLOCK + MAX_CHUNK);
  let start = 0;
  let end = 0;
  let eof = false;
  let size = 0;
  try {
    for (;;) {
      if (!eof && end - start < MAX_CHUNK) {
        // Ramène le reste au début du tampon, puis remplit.
        buf.copy(buf, 0, start, end);
        end -= start;
        start = 0;
        const { bytesRead } = await file.read(buf, end, buf.length - end, null);
        if (bytesRead === 0) eof = true;
        whole.update(buf.subarray(end, end + bytesRead));
        end += bytesRead;
        size += bytesRead;
        continue;
      }
      if (end === start) break;
      const len = cutPoint(buf, start, end - start);
      const data = Buffer.from(buf.subarray(start, start + len));
      const hash = sha256(data);
      chunks.push({ hash, size: len });
      onChunk(hash, data);
      start += len;
    }
  } finally {
    await file.close();
  }
  return { hash: whole.digest('hex'), size, chunks };
}

/** Manifeste binaire : pour chaque bloc, 32 octets de hash puis la taille en u32. */
export function encodeManifest(chunks: ChunkRef[]): Buffer {
  const out = Buffer.allocUnsafe(chunks.length * 36);
  chunks.forEach((c, i) => {
    c.hash.copy(out, i * 36);
    out.writeUInt32BE(c.size, i * 36 + 32);
  });
  return out;
}

export function decodeManifest(raw: Uint8Array): ChunkRef[] | null {
  if (raw.length % 36 !== 0) return null;
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: ChunkRef[] = [];
  for (let i = 0; i < buf.length; i += 36) {
    const size = buf.readUInt32BE(i + 32);
    if (size === 0 || size > MAX_CHUNK) return null;
    out.push({ hash: Buffer.from(buf.subarray(i, i + 32)), size });
  }
  return out;
}
