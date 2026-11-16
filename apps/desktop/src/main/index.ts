import { stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  shell,
  type MessageBoxOptions,
} from 'electron';
import type { CrashReport, EngineEvent } from '../engine/api.ts';
import { autostart, HIDDEN_ARG } from './autostart.ts';
import { EngineHost } from './engine-host.ts';
import { GuardStore } from './guard-store.ts';
import { loadOrCreateIdentity } from './identity-store.ts';
import { LogTail } from './log-tail.ts';
import { handlePreviews, registerPreviewScheme } from './preview.ts';
import { AppTray, resourcePath } from './tray.ts';
import {
  becameHealthy,
  crashLooping,
  keepVersion,
  markClean,
  markHealthy,
  previousVersion,
  recordBoot,
} from './update-guard.ts';
import { Updater } from './updater.ts';
import type { NavigateTarget, PickKind } from '../preload/index.ts';
import { shakeWindow } from './wizz.ts';

// Plusieurs profils sur un même PC, pour tester à deux : BINOME_PROFILE=b npm run desktop:dev
const profile = process.env.BINOME_PROFILE;
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile}`);

const SIGNALING_URL = process.env.BINOME_SIGNALING_URL ?? import.meta.env.MAIN_VITE_SIGNALING_URL ?? 'ws://127.0.0.1:8787';
/** Fond de la zone de contenu : la barre de titre système s'y fond. */
const BACKGROUND = '#141415';

/** Une seule instance : la seconde rend la main à la première et quitte. */
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
registerPreviewScheme();

let win: BrowserWindow | null = null;
let host: EngineHost | null = null;
let tray: AppTray | null = null;
let sharedFolder: string | null = null;
let quitting = false;
let hintShown = false;
const startHidden = process.argv.includes(HIDDEN_ARG);
const store = new GuardStore(join(app.getPath('userData'), 'updates.json'));
const updater = new Updater(store);

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Ouvre une vue de l'interface (clic sur une notification). */
function navigate(view: NavigateTarget): void {
  showWindow();
  win?.webContents.send('navigate', view);
}

function quit(): void {
  quitting = true;
  app.quit();
}

/** Dossier d'installation par défaut des jeux et apps : %LOCALAPPDATA%\Binôme\Bibliothèque. */
function libraryDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local');
  return join(local, profile ? `Binôme-${profile}` : 'Binôme', 'Bibliothèque');
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

// ─── Plantages et garde-fou des mises à jour ─────────────────────────────

const version = app.getVersion();
const bootAt = Date.now();
/** Heures des plantages (moteur, interface) depuis le lancement. */
const crashTimes: number[] = [];
/** Messages d'erreur de l'interface, joints au rapport si elle plante. */
const rendererLog = new LogTail(8_000);
const reportTimes = new Map<string, number[]>();
let rollbackOffered = false;

/** Enregistre un plantage (et l'envoie à l'autre si c'est permis). Au plus 5 par type en 10 minutes. */
function reportCrash(report: Omit<CrashReport, 'app' | 'at'>): void {
  const now = Date.now();
  const recent = (reportTimes.get(report.kind) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 5) return;
  reportTimes.set(report.kind, [...recent, now]);
  host?.command({ cmd: 'crash.report', report: { ...report, app: version, at: now } });
}

/** Un plantage du moteur ou de l'interface : compte pour repérer une version qui plante en boucle. */
function countCrash(): void {
  crashTimes.push(Date.now());
  if (crashLooping(store.state, version, crashTimes, Date.now())) void offerRollback();
}

/** Cette version plante en boucle : on propose de revenir à la précédente. */
async function offerRollback(): Promise<void> {
  const previous = previousVersion(store.state, version);
  if (rollbackOffered || !previous || !Updater.enabled()) return;
  rollbackOffered = true;
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Binôme',
    message: `La version ${version} plante`,
    detail:
      `Binôme s’est arrêté plusieurs fois depuis la mise à jour. Tu peux revenir à la version ${previous}, ` +
      'qui marchait sur ce PC. La version actuelle ne se réinstallera pas toute seule.',
    buttons: [`Revenir à la ${previous}`, 'Rester sur cette version'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (r.response !== 0) {
    store.update((s) => keepVersion(s, version));
    return;
  }
  try {
    await updater.rollback();
  } catch (err) {
    dialog.showErrorBox('Binôme', err instanceof Error ? err.message : 'Retour en arrière impossible');
  }
}

/** Fermeture normale : ce lancement ne comptera pas comme un plantage. */
function markCleanExit(): void {
  if (primary) store.update((s) => markClean(s, version));
}

// La seconde instance quitte tout de suite : elle ne doit pas toucher à l'état de la première.
if (primary) {
  store.update((s) => recordBoot(s, version, bootAt));
  // Une version devient saine après 5 minutes sans boucle de plantages.
  const healthTimer = setInterval(() => {
    if (store.state.healthy.includes(version)) return clearInterval(healthTimer);
    if (becameHealthy(bootAt, crashTimes, Date.now())) {
      store.update((s) => markHealthy(s, version));
      clearInterval(healthTimer);
    }
  }, 30_000);
  healthTimer.unref();
}

process.on('uncaughtException', (err) => {
  console.error('main :', err);
  reportCrash({ kind: 'main', summary: err.message || String(err), log: err.stack ?? String(err) });
});
process.on('unhandledRejection', (reason) => {
  console.error('main (promesse) :', reason);
  const err = reason instanceof Error ? reason : new Error(String(reason));
  reportCrash({ kind: 'main', summary: err.message, log: err.stack ?? String(reason) });
});

// ─── Notifications ───────────────────────────────────────────────────────

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

/** Wizz reçu : la fenêtre visible tremble, sinon une notification. « Occupé » : en silence. */
function onWizz(event: Extract<EngineEvent, { ev: 'wizz' }>): void {
  if (!win) return;
  const who = event.from || 'Ton binôme';
  const visible = win.isVisible() && !win.isMinimized();
  if (!event.quiet) {
    if (visible) shakeWindow(win);
    if (!win.isFocused()) win.flashFrame(true);
  }
  if (win.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({
    title: `${who} t’envoie un wizz`,
    body: event.quiet ? 'Reçu sans bruit : tu es « Occupé »' : 'Clique pour ouvrir Binôme',
    silent: event.quiet,
  });
  n.on('click', () => {
    navigate('chat');
    if (!event.quiet && win) shakeWindow(win);
  });
  n.show();
}

/** Bibliothèque : nouvelle app, mise à jour, avis, bug, « Teste mon jeu ! ». */
function onLibrary(event: Extract<EngineEvent, { ev: 'lib' }>): void {
  // Succès et niveaux : affichés dans l'app seulement.
  if (event.kind === 'achievement' || event.kind === 'level') return;
  if (event.kind === 'test') {
    // La demande expire en une minute : la fenêtre passe devant.
    showWindow();
    win?.flashFrame(true);
  }
  if (!Notification.isSupported() || (win?.isFocused() && event.kind !== 'test')) return;
  const n = new Notification({ title: event.title, body: event.body, silent: event.kind !== 'test' && event.kind !== 'bug' });
  n.on('click', () => navigate(event.app ? `library:${event.app}` : 'library'));
  n.show();
}

function onEngineEvent(event: EngineEvent): void {
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
  if (event.ev === 'wizz') return onWizz(event);
  if (event.ev === 'lib') return onLibrary(event);
  if (event.ev === 'peerCrash') {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: `L’app de ${event.from || 'ton binôme'} a planté`,
      body: `Version ${event.app} · ${event.summary}`.slice(0, 200),
      silent: true,
    });
    n.on('click', () => navigate('crashes'));
    n.show();
    return;
  }
  if (event.ev === 'chat') {
    if (!Notification.isSupported() || win?.isFocused()) return;
    const n = new Notification({ title: event.from || 'Ton binôme', body: event.text.slice(0, 200), silent: false });
    n.on('click', () => navigate('chat'));
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
}

// ─── Fenêtre ─────────────────────────────────────────────────────────────

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
  // Arrêt ou redémarrage de Windows : fermeture normale, pas un plantage.
  w.on('session-end', markCleanExit);
  // Chaque chargement de page reçoit un nouveau port vers le moteur.
  w.webContents.on('did-finish-load', () => {
    host?.connect(w.webContents);
    updater.attach(w.webContents);
  });
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') rendererLog.push(`[${e.level}] ${e.message}\n`);
  });
  w.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    reportCrash({
      kind: 'renderer',
      summary: `Interface arrêtée (${details.reason}, code ${details.exitCode})`,
      log: rendererLog.value,
    });
    countCrash();
    // Fenêtre blanche sinon : on recharge l'interface, sauf si elle replante sans arrêt.
    const lastMinute = crashTimes.filter((t) => Date.now() - t < 60_000).length;
    if (lastMinute <= 3) {
      setTimeout(() => {
        if (!w.isDestroyed()) w.webContents.reload();
      }, 1000);
    }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (url !== w.webContents.getURL()) e.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void w.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return w;
}

/** Photo choisie par l'utilisateur, recadrée en carré et réduite : JPEG en base64. */
async function pickAvatar(): Promise<string | null> {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir une photo',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  const path = r.canceled ? null : r.filePaths[0];
  if (!path) return null;
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) throw new Error('Image illisible : choisis un PNG ou un JPEG');
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  return square.resize({ width: 128, height: 128, quality: 'best' }).toJPEG(85).toString('base64');
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
      appVersion: version,
      libraryDir: libraryDir(),
    },
    onEngineEvent,
    (crash) => {
      reportCrash({
        kind: 'engine',
        summary: crash.lastError ?? `Moteur arrêté (code ${crash.code})`,
        log: crash.log,
      });
      countCrash();
    },
  );
  host.start();
  handlePreviews(() => ({
    shared: sharedFolder,
    inbox: inboxDir(),
    data: app.getPath('userData'),
    media: join(app.getPath('userData'), 'library', 'media'),
  }));
  autostart.initOnce();
  tray = new AppTray({
    show: showWindow,
    openFolder: () => {
      if (sharedFolder) void shell.openPath(sharedFolder);
    },
    wizz: () => host?.command({ cmd: 'wizz' }),
    autostart,
    quit,
  });

  // Affiche un fichier dans l'Explorateur : fichiers reçus ou fichiers du dossier partagé.
  ipcMain.handle('reveal', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return;
    if (insideInbox(path) || (await stat(path).catch(() => null))?.isFile()) shell.showItemInFolder(path);
  });
  ipcMain.handle('update-install', () => updater.install());
  ipcMain.handle('update-info', () => updater.info());
  ipcMain.handle('update-channel', (_e, channel: unknown) => updater.setChannel(channel === 'beta' ? 'beta' : 'stable'));
  ipcMain.handle('update-check', () => {
    updater.check();
    return updater.info();
  });
  ipcMain.handle('update-rollback', () => updater.rollback());
  ipcMain.handle('update-install-skipped', () => updater.installSkipped());
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
  ipcMain.handle('pick-avatar', () => pickAvatar());
  ipcMain.handle('pick-file', async (_e, kind: PickKind, multiple: unknown) => {
    if (!win) return [];
    const filters =
      kind === 'image'
        ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
        : kind === 'media'
          ? [{ name: 'Images et vidéos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'] }]
          : [{ name: 'Programmes', extensions: ['exe', 'bat', 'cmd'] }, { name: 'Tous les fichiers', extensions: ['*'] }];
    const r = await dialog.showOpenDialog(win, { properties: multiple === true ? ['openFile', 'multiSelections'] : ['openFile'], filters });
    return r.canceled ? [] : r.filePaths;
  });
  // Capture de l'écran où se trouve la fenêtre, réduite à 1600 px de large : rapport de bug.
  ipcMain.handle('capture-screen', async () => {
    const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = Math.min(1, 1600 / width);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale * display.scaleFactor), height: Math.round(height * scale * display.scaleFactor) },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return null;
    const img = source.thumbnail.getSize().width > 1600 ? source.thumbnail.resize({ width: 1600, quality: 'good' }) : source.thumbnail;
    return img.toJPEG(80).toString('base64');
  });
  ipcMain.handle('open-link', async (_e, url: unknown) => {
    if (typeof url !== 'string') return;
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') await shell.openExternal(u.toString());
    } catch {
      // lien invalide : rien
    }
  });
  // L'interface a planté (erreur React attrapée) : rapport, et compte pour le garde-fou.
  ipcMain.handle('report-crash', (_e, report: unknown) => {
    const r = (report && typeof report === 'object' ? report : {}) as { message?: unknown; stack?: unknown };
    const message = typeof r.message === 'string' ? r.message.slice(0, 300) : 'Erreur de l’interface';
    const stack = typeof r.stack === 'string' ? r.stack.slice(0, 8_000) : '';
    reportCrash({ kind: 'renderer', summary: message, log: `${stack}\n\n${rendererLog.value}` });
    countCrash();
  });

  win = createWindow();
  updater.start();
  // Les lancements précédents de cette version ont planté : on propose tout de suite d'en revenir.
  if (crashLooping(store.state, version, crashTimes, Date.now())) {
    setTimeout(() => void offerRollback(), startHidden ? 0 : 2_000);
  }
});

app.on('before-quit', () => {
  quitting = true;
  markCleanExit();
  host?.stop();
});
// La fenêtre se cache au lieu de se fermer : rien à faire ici, l'app reste dans la barre des tâches.
app.on('window-all-closed', () => {});
