import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { UpdateInfo, UpdateStatus } from '../main/updater.ts';

// Le port vers le moteur est transmis à la page par window.postMessage :
// contextBridge ne sait pas faire passer un MessagePort.
ipcRenderer.on('engine-port', (e) => {
  window.postMessage('binome:engine-port', '*', e.ports);
});

/** `library:<id>` : page d'une app. */
export type NavigateTarget = 'chat' | 'crashes' | 'library' | `library:${string}`;

export type PickKind = 'source-file' | 'image' | 'media';

const api = {
  /** Chemin d'un fichier glissé dans la fenêtre. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('reveal', path),
  openInbox: (): Promise<void> => ipcRenderer.invoke('open-inbox'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('pick-files'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  /** Photo de profil recadrée et réduite (JPEG en base64), null si annulé. */
  pickAvatar: (): Promise<string | null> => ipcRenderer.invoke('pick-avatar'),
  openFolder: (path: string): Promise<void> => ipcRenderer.invoke('open-folder', path),
  /** Un fichier (exe à publier) ou des images et vidéos (pages de la Bibliothèque). */
  pickFile: (kind: PickKind, multiple = false): Promise<string[]> => ipcRenderer.invoke('pick-file', kind, multiple),
  /** Capture de l'écran principal, JPEG en base64 (rapport de bug). */
  captureScreen: (): Promise<string | null> => ipcRenderer.invoke('capture-screen'),
  /** Lien http(s) d'une description, ouvert dans le navigateur. */
  openLink: (url: string): Promise<void> => ipcRenderer.invoke('open-link', url),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app-version'),
  autostartGet: (): Promise<{ available: boolean; enabled: boolean }> => ipcRenderer.invoke('autostart-get'),
  autostartSet: (on: boolean): Promise<boolean> => ipcRenderer.invoke('autostart-set', on),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update-install'),
  updateInfo: (): Promise<UpdateInfo> => ipcRenderer.invoke('update-info'),
  setUpdateChannel: (channel: 'stable' | 'beta'): Promise<UpdateInfo> => ipcRenderer.invoke('update-channel', channel),
  checkUpdates: (): Promise<UpdateInfo> => ipcRenderer.invoke('update-check'),
  rollback: (): Promise<void> => ipcRenderer.invoke('update-rollback'),
  installSkipped: (): Promise<void> => ipcRenderer.invoke('update-install-skipped'),
  onUpdate: (fn: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: UpdateStatus) => fn(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
  /** L'interface a planté (erreur attrapée par React). */
  reportCrash: (report: { message: string; stack: string }): Promise<void> => ipcRenderer.invoke('report-crash', report),
  /** Clic sur une notification : ouvrir une vue. */
  onNavigate: (fn: (target: NavigateTarget) => void): (() => void) => {
    const listener = (_e: unknown, target: NavigateTarget) => fn(target);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },
};

export type BinomeApi = typeof api;

contextBridge.exposeInMainWorld('binome', api);
