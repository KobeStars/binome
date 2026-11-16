// Échange de blocs pour la Bibliothèque : demande ce qui manque à l'autre, sert ce qu'il demande.
// Les blocs voyagent tels qu'ils sont stockés (compressés), vérifiés à l'arrivée.

import { DATA_CHUNK, encodeChunkPiece, type PeerMessage } from '@binome/protocol';
import { decodeManifest, encodeManifest, type ChunkRef } from '../sync/chunker.ts';
import { HEX64, type LibStore } from './store.ts';

export interface LibPipe {
  send(m: PeerMessage): boolean;
  sendFrame(frame: Uint8Array): void;
  drain(): Promise<void>;
}

/** Octets en route au plus (taille des blocs non compressés). */
const MAX_IN_FLIGHT = 16 * 1024 * 1024;
const HASHES_PER_REQUEST = 64;
const MANIFEST_PART = 30 * 1024;
/** Sans nouvelle d'un bloc pendant ce temps : on le redemande. */
const STALL_MS = 45_000;

interface Want {
  missing: Set<string>;
  progress: (bytes: number) => void;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface Pending {
  size: number;
  buf: Buffer | null;
  received: number;
  wants: Set<Want>;
  at: number;
}

export class LibExchange {
  private pipe: LibPipe | null = null;
  private wants: { want: Want; sizes: Map<string, number> }[] = [];
  private pending = new Map<string, Pending>();
  private inFlight = 0;
  private manifests = new Map<string, { parts: string[]; waiters: ((m: ChunkRef[] | null) => void)[] }>();
  private serveQueue: string[] = [];
  private serving = false;
  private timer: NodeJS.Timeout | null = null;
  /** Octets envoyés, pour les statistiques. */
  onSent: (bytes: number) => void = () => {};

  constructor(private readonly store: LibStore) {}

  get connected(): boolean {
    return this.pipe !== null;
  }

  attach(pipe: LibPipe): void {
    this.pipe = pipe;
    this.timer ??= setInterval(() => this.checkStalled(), 15_000);
    this.timer.unref?.();
  }

  detach(): void {
    this.pipe = null;
    this.serveQueue = [];
    this.pending.clear();
    this.inFlight = 0;
    for (const { want } of this.wants.splice(0)) want.reject(new Error('Connexion perdue'));
    for (const m of this.manifests.values()) for (const w of m.waiters) w(null);
    this.manifests.clear();
  }

  stop(): void {
    this.detach();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  busy(): boolean {
    return this.wants.length > 0 || this.serving;
  }

  /** Manifeste d'un fichier ou d'un blob : du magasin, sinon demandé à l'autre. */
  async manifest(hash: string): Promise<ChunkRef[]> {
    const local = this.store.manifest(hash);
    if (local) return local;
    if (!this.pipe) throw new Error('Ton binôme est hors ligne');
    const m = await new Promise<ChunkRef[] | null>((resolve) => {
      const w = this.manifests.get(hash);
      if (w) return void w.waiters.push(resolve);
      this.manifests.set(hash, { parts: [], waiters: [resolve] });
      this.pipe!.send({ t: 'lib.wantManifest', hash });
    });
    if (!m) throw new Error('Contenu introuvable chez ton binôme');
    this.store.putManifest(hash, m);
    return m;
  }

  /** Récupère les blocs absents du magasin. `progress` reçoit les octets arrivés. */
  fetch(chunks: Map<string, number>, progress: (bytes: number) => void = () => {}): Promise<void> {
    const sizes = new Map([...chunks].filter(([hex]) => !this.store.has(Buffer.from(hex, 'hex'))));
    if (sizes.size === 0) return Promise.resolve();
    if (!this.pipe) return Promise.reject(new Error('Ton binôme est hors ligne'));
    return new Promise((resolve, reject) => {
      const want: Want = { missing: new Set(sizes.keys()), progress, resolve, reject };
      this.wants.push({ want, sizes });
      this.request();
    });
  }

  /** Blob entier : manifeste, blocs, puis lecture vérifiée. */
  async blob(hash: string, maxBytes: number): Promise<Buffer> {
    const m = await this.manifest(hash);
    if (m.reduce((n, c) => n + c.size, 0) > maxBytes) throw new Error('Contenu trop lourd');
    await this.fetch(new Map(m.map((c) => [c.hash.toString('hex'), c.size])));
    const data = this.store.readBlob(hash);
    if (!data) throw new Error('Contenu reçu abîmé');
    return data;
  }

  private request(): void {
    const pipe = this.pipe;
    if (!pipe) return;
    for (const { want, sizes } of this.wants) {
      const batch: string[] = [];
      for (const hex of want.missing) {
        const p = this.pending.get(hex);
        if (p) {
          p.wants.add(want);
          continue;
        }
        if (this.inFlight >= MAX_IN_FLIGHT) break;
        const size = sizes.get(hex) ?? 0;
        this.pending.set(hex, { size, buf: null, received: 0, wants: new Set([want]), at: Date.now() });
        this.inFlight += size;
        batch.push(hex);
        if (batch.length === HASHES_PER_REQUEST) pipe.send({ t: 'lib.wantChunks', hashes: batch.splice(0) });
      }
      if (batch.length) pipe.send({ t: 'lib.wantChunks', hashes: batch });
      if (this.inFlight >= MAX_IN_FLIGHT) break;
    }
  }

  /** Morceau d'un bloc reçu (trame de type 4). `total` : taille stockée du bloc. */
  piece(hash: Buffer, offset: number, total: number, bytes: Uint8Array): void {
    const hex = hash.toString('hex');
    const p = this.pending.get(hex);
    if (!p || total > 2 * 1024 * 1024 || offset + bytes.length > total) return;
    p.buf ??= Buffer.alloc(total);
    if (p.buf.length !== total) return;
    p.buf.set(bytes, offset);
    p.received += bytes.length;
    p.at = Date.now();
    if (p.received < total) return;

    this.pending.delete(hex);
    this.inFlight -= p.size;
    if (this.store.putStored(hash, p.buf)) {
      for (const want of p.wants) {
        want.missing.delete(hex);
        want.progress(p.size);
        if (want.missing.size === 0) this.done(want);
      }
    }
    // Bloc abîmé : il reste à demander.
    this.request();
  }

  private noChunk(hex: string): void {
    const p = this.pending.get(hex);
    if (!p) return;
    this.pending.delete(hex);
    this.inFlight -= p.size;
    for (const want of p.wants) this.fail(want, new Error('Un fichier manque chez ton binôme'));
    this.request();
  }

  private done(want: Want): void {
    this.wants = this.wants.filter((w) => w.want !== want);
    want.resolve();
  }

  private fail(want: Want, err: Error): void {
    this.wants = this.wants.filter((w) => w.want !== want);
    for (const [hex, p] of this.pending) {
      p.wants.delete(want);
      if (p.wants.size === 0) {
        this.pending.delete(hex);
        this.inFlight -= p.size;
      }
    }
    want.reject(err);
  }

  private checkStalled(): void {
    const now = Date.now();
    let stalled = false;
    for (const [hex, p] of this.pending) {
      if (now - p.at < STALL_MS) continue;
      this.pending.delete(hex);
      this.inFlight -= p.size;
      stalled = true;
    }
    if (stalled) this.request();
  }

  // ─── Messages ─────────────────────────────────────────────────────────

  handle(msg: PeerMessage): void {
    switch (msg.t) {
      case 'lib.wantManifest':
        return this.serveManifest(msg.hash);
      case 'lib.manifest':
        return this.manifestPart(msg);
      case 'lib.noManifest': {
        const w = this.manifests.get(msg.hash);
        this.manifests.delete(msg.hash);
        for (const r of w?.waiters ?? []) r(null);
        return;
      }
      case 'lib.wantChunks':
        if (!Array.isArray(msg.hashes)) return;
        for (const h of msg.hashes.slice(0, HASHES_PER_REQUEST)) if (typeof h === 'string' && HEX64.test(h)) this.serveQueue.push(h);
        void this.serve();
        return;
      case 'lib.noChunk':
        if (typeof msg.hash === 'string') this.noChunk(msg.hash);
        return;
    }
  }

  private serveManifest(hash: unknown): void {
    if (typeof hash !== 'string' || !HEX64.test(hash)) return;
    const m = this.store.manifest(hash);
    if (!m) return void this.pipe?.send({ t: 'lib.noManifest', hash });
    const raw = encodeManifest(m);
    const parts = Math.max(1, Math.ceil(raw.length / MANIFEST_PART));
    for (let i = 0; i < parts; i++) {
      this.pipe?.send({ t: 'lib.manifest', hash, part: i, parts, data: raw.subarray(i * MANIFEST_PART, (i + 1) * MANIFEST_PART).toString('base64') });
    }
  }

  private manifestPart(msg: Extract<PeerMessage, { t: 'lib.manifest' }>): void {
    const w = this.manifests.get(msg.hash);
    if (!w || !Number.isInteger(msg.part) || msg.parts > 10_000 || msg.part < 0 || msg.part >= msg.parts) return;
    w.parts[msg.part] = String(msg.data);
    if (w.parts.filter((p) => p !== undefined).length < msg.parts) return;
    this.manifests.delete(msg.hash);
    const m = decodeManifest(Buffer.concat(w.parts.map((p) => Buffer.from(p, 'base64'))));
    // Le manifeste doit décrire exactement le contenu demandé : vérifié à la reconstruction.
    for (const r of w.waiters) r(m);
  }

  private async serve(): Promise<void> {
    if (this.serving) return;
    this.serving = true;
    try {
      while (this.serveQueue.length && this.pipe) {
        const pipe = this.pipe;
        const hex = this.serveQueue.shift()!;
        const hash = Buffer.from(hex, 'hex');
        const data = this.store.stored(hash);
        if (!data) {
          pipe.send({ t: 'lib.noChunk', hash: hex });
          continue;
        }
        for (let off = 0; off < data.length; off += DATA_CHUNK) {
          await pipe.drain();
          if (this.pipe !== pipe) return;
          const piece = data.subarray(off, off + DATA_CHUNK);
          pipe.sendFrame(encodeChunkPiece(hash, off, data.length, piece, true));
          this.onSent(piece.length);
        }
      }
    } finally {
      this.serving = false;
    }
  }
}
