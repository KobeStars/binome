// Envoi direct : un fichier glissé dans l'app part tout de suite chez l'autre.
// Le destinataire écrit dans un fichier .part et indique à chaque (re)connexion
// où il en est : un transfert coupé reprend là où il s'est arrêté.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { DATA_CHUNK, type PeerMessage } from '@binome/protocol';

export type TransferStatus = 'preparing' | 'waiting' | 'active' | 'verifying' | 'done' | 'failed';

export interface TransferView {
  id: string;
  direction: 'out' | 'in';
  name: string;
  size: number;
  bytes: number;
  status: TransferStatus;
  /** Octets par seconde, moyenne glissante. */
  rate: number;
  error?: string;
  /** Chemin du fichier reçu, une fois terminé. */
  path?: string;
  /** Envoi demandé par Claude. */
  via?: 'claude';
}

/** Ce dont les transferts ont besoin du lien. */
export interface Pipe {
  readonly connected: boolean;
  send(msg: PeerMessage): boolean;
  sendData(id: string, offset: number, bytes: Uint8Array): void;
  drain(): Promise<void>;
}

interface Outgoing {
  view: TransferView;
  path: string;
  sha256: string;
  /** Incrémenté à chaque reprise : l'ancienne boucle d'envoi s'arrête. */
  run: number;
}

interface Incoming {
  view: TransferView;
  sha256: string;
  partPath: string;
  file: FileHandle | null;
  writes: Promise<void>;
  /** Dernier offset redemandé, pour ne pas redemander à chaque trame. */
  asked: number;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Garde un nom de fichier valide sous Windows et sans chemin. */
export function safeName(name: string): string {
  let n = basename(name.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '');
  if (!n) n = 'fichier';
  const stem = n.slice(0, n.length - extname(n).length);
  if (WINDOWS_RESERVED.test(stem)) n = `_${n}`;
  return n.slice(0, 200);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** « plan.psd », puis « plan (2).psd », « plan (3).psd »… */
async function freePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function hashFile(path: string, onProgress?: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
    onProgress?.(bytes);
  }
  return hash.digest('hex');
}

export class DirectTransfers {
  private readonly out = new Map<string, Outgoing>();
  private readonly in = new Map<string, Incoming>();
  private pipe: Pipe | null = null;

  constructor(
    private readonly inboxDir: string,
    private readonly onChange: (view: TransferView) => void,
    private readonly onReceived: (view: TransferView) => void = () => {},
  ) {}

  list(): TransferView[] {
    return [...this.out.values(), ...this.in.values()].map((t) => ({ ...t.view }));
  }

  /** Un transfert est en cours : le lien ne change pas de transport. */
  busy(): boolean {
    return [...this.out.values(), ...this.in.values()].some((t) => t.view.status === 'active');
  }

  /** Nouveau canal : on repropose tout ce qui n'est pas fini. */
  attach(pipe: Pipe): void {
    this.pipe = pipe;
    for (const t of this.out.values()) {
      if (t.view.status === 'waiting' || t.view.status === 'active') this.offer(t);
    }
  }

  detach(): void {
    this.pipe = null;
    for (const t of this.out.values()) {
      if (t.view.status === 'active') {
        t.run++;
        this.update(t.view, { status: 'waiting', rate: 0 });
      }
    }
    for (const t of this.in.values()) {
      if (t.view.status === 'active') this.update(t.view, { status: 'waiting', rate: 0 });
    }
  }

  async send(path: string, via?: 'claude'): Promise<TransferView> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Seuls les fichiers peuvent être envoyés');
    const view: TransferView = {
      id: randomBytes(16).toString('hex'),
      direction: 'out',
      name: safeName(basename(path)),
      size: info.size,
      bytes: 0,
      status: 'preparing',
      rate: 0,
      ...(via ? { via } : {}),
    };
    const t: Outgoing = { view, path, sha256: '', run: 0 };
    this.out.set(view.id, t);
    this.onChange({ ...view });

    try {
      t.sha256 = await hashFile(path);
    } catch (err) {
      this.update(view, { status: 'failed', error: 'Lecture du fichier impossible' });
      throw err;
    }
    this.update(view, { status: 'waiting' });
    this.offer(t);
    return { ...view };
  }

  cancel(id: string): void {
    const t = this.out.get(id) ?? this.in.get(id);
    if (!t || t.view.status === 'done') return;
    this.pipe?.send({ t: 'cancel', id });
    if (this.in.has(id)) void this.dropIncoming(id, 'Annulé');
    else this.failOutgoing(id, 'Annulé');
  }

  handle(msg: PeerMessage): void {
    switch (msg.t) {
      case 'offer':
        return void this.onOffer(msg);
      case 'accept':
        return void this.stream(msg.id, msg.offset);
      case 'end':
        return void this.onEnd(msg.id);
      case 'done': {
        const t = this.out.get(msg.id);
        if (t) this.update(t.view, { status: 'done', bytes: t.view.size, rate: 0 });
        return;
      }
      case 'failed':
      case 'cancel':
        if (this.out.has(msg.id)) this.failOutgoing(msg.id, msg.t === 'cancel' ? 'Annulé par l’autre' : msg.reason);
        else if (this.in.has(msg.id)) void this.dropIncoming(msg.id, 'Annulé par l’autre');
        return;
    }
  }

  data(id: string, offset: number, bytes: Uint8Array): void {
    const t = this.in.get(id);
    if (!t || !t.file || t.view.status !== 'active') return;
    if (offset !== t.view.bytes) {
      // Trou dans le flux : on redemande une fois depuis le dernier octet reçu.
      if (t.asked !== t.view.bytes) {
        t.asked = t.view.bytes;
        this.pipe?.send({ t: 'accept', id, offset: t.view.bytes });
      }
      return;
    }
    const file = t.file;
    const copy = bytes.slice();
    t.writes = t.writes.then(() => file.write(copy, 0, copy.length, offset).then(() => {}));
    this.progress(t.view, t.view.bytes + copy.length);
  }

  private offer(t: Outgoing): void {
    const v = t.view;
    this.pipe?.send({ t: 'offer', id: v.id, name: v.name, size: v.size, sha256: t.sha256 });
  }

  private async stream(id: string, offset: number): Promise<void> {
    const t = this.out.get(id);
    const pipe = this.pipe;
    if (!t || !pipe || t.view.status === 'done' || t.view.status === 'failed') return;
    const run = ++t.run;
    this.update(t.view, { status: 'active', bytes: offset });

    try {
      if (offset < t.view.size) {
        const stream = createReadStream(t.path, { start: offset, highWaterMark: DATA_CHUNK });
        let at = offset;
        for await (const chunk of stream) {
          if (t.run !== run || this.pipe !== pipe) {
            stream.destroy();
            return;
          }
          const buf = chunk as Buffer;
          await pipe.drain();
          pipe.sendData(id, at, buf);
          at += buf.length;
          this.progress(t.view, at);
        }
      }
      if (t.run === run) pipe.send({ t: 'end', id });
    } catch {
      if (t.run === run && this.pipe === pipe) this.failOutgoing(id, 'Lecture du fichier impossible');
    }
  }

  private async onOffer(msg: Extract<PeerMessage, { t: 'offer' }>): Promise<void> {
    const existing = this.in.get(msg.id);
    if (existing?.view.status === 'done') {
      this.pipe?.send({ t: 'done', id: msg.id });
      return;
    }
    await mkdir(this.inboxDir, { recursive: true });

    let t = existing;
    if (!t) {
      const view: TransferView = {
        id: msg.id,
        direction: 'in',
        name: safeName(msg.name),
        size: msg.size,
        bytes: 0,
        status: 'active',
        rate: 0,
      };
      t = { view, sha256: msg.sha256, partPath: join(this.inboxDir, `.${msg.id}.part`), file: null, writes: Promise.resolve(), asked: -1 };
      this.in.set(msg.id, t);
    }

    await t.writes;
    await t.file?.close();
    // Reprise : on repart de la taille déjà écrite sur disque.
    const have = Math.min((await stat(t.partPath).catch(() => null))?.size ?? 0, msg.size);
    t.file = await open(t.partPath, have > 0 ? 'r+' : 'w');
    await t.file.truncate(have);
    t.writes = Promise.resolve();
    t.asked = have;
    this.update(t.view, { status: 'active', bytes: have });
    this.pipe?.send({ t: 'accept', id: msg.id, offset: have });
  }

  private async onEnd(id: string): Promise<void> {
    const t = this.in.get(id);
    if (!t || !t.file) return;
    await t.writes;
    await t.file.close();
    t.file = null;
    this.update(t.view, { status: 'verifying', rate: 0 });

    const sha = await hashFile(t.partPath).catch(() => '');
    if (sha !== t.sha256) {
      await rm(t.partPath, { force: true });
      this.update(t.view, { status: 'failed', error: 'Fichier abîmé pendant le transfert' });
      this.pipe?.send({ t: 'failed', id, reason: 'Le fichier reçu ne correspond pas' });
      return;
    }
    const finalPath = await freePath(this.inboxDir, t.view.name);
    await rename(t.partPath, finalPath);
    this.update(t.view, { status: 'done', bytes: t.view.size, path: finalPath });
    this.pipe?.send({ t: 'done', id });
    this.onReceived({ ...t.view });
  }

  private failOutgoing(id: string, error: string): void {
    const t = this.out.get(id);
    if (!t) return;
    t.run++;
    this.update(t.view, { status: 'failed', error, rate: 0 });
  }

  private async dropIncoming(id: string, error: string): Promise<void> {
    const t = this.in.get(id);
    if (!t) return;
    this.update(t.view, { status: 'failed', error, rate: 0 });
    await t.writes;
    await t.file?.close();
    t.file = null;
    await rm(t.partPath, { force: true });
  }

  private lastTick = new Map<string, { at: number; bytes: number }>();

  /** Met à jour la progression au plus 10 fois par seconde. */
  private progress(view: TransferView, bytes: number): void {
    view.bytes = bytes;
    const now = Date.now();
    const last = this.lastTick.get(view.id);
    if (!last) {
      this.lastTick.set(view.id, { at: now, bytes });
      return;
    }
    if (now - last.at < 100 && bytes < view.size) return;
    const instant = ((bytes - last.bytes) * 1000) / Math.max(1, now - last.at);
    view.rate = view.rate ? view.rate * 0.7 + instant * 0.3 : instant;
    this.lastTick.set(view.id, { at: now, bytes });
    this.onChange({ ...view });
  }

  private update(view: TransferView, patch: Partial<TransferView>): void {
    Object.assign(view, patch);
    if (patch.status && patch.status !== 'active') this.lastTick.delete(view.id);
    this.onChange({ ...view });
  }
}
