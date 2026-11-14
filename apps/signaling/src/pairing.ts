import { randomBytes, randomInt } from 'node:crypto';
import { NAMEPLATE_DIGITS, PAIRING_TTL_MS, toB64, type PairCloseReason } from '@binome/protocol';
import { Bucket, type Conn } from './conn.ts';

/** Messages CPace et identité : 2 par côté suffisent, on laisse de la marge. */
const MAX_PAIR_MESSAGES = 8;
const NAMEPLATE_SLOTS = 10 ** NAMEPLATE_DIGITS;

export interface PairingSession {
  nameplate: string;
  creator: Conn;
  joiner: Conn | null;
  sid: string;
  messages: number;
  done: Set<Conn>;
  timer: NodeJS.Timeout;
}

/**
 * Rendez-vous d'appairage. Le serveur ne connaît que les premiers chiffres du code
 * (le nameplate). Le reste sert de mot de passe CPace entre les deux moteurs.
 */
export class Pairings {
  private readonly open = new Map<string, PairingSession>();
  private readonly limits = new Map<string, Bucket>();

  /** `perMinute` créations ou essais de code par minute et par IP. */
  constructor(private readonly perMinute = 10) {}

  private allowed(ip: string): boolean {
    let bucket = this.limits.get(ip);
    if (!bucket) {
      bucket = new Bucket(this.perMinute / 60, this.perMinute);
      this.limits.set(ip, bucket);
    }
    return bucket.take();
  }

  create(conn: Conn): void {
    if (!this.allowed(conn.ip)) return conn.error('rate-limited', 'Trop de tentatives, réessaie dans une minute');
    if (conn.pairing) this.close(conn.pairing, 'failed');
    if (this.open.size >= NAMEPLATE_SLOTS) return conn.error('full', 'Trop d’appairages en cours');

    let nameplate: string;
    do {
      nameplate = String(randomInt(NAMEPLATE_SLOTS)).padStart(NAMEPLATE_DIGITS, '0');
    } while (this.open.has(nameplate));

    const session: PairingSession = {
      nameplate,
      creator: conn,
      joiner: null,
      sid: toB64(randomBytes(16)),
      messages: 0,
      done: new Set(),
      timer: setTimeout(() => this.close(session, 'expired'), PAIRING_TTL_MS),
    };
    this.open.set(nameplate, session);
    conn.pairing = session;
    conn.send({ t: 'pair.created', nameplate, expiresAt: Date.now() + PAIRING_TTL_MS });
  }

  join(conn: Conn, nameplate: string): void {
    if (!this.allowed(conn.ip)) return conn.error('rate-limited', 'Trop de tentatives, réessaie dans une minute');
    const session = this.open.get(nameplate);
    if (!session || session.creator === conn) return conn.error('unknown-code', 'Code inconnu ou expiré');

    // Usage unique : le code disparaît dès qu'il est utilisé, bon ou mauvais.
    this.open.delete(nameplate);
    if (conn.pairing) this.close(conn.pairing, 'failed');
    session.joiner = conn;
    conn.pairing = session;
    session.creator.send({ t: 'pair.peer', sid: session.sid, role: 'initiator' });
    conn.send({ t: 'pair.peer', sid: session.sid, role: 'responder' });
  }

  forward(conn: Conn, data: string): void {
    const session = conn.pairing;
    const other = session && (session.creator === conn ? session.joiner : session.creator);
    if (!session || !other) return conn.error('no-pairing', 'Aucun appairage en cours');
    if (++session.messages > MAX_PAIR_MESSAGES) return this.close(session, 'failed');
    other.send({ t: 'pair.msg', data });
  }

  done(conn: Conn): void {
    const session = conn.pairing;
    if (!session?.joiner) return conn.error('no-pairing', 'Aucun appairage en cours');
    session.done.add(conn);
    if (session.done.size === 2) this.close(session, 'done');
  }

  fail(conn: Conn): void {
    if (conn.pairing) this.close(conn.pairing, 'failed');
  }

  left(conn: Conn): void {
    if (conn.pairing) this.close(conn.pairing, 'peer-left', conn);
  }

  private close(session: PairingSession, reason: PairCloseReason, gone?: Conn): void {
    clearTimeout(session.timer);
    if (this.open.get(session.nameplate) === session) this.open.delete(session.nameplate);
    for (const c of [session.creator, session.joiner]) {
      if (!c || c.pairing !== session) continue;
      c.pairing = null;
      if (c !== gone) c.send({ t: 'pair.closed', reason });
    }
  }

  /** Oublie les compteurs pleins pour ne pas grossir indéfiniment. */
  sweep(): void {
    for (const [ip, bucket] of this.limits) if (bucket.full()) this.limits.delete(ip);
  }
}
