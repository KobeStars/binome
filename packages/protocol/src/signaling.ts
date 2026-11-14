// Messages JSON échangés entre le moteur et le serveur de signalisation.
// Le serveur ne voit jamais le mot de passe d'appairage ni les clés privées.

export const SIGNALING_VERSION = 1;

/** Taille maximale d'un message de contrôle, en octets. */
export const MAX_CONTROL_MESSAGE = 64 * 1024;

/** Taille maximale d'une trame binaire passant par le relais. */
export const MAX_RELAY_FRAME = 128 * 1024;

/** Durée de vie d'un code d'appairage. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Nombre de chiffres du code donnés au serveur pour le rendez-vous. */
export const NAMEPLATE_DIGITS = 2;
/** Nombre de chiffres gardés secrets, utilisés comme mot de passe CPace. */
export const PASSWORD_DIGITS = 4;

export type ClientMessage =
  | { t: 'pair.create' }
  | { t: 'pair.join'; nameplate: string }
  | { t: 'pair.msg'; data: string }
  | { t: 'pair.done' }
  | { t: 'pair.fail'; reason: string }
  | { t: 'auth'; pub: string; peerPub: string; sig: string }
  | { t: 'signal'; data: string };

export type ServerMessage =
  | { t: 'challenge'; nonce: string; v: number }
  | { t: 'pair.created'; nameplate: string; expiresAt: number }
  | { t: 'pair.peer'; sid: string; role: 'initiator' | 'responder' }
  | { t: 'pair.msg'; data: string }
  | { t: 'pair.closed'; reason: PairCloseReason }
  | { t: 'auth.ok'; pairId: string; peerOnline: boolean }
  | { t: 'presence'; online: boolean }
  | { t: 'signal'; data: string }
  | { t: 'error'; code: ErrorCode; message: string };

export type PairCloseReason = 'done' | 'failed' | 'expired' | 'peer-left';

export type ErrorCode =
  | 'bad-message'
  | 'unknown-code'
  | 'rate-limited'
  | 'full'
  | 'bad-auth'
  | 'not-authed'
  | 'no-pairing'
  | 'peer-offline';

/** Données signées par le client pour s'authentifier auprès du serveur. */
export function authPayload(nonce: string): Uint8Array {
  return new TextEncoder().encode(`binome-auth-v${SIGNALING_VERSION}:${nonce}`);
}

export function parseMessage<T>(raw: string): T | null {
  if (raw.length > MAX_CONTROL_MESSAGE) return null;
  try {
    const msg = JSON.parse(raw) as unknown;
    if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') {
      return null;
    }
    return msg as T;
  } catch {
    return null;
  }
}
