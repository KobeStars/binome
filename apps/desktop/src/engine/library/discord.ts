// Discord Rich Presence par le pipe local de Discord (\\.\pipe\discord-ipc-N), sans dépendance.
// Trame : opcode (u32 LE), longueur (u32 LE), JSON. 0 : poignée de main, 1 : commande.

import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

export type DiscordStatus = 'off' | 'connecting' | 'connected' | 'unavailable';

export interface Activity {
  details: string;
  state?: string;
  start: number;
}

function frame(op: number, body: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(body));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function pipePath(i: number): string {
  return process.platform === 'win32' ? `\\\\?\\pipe\\discord-ipc-${i}` : `${process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? '/tmp'}/discord-ipc-${i}`;
}

function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

export class DiscordPresence {
  private socket: Socket | null = null;
  private ready = false;
  private clientId = '';
  private activity: Activity | null = null;
  private retryAt = 0;
  status: DiscordStatus = 'off';

  constructor(private readonly onStatus: () => void) {}

  /** Identifiant d'application Discord (Developer Portal), vide pour désactiver. */
  configure(clientId: string): void {
    const id = /^\d{15,25}$/.test(clientId) ? clientId : '';
    if (id === this.clientId) return;
    this.close();
    this.clientId = id;
    this.retryAt = 0;
    this.setStatus(id ? 'connecting' : 'off');
    void this.push();
  }

  set(activity: Activity | null): void {
    this.activity = activity;
    void this.push();
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.ready = false;
  }

  private setStatus(s: DiscordStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus();
  }

  private async push(): Promise<void> {
    if (!this.clientId) return;
    if (!this.ready) {
      // Discord fermé : pas plus d'une tentative par minute.
      if (Date.now() < this.retryAt) return;
      if (!(await this.connect())) {
        this.retryAt = Date.now() + 60_000;
        this.setStatus('unavailable');
        return;
      }
    }
    const a = this.activity;
    this.socket?.write(
      frame(1, {
        cmd: 'SET_ACTIVITY',
        nonce: randomUUID(),
        args: {
          pid: process.pid,
          ...(a ? { activity: { details: a.details, state: a.state, timestamps: { start: a.start }, instance: false } } : {}),
        },
      }),
    );
  }

  private async connect(): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
      const s = await open(pipePath(i)).catch(() => null);
      if (!s) continue;
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 5_000);
        let buf = Buffer.alloc(0);
        s.on('data', (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 8) {
            const len = buf.readInt32LE(4);
            if (buf.length < 8 + len) return;
            const op = buf.readInt32LE(0);
            let body: { evt?: string } = {};
            try {
              body = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')) as { evt?: string };
            } catch {
              // trame illisible : ignorée
            }
            buf = buf.subarray(8 + len);
            if (op === 1 && body.evt === 'READY') {
              clearTimeout(t);
              resolve(true);
            }
            if (op === 2) {
              clearTimeout(t);
              resolve(false);
            }
          }
        });
        s.once('error', () => resolve(false));
        s.once('close', () => resolve(false));
        s.write(frame(0, { v: 1, client_id: this.clientId }));
      });
      if (!ok) {
        s.destroy();
        continue;
      }
      this.socket = s;
      this.ready = true;
      s.once('close', () => {
        if (this.socket !== s) return;
        this.socket = null;
        this.ready = false;
        this.setStatus('unavailable');
      });
      s.on('error', () => {});
      this.setStatus('connected');
      return true;
    }
    return false;
  }
}
