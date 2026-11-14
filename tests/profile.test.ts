import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AVATAR_FILES, cleanStatus, decodeAvatar } from '../apps/desktop/src/engine/profile.ts';
import { boot, connected, pair, stop, until, useSyncEnv, type Device } from './helpers/sync-env.ts';

useSyncEnv();

// Les premiers octets d'un JPEG suffisent : l'app reconnaît une image à sa signature.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

/** Deux apps reliées, sans dossier partagé : le profil n'en a pas besoin. */
async function duo(): Promise<[Device, Device]> {
  const a = await boot('Alex', undefined, undefined, { appVersion: '0.2.0-beta.1' });
  const b = await boot('Sam', undefined, undefined, { appVersion: '0.2.0' });
  await pair(a, b);
  await connected(a, b);
  return [a, b];
}

describe('profil', () => {
  test('statut, avatar et version de l’app arrivent chez l’autre', async () => {
    const [a, b] = await duo();
    await until('versions', () => b.state()?.peerProfile.app === '0.2.0-beta.1' && a.state()?.peerProfile.app === '0.2.0');
    assert.equal(b.state()!.peerProfile.proto, 2);

    await a.engine.command({ cmd: 'profile.status', status: { kind: 'busy', text: '  En train de coder\n' } });
    await until('statut chez Sam', () => b.state()?.peerProfile.status?.text === 'En train de coder');
    assert.equal(b.state()!.peerProfile.status!.kind, 'busy');

    await a.engine.request({ req: 'profile.avatar', data: JPEG.toString('base64') });
    await until('avatar chez Sam', () => (b.state()?.peerProfile.avatar ?? 0) > 0);
    assert.ok((await readFile(join(b.dir, 'data', AVATAR_FILES.peer))).equals(JPEG));
    assert.ok(a.state()!.me.avatar > 0);

    // Photo retirée : les initiales reviennent des deux côtés.
    await a.engine.request({ req: 'profile.avatar', data: null });
    await until('avatar retiré', () => b.state()?.peerProfile.avatar === 0 && a.state()?.me.avatar === 0);
    await assert.rejects(stat(join(b.dir, 'data', AVATAR_FILES.peer)));

    await a.engine.command({ cmd: 'profile.status', status: null });
    await until('statut effacé', () => b.state()?.peerProfile.status === null);
  });

  test('une image refusée ne remplace pas l’avatar', async () => {
    const [a] = await duo();
    await assert.rejects(a.engine.request({ req: 'profile.avatar', data: Buffer.from('<svg onload=x>').toString('base64') }));
    assert.equal(a.state()!.me.avatar, 0);
  });

  test('le profil repart à la reconnexion, une image identique n’est pas réécrite', async () => {
    let [a, b] = await duo();
    await a.engine.command({ cmd: 'profile.status', status: { kind: 'away', text: 'AFK' } });
    await a.engine.request({ req: 'profile.avatar', data: JPEG.toString('base64') });
    await until('reçus', () => b.state()?.peerProfile.status?.text === 'AFK' && (b.state()?.peerProfile.avatar ?? 0) > 0);

    await stop(b);
    b = await boot('Sam', b.identity, b.dir, { appVersion: '0.2.0' });
    const rev = Math.round((await stat(join(b.dir, 'data', AVATAR_FILES.peer))).mtimeMs);
    await connected(a, b);
    // Après un redémarrage, Sam ne connaît le statut d'Alex que par le profil renvoyé.
    await until('profil renvoyé', () => b.state()?.peerProfile.status?.text === 'AFK');
    assert.equal(b.state()!.peerProfile.avatar, rev, 'même image : même révision, l’interface ne recharge rien');
  });

  test('ton statut et ta photo survivent au redémarrage', async () => {
    const [a] = await duo();
    await a.engine.command({ cmd: 'profile.status', status: { kind: 'away', text: 'AFK' } });
    await a.engine.request({ req: 'profile.avatar', data: JPEG.toString('base64') });
    await stop(a);
    const again = await boot('Alex', a.identity, a.dir);
    await until('gardés', () => again.state()?.me.status?.text === 'AFK' && (again.state()?.me.avatar ?? 0) > 0);
  });

  test('un wizz secoue l’autre, une fois par 10 s au plus', async () => {
    const [a, b] = await duo();
    assert.equal(await a.engine.request({ req: 'wizz' }), 'sent');
    await until('wizz reçu', () => b.events.some((e) => e.ev === 'wizz'));
    const ev = b.events.find((e) => e.ev === 'wizz');
    assert.deepEqual(ev, { ev: 'wizz', from: 'Alex', quiet: false });
    assert.equal(await a.engine.request({ req: 'wizz' }), 'wait');

    // Noté dans le fil des deux côtés, sans compter comme message non lu.
    const theirs = await b.engine.request({ req: 'chat.list' });
    assert.equal(theirs.at(-1)?.kind, 'wizz');
    assert.equal(theirs.at(-1)?.mine, false);
    assert.equal(b.state()!.chat.unread, 0);
    const mine = await a.engine.request({ req: 'chat.list' });
    assert.equal(mine.at(-1)?.kind, 'wizz');
    assert.equal(mine.at(-1)?.mine, true);
  });

  test('« Occupé » : le wizz arrive sans secousse', async () => {
    const [a, b] = await duo();
    await b.engine.command({ cmd: 'profile.status', status: { kind: 'busy', text: '' } });
    await a.engine.request({ req: 'wizz' });
    await until('wizz', () => b.events.some((e) => e.ev === 'wizz'));
    const ev = b.events.find((e) => e.ev === 'wizz');
    assert.equal(ev?.ev === 'wizz' && ev.quiet, true);
  });

  test('hors ligne : pas de wizz', async () => {
    const [a, b] = await duo();
    await stop(b);
    await until('hors ligne', () => a.state()?.route === null);
    assert.equal(await a.engine.request({ req: 'wizz' }), 'offline');
  });

  test('dissocier oublie le profil de l’autre', async () => {
    const [a, b] = await duo();
    await b.engine.command({ cmd: 'profile.status', status: { kind: 'away', text: 'En pause' } });
    await b.engine.request({ req: 'profile.avatar', data: JPEG.toString('base64') });
    await until('reçus', () => a.state()?.peerProfile.status?.text === 'En pause' && (a.state()?.peerProfile.avatar ?? 0) > 0);
    await a.engine.command({ cmd: 'unpair' });
    await until('oublié', () => a.state()?.peerProfile.status === null && a.state()?.peerProfile.avatar === 0);
    await assert.rejects(stat(join(a.dir, 'data', AVATAR_FILES.peer)));
  });

  test('validation du statut et de l’avatar', () => {
    assert.equal(cleanStatus({ kind: 'nope', text: 'x' }), null);
    assert.equal(cleanStatus('busy'), null);
    assert.deepEqual(cleanStatus({ kind: 'away', text: 'a'.repeat(100) }), { kind: 'away', text: 'a'.repeat(60) });
    assert.deepEqual(cleanStatus({ kind: 'busy' }), { kind: 'busy', text: '' });
    assert.equal(decodeAvatar(Buffer.from('<svg/>').toString('base64')), null);
    assert.equal(decodeAvatar(Buffer.concat([JPEG, Buffer.alloc(60_000)]).toString('base64')), null, 'trop lourde');
    assert.equal(decodeAvatar(42), null);
    assert.ok(decodeAvatar(JPEG.toString('base64'))?.equals(JPEG));
  });
});
