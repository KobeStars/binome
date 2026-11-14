import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sync } from '../apps/desktop/src/engine/sync/sync.ts';
import { VERSIONS_PER_FILE } from '../apps/desktop/src/engine/sync/history.ts';
import { boot, couple, put, read, sameContent, stop, until, useSyncEnv, type Device } from './helpers/sync-env.ts';

useSyncEnv();

const versions = (d: Device, path: string) => d.engine.request({ req: 'history.versions', path });

/** Écrit une nouvelle version et attend qu'elle soit indexée chez l'auteur et reçue chez l'autre. */
async function newVersion(a: Device, b: Device, path: string, content: string): Promise<void> {
  await put(a, path, content);
  await until(`version « ${content} »`, async () => (await read(b, path))?.toString() === content);
}

describe('historique des versions', () => {
  test('on garde les 10 dernières versions et on restaure en un clic, des deux côtés', async () => {
    const [a, b] = await couple();
    for (let i = 1; i <= 12; i++) await newVersion(a, b, 'plan.txt', `version ${i}`);

    const listA = await versions(a, 'plan.txt');
    const listB = await versions(b, 'plan.txt');
    assert.equal(listA.length, VERSIONS_PER_FILE);
    assert.equal(listB.length, VERSIONS_PER_FILE);
    assert.ok(listB[0]!.current && !listB[1]!.current);
    assert.equal(listB[0]!.by, 'Alex');

    // Sam restaure la plus ancienne version gardée (version 3).
    const oldest = listB[listB.length - 1]!;
    await b.engine.request({ req: 'history.restore', versionId: oldest.id });
    assert.equal((await read(b, 'plan.txt'))!.toString(), 'version 3');
    await until('restauration reçue chez Alex', async () => (await read(a, 'plan.txt'))?.toString() === 'version 3');
    const after = await versions(a, 'plan.txt');
    assert.equal(after[0]!.by, 'Sam', 'la restauration est une nouvelle version, de Sam');
  });

  test('corbeille : un fichier supprimé se restaure', async () => {
    const [a, b] = await couple();
    await put(a, 'devis.pdf', randomBytes(300_000));
    await until('reçu', () => sameContent(a, b, 'devis.pdf'));
    const original = await read(a, 'devis.pdf');

    await unlink(join(a.folder, 'devis.pdf'));
    await until('supprimé chez Sam', async () => (await read(b, 'devis.pdf')) === null);

    let trash = await b.engine.request({ req: 'history.trash' });
    await until('dans la corbeille de Sam', async () => {
      trash = await b.engine.request({ req: 'history.trash' });
      return trash.some((t) => t.path === 'devis.pdf');
    });
    const item = trash.find((t) => t.path === 'devis.pdf')!;
    assert.equal(item.by, 'Alex');
    assert.ok(item.expiresAt - item.deletedAt === 30 * 24 * 3600 * 1000);

    await b.engine.request({ req: 'history.restore', versionId: item.versionId });
    await until('restauré des deux côtés', () => sameContent(a, b, 'devis.pdf'));
    assert.ok((await read(a, 'devis.pdf'))!.equals(original!));
    await until('sorti de la corbeille', async () => {
      const t = await b.engine.request({ req: 'history.trash' });
      return !t.some((x) => x.path === 'devis.pdf');
    });
  });

  test('un conflit est signalé des deux côtés, puis marqué comme vu', async () => {
    let [a, b] = await couple();
    await put(a, 'texte.md', 'origine');
    await until('origine', () => sameContent(a, b, 'texte.md'));
    await stop(b);
    await put(a, 'texte.md', 'Alex');
    await new Promise((r) => setTimeout(r, 1100));
    await put(b, 'texte.md', 'Sam');
    b = await boot('Sam', b.identity, b.dir);

    await until('conflit signalé des deux côtés', () =>
      (a.state()?.sync.conflicts.length ?? 0) === 1 && (b.state()?.sync.conflicts.length ?? 0) === 1,
    30_000);
    const c = a.state()!.sync.conflicts[0]!;
    assert.equal(c.path, 'texte.md');
    assert.equal(c.aside, 'texte.conflit-Alex.md');
    assert.equal(c.keptBy, 'Sam');
    await a.engine.command({ cmd: 'conflict.dismiss', id: c.id });
    await until('marqué comme vu', () => a.state()?.sync.conflicts.length === 0);
  });
});

describe('nettoyage du magasin', () => {
  async function localSync(cap = Infinity) {
    const dir = await mkdtemp(join(tmpdir(), 'binome-gc-'));
    const root = join(dir, 'Partage');
    await mkdir(root);
    const sync = new Sync({
      root,
      dataDir: join(dir, 'data'),
      device: 'moi',
      nameOf: () => 'Moi',
      onChange: () => {},
      onRemoteChange: () => {},
      historyCapBytes: () => cap,
    });
    await sync.start();
    return { dir, root, sync };
  }

  test('corbeille vidée après 30 jours, blocs libérés', async () => {
    const { dir, root, sync } = await localSync();
    try {
      await writeFile(join(root, 'gros.bin'), randomBytes(4 * 1024 * 1024));
      await sync.reindex('gros.bin');
      await unlink(join(root, 'gros.bin'));
      await sync.reindex('gros.bin');
      assert.equal(sync.trash().length, 1);

      // Avant 30 jours : rien n'est libéré, la corbeille garde le contenu.
      sync.runGc({ minAgeMs: 0 });
      assert.ok(sync.storeBytes() >= 4 * 1024 * 1024);

      const in31days = Date.now() + 31 * 24 * 3600 * 1000;
      const freed = sync.runGc({ now: in31days, minAgeMs: 0 });
      assert.equal(sync.trash(in31days).length, 0);
      assert.ok(freed.bytes >= 4 * 1024 * 1024, `libéré ${freed.bytes}`);
      assert.equal(sync.storeBytes(), 0);
    } finally {
      await sync.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('plafond : les versions les plus anciennes partent, jamais la version actuelle', async () => {
    const { dir, root, sync } = await localSync(3 * 1024 * 1024);
    try {
      for (let i = 0; i < 4; i++) {
        await writeFile(join(root, 'f.bin'), randomBytes(1024 * 1024));
        await sync.reindex('f.bin');
      }
      assert.ok(sync.storeBytes() >= 4 * 1024 * 1024);
      sync.runGc({ minAgeMs: 0 });
      assert.ok(sync.storeBytes() <= 3 * 1024 * 1024, `taille ${sync.storeBytes()}`);
      const list = sync.versionsOf('f.bin');
      const current = sync.index.get('f.bin')!;
      assert.equal(list.filter((v) => v.hash).at(0)?.hash, current.hash);
      // La version actuelle se reconstruit toujours.
      const restorable = list.find((v) => v.hash === current.hash)!;
      await sync.restore(restorable.id);
    } finally {
      await sync.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('un bloc récent n’est jamais supprimé', async () => {
    const { dir, root, sync } = await localSync();
    try {
      await writeFile(join(root, 'a.bin'), randomBytes(1024 * 1024));
      await sync.reindex('a.bin');
      // Bloc orphelin tout juste écrit (fichier en cours d'indexation, par exemple).
      const orphan = randomBytes(20_000);
      const { createHash } = await import('node:crypto');
      const h = createHash('sha256').update(orphan).digest();
      sync.store.put(h, orphan);
      sync.runGc();
      assert.ok(sync.store.has(h), 'bloc récent gardé');
      sync.runGc({ minAgeMs: 0 });
      assert.ok(!sync.store.has(h), 'bloc ancien et orphelin supprimé');
    } finally {
      await sync.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
