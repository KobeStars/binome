// Messages entre les deux moteurs, toujours à l'intérieur du canal chiffré.
// Un type inconnu est ignoré par l'autre côté : une version plus ancienne reste compatible.

/** 2 : profil (statut, avatar), wizz, rapports de plantage. 3 : Bibliothèque. */
export const PEER_PROTOCOL_VERSION = 3;

/** Données de fichier par trame. Reste sous la limite de message SCTP avec les en-têtes. */
export const DATA_CHUNK = 60 * 1024;

export type StatusKind = 'available' | 'busy' | 'away';

/** Statut affiché chez l'autre : « En train de coder », « AFK »… */
export interface PeerStatus {
  kind: StatusKind;
  text: string;
}

export type PeerMessage =
  /** `app` : version de l'app, pour savoir ce que l'autre sait faire. */
  | { t: 'hello'; v: number; name: string; app?: string }
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
  /** « Envoie-moi ton index » : l'autre a choisi son dossier après l'ouverture de la connexion. */
  | { t: 'sync.wantIndex' }
  | { t: 'sync.wantManifest'; hash: string }
  /** Manifeste binaire (base64) découpé en morceaux. */
  | { t: 'sync.manifest'; hash: string; part: number; parts: number; data: string }
  | { t: 'sync.noManifest'; hash: string }
  /** Blocs demandés pour reconstruire `file` (attribution de la progression côté émetteur). */
  | { t: 'sync.wantChunks'; file: string; path: string; hashes: string[] }
  | { t: 'sync.noChunk'; hash: string }
  // Chat
  | { t: 'chat'; id: string; text: string; file: string | null; at: number; via?: 'claude' }
  | { t: 'chat.ack'; id: string }
  // Profil (protocole 2)
  /** Statut et avatar. `avatar` : image en base64, null pour l'enlever, absent s'il n'a pas changé. */
  | { t: 'profile'; status: PeerStatus | null; avatar?: string | null }
  /** Secoue la fenêtre de l'autre. */
  | { t: 'wizz' }
  // Rapports de plantage (protocole 2)
  | { t: 'crash'; id: string; at: number; app: string; kind: string; summary: string; log: string }
  | { t: 'crash.ack'; id: string }
  // Bibliothèque (protocole 3)
  /** Liste des apps publiées par l'émetteur, envoyée à chaque connexion avant leurs pages. */
  | { t: 'lib.catalog'; apps: string[] }
  /** Page d'une version, signée par son auteur (Ed25519, sur `releaseBytes`). */
  | { t: 'lib.release'; release: LibRelease; sig: string }
  | { t: 'lib.remove'; app: string }
  | { t: 'lib.wantManifest'; hash: string }
  | { t: 'lib.manifest'; hash: string; part: number; parts: number; data: string }
  | { t: 'lib.noManifest'; hash: string }
  /** Blocs demandés. Réponse : trames de type 4 (bloc compressé), ou `lib.noChunk`. */
  | { t: 'lib.wantChunks'; hashes: string[] }
  | { t: 'lib.noChunk'; hash: string }
  /** Avis sur une app de l'autre. `stars` 0 : avis retiré. */
  | { t: 'lib.review'; app: string; stars: number; text: string; at: number }
  /** Rapport de bug, avec capture d'écran (blob à demander par son hash). */
  | { t: 'lib.bug'; id: string; app: string; version: string; text: string; shot: LibMedia | null; at: number }
  | { t: 'lib.bug.ack'; id: string }
  /** L'auteur marque un rapport corrigé (ou le rouvre). */
  | { t: 'lib.bug.status'; id: string; status: 'open' | 'fixed' }
  /** « Teste mon jeu ! » : demande valable jusqu'à `expiresAt`. */
  | { t: 'lib.test'; id: string; app: string; version: string; expiresAt: number }
  | { t: 'lib.test.reply'; id: string; answer: 'yes' | 'no' }
  /** Idées et wishlist, communes aux deux. La plus récente (`updatedAt`) gagne. */
  | { t: 'lib.ideas'; ideas: LibIdea[] }
  /** `app` null : ne joue plus. */
  | { t: 'lib.playing'; app: string | null; name?: string; since?: number }
  | { t: 'lib.level'; xp: number };

export type AppCategory = 'game' | 'tool' | 'bot' | 'site' | 'other';

/** Image ou vidéo d'une page : fichier du magasin, demandé par son hash. */
export interface LibMedia {
  h: string;
  s: number;
  type: string;
}

/** Page d'une version d'app, figée à la publication. */
export interface LibRelease {
  /** Identifiant de l'app, 32 caractères hexadécimaux, le même pour toutes ses versions. */
  app: string;
  version: string;
  name: string;
  category: AppCategory;
  tags: string[];
  /** Markdown, rendu sans HTML. */
  description: string;
  requirements: string;
  /** Notes de version, Markdown. */
  notes: string;
  /** Exécutable de lancement, chemin relatif au paquet. */
  exe: string | null;
  icon: LibMedia | null;
  banner: LibMedia | null;
  gallery: LibMedia[];
  /** Hash de la liste des fichiers du paquet (blob du magasin). */
  files: string;
  size: number;
  count: number;
  at: number;
  via?: 'claude';
}

export interface LibIdea {
  id: string;
  kind: 'idea' | 'wish';
  text: string;
  /** Appareil auteur. */
  by: string;
  status: 'open' | 'doing' | 'done';
  app: string | null;
  updatedAt: number;
  deleted?: 1;
}

/** Octets signés d'une page : JSON aux clés triées, stable d'un appareil à l'autre. */
export function releaseBytes(r: LibRelease): Uint8Array {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return new TextEncoder().encode(`binome-release:${JSON.stringify(sort(r))}`);
}

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
const KIND_LIB_CHUNK = 4;
const ID_BYTES = 16;
const HASH_BYTES = 32;

export type Inner =
  | { kind: 'msg'; msg: PeerMessage }
  | { kind: 'data'; id: string; offset: number; bytes: Uint8Array }
  /** Morceau d'un bloc du magasin (un bloc peut dépasser la taille d'une trame). */
  | { kind: 'chunk'; hash: Buffer; offset: number; total: number; bytes: Uint8Array }
  /** Même chose pour la Bibliothèque : le bloc circule compressé (octet de mode + données). */
  | { kind: 'libchunk'; hash: Buffer; offset: number; total: number; bytes: Uint8Array };

/** Morceau de bloc : hash (32), offset (u32), taille totale du bloc (u32), données. */
export function encodeChunkPiece(hash: Uint8Array, offset: number, total: number, bytes: Uint8Array, lib = false): Uint8Array {
  const out = new Uint8Array(1 + HASH_BYTES + 8 + bytes.length);
  out[0] = lib ? KIND_LIB_CHUNK : KIND_CHUNK;
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
  if ((frame[0] === KIND_CHUNK || frame[0] === KIND_LIB_CHUNK) && frame.length >= 1 + HASH_BYTES + 8) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    return {
      kind: frame[0] === KIND_CHUNK ? 'chunk' : 'libchunk',
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
