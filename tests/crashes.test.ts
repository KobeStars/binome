import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_MIGRATIONS, openDb } from '../apps/desktop/src/engine/db/index.ts';
import { CRASH_LOG_MAX, Crashes } from '../apps/desktop/src/engine/crashes.ts';
import { boot, connected, pair, stop, until, useSyncEnv, type Device } from './helpers/sync-env.ts';

useSyncEnv();

async function duo(): Promise<[Device, Device]> {
  const a = await boot('Alex');
  const b = await boot('Sam');
  await pair(a, b);
  await connected(a, b);
  return [a, b];
}

const REPORT = { kind: 'engine', summary: 'TypeError: x is undefined', log: 'démarrage\nTypeError: x is undefined\n', app: '0.2.0' };

describe('plantages', () => {
  test('noté hors ligne, envoyé à la reconnexion, accusé, vu', async () => {
    let [a, b] = await duo();
    await stop(b);
    await until('hors ligne', () => a.state()?.route === null);
    await a.engine.command({ cmd: 'crash.report', report: REPORT });
    const [pending] = await a.engine.request({ req: 'crash.list' });
    assert.equal(pending!.status, 'pending');
    assert.equal(pending!.mine, true);

    b = await boot('Sam', b.identity, b.dir);
    await until('reçu chez Sam', () => b.state()?.crashes.unseen === 1, 30_000);
    const [received] = await b.engine.request({ req: 'crash.list' });
    assert.equal(received!.mine, false);
    assert.equal(received!.summary, REPORT.summary);
    assert.equal(received!.log, REPORT.log);
    assert.equal(received!.app, '0.2.0');
    assert.ok(b.events.some((e) => e.ev === 'peerCrash' && e.from === 'Alex'));

    await until('accusé chez Alex', async () => (await a.engine.request({ req: 'crash.list' }))[0]?.status === 'sent');
    await b.engine.command({ cmd: 'crash.read' });
    await until('vu', () => b.state()?.crashes.unseen === 0);
  });

  test('partage coupé : le rapport reste sur ce PC', async () => {
    const [a, b] = await duo();
    await a.engine.command({ cmd: 'crash.share', on: false });
    await until('réglage', () => a.state()?.crashes.share === false);
    await a.engine.command({ cmd: 'crash.report', report: REPORT });
    const [mine] = await a.engine.request({ req: 'crash.list' });
    assert.equal(mine!.status, 'local');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await b.engine.request({ req: 'crash.list' })).length, 0);
  });

  test('un renvoi après coupure ne crée pas de doublon, le non-vu survit au redémarrage', () => {
    const db = openDb(':memory:', APP_MIGRATIONS);
    const received: string[] = [];
    const crashes = new Crashes(db, (c) => received.push(c.id), () => {});
    const acks: string[] = [];
    crashes.attach((m) => {
      if (m.t === 'crash.ack') acks.push(m.id);
      return true;
    }, true);
    const msg = { t: 'crash' as const, id: 'abcdef0123456789', at: 1, app: '0.2.0', kind: 'engine', summary: 's', log: 'l' };
    crashes.handle(msg);
    crashes.handle(msg);
    assert.deepEqual(received, [msg.id]);
    assert.deepEqual(acks, [msg.id, msg.id], 'chaque renvoi est accusé, pour que l’émetteur arrête');
    assert.equal(new Crashes(db, () => {}, () => {}).unseen, 1);
    db.close();
  });

  test('le rapport garde la fin du journal, là où se trouve l’erreur', () => {
    const db = openDb(':memory:', APP_MIGRATIONS);
    const crashes = new Crashes(db, () => {}, () => {});
    const log = `${'x'.repeat(CRASH_LOG_MAX)}\nError: la vraie cause\n`;
    const c = crashes.record({ ...REPORT, log }, false);
    assert.equal(c.log.length, CRASH_LOG_MAX);
    assert.ok(c.log.endsWith('Error: la vraie cause\n'));
    db.close();
  });

  test('un message abîmé est ignoré', () => {
    const db = openDb(':memory:', APP_MIGRATIONS);
    const crashes = new Crashes(db, () => {}, () => {});
    crashes.handle({ t: 'crash', id: '../../etc', at: 1, app: 'x', kind: 'x', summary: 'x', log: 'x' });
    crashes.handle({ t: 'crash', id: 42 as unknown as string, at: 1, app: 'x', kind: 'x', summary: 'x', log: 'x' });
    assert.equal(crashes.list().length, 0);
    db.close();
  });
});
