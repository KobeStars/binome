import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, type WebContents } from 'electron';
import updaterPkg from 'electron-updater';

// electron-updater est en CommonJS : import par défaut depuis un module ESM.
const { autoUpdater } = updaterPkg;

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 10_000;

/**
 * Vérifie les releases GitHub au démarrage puis toutes les 4 heures,
 * télécharge en arrière-plan et prévient l'interface quand la version est prête.
 * Inactif en développement et dans un build sans config de publication.
 */
export class Updater {
  private status: UpdateStatus = { state: 'idle' };
  private readonly views = new Set<WebContents>();

  /**
   * Vrai si l'app a été construite avec une config de publication : electron-builder
   * écrit alors app-update.yml (dépôt GitHub, ou serveur local pour les tests).
   */
  static enabled(): boolean {
    return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'));
  }

  start(): void {
    if (!Updater.enabled()) return;
    autoUpdater.autoDownload = true;
    // Installeur complet uniquement, pas d'installeur web.
    autoUpdater.disableWebInstaller = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => {
      if (this.status.state === 'downloading') this.set({ ...this.status, percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => {
      console.error('mise à jour :', err);
      // Une version déjà prête reste installable même si une vérification suivante échoue.
      if (this.status.state !== 'ready') this.set({ state: 'error', message: 'Vérification des mises à jour impossible' });
    });

    const check = () => {
      if (this.status.state === 'ready' || this.status.state === 'downloading') return;
      autoUpdater.checkForUpdates().catch(() => {});
    };
    setTimeout(check, FIRST_CHECK_MS);
    setInterval(check, CHECK_EVERY_MS);
  }

  attach(view: WebContents): void {
    this.views.add(view);
    view.once('destroyed', () => this.views.delete(view));
    view.send('update-status', this.status);
  }

  /** Redémarre sur la nouvelle version. Le moteur est arrêté par `before-quit`. */
  install(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall(true, true);
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    for (const view of this.views) view.send('update-status', status);
  }
}
