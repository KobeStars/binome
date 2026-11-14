// Chiffrement de bout en bout sur n'importe quel transport (WebRTC, relais, LAN).
// Poignée de main : chaque côté envoie une clé X25519 éphémère signée par sa clé
// d'identité. Les clés de session en découlent, une par sens.

import { createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { fromB64, lvConcat, toB64, utf8 } from '@binome/protocol';
import { deriveKey, NONCE_BYTES, open, seal } from './aead.ts';
import { verifySignature, type Identity } from './identity.ts';
import type { Route, Transport } from '../net/transport.ts';

const MAGIC = utf8('BNM1');
const PUB = 32;
const SIG = 64;
const HELLO_BYTES = MAGIC.length + PUB + SIG;
const COUNTER = 8;
const EMPTY = new Uint8Array(0);

function helloPayload(eph: Uint8Array, identity: Uint8Array): Uint8Array {
  return lvConcat(utf8('binome-session-v1'), eph, identity);
}

function nonceFor(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setBigUint64(NONCE_BYTES - 8, counter);
  return nonce;
}

/** Canal chiffré et authentifié au-dessus d'un transport. */
export class SecureChannel {
  private sendCounter = 0n;
  private recvCounter = 0n;
  private listener: ((plain: Uint8Array) => void) | null = null;
  private queued: Uint8Array[] = [];

  constructor(
    readonly transport: Transport,
    private readonly sendKey: Uint8Array,
    private readonly recvKey: Uint8Array,
  ) {}

  route(): Route {
    return this.transport.route();
  }

  send(plain: Uint8Array): void {
    const counter = this.sendCounter++;
    const sealed = seal(this.sendKey, nonceFor(counter), plain, EMPTY);
    const frame = new Uint8Array(COUNTER + sealed.length);
    new DataView(frame.buffer).setBigUint64(0, counter);
    frame.set(sealed, COUNTER);
    this.transport.send(frame);
  }

  drain(): Promise<void> {
    return this.transport.drain();
  }

  onMessage(fn: (plain: Uint8Array) => void): void {
    this.listener = fn;
    const queued = this.queued;
    this.queued = [];
    for (const m of queued) fn(m);
  }

  onClose(fn: () => void): void {
    this.transport.onClose(fn);
  }

  close(): void {
    this.transport.close();
  }

  /** Appelé par la poignée de main pour chaque trame chiffrée reçue. */
  receive(frame: Uint8Array): void {
    if (frame.length < COUNTER) return this.close();
    const counter = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0);
    // Transport fiable et ordonné : tout trou ou rejeu est une attaque ou un bug.
    if (counter !== this.recvCounter) return this.close();
    let plain: Uint8Array;
    try {
      plain = open(this.recvKey, nonceFor(counter), frame.subarray(COUNTER), EMPTY);
    } catch {
      return this.close();
    }
    this.recvCounter++;
    if (this.listener) this.listener(plain);
    else this.queued.push(plain);
  }
}

/**
 * Établit le canal chiffré. `leader` : le côté dont la clé publique est la plus petite,
 * les deux côtés le calculent de la même façon.
 */
export function handshake(
  transport: Transport,
  identity: Identity,
  peerPub: Uint8Array,
  leader: boolean,
  timeoutMs = 10_000,
): Promise<SecureChannel> {
  const eph = generateKeyPairSync('x25519');
  const ephPub = fromB64(eph.publicKey.export({ format: 'jwk' }).x!);

  const hello = new Uint8Array(HELLO_BYTES);
  hello.set(MAGIC, 0);
  hello.set(ephPub, MAGIC.length);
  hello.set(identity.sign(helloPayload(ephPub, identity.publicKey)), MAGIC.length + PUB);

  return new Promise((resolve, reject) => {
    let channel: SecureChannel | null = null;
    const timer = setTimeout(() => {
      transport.close();
      reject(new Error('Poignée de main expirée'));
    }, timeoutMs);
    transport.onClose(() => {
      clearTimeout(timer);
      if (!channel) reject(new Error('Transport fermé pendant la poignée de main'));
    });

    transport.onFrame((frame) => {
      if (channel) return channel.receive(frame);

      const peerEph = frame.subarray(MAGIC.length, MAGIC.length + PUB);
      const sig = frame.subarray(MAGIC.length + PUB, HELLO_BYTES);
      if (
        frame.length !== HELLO_BYTES ||
        !MAGIC.every((b, i) => frame[i] === b) ||
        !verifySignature(peerPub, helloPayload(peerEph, peerPub), sig)
      ) {
        clearTimeout(timer);
        transport.close();
        return reject(new Error('Poignée de main invalide'));
      }

      const shared = diffieHellman({
        privateKey: eph.privateKey,
        publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: toB64(peerEph) }, format: 'jwk' }),
      });
      const salt = leader ? lvConcat(ephPub, peerEph) : lvConcat(peerEph, ephPub);
      const toFollower = deriveKey(shared, salt, 'binome-session leader->follower');
      const toLeader = deriveKey(shared, salt, 'binome-session follower->leader');
      channel = leader
        ? new SecureChannel(transport, toFollower, toLeader)
        : new SecureChannel(transport, toLeader, toFollower);
      clearTimeout(timer);
      resolve(channel);
    });

    transport.send(hello);
  });
}
