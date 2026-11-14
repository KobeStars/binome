// État du garde-fou des mises à jour, enregistré dans updates.json (dossier de données de l'app).
// Écritures synchrones : un petit fichier, écrit au démarrage, à la fermeture et rarement entre les deux.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeGuard, type GuardState } from './update-guard.ts';

export class GuardStore {
  state: GuardState;

  constructor(private readonly path: string) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Premier lancement ou fichier abîmé : on repart de zéro.
    }
    this.state = normalizeGuard(raw);
  }

  update(fn: (s: GuardState) => GuardState): GuardState {
    this.state = fn(this.state);
    try {
      // Premier lancement : le dossier de données n'existe pas encore.
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error('updates.json :', err);
    }
    return this.state;
  }
}
