// base64url sans dépendance, identique côté serveur et moteur.

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

export function fromB64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** Concatène des champs préfixés par leur longueur (u32 big-endian). */
export function lvConcat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
