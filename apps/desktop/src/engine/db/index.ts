// Base SQLite du moteur (node:sqlite, intégré à Node et à Electron : pas de module natif).

import { DatabaseSync } from 'node:sqlite';

/** Base de la synchro (sync.sqlite). */
export const SYNC_MIGRATIONS: string[] = [
  // 1 : index des fichiers, manifestes, magasin de blocs
  `
  CREATE TABLE files (
    key        TEXT PRIMARY KEY,          -- chemin en minuscules : NTFS ignore la casse
    path       TEXT NOT NULL,             -- chemin relatif tel qu'affiché, séparateur /
    hash       TEXT,                      -- SHA-256 du fichier entier, NULL si supprimé
    size       INTEGER NOT NULL DEFAULT 0,
    mtime      INTEGER NOT NULL DEFAULT 0,-- mtime local (ms) : évite de rehacher un fichier inchangé
    vtime      INTEGER NOT NULL DEFAULT 0,-- date de la version chez son auteur, pour départager un conflit
    vv         TEXT NOT NULL,             -- vecteur de version, JSON { appareil: compteur }
    deleted    INTEGER NOT NULL DEFAULT 0,
    by         TEXT NOT NULL,             -- appareil auteur de la version
    changed_at INTEGER NOT NULL           -- horloge locale, pour l'affichage et la corbeille
  );
  CREATE INDEX files_changed ON files (changed_at);
  CREATE TABLE manifests (
    hash   TEXT PRIMARY KEY,              -- SHA-256 du fichier entier
    chunks BLOB NOT NULL                  -- suite de (32 octets de hash + u32 taille)
  );
  CREATE TABLE packs (
    id   INTEGER PRIMARY KEY,
    size INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE chunks (
    hash   BLOB PRIMARY KEY,              -- SHA-256 du bloc
    pack   INTEGER NOT NULL REFERENCES packs(id),
    offset INTEGER NOT NULL,
    length INTEGER NOT NULL
  );
  `,
  // 2 : historique des versions, conflits, âge des blocs pour le ramasse-miettes
  `
  CREATE TABLE versions (
    id   INTEGER PRIMARY KEY,
    key  TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,                   -- added, modified, deleted
    hash TEXT,                            -- NULL pour une suppression
    size INTEGER NOT NULL DEFAULT 0,
    by   TEXT NOT NULL,
    at   INTEGER NOT NULL                 -- horloge locale
  );
  CREATE INDEX versions_key ON versions (key, id);
  CREATE TABLE conflicts (
    id        INTEGER PRIMARY KEY,
    path      TEXT NOT NULL,              -- chemin qui garde la version gagnante
    aside     TEXT NOT NULL,              -- copie de la version mise de côté
    kept_by   TEXT NOT NULL,
    aside_by  TEXT NOT NULL,
    at        INTEGER NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE chunks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
  `,
  // 3 : versions faites par Claude
  `
  ALTER TABLE versions ADD COLUMN via TEXT;
  ALTER TABLE files ADD COLUMN via TEXT;
  `,
];

/** Base de l'app hors synchro (app.sqlite) : chat. */
export const APP_MIGRATIONS: string[] = [
  `
  CREATE TABLE chat (
    id      TEXT PRIMARY KEY,             -- identifiant aléatoire, sert à dédoublonner les renvois
    mine    INTEGER NOT NULL,             -- 1 si envoyé depuis ce PC
    text    TEXT NOT NULL,
    file    TEXT,                         -- fichier commenté (chemin relatif), facultatif
    at      INTEGER NOT NULL,             -- heure d'envoi chez l'auteur
    status  TEXT NOT NULL                 -- pending, sent (accusé reçu), received, read
  );
  CREATE INDEX chat_at ON chat (at);
  `,
  // 2 : actions de Claude
  `
  ALTER TABLE chat ADD COLUMN via TEXT;
  CREATE TABLE claude_log (
    id      INTEGER PRIMARY KEY,
    at      INTEGER NOT NULL,
    tool    TEXT NOT NULL,
    summary TEXT NOT NULL,
    outcome TEXT NOT NULL,                -- ok, refused, error
    detail  TEXT
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string, migrations: string[] = SYNC_MIGRATIONS): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

/** Exécute `fn` dans une transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
