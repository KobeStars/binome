import { stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, shell } from 'electron';
import type { EngineEvent } from '../engine/api.ts';
import { autostart, HIDDEN_ARG } from './autostart.ts';
import { EngineHost } from './engine-host.ts';
import { loadOrCreateIdentity } from './identity-store.ts';
import { handlePreviews, registerPreviewScheme } from './preview.ts';
import { AppTray, resourcePath } from './tray.ts';
import { Updater } from './updater.ts';

// Plusieurs profils sur un même PC, pour tester à deux : BINOME_PROFILE=b npm run desktop:dev
const profile = process.env.BINOME_PROFILE;
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile}`);

const SIGNALING_URL = process.env.BINOME_SIGNALING_URL ?? import.meta.env.MAIN_VITE_SIGNALING_URL ?? 'ws://127.0.0.1:8787';
/** Fond de la zone de contenu : la barre de titre système s'y fond. */
const BACKGROUND = '#141415';

if (!app.requestSingleInstanceLock()) app.quit();
registerPreviewScheme();

let win: BrowserWindow | null = null;
let host: EngineHost | null = null;
let tray: AppTray | null = null;
let sharedFolder: string | null = null;
let quitting = false;
let hintShown = false;
const updater = new Updater();
const startHidden = process.argv.includes(HIDDEN_ARG);

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function inboxDir(): string {
  if (process.env.BINOME_INBOX) return process.env.BINOME_INBOX;
  const base = join(app.getPath('downloads'), 'Binôme');
  return profile ? `${base}-${profile}` : base;
}

/** N'ouvre que des fichiers du dossier de réception. */
function insideInbox(path: string): boolean {
  const rel = relative(inboxDir(), path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

type ChangeEvent = Extract<EngineEvent, { ev: 'changed' }>;
let changeBatch: ChangeEvent[] = [];
let changeTimer: NodeJS.Timeout | null = null;

/** « Sam a modifié plan.psd », regroupé quand plusieurs fichiers changent d'un coup. */
function notifyChange(event: ChangeEvent): void {
  changeBatch.push(event);
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    const batch = changeBatch;
    changeBatch = [];
    changeTimer = null;
    if (!Notification.isSupported() || win?.isFocused()) return;
    const who = batch[0]!.from || 'Ton binôme';
    const verbs = { added: 'ajouté', modified: 'modifié', deleted: 'supprimé' } as const;
    const name = (p: string) => p.split('/').pop() ?? p;
    const body =
      batch.length === 1
        ? `${who} a ${verbs[batch[0]!.kind]} ${name(batch[0]!.path)}`
        : `${who} a modifié ${batch.length} fichiers`;
    new Notification({ title: 'Binôme', body, silent: true }).show();
  }, 1500);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: BACKGROUND,
    title: profile ? `Binôme (${profile})` : 'Binôme',
    icon: resourcePath('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#a1a1a6', height: 40 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  w.once('ready-to-show', () => {
    // Lancé au démarrage de Windows : l'app reste dans la barre des tâches.
    if (!startHidden) w.show();
  });
  // Fermer la fenêtre ne quitte pas : la synchro continue en arrière-plan.
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
    if (!hintShown && Notification.isSupported()) {
      hintShown = true;
      new Notification({ title: 'Binôme continue en arrière-plan', body: 'Clic droit sur l’icône près de l’horloge pour quitter', silent: true }).show();
    }
  });
  // Chaque chargement de page reçoit un nouveau port vers le moteur.
  w.webContents.on('did-finish-load', () => {
    host?.connect(w.webContents);
    updater.attach(w.webContents);
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (url !== w.webContents.getURL()) e.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return w;
}

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const identityPkcs8 = await loadOrCreateIdentity(app.getPath('userData'));

  host = new EngineHost(
    {
      dataDir: app.getPath('userData'),
      inboxDir: inboxDir(),
      signalingUrl: SIGNALING_URL,
      defaultName: userInfo().username,
      identityPkcs8,
      forceRelay: process.env.BINOME_FORCE_RELAY === '1',
    },
    (event) => {
      if (event.ev === 'folder') {
        sharedFolder = event.path;
        tray?.setFolder(event.path);
        return;
      }
      if (event.ev === 'status') return tray?.update(event);
      if (event.ev === 'attention') {
        // Claude attend une confirmation : la fenêtre passe devant.
        showWindow();
        win?.flashFrame(true);
        if (Notification.isSupported()) new Notification({ title: 'Claude demande ton accord', body: event.text }).show();
        return;
      }
      if (event.ev === 'chat') {
        if (!Notification.isSupported() || win?.isFocused()) return;
        const n = new Notification({ title: event.from || 'Ton binôme', body: event.text.slice(0, 200), silent: false });
        n.on('click', () => showWindow());
        n.show();
        return;
      }
      if (event.ev === 'changed') return notifyChange(event);
      if (event.ev === 'conflict') {
        if (!Notification.isSupported()) return;
        const name = event.path.split('/').pop() ?? event.path;
        const aside = event.aside.split('/').pop() ?? event.aside;
        new Notification({ title: `Conflit sur ${name}`, body: `Les deux versions sont gardées. L’autre est dans ${aside}` }).show();
        return;
      }
      if (event.ev !== 'received' || !Notification.isSupported()) return;
      const n = new Notification({
        title: `${event.from || 'Ton binôme'} t’a envoyé un fichier`,
        body: event.transfer.name,
        silent: false,
      });
      n.on('click', () => {
        if (event.transfer.path) shell.showItemInFolder(event.transfer.path);
      });
      n.show();
    },
  );
  host.start();
  handlePreviews(() => ({ shared: sharedFolder, inbox: inboxDir() }));
  autostart.initOnce();
  tray = new AppTray({
    show: showWindow,
    openFolder: () => {
      if (sharedFolder) void shell.openPath(sharedFolder);
    },
    autostart,
    quit,
  });

  // Affiche un fichier dans l'Explorateur : fichiers reçus ou fichiers du dossier partagé.
  ipcMain.handle('reveal', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return;
    if (insideInbox(path) || (await stat(path).catch(() => null))?.isFile()) shell.showItemInFolder(path);
  });
  ipcMain.handle('update-install', () => updater.install());
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('open-inbox', () => shell.openPath(inboxDir()));
  ipcMain.handle('pick-folder', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('open-folder', async (_e, path: unknown) => {
    if (typeof path !== 'string') return;
    const st = await stat(path).catch(() => null);
    if (st?.isDirectory()) await shell.openPath(path);
  });
  ipcMain.handle('autostart-get', () => ({ available: autostart.available, enabled: autostart.get() }));
  ipcMain.handle('autostart-set', (_e, on: unknown) => {
    autostart.set(on === true);
    return autostart.get();
  });
  ipcMain.handle('pick-files', async () => {
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  win = createWindow();
  updater.start();
});

app.on('before-quit', () => {
  quitting = true;
  host?.stop();
});
// La fenêtre se cache au lieu de se fermer : rien à faire ici, l'app reste dans la barre des tâches.
app.on('window-all-closed', () => {});
