import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APP_MIGRATIONS, openDb } from '../apps/desktop/src/engine/db/index.ts';
import { Chat } from '../apps/desktop/src/engine/chat.ts';
import { boot, couple, stop, until, useSyncEnv } from './helpers/sync-env.ts';

useSyncEnv();

describe('chat', () => {
  test('un message arrive, est accusé, puis marqué lu', async () => {
    const [a, b] = await couple();
    await a.engine.command({ cmd: 'chat.send', text: 'Tu as vu la nouvelle affiche ?', file: 'maquettes/affiche.psd' });
    await until('non lu chez Sam', () => b.state()?.chat.unread === 1);
    const [received] = await b.engine.request({ req: 'chat.list' });
    assert.equal(received!.text, 'Tu as vu la nouvelle affiche ?');
    assert.equal(received!.file, 'maquettes/affiche.psd');
    assert.equal(received!.mine, false);
    await until('accusé chez Alex', async () => (await a.engine.request({ req: 'chat.list' }))[0]?.status === 'sent');
    await b.engine.command({ cmd: 'chat.read' });
    await until('lu', () => b.state()?.chat.unread === 0);
  });

  test('écrit hors ligne, envoyé à la reconnexion, une seule fois', async () => {
    let [a, b] = await couple();
    await stop(b);
    await a.engine.command({ cmd: 'chat.send', text: 'premier' });
    await a.engine.command({ cmd: 'chat.send', text: 'second' });
    const pending = await a.engine.request({ req: 'chat.list' });
    assert.deepEqual(
      pending.map((m) => m.status),
      ['pending', 'pending'],
    );
    b = await boot('Sam', b.identity, b.dir);
    await until('reçus', () => b.state()?.chat.unread === 2, 30_000);
    const list = await b.engine.request({ req: 'chat.list' });
    assert.deepEqual(
      list.map((m) => m.text),
      ['premier', 'second'],
    );
    await until('accusés', async () => (await a.engine.request({ req: 'chat.list' })).every((m) => m.status === 'sent'));
  });

  test('un renvoi du même message ne crée pas de doublon, le non-lu survit au redémarrage', () => {
    const db: DatabaseSync = openDb(':memory:', APP_MIGRATIONS);
    const received: string[] = [];
    const chat = new Chat(db, (m) => received.push(m.text), () => {});
    const acks: string[] = [];
    chat.attach((m) => {
      if (m.t === 'chat.ack') acks.push(m.id);
      return true;
    });
    const msg = { t: 'chat' as const, id: 'abc', text: 'salut', file: null, at: 1 };
    chat.handle(msg);
    chat.handle(msg);
    assert.deepEqual(received, ['salut']);
    assert.deepEqual(acks, ['abc', 'abc'], 'chaque renvoi est accusé, pour que l’émetteur arrête');
    assert.equal(new Chat(db, () => {}, () => {}).unread, 1);
    db.close();
  });
});
