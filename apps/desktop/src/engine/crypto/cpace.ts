// CPace sur ristretto255, d'après draft-irtf-cfrg-cpace.
// Écart assumé : les longueurs sont préfixées en u32 et non en LEB128.
// On ne cherche pas l'interopérabilité, seulement les propriétés du protocole :
// un attaquant actif n'a qu'un essai de mot de passe par exécution,
// un observateur passif n'apprend rien.

import { createHash, randomBytes } from 'node:crypto';
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { lvConcat, utf8 } from '@binome/protocol';

const Point = ristretto255.Point;
type Point = InstanceType<typeof Point>;
const ORDER = Point.Fn.ORDER;
const DSI = utf8('CPaceRistretto255');
const DSI_ISK = utf8('CPaceRistretto255_ISK');

export type Role = 'initiator' | 'responder';

export interface CPaceState {
  readonly role: Role;
  readonly sid: Uint8Array;
  readonly scalar: bigint;
  readonly share: Uint8Array;
}

function sha512(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha512').update(data).digest());
}

function randomScalar(): bigint {
  // 64 octets réduits modulo l'ordre : biais négligeable.
  for (;;) {
    const k = bytesToNumberLE(randomBytes(64)) % ORDER;
    if (k !== 0n) return k;
  }
}

function generator(password: Uint8Array, channel: Uint8Array, sid: Uint8Array): Point {
  return ristretto255_hasher.deriveToCurve!(sha512(lvConcat(DSI, password, channel, sid)));
}

/** Première moitié : calcule la part publique à envoyer à l'autre. */
export function cpaceStart(role: Role, password: Uint8Array, channel: Uint8Array, sid: Uint8Array): CPaceState {
  const scalar = randomScalar();
  const share = generator(password, channel, sid).multiply(scalar).toBytes();
  return { role, sid, scalar, share };
}

/**
 * Seconde moitié : combine la part reçue et renvoie la clé de session (64 octets).
 * Les deux côtés obtiennent la même clé seulement s'ils ont le même mot de passe.
 * Lève une erreur si la part reçue est invalide ou neutre.
 */
export function cpaceFinish(state: CPaceState, peerShare: Uint8Array): Uint8Array {
  const peer = Point.fromBytes(peerShare);
  const shared = peer.multiply(state.scalar);
  if (shared.is0()) throw new Error('Part CPace invalide');

  const [first, second] = state.role === 'initiator' ? [state.share, peerShare] : [peerShare, state.share];
  return sha512(lvConcat(DSI_ISK, state.sid, shared.toBytes(), first, second));
}
