import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

const TAG = 16;
export const NONCE_BYTES = 12;

/** Dérive une clé de 32 octets. `info` sépare les usages d'une même clé source. */
export function deriveKey(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, info, 32));
}

// AES-256-GCM plutôt que ChaCha20-Poly1305 : la build Node d'Electron (BoringSSL)
// n'expose pas ChaCha20, et AES est accéléré par le processeur (AES-NI).
const CIPHER = 'aes-256-gcm';

/** AES-256-GCM. Renvoie chiffré + tag. Ne jamais réutiliser un nonce avec la même clé. */
export function seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Uint8Array {
  const c = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG });
  c.setAAD(aad);
  return new Uint8Array(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
}

/** Lève une erreur si le message a été modifié ou si la clé est fausse. */
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array {
  if (sealed.length < TAG) throw new Error('Message chiffré trop court');
  const body = sealed.subarray(0, sealed.length - TAG);
  const d = createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG });
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
}
