import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { UpdateStatus } from '../main/updater.ts';

// Le port vers le moteur est transmis à la page par window.postMessage :
// contextBridge ne sait pas faire passer un MessagePort.
ipcRenderer.on('engine-port', (e) => {
  window.postMessage('binome:engine-port', '*', e.ports);
});

const api = {
  /** Chemin d'un fichier glissé dans la fenêtre. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('reveal', path),
  openInbox: (): Promise<void> => ipcRenderer.invoke('open-inbox'),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('pick-files'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  openFolder: (path: string): Promise<void> => ipcRenderer.invoke('open-folder', path),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app-version'),
  autostartGet: (): Promise<{ available: boolean; enabled: boolean }> => ipcRenderer.invoke('autostart-get'),
  autostartSet: (on: boolean): Promise<boolean> => ipcRenderer.invoke('autostart-set', on),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update-install'),
  onUpdate: (fn: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: UpdateStatus) => fn(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
};

export type BinomeApi = typeof api;

contextBridge.exposeInMainWorld('binome', api);
