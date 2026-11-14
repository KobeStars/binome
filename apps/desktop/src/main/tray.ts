import { join } from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';

export interface TrayStatus {
  peer: string | null;
  online: boolean;
  syncing: boolean;
  /** Statut de l'autre, quand il est en ligne. */
  peerStatus: string | null;
}

export interface TrayActions {
  show(): void;
  openFolder(): void;
  wizz(): void;
  autostart: { get(): boolean; set(on: boolean): void; available: boolean };
  quit(): void;
}

/** Fichiers d'icônes : `resources/` en développement, à côté de l'app une fois installée. */
export function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name);
}

/** Icône dans la zone de notification : ouvrir, dossier partagé, démarrage auto, quitter. */
export class AppTray {
  private readonly tray: Tray;
  private status: TrayStatus = { peer: null, online: false, syncing: false, peerStatus: null };
  private folder: string | null = null;

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(nativeImage.createFromPath(resourcePath('tray.png')));
    this.tray.on('click', () => actions.show());
    this.refresh();
  }

  update(status: Partial<TrayStatus>): void {
    this.status = { ...this.status, ...status };
    this.refresh();
  }

  setFolder(folder: string | null): void {
    this.folder = folder;
    this.refresh();
  }

  private refresh(): void {
    const { peer, online, syncing, peerStatus } = this.status;
    const presence = online ? `${peer} en ligne${peerStatus ? ` · ${peerStatus}` : ''}` : `${peer} hors ligne`;
    const line = !peer ? 'Pas encore relié' : syncing ? 'Synchronisation en cours' : presence;
    // L'info-bulle de Windows est limitée à 127 caractères.
    this.tray.setToolTip(`Binôme · ${line}`.slice(0, 127));
    const { autostart } = this.actions;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: line, enabled: false },
        { type: 'separator' },
        { label: 'Ouvrir Binôme', click: () => this.actions.show() },
        { label: 'Ouvrir le dossier partagé', enabled: this.folder !== null, click: () => this.actions.openFolder() },
        { label: peer ? `Envoyer un wizz à ${peer}` : 'Envoyer un wizz', enabled: online, click: () => this.actions.wizz() },
        { type: 'separator' },
        {
          label: 'Lancer au démarrage de Windows',
          type: 'checkbox',
          enabled: autostart.available,
          checked: autostart.get(),
          click: (item) => {
            autostart.set(item.checked);
            this.refresh();
          },
        },
        { type: 'separator' },
        { label: 'Quitter', click: () => this.actions.quit() },
      ]),
    );
  }
}
