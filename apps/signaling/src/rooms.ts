import { createPublicKey, verify } from 'node:crypto';
import { authPayload, fromB64, pairIdOf, toB64 } from '@binome/protocol';
import type { Conn } from './conn.ts';

const RELAY_HIGH_WATER = 4 * 1024 * 1024;
const RELAY_LOW_WATER = 1024 * 1024;

function verifyEd25519(pub: Uint8Array, data: Uint8Array, sig: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: toB64(pub) }, format: 'jwk' });
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}

/**
 * Salons des paires déjà appairées. Le serveur ne garde rien sur disque :
 * le pairId se recalcule à partir des deux clés publiques envoyées par le client,
 * et la signature du défi prouve que le client détient l'une d'elles.
 */
export class Rooms {
  private readonly rooms = new Map<string, Map<string, Conn>>();

  auth(conn: Conn, pubB64: string, peerPubB64: string, sigB64: string): void {
    const pub = fromB64(pubB64);
    const peerPub = fromB64(peerPubB64);
    const sig = fromB64(sigB64);
    if (pub.length !== 32 || peerPub.length !== 32 || pubB64 === peerPubB64) {
      return conn.error('bad-auth', 'Clés invalides');
    }
    if (!verifyEd25519(pub, authPayload(conn.nonce), sig)) {
      return conn.error('bad-auth', 'Signature invalide');
    }

    if (conn.room) this.leave(conn);
    const pairId = pairIdOf(pub, peerPub);
    let room = this.rooms.get(pairId);
    if (!room) {
      room = new Map();
      this.rooms.set(pairId, room);
    }

    // Même appareil reconnecté : l'ancienne connexion est fermée.
    const previous = room.get(pubB64);
    if (previous && previous !== conn) {
      previous.room = null;
      previous.ws.close(4001, 'replaced');
    }
    room.set(pubB64, conn);
    conn.room = { pairId, pub: pubB64 };

    const peer = room.get(peerPubB64);
    conn.send({ t: 'auth.ok', pairId, peerOnline: Boolean(peer) });
    peer?.send({ t: 'presence', online: true });
  }

  private peerOf(conn: Conn): Conn | undefined {
    if (!conn.room) return undefined;
    const room = this.rooms.get(conn.room.pairId);
    if (!room) return undefined;
    for (const [pub, c] of room) if (pub !== conn.room.pub) return c;
    return undefined;
  }

  signal(conn: Conn, data: string): void {
    if (!conn.room) return conn.error('not-authed', 'Authentification requise');
    const peer = this.peerOf(conn);
    if (!peer) return conn.error('peer-offline', 'L’autre appareil est hors ligne');
    peer.send({ t: 'signal', data });
  }

  /**
   * Relais de données : trames chiffrées de bout en bout, transmises telles quelles.
   * Si l'autre côté lit moins vite, on arrête de lire l'émetteur au lieu de tout garder en mémoire.
   */
  relay(conn: Conn, frame: Buffer): void {
    if (!conn.room) return conn.error('not-authed', 'Authentification requise');
    const peer = this.peerOf(conn);
    if (!peer) return;
    peer.ws.send(frame, { binary: true });
    if (!conn.paused && peer.ws.bufferedAmount > RELAY_HIGH_WATER) {
      conn.paused = true;
      conn.ws.pause();
      const check = setInterval(() => {
        if (peer.ws.readyState !== peer.ws.OPEN || peer.ws.bufferedAmount < RELAY_LOW_WATER) {
          clearInterval(check);
          conn.paused = false;
          conn.ws.resume();
        }
      }, 20);
    }
  }

  leave(conn: Conn): void {
    if (!conn.room) return;
    const { pairId, pub } = conn.room;
    const room = this.rooms.get(pairId);
    conn.room = null;
    if (!room || room.get(pub) !== conn) return;
    room.delete(pub);
    for (const peer of room.values()) peer.send({ t: 'presence', online: false });
    if (room.size === 0) this.rooms.delete(pairId);
  }

  get size(): number {
    return this.rooms.size;
  }
}
