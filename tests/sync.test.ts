import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { boot, couple, connected, exists, pair, put, read, sameContent, setFolder, stop, until, useSyncEnv } from './helpers/sync-env.ts';

useSyncEnv();

describe('synchro du dossier partagé', () => {
  test('un fichier ajouté arrive chez l’autre, avec son auteur', async () => {
    const [a, b] = await couple();
    await put(a, 'docs/note.txt', 'bonjour');
    await until('fichier reçu', () => sameContent(a, b, 'docs/note.txt'));
    await until('auteur affiché', () => b.state()?.sync.recent.some((r) => r.path === 'docs/note.txt' && r.by === 'Alex') ?? false);
    await until('dernière synchro', () => b.state()?.sync.lastSync != null);
  });

  test('une modification n’envoie que les blocs changés', async () => {
    const [a, b] = await couple();
    const big = randomBytes(20 * 1024 * 1024);
    const t0 = Date.now();
    await put(a, 'plan.psd', big);
    await until('indexé chez A', () => a.state()?.sync.files === 1, 60_000);
    const t1 = Date.now();
    await until('premier envoi', () => sameContent(a, b, 'plan.psd'), 60_000);
    if (process.env.BINOME_TIMING) console.log(`indexation ${t1 - t0} ms, transfert ${Date.now() - t1} ms, octets ${b.chunkBytes()}`);
    const before = b.chunkBytes();
    assert.ok(before >= big.length, `premier envoi complet (${before})`);

    // Retouche de 100 octets au milieu.
    const edited = Buffer.from(big);
    randomBytes(100).copy(edited, 10_000_000);
    const t2 = Date.now();
    const recentAt = () => a.state()?.sync.recent.find((r) => r.path === 'plan.psd')?.at ?? 0;
    const firstAt = recentAt();
    await put(a, 'plan.psd', edited);
    await until('réindexé chez A', () => recentAt() !== firstAt, 60_000);
    const t3 = Date.now();
    await until('modification reçue', () => sameContent(a, b, 'plan.psd'), 60_000);
    if (process.env.BINOME_TIMING) console.log(`réindexation ${t3 - t2} ms, réception ${Date.now() - t3} ms`);
    const delta = b.chunkBytes() - before;
    assert.ok(delta < 1024 * 1024, `seulement ${delta} octets transférés pour 20 Mo`);
  });

  test('suppression et renommage', async () => {
    const [a, b] = await couple();
    const data = randomBytes(2 * 1024 * 1024);
    await put(a, 'a-renommer.bin', data);
    await put(a, 'a-supprimer.txt', 'x');
    await until('reçus', async () => (await sameContent(a, b, 'a-renommer.bin')) && (await exists(b, 'a-supprimer.txt')));

    await unlink(join(a.folder, 'a-supprimer.txt'));
    await until('supprimé chez B', async () => !(await exists(b, 'a-supprimer.txt')));

    const before = b.chunkBytes();
    await rename(join(a.folder, 'a-renommer.bin'), join(a.folder, 'renommé.bin'));
    await until('renommé chez B', async () => (await sameContent(a, b, 'renommé.bin')) && !(await exists(b, 'a-renommer.bin')));
    assert.equal(b.chunkBytes() - before, 0, 'un renommage ne transfère aucun bloc');
  });

  test('les changements faits hors ligne passent à la reconnexion', async () => {
    let [a, b] = await couple();
    await put(a, 'commun.txt', 'v1');
    await until('v1', () => sameContent(a, b, 'commun.txt'));

    await stop(b);
    await put(a, 'commun.txt', 'v2 écrite pendant que Sam était éteint');
    await put(a, 'nouveau.txt', 'créé hors ligne');
    b = await boot('Sam', b.identity, b.dir);
    await until('reconnexion', () => b.state()?.route != null, 30_000);
    await until('rattrapage', async () => (await sameContent(a, b, 'commun.txt')) && (await sameContent(a, b, 'nouveau.txt')), 30_000);
  });

  test('conflit : les deux versions sont gardées, des deux côtés', async () => {
    let [a, b] = await couple();
    await put(a, 'devis.txt', 'origine');
    await until('origine', () => sameContent(a, b, 'devis.txt'));

    await stop(b);
    await put(a, 'devis.txt', 'version Alex');
    await new Promise((r) => setTimeout(r, 1100));
    // Sam modifie pendant qu'il est déconnecté : sa version est plus récente.
    await put(b, 'devis.txt', 'version Sam');
    b = await boot('Sam', b.identity, b.dir);

    await until(
      'convergence',
      async () =>
        (await sameContent(a, b, 'devis.txt')) && (await sameContent(a, b, 'devis.conflit-Alex.txt')),
      30_000,
    );
    assert.equal((await read(a, 'devis.txt'))!.toString(), 'version Sam');
    assert.equal((await read(a, 'devis.conflit-Alex.txt'))!.toString(), 'version Alex');
  });

  test('deux dossiers déjà remplis fusionnent à l’appairage', async () => {
    const a = await boot('Alex');
    const b = await boot('Sam');
    await put(a, 'chez-alex.txt', 'a');
    await put(b, 'chez-sam.txt', 'b');
    await put(a, 'pareil.txt', 'identique');
    await put(b, 'pareil.txt', 'identique');
    await setFolder(a);
    await setFolder(b);
    await pair(a, b);
    await connected(a, b);
    await until(
      'union',
      async () =>
        (await sameContent(a, b, 'chez-alex.txt')) &&
        (await sameContent(a, b, 'chez-sam.txt')) &&
        (await sameContent(a, b, 'pareil.txt')),
    );
    assert.equal(await exists(a, 'pareil.conflit-Sam.txt'), false, 'pas de faux conflit pour un contenu identique');
    assert.equal(await exists(a, 'pareil.conflit-Alex.txt'), false);
  });

  test('un dossier choisi après la connexion reçoit quand même tout', async () => {
    const a = await boot('Alex');
    const b = await boot('Sam');
    await put(a, 'jeu/scene.tscn', 'contenu de la scène');
    await setFolder(a);
    await pair(a, b);
    await connected(a, b);
    // Sam choisit son dossier seulement maintenant, la connexion déjà ouverte.
    await setFolder(b);
    await until('reçu sans reconnexion', () => sameContent(a, b, 'jeu/scene.tscn'));
  });

  test('le cache .godot, .git et node_modules ne partent pas', async () => {
    const [a, b] = await couple();
    await put(a, 'SoulBladyes/project.godot', 'config');
    await put(a, 'SoulBladyes/.godot/imported/voilier.glb-123.scn', 'cache');
    await put(a, 'SoulBladyes/.git/HEAD', 'ref');
    await put(a, 'outil/node_modules/x/index.js', 'x');
    await until('fichier du projet reçu', () => sameContent(a, b, 'SoulBladyes/project.godot'));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await exists(b, 'SoulBladyes/.godot/imported/voilier.glb-123.scn'), false);
    assert.equal(await exists(b, 'SoulBladyes/.git/HEAD'), false);
    assert.equal(await exists(b, 'outil/node_modules/x/index.js'), false);
    assert.equal(a.state()?.sync.files, 1, 'seul project.godot est compté chez Alex');
  });
});
