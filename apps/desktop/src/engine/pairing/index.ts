import { randomInt } from 'node:crypto';
import {
  NAMEPLATE_DIGITS,
  PASSWORD_DIGITS,
  authPayload,
  fromB64,
  lvConcat,
  pairIdOf,
  toB64,
  utf8,
} from '@binome/protocol';
import { cpaceFinish, cpaceStart, type Role } from '../crypto/cpace.ts';
import { deriveKey, NONCE_BYTES, open, seal } from '../crypto/aead.ts';
import { safetyCode, verifySignature, type Identity } from '../crypto/identity.ts';
import { SignalingError, type SignalingClient } from '../net/signaling.ts';

export const CODE_DIGITS = NAMEPLATE_DIGITS + PASSWORD_DIGITS;
const STEP_TIMEOUT_MS = 15_000;
const MAX_NAME = 40;

/** Ce qu'on garde de l'autre appareil après l'appairage. */
export interface PeerRecord {
  pairId: string;
  peerPub: string;
  peerName: string;
  safetyCode: string;
  pairedAt: number;
}

export interface Me {
  identity: Identity;
  name: string;
}

export type PairingFailure =
  | 'wrong-code'
  | 'unknown-code'
  | 'expired'
  | 'peer-left'
  | 'rate-limited'
  | 'network'
  | 'internal';

export class PairingError extends Error {
  constructor(
    readonly reason: PairingFailure,
    message: string,
  ) {
    super(message);
  }
}

/** « 482913 » → « 482 913 » pour l'affichage. */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function toPairingError(err: unknown): PairingError {
  if (err instanceof PairingError) return err;
  if (err instanceof SignalingError) {
    if (err.code === 'unknown-code') return new PairingError('unknown-code', 'Code inconnu ou expiré');
    if (err.code === 'rate-limited') return new PairingError('rate-limited', err.message);
    return new PairingError('network', 'Connexion au serveur interrompue');
  }
  // Bug local (crypto, disque) : on le trace au lieu de le faire passer pour une coupure réseau.
  console.error('appairage :', err);
  return new PairingError('internal', 'Appairage impossible, erreur interne');
}

/**
 * Côté qui affiche le code. `onCode` reçoit les 6 chiffres à montrer.
 * Se termine quand l'autre a tapé le code et que l'échange a réussi.
 */
export async function createPairing(
  sig: SignalingClient,
  me: Me,
  onCode: (code: string, expiresAt: number) => void,
): Promise<PeerRecord> {
  try {
    sig.send({ t: 'pair.create' });
    const created = await sig.waitFor(['pair.created'], STEP_TIMEOUT_MS);
    const password = String(randomInt(10 ** PASSWORD_DIGITS)).padStart(PASSWORD_DIGITS, '0');
    onCode(created.nameplate + password, created.expiresAt);

    const peer = await sig.waitFor(['pair.peer', 'pair.closed'], created.expiresAt - Date.now());
    if (peer.t === 'pair.closed') throw closedError(peer.reason);
    return await exchange(sig, me, password, created.nameplate, peer.sid, 'initiator');
  } catch (err) {
    if (err instanceof SignalingError && err.code === 'timeout') {
      throw new PairingError('expired', 'Code expiré');
    }
    throw toPairingError(err);
  }
}

/** Côté qui tape le code. */
export async function joinPairing(sig: SignalingClient, me: Me, code: string): Promise<PeerRecord> {
  const digits = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${CODE_DIGITS}}$`).test(digits)) {
    throw new PairingError('unknown-code', `Le code fait ${CODE_DIGITS} chiffres`);
  }
  const nameplate = digits.slice(0, NAMEPLATE_DIGITS);
  const password = digits.slice(NAMEPLATE_DIGITS);

  try {
    sig.send({ t: 'pair.join', nameplate });
    const peer = await sig.waitFor(['pair.peer', 'pair.closed'], STEP_TIMEOUT_MS);
    if (peer.t === 'pair.closed') throw closedError(peer.reason);
    return await exchange(sig, me, password, nameplate, peer.sid, 'responder');
  } catch (err) {
    throw toPairingError(err);
  }
}

function closedError(reason: string): PairingError {
  if (reason === 'expired') return new PairingError('expired', 'Code expiré');
  if (reason === 'failed') return new PairingError('wrong-code', 'Les codes ne correspondent pas');
  return new PairingError('peer-left', 'L’autre appareil s’est déconnecté');
}

async function nextPairMessage(sig: SignalingClient): Promise<Uint8Array> {
  const msg = await sig.waitFor(['pair.msg', 'pair.closed'], STEP_TIMEOUT_MS);
  if (msg.t === 'pair.closed') throw closedError(msg.reason);
  return fromB64(msg.data);
}

interface IdentityCard {
  pub: string;
  name: string;
  sig: string;
}

/**
 * CPace avec les 4 derniers chiffres, puis échange chiffré des clés d'identité.
 * Chaque côté signe la transcription : la clé reçue appartient bien à celui
 * qui a mené l'échange CPace.
 */
async function exchange(
  sig: SignalingClient,
  me: Me,
  password: string,
  nameplate: string,
  sidB64: string,
  role: Role,
): Promise<PeerRecord> {
  const sid = fromB64(sidB64);
  const channel = lvConcat(utf8('binome-pair-v1'), utf8(nameplate));

  const state = cpaceStart(role, utf8(password), channel, sid);
  sig.send({ t: 'pair.msg', data: toB64(state.share) });
  const peerShare = await nextPairMessage(sig);

  let isk: Uint8Array;
  try {
    isk = cpaceFinish(state, peerShare);
  } catch {
    sig.send({ t: 'pair.fail', reason: 'bad-share' });
    throw new PairingError('wrong-code', 'Échange invalide');
  }

  const [initShare, respShare] = role === 'initiator' ? [state.share, peerShare] : [peerShare, state.share];
  const transcript = lvConcat(utf8('binome-pair-confirm'), sid, initShare, respShare);
  const toResponder = deriveKey(isk, sid, 'binome-pair initiator->responder');
  const toInitiator = deriveKey(isk, sid, 'binome-pair responder->initiator');
  const [sendKey, recvKey] = role === 'initiator' ? [toResponder, toInitiator] : [toInitiator, toResponder];
  // Chaque clé ne chiffre qu'un message : un nonce nul suffit.
  const nonce = new Uint8Array(NONCE_BYTES);

  const card: IdentityCard = {
    pub: toB64(me.identity.publicKey),
    name: me.name.slice(0, MAX_NAME),
    sig: toB64(me.identity.sign(lvConcat(transcript, me.identity.publicKey))),
  };
  sig.send({ t: 'pair.msg', data: toB64(seal(sendKey, nonce, utf8(JSON.stringify(card)), sid)) });

  let peerCard: IdentityCard;
  try {
    const plain = open(recvKey, nonce, await nextPairMessage(sig), sid);
    peerCard = JSON.parse(new TextDecoder().decode(plain)) as IdentityCard;
  } catch (err) {
    if (err instanceof PairingError) throw err;
    // Déchiffrement impossible : les deux côtés n'ont pas le même mot de passe.
    sig.send({ t: 'pair.fail', reason: 'wrong-code' });
    throw new PairingError('wrong-code', 'Les codes ne correspondent pas');
  }

  const peerPub = fromB64(peerCard.pub);
  if (
    peerPub.length !== 32 ||
    typeof peerCard.name !== 'string' ||
    !verifySignature(peerPub, lvConcat(transcript, peerPub), fromB64(peerCard.sig))
  ) {
    sig.send({ t: 'pair.fail', reason: 'bad-card' });
    throw new PairingError('wrong-code', 'Identité de l’autre appareil invalide');
  }

  sig.send({ t: 'pair.done' });
  const closed = await sig.waitFor(['pair.closed'], STEP_TIMEOUT_MS);
  if (closed.reason !== 'done') throw closedError(closed.reason);

  const pairId = pairIdOf(me.identity.publicKey, peerPub);
  return {
    pairId,
    peerPub: peerCard.pub,
    peerName: peerCard.name.slice(0, MAX_NAME),
    safetyCode: safetyCode(pairId),
    pairedAt: Date.now(),
  };
}

/** Rejoint le salon de la paire sur le serveur. Renvoie si l'autre est en ligne. */
export async function authenticate(sig: SignalingClient, identity: Identity, peer: PeerRecord): Promise<boolean> {
  sig.send({
    t: 'auth',
    pub: toB64(identity.publicKey),
    peerPub: peer.peerPub,
    sig: toB64(identity.sign(authPayload(sig.nonce))),
  });
  const ok = await sig.waitFor(['auth.ok'], STEP_TIMEOUT_MS);
  if (ok.pairId !== peer.pairId) throw new Error('Le serveur a renvoyé un autre salon');
  return ok.peerOnline;
}
