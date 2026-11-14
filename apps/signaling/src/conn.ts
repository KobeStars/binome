import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { toB64, type ServerMessage, type ErrorCode } from '@binome/protocol';
import type { PairingSession } from './pairing.ts';

/** Seau à jetons : `rate` jetons par seconde, `burst` au maximum. */
export class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }
  full(): boolean {
    this.refill();
    return this.tokens >= this.burst;
  }
  take(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Une connexion WebSocket d'un moteur. */
export class Conn {
  readonly nonce = toB64(randomBytes(32));
  readonly messages = new Bucket(100, 200);
  /** Trames du relais : jusqu'à ~60 Mo/s avec des trames de 64 Kio. */
  readonly frames = new Bucket(1000, 2000);
  alive = true;
  /** Lecture suspendue parce que l'autre côté du relais est en retard. */
  paused = false;
  pairing: PairingSession | null = null;
  room: { pairId: string; pub: string } | null = null;

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
  ) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  error(code: ErrorCode, message: string): void {
    this.send({ t: 'error', code, message });
  }
}
