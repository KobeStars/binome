// Profil : statut affiché chez l'autre, avatar, version de son app, wizz.
// Les avatars sont des fichiers du dossier de données, servis à l'interface par
// binome://avatar/me et binome://avatar/peer : l'état poussé ne porte qu'un numéro de révision.

import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PeerMessage, PeerStatus, StatusKind } from '@binome/protocol';

/** Fichiers des avatars dans le dossier de données de l'app. */
export const AVATAR_FILES = { me: 'avatar-me', peer: 'avatar-peer' } as const;
export const AVATAR_MAX_BYTES = 48 * 1024;
export const STATUS_MAX = 60;
/** Un wizz toutes les 10 s au plus. */
export const WIZZ_COOLDOWN_MS = 10_000;

const KINDS = new Set<StatusKind>(['available', 'busy', 'away']);

/** Statut valide, ou null. Le texte est coupé à 60 caractères, sans caractères de contrôle. */
export function cleanStatus(s: unknown): PeerStatus | null {
  if (!s || typeof s !== 'object') return null;
  const { kind, text } = s as { kind?: unknown; text?: unknown };
  if (typeof kind !== 'string' || !KINDS.has(kind as StatusKind)) return null;
  const clean = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, STATUS_MAX) : '';
  return { kind: kind as StatusKind, text: clean };
}

/** Type d'image reconnu à ses premiers octets. */
export function imageType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Avatar reçu en base64 : une image JPEG, PNG ou WebP de 48 Kio au plus. */
export function decodeAvatar(b64: unknown): Buffer | null {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES) return null;
  return imageType(buf) ? buf : null;
}

async function mtimeOf(path: string): Promise<number> {
  const st = await stat(path).catch(() => null);
  return st?.isFile() ? Math.round(st.mtimeMs) : 0;
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export interface ProfileState {
  status: PeerStatus | null;
  /** Révision de l'avatar, 0 s'il n'y en a pas. */
  avatar: number;
}

export interface PeerProfileState extends ProfileState {
  /** Version de l'app de l'autre, connue après son `hello`. */
  app: string | null;
  /** Version du protocole de l'autre : 0 tant qu'on ne la connaît pas. */
  proto: number;
}

export type WizzResult = 'sent' | 'offline' | 'wait';

export class Profiles {
  me: ProfileState;
  peer: PeerProfileState = { status: null, avatar: 0, app: null, proto: 0 };
  private send: ((m: PeerMessage) => boolean) | null = null;
  private lastWizzOut = 0;
  private lastWizzIn = 0;

  constructor(
    private readonly dataDir: string,
    status: PeerStatus | null,
    private readonly events: { changed(): void; wizz(): void },
  ) {
    this.me = { status, avatar: 0 };
  }

  async load(): Promise<void> {
    this.me.avatar = await mtimeOf(join(this.dataDir, AVATAR_FILES.me));
    this.peer.avatar = await mtimeOf(join(this.dataDir, AVATAR_FILES.peer));
  }

  /** Canal ouvert : l'autre reçoit notre profil complet, avatar compris. */
  attach(send: (m: PeerMessage) => boolean): void {
    this.send = send;
    void this.sendProfile(true);
  }

  detach(): void {
    this.send = null;
  }

  /** `hello` de l'autre : versions de son protocole et de son app. */
  hello(proto: unknown, app: unknown): void {
    this.peer.proto = typeof proto === 'number' && Number.isInteger(proto) && proto > 0 ? proto : 1;
    this.peer.app = typeof app === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(app) ? app : null;
    this.events.changed();
  }

  setStatus(status: PeerStatus | null): void {
    this.me.status = status;
    this.events.changed();
    void this.sendProfile(false);
  }

  /** `b64` : image déjà réduite par le main, ou null pour revenir aux initiales. */
  async setAvatar(b64: string | null): Promise<void> {
    const file = join(this.dataDir, AVATAR_FILES.me);
    if (b64 === null) {
      await rm(file, { force: true });
      this.me.avatar = 0;
    } else {
      const buf = decodeAvatar(b64);
      if (!buf) throw new Error('Image invalide ou trop lourde');
      await writeAtomic(file, buf);
      this.me.avatar = Date.now();
    }
    this.events.changed();
    await this.sendProfile(true);
  }

  wizz(now = Date.now()): WizzResult {
    if (!this.send) return 'offline';
    if (now - this.lastWizzOut < WIZZ_COOLDOWN_MS) return 'wait';
    if (!this.send({ t: 'wizz' })) return 'offline';
    this.lastWizzOut = now;
    return 'sent';
  }

  async handle(msg: Extract<PeerMessage, { t: 'profile' | 'wizz' }>, now = Date.now()): Promise<void> {
    if (msg.t === 'wizz') {
      // L'émetteur se limite déjà ; on ne se fie pas à lui pour autant.
      if (now - this.lastWizzIn < WIZZ_COOLDOWN_MS / 2) return;
      this.lastWizzIn = now;
      this.events.wizz();
      return;
    }
    this.peer.status = cleanStatus(msg.status);
    if (msg.avatar !== undefined) await this.storePeerAvatar(msg.avatar);
    this.events.changed();
  }

  /** Dissociation : on oublie le profil de l'autre. */
  async forgetPeer(): Promise<void> {
    this.peer = { status: null, avatar: 0, app: null, proto: 0 };
    await rm(join(this.dataDir, AVATAR_FILES.peer), { force: true });
    this.events.changed();
  }

  private async storePeerAvatar(b64: string | null): Promise<void> {
    const file = join(this.dataDir, AVATAR_FILES.peer);
    if (b64 === null) {
      await rm(file, { force: true });
      this.peer.avatar = 0;
      return;
    }
    const buf = decodeAvatar(b64);
    if (!buf) return;
    // Renvoyé à chaque connexion : on ne réécrit (et l'interface ne recharge) que s'il a changé.
    const current = await readFile(file).catch(() => null);
    if (current?.equals(buf) && this.peer.avatar) return;
    await writeAtomic(file, buf);
    this.peer.avatar = Date.now();
  }

  private async sendProfile(withAvatar: boolean): Promise<void> {
    const send = this.send;
    if (!send) return;
    const msg: Extract<PeerMessage, { t: 'profile' }> = { t: 'profile', status: this.me.status };
    if (withAvatar) {
      const data = this.me.avatar ? await readFile(join(this.dataDir, AVATAR_FILES.me)).catch(() => null) : null;
      msg.avatar = data ? data.toString('base64') : null;
    }
    // Le canal a pu changer pendant la lecture du fichier.
    if (this.send === send) send(msg);
  }
}
