// Environnement de test : serveur local, moteurs, dossiers partagés.

import { after, before } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startServer, type SignalingServer } from '../../apps/signaling/src/server.ts';
import { Engine } from '../../apps/desktop/src/engine/core.ts';
import type { EngineEvent, EngineState } from '../../apps/desktop/src/engine/api.ts';
import { generateIdentity, type Identity } from '../../apps/desktop/src/engine/crypto/identity.ts';
import { shutdownWebRTC } from '../../apps/desktop/src/engine/net/peer.ts';

let server: SignalingServer;
export let root: string;
const running = new Set<Engine>();

export interface Device {
  name: string;
  identity: Identity;
  dir: string;
  folder: string;
  engine: Engine;
  state: () => EngineState | null;
  /** Événements ponctuels reçus (wizz, plantage de l'autre…), dans l'ordre. */
  events: EngineEvent[];
  /** Octets de blocs reçus par la synchro depuis le démarrage. */
  chunkBytes: () => number;
}

export async function boot(
  name: string,
  identity = generateIdentity(),
  dir?: string,
  opts: { appVersion?: string } = {},
): Promise<Device> {
  dir ??= await mkdtemp(join(root, `${name}-`));
  const folder = join(dir, 'Partage');
  await mkdir(folder, { recursive: true });
  let latest: EngineState | null = null;
  const events: EngineEvent[] = [];
  const engine = new Engine(
    {
      dataDir: join(dir, 'data'),
      inboxDir: join(dir, 'inbox'),
      signalingUrl: `ws://127.0.0.1:${server.port}`,
      identity,
      defaultName: name,
      link: { iceServers: [], p2pTimeoutMs: 5_000 },
      syncStabilityMs: 200,
      appVersion: opts.appVersion,
    },
    (ev) => {
      if (ev.ev === 'state') latest = ev.state;
      else events.push(ev);
    },
  );
  running.add(engine);
  await engine.start();
  let bytes = 0;
  const device: Device = {
    name,
    identity,
    dir,
    folder,
    engine,
    state: () => latest,
    events,
    chunkBytes: () => bytes,
  };
  // Compte les octets de blocs reçus, pour vérifier qu'on n'envoie que ce qui a changé.
  const spy = () => {
    const sync = (engine as unknown as { sync: { chunk: (...a: unknown[]) => void } | null }).sync;
    if (!sync || (sync as { __spied?: boolean }).__spied) return;
    const orig = sync.chunk.bind(sync);
    sync.chunk = (h, o, t, data) => {
      bytes += (data as Uint8Array).length;
      orig(h, o, t, data);
    };
    (sync as { __spied?: boolean }).__spied = true;
  };
  const timer = setInterval(spy, 20);
  timer.unref();
  return device;
}

export async function stop(d: Device): Promise<void> {
  await d.engine.stop();
  running.delete(d.engine);
}

export async function until(what: string, fn: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Délai dépassé : ${what}`);
}

export const read = (d: Device, rel: string) => readFile(join(d.folder, ...rel.split('/'))).catch(() => null);
export const exists = (d: Device, rel: string) =>
  stat(join(d.folder, ...rel.split('/'))).then(
    () => true,
    () => false,
  );
export async function put(d: Device, rel: string, data: Buffer | string): Promise<void> {
  const abs = join(d.folder, ...rel.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
}

export async function sameContent(a: Device, b: Device, rel: string): Promise<boolean> {
  const [x, y] = await Promise.all([read(a, rel), read(b, rel)]);
  return x !== null && y !== null && x.equals(y);
}

export async function pair(a: Device, b: Device): Promise<void> {
  await until('serveur', () => a.state()?.server === 'online' && b.state()?.server === 'online');
  void a.engine.command({ cmd: 'pair.create' });
  await until('code', () => a.state()?.pairing.status === 'showing');
  const p = a.state()!.pairing;
  void b.engine.command({ cmd: 'pair.join', code: p.status === 'showing' ? p.code : '' });
}

export async function connected(a: Device, b: Device): Promise<void> {
  await until('canal', () => a.state()?.route != null && b.state()?.route != null);
}

export async function setFolder(d: Device): Promise<void> {
  await d.engine.command({ cmd: 'sync.setFolder', path: d.folder });
  await until('analyse', () => d.state()?.sync.status !== 'scanning' && d.state()?.sync.folder != null);
}

export async function couple(): Promise<[Device, Device]> {
  const a = await boot('Alex');
  const b = await boot('Sam');
  await setFolder(a);
  await setFolder(b);
  await pair(a, b);
  await connected(a, b);
  return [a, b];
}

/** À appeler une fois par fichier de test. */
export function useSyncEnv(): void {
before(async () => {
  server = await startServer(0, '127.0.0.1', { pairingAttemptsPerMinute: 1000 });
  root = await mkdtemp(join(tmpdir(), 'binome-sync-'));
});

after(async () => {
  for (const e of running) await e.stop();
  await server.close();
  shutdownWebRTC();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});
}
