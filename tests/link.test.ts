import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type SignalingServer } from '../apps/signaling/src/server.ts';
import { Engine } from '../apps/desktop/src/engine/core.ts';
import type { EngineState } from '../apps/desktop/src/engine/api.ts';
import type { LinkOptions } from '../apps/desktop/src/engine/net/link.ts';
import { generateIdentity } from '../apps/desktop/src/engine/crypto/identity.ts';
import { shutdownWebRTC } from '../apps/desktop/src/engine/net/peer.ts';

let server: SignalingServer;
let root: string;
const engines: Engine[] = [];

interface Handle {
  engine: Engine;
  inbox: string;
  until(pred: (s: EngineState) => boolean, timeoutMs?: number): Promise<EngineState>;
}

async function makeEngine(name: string, link: LinkOptions = {}): Promise<Handle> {
  const dir = await mkdtemp(join(root, `${name}-`));
  const inbox = join(dir, 'inbox');
  let latest: EngineState | null = null;
  const waiters = new Set<() => void>();
  const engine = new Engine(
    {
      dataDir: join(dir, 'data'),
      inboxDir: inbox,
      signalingUrl: `ws://127.0.0.1:${server.port}`,
      identity: generateIdentity(),
      defaultName: name,
      // Pas de STUN en test : tout se passe sur la machine.
      link: { iceServers: [], p2pTimeoutMs: 5_000, ...link },
    },
    (ev) => {
      if (ev.ev !== 'state') return;
      latest = ev.state;
      for (const w of waiters) w();
    },
  );
  engines.push(engine);
  await engine.start();

  const until = (pred: (s: EngineState) => boolean, timeoutMs = 15_000) =>
    new Promise<EngineState>((resolve, reject) => {
      const check = () => {
        if (latest && pred(latest)) {
          waiters.delete(check);
          clearTimeout(timer);
          resolve(latest);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Délai dépassé. Dernier état : ${JSON.stringify(latest, null, 1)}`));
      }, timeoutMs);
      waiters.add(check);
      check();
    });
  return { engine, inbox, until };
}

async function pairedCouple(link: LinkOptions = {}) {
  const a = await makeEngine('Alex', link);
  const b = await makeEngine('Sam', link);
  await a.until((s) => s.server === 'online');
  await b.until((s) => s.server === 'online');

  void a.engine.command({ cmd: 'pair.create' });
  const shown = await a.until((s) => s.pairing.status === 'showing');
  assert.equal(shown.pairing.status, 'showing');
  const code = shown.pairing.status === 'showing' ? shown.pairing.code : '';
  void b.engine.command({ cmd: 'pair.join', code });

  await a.until((s) => s.peer?.name === 'Sam' && s.route !== null);
  await b.until((s) => s.peer?.name === 'Alex' && s.route !== null);
  return { a, b };
}

async function sendAndCheck(a: Handle, b: Handle, size: number, during?: (bytes: number) => void) {
  const src = join(root, `source-${randomBytes(4).toString('hex')}.bin`);
  const content = randomBytes(size);
  await writeFile(src, content);
  await a.engine.command({ cmd: 'send', paths: [src] });

  const name = src.split(/[\\/]/).pop()!;
  const done = await b.until((s) => {
    const t = s.transfers.find((x) => x.name === name);
    if (t && during) during(t.bytes);
    return t?.status === 'done';
  }, 60_000);
  const received = done.transfers.find((x) => x.name === name)!;
  assert.ok(received.path);
  assert.ok(content.equals(await readFile(received.path)), 'contenu identique');
  await a.until((s) => s.transfers.find((x) => x.name === name)?.status === 'done');
  return received;
}

before(async () => {
  server = await startServer(0, '127.0.0.1', { pairingAttemptsPerMinute: 1000 });
  root = await mkdtemp(join(tmpdir(), 'binome-test-'));
});

after(async () => {
  for (const e of engines) await e.stop();
  await server.close();
  shutdownWebRTC();
  await rm(root, { recursive: true, force: true });
});

describe('lien entre deux moteurs', () => {
  test('WebRTC direct et envoi d’un fichier de 8 Mo', async () => {
    const { a, b } = await pairedCouple();
    const route = (await a.until((s) => s.route !== null)).route;
    assert.ok(route === 'lan' || route === 'internet', `route : ${route}`);
    await sendAndCheck(a, b, 8 * 1024 * 1024);
  });

  test('relais quand le P2P est désactivé', async () => {
    const { a, b } = await pairedCouple({ forceRelay: true });
    assert.equal((await a.until((s) => s.route !== null)).route, 'relay');
    await sendAndCheck(a, b, 3 * 1024 * 1024);
  });

  test('un transfert coupé reprend où il s’était arrêté', async () => {
    const { a, b } = await pairedCouple({ forceRelay: true });
    let cut = false;
    let lowestAfterCut = Infinity;
    await sendAndCheck(a, b, 12 * 1024 * 1024, (bytes) => {
      if (cut) lowestAfterCut = Math.min(lowestAfterCut, bytes);
      if (!cut && bytes > 3 * 1024 * 1024) {
        cut = true;
        // Coupe le canal chiffré comme le ferait une perte de réseau.
        (a.engine as unknown as { link: { channel: { close(): void } } }).link.channel.close();
      }
    });
    assert.ok(cut, 'la coupure a eu lieu');
    assert.ok(lowestAfterCut > 2 * 1024 * 1024, `reprise à ${lowestAfterCut} octets, pas à zéro`);
  });

});
