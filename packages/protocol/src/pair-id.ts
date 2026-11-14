import { createHash } from 'node:crypto';
import { toB64 } from './encoding.ts';

/** Identifiant d'une paire : SHA-256 des deux clés publiques Ed25519 triées. */
export function pairIdOf(a: Uint8Array, b: Uint8Array): string {
  const [first, second] = Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
  return toB64(createHash('sha256').update(first).update(second).digest());
}
