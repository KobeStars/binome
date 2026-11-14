import { randomBytes } from 'node:crypto';
import {
  decodeInner,
  encodeData,
  encodeMessage,
  fromB64,
  toB64,
  type Inner,
  type PeerMessage,
  type SignalPayload,
} from '@binome/protocol';
import { handshake, type SecureChannel } from '../crypto/session.ts';
import type { Identity } from '../crypto/identity.ts';
import { DEFAULT_ICE_SERVERS, PeerAttempt } from './peer.ts';
import { RelayTransport } from './relay.ts';
import type { SignalingClient } from './signaling.ts';
import type { Route } from './transport.ts';

export interface LinkOptions {
  iceServers?: string[];
  /** Saute WebRTC, pour les tests et en dépannage. */
  forceRelay?: boolean;
  /** Délai avant de passer au relais. */
  p2pTimeoutMs?: number;
  /** Intervalle entre deux nouvelles tentatives de P2P quand on est sur le relais. */
  retryP2pMs?: number;
  /** Vrai pendant un transfert : on ne change pas de transport en plein milieu. */
  isBusy?: () => boolean;
}

export interface LinkEvents {
  route(route: Route | null): void;
  message(inner: Inner): void;
}

function parseSignal(data: string): SignalPayload | null {
  try {
    const p = JSON.parse(data) as SignalPayload;
    return typeof p?.k === 'string' && typeof p.a === 'string' ? p : null;
  } catch {
    return null;
  }
}

const PING_MS = 5_000;
const DEAD_MS = 15_000;

/**
 * Lien vers l'autre appareil, au-dessus d'une connexion au serveur déjà authentifiée.
 * Le meneur (clé publique la plus petite) propose WebRTC ; après `p2pTimeoutMs`
 * sans succès, il bascule les deux côtés sur le relais et réessaie le P2P plus tard.
 */
export class Link {
  readonly leader: boolean;
  private readonly peerPub: Uint8Array;
  private channel: SecureChannel | null = null;
  private attempt: PeerAttempt | null = null;
  private attemptId = '';
  private peerOnline = false;
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();
  private lastSeen = 0;
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly sig: SignalingClient,
    private readonly identity: Identity,
    peerPubB64: string,
    private readonly events: LinkEvents,
    private readonly opts: LinkOptions = {},
  ) {
    this.peerPub = fromB64(peerPubB64);
    this.leader = toB64(identity.publicKey) < peerPubB64;

    this.off.push(
      sig.on('presence', (m) => (m.online ? this.peerUp() : this.peerDown())),
      sig.on('signal', (m) => {
        const payload = parseSignal(m.data);
        if (payload) this.onSignal(payload);
      }),
      sig.onClose(() => this.stop()),
    );
    this.every(PING_MS, () => this.heartbeat());
  }

  get route(): Route | null {
    return this.channel?.route() ?? null;
  }

  /** À appeler après `auth.ok`. */
  start(peerOnline: boolean): void {
    // `presence` a pu arriver avant : ne pas relancer une tentative déjà partie.
    if (peerOnline && !this.peerOnline) this.peerUp();
  }

  send(msg: PeerMessage): boolean {
    if (!this.channel) return false;
    try {
      this.channel.send(encodeMessage(msg));
      return true;
    } catch {
      return false;
    }
  }

  sendData(id: string, offset: number, bytes: Uint8Array): void {
    if (!this.channel) throw new Error('Pas de canal');
    this.channel.send(encodeData(id, offset, bytes));
  }

  /** Trame déjà encodée (morceaux de blocs). */
  sendFrame(frame: Uint8Array): void {
    if (!this.channel) throw new Error('Pas de canal');
    this.channel.send(frame);
  }

  async drain(): Promise<void> {
    await this.channel?.drain();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const fn of this.off) fn();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.attempt?.abort();
    this.setChannel(null);
  }

  private peerUp(): void {
    this.peerOnline = true;
    if (this.leader && !this.channel) this.tryP2P();
  }

  private peerDown(): void {
    this.peerOnline = false;
    this.attempt?.abort();
    this.attempt = null;
    this.setChannel(null);
  }

  private sendSignal(payload: SignalPayload): void {
    if (this.sig.isOpen) this.sig.send({ t: 'signal', data: JSON.stringify(payload) });
  }

  private tryP2P(): void {
    if (this.stopped || !this.peerOnline) return;
    const id = toB64(randomBytes(9));
    this.attemptId = id;
    if (this.opts.forceRelay) return this.useRelay(id, true);

    this.attempt?.abort();
    const attempt = this.newAttempt(id);
    attempt.ready.then(
      (t) => this.secure(t, id),
      () => {
        // Le P2P a échoué : on passe au relais, sauf si un canal direct existe déjà.
        if (this.attemptId === id && this.channel?.route() !== 'lan' && this.channel?.route() !== 'internet') {
          if (!this.channel) this.useRelay(id, true);
          else this.scheduleRetry();
        }
      },
    );
  }

  private newAttempt(id: string): PeerAttempt {
    const attempt = new PeerAttempt({
      attempt: id,
      leader: this.leader,
      identity: this.identity,
      peerPub: this.peerPub,
      iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS,
      sendSignal: (p) => this.sendSignal(p),
      // Le suiveur attend plus longtemps : c'est le meneur qui décide du repli.
      timeoutMs: (this.opts.p2pTimeoutMs ?? 10_000) * (this.leader ? 1 : 1.5),
    });
    this.attempt = attempt;
    return attempt;
  }

  private onSignal(payload: SignalPayload): void {
    if (this.stopped) return;
    if (!this.leader && payload.k === 'sdp' && payload.type === 'offer' && payload.a !== this.attemptId) {
      this.attempt?.abort();
      this.attemptId = payload.a;
      const id = payload.a;
      this.newAttempt(id).ready.then(
        (t) => this.secure(t, id),
        () => {},
      );
    }
    if (!this.leader && payload.k === 'relay') {
      this.attempt?.abort();
      this.attempt = null;
      this.attemptId = payload.a;
      return this.useRelay(payload.a, false);
    }
    if (payload.a === this.attemptId) this.attempt?.handleSignal(payload);
  }

  private useRelay(id: string, announce: boolean): void {
    if (announce) this.sendSignal({ k: 'relay', a: id });
    this.secure(new RelayTransport(this.sig), id);
  }

  private secure(transport: RelayTransport | Awaited<PeerAttempt['ready']>, id: string): void {
    handshake(transport, this.identity, this.peerPub, this.leader).then(
      (channel) => {
        if (this.stopped || id !== this.attemptId) return channel.close();
        this.setChannel(channel);
      },
      () => {
        if (this.leader && this.attemptId === id && !this.channel) this.later(2_000, () => this.tryP2P());
      },
    );
  }

  private setChannel(channel: SecureChannel | null): void {
    const old = this.channel;
    if (old === channel) return;
    this.channel = channel;
    old?.close();

    if (channel) {
      this.lastSeen = Date.now();
      channel.onMessage((plain) => {
        this.lastSeen = Date.now();
        const inner = decodeInner(plain);
        if (!inner) return;
        if (inner.kind === 'msg' && inner.msg.t === 'ping') return void this.send({ t: 'pong' });
        if (inner.kind === 'msg' && inner.msg.t === 'pong') return;
        this.events.message(inner);
      });
      channel.onClose(() => {
        if (this.channel !== channel) return;
        this.channel = null;
        this.events.route(null);
        // Coupure (changement de réseau, veille) : le meneur relance.
        if (this.leader && this.peerOnline && !this.stopped) this.later(2_000, () => this.tryP2P());
      });
      if (channel.route() === 'relay') this.scheduleRetry();
    }
    if (!this.stopped || channel === null) this.events.route(channel?.route() ?? null);
  }

  /** Sur le relais, le meneur réessaie le P2P dès qu'aucun transfert n'est en cours. */
  private scheduleRetry(): void {
    if (!this.leader || this.opts.forceRelay) return;
    this.later(this.opts.retryP2pMs ?? 120_000, () => {
      if (this.channel?.route() !== 'relay') return;
      if (this.opts.isBusy?.()) return this.scheduleRetry();
      this.tryP2P();
    });
  }

  private heartbeat(): void {
    if (!this.channel) return;
    if (Date.now() - this.lastSeen > DEAD_MS) return this.channel.close();
    this.send({ t: 'ping' });
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    this.timers.add(t);
  }
}
