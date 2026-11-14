import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, type WebContents } from 'electron';
import updaterPkg from 'electron-updater';
import type { GuardStore } from './guard-store.ts';
import {
  isPrerelease,
  parsePublishRepo,
  previousVersion,
  skipVersion,
  unskipVersion,
  type Channel,
} from './update-guard.ts';

// electron-updater est en CommonJS : import par défaut depuis un module ESM.
const { autoUpdater } = updaterPkg;

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  /** À jour. */
  | { state: 'latest' }
  /** `rollback` : retour à une version précédente. */
  | { state: 'downloading'; version: string; percent: number; rollback?: boolean }
  | { state: 'ready'; version: string; rollback?: boolean }
  /** Version dont on est revenu : pas réinstallée sans accord. */
  | { state: 'skipped'; version: string }
  | { state: 'error'; message: string };

export interface UpdateInfo {
  /** App installée avec une config de publication : les mises à jour fonctionnent. */
  enabled: boolean;
  current: string;
  channel: Channel;
  /** Dernière version saine lancée avant celle-ci : on peut y revenir. */
  previous: string | null;
  status: UpdateStatus;
}

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 10_000;

/**
 * Vérifie les releases GitHub au démarrage puis toutes les 4 heures, télécharge en arrière-plan
 * et prévient l'interface quand la version est prête. Canal bêta : les versions « 0.2.0-beta.1 »
 * arrivent aussi. Retour en arrière : réinstalle la version précédente depuis sa release.
 * Inactif en développement et dans un build sans config de publication.
 */
export class Updater {
  private status: UpdateStatus = { state: 'idle' };
  private readonly views = new Set<WebContents>();
  private started = false;
  private rollingBack = false;

  constructor(private readonly store: GuardStore) {}

  /**
   * Vrai si l'app a été construite avec une config de publication : electron-builder
   * écrit alors app-update.yml (dépôt GitHub, ou serveur local pour les tests).
   */
  static enabled(): boolean {
    return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'));
  }

  /** Dépôt GitHub de publication, null pour un serveur de test. */
  private repo(): { owner: string; repo: string } | null {
    try {
      return parsePublishRepo(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'));
    } catch {
      return null;
    }
  }

  start(): void {
    if (!Updater.enabled()) return;
    this.started = true;
    // Téléchargement à la main : une version dont on est revenu ne doit pas se réinstaller.
    autoUpdater.autoDownload = false;
    // Installeur complet uniquement, pas d'installeur web.
    autoUpdater.disableWebInstaller = true;
    autoUpdater.autoInstallOnAppQuit = true;
    this.applyChannel();

    autoUpdater.on('checking-for-update', () => {
      if (this.quiet()) this.set({ state: 'checking' });
    });
    autoUpdater.on('update-not-available', () => {
      if (this.quiet()) this.set({ state: 'latest' });
    });
    autoUpdater.on('update-available', (info) => {
      if (!this.rollingBack && this.store.state.skip.includes(info.version)) {
        this.set({ state: 'skipped', version: info.version });
        return;
      }
      this.set({ state: 'downloading', version: info.version, percent: 0, ...(this.rollingBack ? { rollback: true } : {}) });
      autoUpdater.downloadUpdate().catch((err: unknown) => this.fail(err));
    });
    autoUpdater.on('download-progress', (p) => {
      if (this.status.state === 'downloading') this.set({ ...this.status, percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      autoUpdater.autoInstallOnAppQuit = true;
      if (this.rollingBack) {
        this.set({ state: 'ready', version: info.version, rollback: true });
        // Retour en arrière demandé : on installe tout de suite. Le moteur est arrêté par `before-quit`.
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
        return;
      }
      this.set({ state: 'ready', version: info.version });
    });
    autoUpdater.on('error', (err) => this.fail(err));

    setTimeout(() => this.check(), FIRST_CHECK_MS);
    setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  attach(view: WebContents): void {
    this.views.add(view);
    view.once('destroyed', () => this.views.delete(view));
    view.send('update-status', this.status);
  }

  info(): UpdateInfo {
    const current = app.getVersion();
    const canRollBack = Updater.enabled() && this.repo() !== null;
    return {
      enabled: Updater.enabled(),
      current,
      channel: this.store.state.channel,
      previous: canRollBack ? previousVersion(this.store.state, current) : null,
      status: this.status,
    };
  }

  check(): void {
    if (!this.started || this.rollingBack) return;
    if (this.status.state === 'ready' || this.status.state === 'downloading') return;
    // Les erreurs passent aussi par l'événement `error`.
    autoUpdater.checkForUpdates().catch(() => {});
  }

  setChannel(channel: Channel): UpdateInfo {
    this.store.update((s) => ({ ...s, channel }));
    if (this.started && !this.rollingBack) {
      // Retour au canal stable avec une bêta déjà téléchargée : elle ne s'installe plus en quittant.
      if (channel === 'stable' && this.status.state === 'ready' && isPrerelease(this.status.version)) {
        autoUpdater.autoInstallOnAppQuit = false;
        this.set({ state: 'idle' });
      }
      this.applyChannel();
      this.check();
    }
    return this.info();
  }

  /** Redémarre sur la nouvelle version. Le moteur est arrêté par `before-quit`. */
  install(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall(true, true);
  }

  /**
   * Revient à la dernière version saine : télécharge son installeur depuis sa release GitHub
   * et l'installe. La version actuelle est mise de côté pour ne pas revenir toute seule.
   */
  async rollback(): Promise<void> {
    const current = app.getVersion();
    const target = previousVersion(this.store.state, current);
    const repo = this.repo();
    if (!this.started || !target || !repo) throw new Error('Aucune version précédente disponible');
    if (this.rollingBack) return;
    this.rollingBack = true;
    this.store.update((s) => skipVersion(s, current));
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `https://github.com/${repo.owner}/${repo.repo}/releases/download/v${target}`,
      // Publiée sur GitHub, une release porte toujours latest.yml, bêta comprise (vérifié sur v0.2.0-beta.1).
      channel: 'latest',
    });
    autoUpdater.allowDowngrade = true;
    autoUpdater.disableDifferentialDownload = true;
    this.set({ state: 'downloading', version: target, percent: 0, rollback: true });
    await autoUpdater.checkForUpdates().catch(() => {});
  }

  /** Installe quand même une version dont on était revenu. */
  installSkipped(): void {
    if (this.status.state !== 'skipped') return;
    const version = this.status.version;
    this.store.update((s) => unskipVersion(s, version));
    this.set({ state: 'idle' });
    this.check();
  }

  private applyChannel(): void {
    autoUpdater.allowPrerelease = this.store.state.channel === 'beta';
    // Jamais de retour en arrière automatique, même sur le canal bêta.
    autoUpdater.allowDowngrade = false;
  }

  /** Après un retour en arrière raté : on revient aux releases GitHub du dépôt. */
  private restoreFeed(): void {
    const repo = this.repo();
    if (repo) autoUpdater.setFeedURL({ provider: 'github', owner: repo.owner, repo: repo.repo });
    autoUpdater.disableDifferentialDownload = false;
    this.applyChannel();
  }

  /** Une vérification de fond ne cache pas un téléchargement ou une version prête. */
  private quiet(): boolean {
    return !this.rollingBack && this.status.state !== 'downloading' && this.status.state !== 'ready';
  }

  private fail(err: unknown): void {
    console.error('mise à jour :', err);
    if (this.rollingBack) {
      this.rollingBack = false;
      this.restoreFeed();
      this.set({ state: 'error', message: 'Retour à la version précédente impossible pour l’instant' });
      return;
    }
    // Une version déjà prête reste installable même si une vérification suivante échoue.
    if (this.status.state !== 'ready') this.set({ state: 'error', message: 'Vérification des mises à jour impossible' });
  }

  private set(status: UpdateStatus): void {
    this.status = status;
    for (const view of this.views) view.send('update-status', status);
  }
}
