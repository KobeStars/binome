// Messages entre les deux moteurs, toujours à l'intérieur du canal chiffré.

export const PEER_PROTOCOL_VERSION = 1;

/** Données de fichier par trame. Reste sous la limite de message SCTP avec les en-têtes. */
export const DATA_CHUNK = 60 * 1024;

export type PeerMessage =
  | { t: 'hello'; v: number; name: string }
  | { t: 'ping' }
  | { t: 'pong' }
  /** Envoi direct : l'émetteur propose un fichier. */
  | { t: 'offer'; id: string; name: string; size: number; sha256: string }
  /** Le destinataire indique à partir d'où envoyer (reprise). */
  | { t: 'accept'; id: string; offset: number }
  | { t: 'end'; id: string }
  | { t: 'done'; id: string }
  | { t: 'failed'; id: string; reason: string }
  | { t: 'cancel'; id: string }
  // Synchro du dossier partagé
  /** Index complet, envoyé par lots à chaque connexion. */
  | { t: 'sync.index'; entries: SyncEntry[]; last: boolean }
  /** Un fichier a changé (ou a été supprimé) depuis l'index. */
  | { t: 'sync.announce'; entry: SyncEntry }
  | { t: 'sync.wantManifest'; hash: string }
  /** Manifeste binaire (base64) découpé en morceaux. */
  | { t: 'sync.manifest'; hash: string; part: number; parts: number; data: string }
  | { t: 'sync.noManifest'; hash: string }
  /** Blocs demandés pour reconstruire `file` (attribution de la progression côté émetteur). */
  | { t: 'sync.wantChunks'; file: string; path: string; hashes: string[] }
  | { t: 'sync.noChunk'; hash: string }
  // Chat
  | { t: 'chat'; id: string; text: string; file: string | null; at: number; via?: 'claude' }
  | { t: 'chat.ack'; id: string };

/** Version d'un fichier telle qu'elle circule entre les deux appareils. */
export interface SyncEntry {
  /** Chemin relatif, séparateur /. */
  p: string;
  /** SHA-256 du fichier, null si supprimé. */
  h: string | null;
  /** Taille en octets. */
  s: number;
  /** Vecteur de version. */
  v: Record<string, number>;
  /** 1 si supprimé. */
  d: 0 | 1;
  /** Date de la version chez son auteur (ms), sert seulement à départager un conflit. */
  m: number;
  /** Appareil auteur de la version. */
  b: string;
  /** 1 si la version a été faite par Claude. */
  c?: 1;
}

/** Messages de signalisation WebRTC, passés en JSON dans `signal.data`. */
export type SignalPayload =
  | { k: 'sdp'; a: string; type: 'offer' | 'answer'; sdp: string; sig: string }
  | { k: 'ice'; a: string; candidate: string; mid: string }
  /** Le meneur abandonne le P2P pour cette tentative et passe par le relais. */
  | { k: 'relay'; a: string };

const KIND_JSON = 1;
const KIND_DATA = 2;
const KIND_CHUNK = 3;
const ID_BYTES = 16;
const HASH_BYTES = 32;

export type Inner =
  | { kind: 'msg'; msg: PeerMessage }
  | { kind: 'data'; id: string; offset: number; bytes: Uint8Array }
  /** Morceau d'un bloc du magasin (un bloc peut dépasser la taille d'une trame). */
  | { kind: 'chunk'; hash: Buffer; offset: number; total: number; bytes: Uint8Array };

/** Morceau de bloc : hash (32), offset (u32), taille totale du bloc (u32), données. */
export function encodeChunkPiece(hash: Uint8Array, offset: number, total: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + HASH_BYTES + 8 + bytes.length);
  out[0] = KIND_CHUNK;
  out.set(hash, 1);
  const view = new DataView(out.buffer);
  view.setUint32(1 + HASH_BYTES, offset);
  view.setUint32(1 + HASH_BYTES + 4, total);
  out.set(bytes, 1 + HASH_BYTES + 8);
  return out;
}

export function encodeMessage(msg: PeerMessage): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const out = new Uint8Array(1 + json.length);
  out[0] = KIND_JSON;
  out.set(json, 1);
  return out;
}

/** `id` : 32 caractères hexadécimaux. */
export function encodeData(id: string, offset: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + ID_BYTES + 8 + bytes.length);
  out[0] = KIND_DATA;
  out.set(Buffer.from(id, 'hex'), 1);
  new DataView(out.buffer).setBigUint64(1 + ID_BYTES, BigInt(offset));
  out.set(bytes, 1 + ID_BYTES + 8);
  return out;
}

export function decodeInner(frame: Uint8Array): Inner | null {
  if (frame[0] === KIND_JSON) {
    try {
      const msg = JSON.parse(new TextDecoder().decode(frame.subarray(1))) as PeerMessage;
      return typeof msg?.t === 'string' ? { kind: 'msg', msg } : null;
    } catch {
      return null;
    }
  }
  if (frame[0] === KIND_CHUNK && frame.length >= 1 + HASH_BYTES + 8) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    return {
      kind: 'chunk',
      hash: Buffer.from(frame.subarray(1, 1 + HASH_BYTES)),
      offset: view.getUint32(1 + HASH_BYTES),
      total: view.getUint32(1 + HASH_BYTES + 4),
      bytes: frame.subarray(1 + HASH_BYTES + 8),
    };
  }
  if (frame[0] === KIND_DATA && frame.length >= 1 + ID_BYTES + 8) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    return {
      kind: 'data',
      id: Buffer.from(frame.subarray(1, 1 + ID_BYTES)).toString('hex'),
      offset: Number(view.getBigUint64(1 + ID_BYTES)),
      bytes: frame.subarray(1 + ID_BYTES + 8),
    };
  }
  return null;
}
