import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { utf8 } from '@binome/protocol';
import { cpaceFinish, cpaceStart } from '../apps/desktop/src/engine/crypto/cpace.ts';
import { startServer } from '../apps/signaling/src/server.ts';
import { SignalingClient, SignalingError } from '../apps/desktop/src/engine/net/signaling.ts';

const channel = utf8('test');

function run(pa: string, pb: string) {
  const sid = randomBytes(16);
  const a = cpaceStart('initiator', utf8(pa), channel, sid);
  const b = cpaceStart('responder', utf8(pb), channel, sid);
  return [cpaceFinish(a, b.share), cpaceFinish(b, a.share)] as const;
}

test('CPace : même mot de passe, même clé', () => {
  const [ka, kb] = run('2913', '2913');
  assert.deepEqual(ka, kb);
});

test('CPace : mot de passe différent, clés différentes', () => {
  const [ka, kb] = run('2913', '2914');
  assert.notDeepEqual(ka, kb);
});

test('CPace : une part neutre est refusée', () => {
  const a = cpaceStart('initiator', utf8('2913'), channel, randomBytes(16));
  assert.throws(() => cpaceFinish(a, new Uint8Array(32)));
});

test('le serveur limite les créations de code par IP', async () => {
  const server = await startServer(0, '127.0.0.1');
  const c = new SignalingClient(`ws://127.0.0.1:${server.port}`);
  await c.connect();
  let limited = false;
  for (let i = 0; i < 11 && !limited; i++) {
    c.send({ t: 'pair.create' });
    await c.waitFor(['pair.created'], 2000).catch((e: unknown) => {
      if (e instanceof SignalingError && e.code === 'rate-limited') limited = true;
    });
  }
  c.close();
  await server.close();
  assert.ok(limited);
});
