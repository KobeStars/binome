import { PeerConnection, cleanup, type DataChannel } from 'node-datachannel';
import { fromB64, lvConcat, toB64, utf8, type SignalPayload } from '@binome/protocol';
import { verifySignature, type Identity } from '../crypto/identity.ts';
import { BaseTransport, HIGH_WATER, LOW_WATER, type Route } from './transport.ts';

export const DEFAULT_ICE_SERVERS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

/** Adresses qui ne sortent pas du réseau local : RFC 1918, lien local, ULA, boucle. */
export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (/^(10|127)\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return a === '::1' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** Mêmes 64 premiers bits : même réseau local en IPv6. */
export function sameIpv6Prefix(a: string, b: string): boolean {
  if (!a.includes(':') || !b.includes(':')) return false;
  const prefix = (addr: string) => {
    const [head = '', tail = ''] = addr.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const full = addr.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
    return full.slice(0, 4).map((x) => parseInt(x || '0', 16)).join(':');
  };
  return prefix(a) === prefix(b);
}

/** Transport WebRTC : un DataChannel fiable et ordonné. */
export class PeerTransport extends BaseTransport {
  private drainWaiters: (() => void)[] = [];

  constructor(
    private readonly pc: PeerConnection,
    private readonly dc: DataChannel,
  ) {
    super();
    dc.setBufferedAmountLowThreshold(LOW_WATER);
    dc.onBufferedAmountLow(() => this.releaseDrain());
    dc.onMessage((msg) => {
      if (typeof msg === 'string') return;
      this.deliver(msg instanceof ArrayBuffer ? new Uint8Array(msg.slice(0)) : new Uint8Array(msg));
    });
    dc.onClosed(() => this.close());
    pc.onStateChange((state) => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') this.close();
    });
  }

  /**
   * Réseau local si l'adresse de l'autre est privée (IPv4) ou dans le même /64
   * que la nôtre (IPv6 : pas de NAT, les adresses locales sont publiques).
   */
  route(): Route {
    const pair = this.pc.getSelectedCandidatePair();
    if (!pair) return 'internet';
    const { local, remote } = pair;
    if (isPrivateAddress(remote.address)) return 'lan';
    return sameIpv6Prefix(local.address, remote.address) ? 'lan' : 'internet';
  }

  send(frame: Uint8Array): void {
    if (this.closed) throw new Error('Canal fermé');
    this.dc.sendMessageBinary(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  }

  drain(): Promise<void> {
    if (this.closed || this.dc.bufferedAmount() < HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private releaseDrain(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const fn of waiters) fn();
  }

  protected shutdown(): void {
    this.releaseDrain();
    try {
      this.dc.close();
    } catch {
      // déjà fermé
    }
    this.pc.close();
  }
}

export interface PeerAttemptOptions {
  /** Identifiant de la tentative, pour ignorer les messages d'une tentative précédente. */
  attempt: string;
  leader: boolean;
  identity: Identity;
  peerPub: Uint8Array;
  iceServers: string[];
  sendSignal(payload: SignalPayload): void;
  timeoutMs: number;
}

function sdpPayload(attempt: string, type: string, sdp: string): Uint8Array {
  return lvConcat(utf8('binome-sdp-v1'), utf8(attempt), utf8(type), utf8(sdp));
}

/**
 * Une tentative de connexion directe. Le meneur crée l'offre, l'autre répond.
 * Les descriptions SDP sont signées : elles contiennent l'empreinte DTLS,
 * le serveur ne peut donc pas s'interposer en la remplaçant.
 */
export class PeerAttempt {
  readonly ready: Promise<PeerTransport>;
  private readonly pc: PeerConnection;
  private remoteSet = false;
  private pendingCandidates: { candidate: string; mid: string }[] = [];
  private settled = false;
  private fail!: (err: Error) => void;

  constructor(private readonly opts: PeerAttemptOptions) {
    this.pc = new PeerConnection('binome', { iceServers: opts.iceServers });

    this.ready = new Promise<PeerTransport>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Connexion directe impossible')), opts.timeoutMs);
      this.fail = (err) => {
        if (this.settled) return;
        this.settled = true;
        clearTimeout(timer);
        this.pc.close();
        reject(err);
      };
      const opened = (dc: DataChannel) => {
        if (this.settled) return;
        this.settled = true;
        clearTimeout(timer);
        resolve(new PeerTransport(this.pc, dc));
      };

      this.pc.onLocalDescription((sdp, type) => {
        const kind = type.toLowerCase() as 'offer' | 'answer';
        opts.sendSignal({
          k: 'sdp',
          a: opts.attempt,
          type: kind,
          sdp,
          sig: toB64(opts.identity.sign(sdpPayload(opts.attempt, kind, sdp))),
        });
      });
      this.pc.onLocalCandidate((candidate, mid) => {
        opts.sendSignal({ k: 'ice', a: opts.attempt, candidate, mid });
      });
      this.pc.onStateChange((state) => {
        if (state === 'failed' || state === 'closed') this.fail(new Error('Connexion directe échouée'));
      });

      if (opts.leader) {
        const dc = this.pc.createDataChannel('binome');
        dc.onOpen(() => opened(dc));
      } else {
        this.pc.onDataChannel((dc) => {
          if (dc.isOpen()) opened(dc);
          else dc.onOpen(() => opened(dc));
        });
      }
    });
    // Évite un rejet non géré si personne n'attend la tentative.
    this.ready.catch(() => {});
  }

  handleSignal(payload: SignalPayload): void {
    if (this.settled || payload.a !== this.opts.attempt) return;
    if (payload.k === 'sdp') {
      const expected = this.opts.leader ? 'answer' : 'offer';
      if (
        payload.type !== expected ||
        !verifySignature(this.opts.peerPub, sdpPayload(payload.a, payload.type, payload.sdp), fromB64(payload.sig))
      ) {
        return this.fail(new Error('Description SDP non signée par l’ami'));
      }
      this.pc.setRemoteDescription(payload.sdp, payload.type === 'offer' ? 'offer' : 'answer');
      this.remoteSet = true;
      for (const c of this.pendingCandidates) this.pc.addRemoteCandidate(c.candidate, c.mid);
      this.pendingCandidates = [];
    } else if (payload.k === 'ice') {
      if (this.remoteSet) this.pc.addRemoteCandidate(payload.candidate, payload.mid);
      else this.pendingCandidates.push({ candidate: payload.candidate, mid: payload.mid });
    }
  }

  abort(): void {
    this.fail(new Error('Tentative annulée'));
  }
}

/** À appeler à la fermeture du moteur : libère les threads de libdatachannel. */
export function shutdownWebRTC(): void {
  cleanup();
}
