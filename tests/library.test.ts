import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseBytes, toB64, type LibRelease } from '@binome/protocol';
import type { Library } from '../apps/desktop/src/engine/library/library.ts';
import { cleanRelease } from '../apps/desktop/src/engine/library/library.ts';
import { decodePackage, encodePackage, packChunk, unpackChunk } from '../apps/desktop/src/engine/library/store.ts';
import { levelOf, nightSession } from '../apps/desktop/src/engine/library/fun.ts';
import { generateIdentity } from '../apps/desktop/src/engine/crypto/identity.ts';
import { chunkBuffer } from '../apps/desktop/src/engine/sync/chunker.ts';
import { boot, connected, pair, until, useSyncEnv, type Device } from './helpers/sync-env.ts';

useSyncEnv();

// Signature PNG suivie de données : l'app reconnaît une image à ses premiers octets.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]);

const lib = (d: Device) => (d.engine as unknown as { library: Library }).library;

/** Compte les octets de blocs de la Bibliothèque reçus par `d`. */
function spyPieces(d: Device): () => number {
  let bytes = 0;
  const l = lib(d);
  const orig = l.piece.bind(l);
  l.piece = (h, o, t, data) => {
    bytes += data.length;
    orig(h, o, t, data);
  };
  return () => bytes;
}

async function duo(): Promise<[Device, Device]> {
  const a = await boot('Alex');
  const b = await boot('Sam');
  await pair(a, b);
  await connected(a, b);
  return [a, b];
}

async function writeGame(dir: string, files: Record<string, Buffer | string>): Promise<void> {
  for (const [rel, data] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, data);
  }
}

describe('bibliothèque : paquets', () => {
  test('un bloc compressible est compressé, un bloc aléatoire reste tel quel', () => {
    const text = Buffer.from('a'.repeat(60_000));
    const z = packChunk(text);
    assert.ok(z.length < 1000);
    assert.ok(unpackChunk(z)!.equals(text));
    const noise = randomBytes(60_000);
    const r = packChunk(noise);
    assert.equal(r[0], 0);
    assert.ok(unpackChunk(r)!.equals(noise));
    assert.equal(unpackChunk(Buffer.from([7, 1, 2])), null);
  });

  test('une liste de fichiers avec « .. » ou en double est refusée', () => {
    const data = Buffer.from('x');
    const file = (path: string) => ({ path, hash: 'a'.repeat(64), size: 1, chunks: chunkBuffer(data) });
    assert.ok(decodePackage(encodePackage([file('jeu/data.pck')])));
    assert.equal(decodePackage(encodePackage([file('../evil.exe')])), null);
    assert.equal(decodePackage(encodePackage([file('a.txt'), file('A.TXT')])), null);
    assert.equal(decodePackage(Buffer.from('{"files":[["a",1,2,3]]}')), null);
  });

  test('niveaux et séances de nuit', () => {
    assert.equal(levelOf(0).level, 1);
    assert.equal(levelOf(100).level, 2);
    assert.equal(levelOf(299).level, 2);
    assert.equal(levelOf(300).level, 3);
    const twoAm = new Date(2026, 10, 16, 2, 30).getTime();
    assert.ok(nightSession(twoAm - 3_600_000, twoAm));
    assert.ok(!nightSession(new Date(2026, 10, 16, 14, 0).getTime(), new Date(2026, 10, 16, 16, 0).getTime()));
  });
});

describe('bibliothèque : de bout en bout', () => {
  test('publier, installer, lancer, mettre à jour seulement ce qui change, désinstaller', async () => {
    const [a, b] = await duo();
    const pieces = spyPieces(b);
    const src = join(a.dir, 'MonJeu');
    const big = randomBytes(900 * 1024);
    await writeGame(src, {
      'run.cmd': '@exit 0\r\n',
      'data/big.bin': big,
      'data/notes.txt': 'version 1\n'.repeat(5000),
      'old.txt': 'à supprimer',
    });
    const icon = join(a.dir, 'icone.png');
    await writeFile(icon, PNG);

    const { app } = await lib(a).publish({
      source: src,
      name: 'Mon Jeu',
      version: '1.0',
      category: 'game',
      tags: ['coop'],
      description: '# Mon jeu\nUn **test**.',
      requirements: 'Windows 10',
      notes: 'Première version',
      icon,
    });
    const mine = lib(a).detail(app);
    assert.equal(mine.exe, 'run.cmd');
    assert.equal(mine.count, 4);
    assert.ok(mine.icon);

    await until('page chez Sam', () => lib(b).list().some((x) => x.id === app));
    assert.ok(b.events.some((e) => e.ev === 'lib' && e.kind === 'new'));
    // L'icône arrive dans le dossier des médias.
    await until('icône', () => stat(join(b.dir, 'data', 'library', 'media', mine.icon!.name)).then(() => true, () => false));

    await lib(b).install(app);
    const installed = lib(b).detail(app);
    assert.equal(installed.installed, '1.0');
    const dir = installed.installDir!;
    assert.ok((await readFile(join(dir, 'data', 'big.bin'))).equals(big));
    assert.equal(await readFile(join(dir, 'old.txt'), 'utf8'), 'à supprimer');
    // Les notes (texte répétitif) voyagent compressées : moins d'octets reçus que la taille du paquet.
    const firstBytes = pieces();
    assert.ok(firstBytes < mine.size, `${firstBytes} octets reçus pour ${mine.size}`);

    // Premier lancement : confirmation demandée, puis le temps de jeu est compté.
    assert.equal(await lib(b).launch(app, false), 'trust');
    assert.equal(await lib(b).launch(app, true), 'started');
    await until('fin du jeu', () => !lib(b).list().find((x) => x.id === app)!.running, 10_000);
    assert.equal(lib(b).detail(app).launches, 1);

    // Version 2 : un octet change au début du gros fichier, un fichier part, un autre arrive.
    big[10] = big[10]! ^ 0xff;
    await writeGame(src, { 'data/big.bin': big, 'data/new.txt': 'nouveau' });
    await rm(join(src, 'old.txt'));
    await lib(a).publish({ app, name: 'Mon Jeu', version: '1.1', category: 'game', tags: [], description: '', requirements: '', notes: 'Correctifs' });

    // Mise à jour automatique chez Sam.
    await until('mise à jour', () => lib(b).detail(app).installed === '1.1', 20_000);
    assert.ok((await readFile(join(dir, 'data', 'big.bin'))).equals(big));
    assert.equal(await readFile(join(dir, 'data', 'new.txt'), 'utf8'), 'nouveau');
    await assert.rejects(stat(join(dir, 'old.txt')));
    const updateBytes = pieces() - firstBytes;
    assert.ok(updateBytes < 400 * 1024, `mise à jour : ${updateBytes} octets reçus`);
    assert.deepEqual(
      lib(b).detail(app).releases.map((r) => r.version),
      ['1.1', '1.0'],
    );

    await lib(b).uninstall(app);
    await assert.rejects(stat(dir));
    assert.equal(lib(b).detail(app).installed, null);
  });

  test('avis, bug avec capture, idées, test, succès et niveau', async () => {
    const [a, b] = await duo();
    const src = join(a.dir, 'Outil');
    await writeGame(src, { 'outil.exe': 'MZ' });
    const { app } = await lib(a).publish({ source: src, name: 'Outil', version: '0.1', category: 'tool', tags: [], description: '', requirements: '', notes: '' });
    await until('page', () => lib(b).list().some((x) => x.id === app));

    assert.throws(() => lib(a).review(app, 5, 'moi-même'));
    lib(b).review(app, 4, 'Pratique');
    await until('avis chez Alex', () => lib(a).detail(app).reviews.length === 1);
    assert.equal(lib(a).detail(app).reviews[0]!.stars, 4);
    assert.equal(lib(a).detail(app).reviews[0]!.by, 'Sam');

    await lib(b).bug(app, 'Plante au démarrage', PNG.toString('base64'));
    await until('bug chez Alex', () => lib(a).detail(app).bugs.length === 1);
    const bug = lib(a).detail(app).bugs[0]!;
    assert.equal(bug.text, 'Plante au démarrage');
    assert.equal(a.state()?.library.unseenBugs, 1);
    await until('capture', () => stat(join(a.dir, 'data', 'library', 'media', bug.shot!.name)).then(() => true, () => false));
    lib(a).setBugStatus(bug.id, 'fixed');
    await until('corrigé chez Sam', () => lib(b).detail(app).bugs[0]?.status === 'fixed');

    const idea = lib(a).saveIdea({ kind: 'idea', text: 'Un mode coop', app });
    await until('idée chez Sam', () => lib(b).ideas().some((i) => i.id === idea.id));
    lib(b).saveIdea({ id: idea.id, kind: 'idea', text: idea.text, status: 'doing' });
    await until('statut chez Alex', () => lib(a).ideas().find((i) => i.id === idea.id)?.status === 'doing');
    lib(a).deleteIdea(idea.id);
    await until('supprimée chez Sam', () => !lib(b).ideas().some((i) => i.id === idea.id));

    assert.equal(lib(a).test(app), 'sent');
    await until('demande chez Sam', () => b.state()?.library.testIn?.app === app);
    await b.engine.command({ cmd: 'lib.test.reply', id: b.state()!.library.testIn!.id, answer: 'yes' });
    await until('réponse chez Alex', () => a.state()?.library.testOut?.answer === 'yes');

    const got = (d: Device, id: string) => lib(d).achievements().find((x) => x.id === id)?.at != null;
    assert.ok(got(a, 'first_publish'));
    assert.ok(got(b, 'critic'));
    assert.ok(got(b, 'tester'));
    assert.ok(a.state()!.library.level.xp > 0);
    await until('niveau de Sam chez Alex', () => (a.state()?.library.peerLevel ?? 0) >= 2);

    const w = lib(b).wrapped();
    assert.equal(w.reviews, 1);
    assert.equal(w.bugs, 1);
    assert.ok(w.xp > 0);
  });

  test('une page mal signée est ignorée', async () => {
    const [a, b] = await duo();
    const fake: LibRelease = {
      app: 'ab'.repeat(16),
      version: '1',
      name: 'Faux',
      category: 'game',
      tags: [],
      description: '',
      requirements: '',
      notes: '',
      exe: 'x.exe',
      icon: null,
      banner: null,
      gallery: [],
      files: 'cd'.repeat(32),
      size: 1,
      count: 1,
      at: Date.now(),
    };
    assert.ok(cleanRelease(fake));
    assert.equal(cleanRelease({ ...fake, exe: '../x.exe' }), null);
    const other = generateIdentity();
    lib(b).handle({ t: 'lib.release', release: fake, sig: toB64(other.sign(releaseBytes(fake))) });
    assert.equal(lib(b).list().length, 0);
    // Signée par Alex, elle passe.
    lib(b).handle({ t: 'lib.release', release: fake, sig: toB64(a.identity.sign(releaseBytes(fake))) });
    assert.equal(lib(b).list().length, 1);
  });
});
