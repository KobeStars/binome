import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** Argument passé au lancement automatique : l'app démarre dans la barre des tâches, sans fenêtre. */
export const HIDDEN_ARG = '--hidden';

/**
 * Lancement au démarrage de Windows. Seulement pour l'app installée : en développement,
 * on enregistrerait electron.exe dans le démarrage.
 */
export const autostart = {
  available: app.isPackaged,

  get(): boolean {
    if (!app.isPackaged) return false;
    return app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin;
  },

  set(on: boolean): void {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] });
  },

  /** Activé par défaut au premier lancement de l'app installée. */
  initOnce(): void {
    if (!app.isPackaged) return;
    const marker = join(app.getPath('userData'), 'autostart-init');
    if (existsSync(marker)) return;
    this.set(true);
    writeFileSync(marker, '');
  },
};
