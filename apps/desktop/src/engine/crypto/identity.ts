import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { fromB64, toB64 } from '@binome/protocol';

/** Clé Ed25519 propre à cet appareil, créée au premier lancement. */
export interface Identity {
  readonly publicKey: Uint8Array;
  sign(data: Uint8Array): Uint8Array;
  /** Clé privée en PKCS#8, à chiffrer avant de l'écrire sur disque. */
  exportPrivate(): Uint8Array;
}

function fromKey(privateKey: KeyObject): Identity {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = fromB64(jwk.x!);
  return {
    publicKey,
    sign: (data) => new Uint8Array(sign(null, data, privateKey)),
    exportPrivate: () => new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

export function generateIdentity(): Identity {
  return fromKey(generateKeyPairSync('ed25519').privateKey);
}

export function loadIdentity(pkcs8: Uint8Array): Identity {
  return fromKey(createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' }));
}

export function verifySignature(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: toB64(publicKey) }, format: 'jwk' });
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

/**
 * Code de vérification affiché des deux côtés après l'appairage, ex. « 4821 0937 ».
 * Identique chez les deux seulement si personne ne s'est interposé.
 */
export function safetyCode(pairId: string): string {
  const digest = createHash('sha256').update('binome-safety').update(pairId).digest();
  const n = digest.readUInt32BE(0) % 100_000_000;
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}
