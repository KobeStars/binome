import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_CHUNK,
  MIN_CHUNK,
  chunkBuffer,
  chunkFile,
  decodeManifest,
  encodeManifest,
} from '../apps/desktop/src/engine/sync/chunker.ts';
import { openDb } from '../apps/desktop/src/engine/db/index.ts';
import { ChunkStore } from '../apps/desktop/src/engine/sync/store.ts';
import { compare, merge } from '../apps/desktop/src/engine/sync/vv.ts';
import { conflictPath, safeRemotePath } from '../apps/desktop/src/engine/sync/paths.ts';

const keys = (chunks: { hash: Buffer }[]) => new Set(chunks.map((c) => c.hash.toString('hex')));

test('FastCDC : tailles dans les bornes, moyenne proche de 64 Kio', () => {
  const data = randomBytes(16 * 1024 * 1024);
  const chunks = chunkBuffer(data);
  assert.equal(
    chunks.reduce((n, c) => n + c.size, 0),
    data.length,
  );
  for (const c of chunks.slice(0, -1)) assert.ok(c.size >= MIN_CHUNK && c.size <= MAX_CHUNK);
  const avg = data.length / chunks.length;
  assert.ok(avg > 40 * 1024 && avg < 100 * 1024, `moyenne ${avg}`);
});

test('FastCDC : un octet inséré au milieu ne change que quelques blocs', () => {
  const data = randomBytes(8 * 1024 * 1024);
  const edited = Buffer.concat([data.subarray(0, 4_000_000), Buffer.from([42]), data.subarray(4_000_000)]);
  const before = keys(chunkBuffer(data));
  const after = chunkBuffer(edited);
  const fresh = after.filter((c) => !before.has(c.hash.toString('hex')));
  assert.ok(fresh.length <= 3, `${fresh.length} blocs nouveaux sur ${after.length}`);
});

test('FastCDC : le flux depuis un fichier coupe comme en mémoire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'binome-chunk-'));
  try {
    const data = randomBytes(10 * 1024 * 1024 + 123);
    await writeFile(join(dir, 'f.bin'), data);
    const fromFile = await chunkFile(join(dir, 'f.bin'), () => {});
    assert.deepEqual(
      fromFile.chunks.map((c) => c.hash.toString('hex')),
      chunkBuffer(data).map((c) => c.hash.toString('hex')),
    );
    assert.equal(fromFile.size, data.length);
    assert.deepEqual(decodeManifest(encodeManifest(fromFile.chunks)), fromFile.chunks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('magasin : blocs et manifestes survivent à la réouverture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'binome-store-'));
  try {
    const data = randomBytes(3 * 1024 * 1024);
    let db = openDb(join(dir, 'db.sqlite'));
    let store = new ChunkStore(db, join(dir, 'store'));
    const chunks = chunkBuffer(data);
    let off = 0;
    for (const c of chunks) {
      store.put(c.hash, data.subarray(off, off + c.size));
      off += c.size;
    }
    store.putManifest('abc', chunks);
    store.close();
    db.close();

    db = openDb(join(dir, 'db.sqlite'));
    store = new ChunkStore(db, join(dir, 'store'));
    const back = Buffer.concat(store.getManifest('abc')!.map((c) => store.get(c.hash)!));
    assert.ok(back.equals(data));
    store.close();
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('magasin : un pack à moitié vide est réécrit puis supprimé', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'binome-pack-'));
  try {
    const db = openDb(join(dir, 'db.sqlite'));
    const store = new ChunkStore(db, join(dir, 'store'));
    // 70 Mo de blocs : le premier pack (64 Mo) se remplit, un second commence.
    const blocks = Array.from({ length: 280 }, () => randomBytes(256 * 1024));
    const refs = blocks.map((b) => ({ hash: chunkBuffer(b)[0]!.hash, size: b.length }));
    blocks.forEach((b, i) => store.put(refs[i]!.hash, b));
    assert.equal((await readdir(join(dir, 'store'))).length, 2);

    // On ne garde que 40 blocs du premier pack : il passe sous la moitié.
    const kept = refs.slice(200, 280).concat(refs.slice(0, 40));
    store.putManifest('garde', kept);
    store.putManifest('jete', refs.slice(40, 200));
    store.gc(new Set(['garde']), 0);

    const packs = await readdir(join(dir, 'store'));
    assert.ok(!packs.includes('pack-000001.bin'), `premier pack supprimé (${packs.join(', ')})`);
    for (const r of kept) assert.ok(store.get(r.hash)?.length === r.size);
    assert.equal(store.get(refs[100]!.hash), null);
    store.close();
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('vecteurs de version', () => {
  assert.equal(compare({ a: 2, b: 1 }, { a: 1, b: 1 }), 'newer');
  assert.equal(compare({ a: 1 }, { a: 1, b: 1 }), 'older');
  assert.equal(compare({ a: 2 }, { b: 1 }), 'concurrent');
  assert.equal(compare({}, {}), 'equal');
  assert.deepEqual(merge({ a: 2 }, { a: 1, b: 3 }), { a: 2, b: 3 });
});

test('chemins reçus : refus des chemins dangereux', () => {
  assert.equal(safeRemotePath('docs/plan.psd'), 'docs/plan.psd');
  for (const bad of ['../x', 'a/../b', '/etc', 'C:/x', 'a\\b', 'con.txt', 'a/nul', 'x.', '.binome/t', '~$doc.docx', '']) {
    assert.equal(safeRemotePath(bad), null, bad);
  }
  assert.equal(conflictPath('docs/plan.psd', 'Sam'), 'docs/plan.conflit-Sam.psd');
  assert.equal(conflictPath('Makefile', 'Sam'), 'Makefile.conflit-Sam');
});
