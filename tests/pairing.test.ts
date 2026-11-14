import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { toB64 } from '@binome/protocol';
import { startServer, type SignalingServer } from '../apps/signaling/src/server.ts';
import { SignalingClient, SignalingError } from '../apps/desktop/src/engine/net/signaling.ts';
import { generateIdentity, loadIdentity } from '../apps/desktop/src/engine/crypto/identity.ts';
import {
  PairingError,
  authenticate,
  createPairing,
  joinPairing,
  type PeerRecord,
} from '../apps/desktop/src/engine/pairing/index.ts';

let server: SignalingServer;
let url: string;
const clients: SignalingClient[] = [];

async function client(): Promise<SignalingClient> {
  const c = new SignalingClient(url);
  await c.connect();
  clients.push(c);
  return c;
}

/** A crée un code, B le tape (éventuellement modifié par `typed`). */
async function pair(typed: (code: string) => string = (c) => c) {
  const alex = { identity: generateIdentity(), name: 'Alex' };
  const ami = { identity: generateIdentity(), name: 'Sam' };
  const sa = await client();
  const sb = await client();

  let showCode!: (code: string) => void;
  const shown = new Promise<string>((resolve) => (showCode = resolve));
  const a = createPairing(sa, alex, showCode).catch((e: unknown) => e);
  const code = await shown;
  const b = joinPairing(sb, ami, typed(code)).catch((e: unknown) => e);
  return { alex, ami, sa, sb, code, a: await a, b: await b };
}

before(async () => {
  server = await startServer(0, '127.0.0.1', { pairingAttemptsPerMinute: 1000 });
  url = `ws://127.0.0.1:${server.port}`;
});

after(async () => {
  for (const c of clients) c.close();
  await server.close();
});

describe('appairage', () => {
  test('le bon code relie les deux appareils', async () => {
    const r = await pair();
    assert.match(r.code, /^\d{6}$/);
    const a = r.a as PeerRecord;
    const b = r.b as PeerRecord;
    assert.equal(a.pairId, b.pairId);
    assert.equal(a.safetyCode, b.safetyCode);
    assert.equal(a.peerName, 'Sam');
    assert.equal(b.peerName, 'Alex');
    assert.equal(a.peerPub, toB64(r.ami.identity.publicKey));
    assert.equal(b.peerPub, toB64(r.alex.identity.publicKey));
  });

  test('un mauvais code échoue des deux côtés', async () => {
    const r = await pair((code) => code.slice(0, 2) + String((Number(code.slice(2)) + 1) % 10000).padStart(4, '0'));
    assert.ok(r.a instanceof PairingError);
    assert.ok(r.b instanceof PairingError);
    assert.equal(r.a.reason, 'wrong-code');
    assert.equal(r.b.reason, 'wrong-code');
  });

  test('un code ne sert qu’une fois', async () => {
    const wrong = await pair((code) => code.slice(0, 2) + (code.slice(2) === '0000' ? '0001' : '0000'));
    assert.ok(wrong.b instanceof PairingError);
    const again = await joinPairing(await client(), { identity: generateIdentity(), name: 'X' }, wrong.code).catch(
      (e: unknown) => e,
    );
    assert.ok(again instanceof PairingError);
    assert.equal(again.reason, 'unknown-code');
  });

  test('un code inconnu est refusé', async () => {
    const err = await joinPairing(await client(), { identity: generateIdentity(), name: 'X' }, '000000').catch(
      (e: unknown) => e,
    );
    assert.ok(err instanceof PairingError);
    assert.equal(err.reason, 'unknown-code');
  });

  test('la clé privée exportée se recharge', () => {
    const id = generateIdentity();
    const back = loadIdentity(id.exportPrivate());
    assert.deepEqual(back.publicKey, id.publicKey);
  });
});

describe('salon de la paire', () => {
  test('présence et relais des messages de signal', async () => {
    const r = await pair();
    const a = r.a as PeerRecord;
    const b = r.b as PeerRecord;

    const sa = await client();
    const sb = await client();
    assert.equal(await authenticate(sa, r.alex.identity, a), false);

    const online = sa.waitFor(['presence'], 2000);
    assert.equal(await authenticate(sb, r.ami.identity, b), true);
    assert.equal((await online).online, true);

    const got = sb.waitFor(['signal'], 2000);
    sa.send({ t: 'signal', data: 'offre-sdp' });
    assert.equal((await got).data, 'offre-sdp');

    const offline = sa.waitFor(['presence'], 2000);
    sb.close();
    assert.equal((await offline).online, false);
  });

  test('une signature fausse est refusée', async () => {
    const r = await pair();
    const a = r.a as PeerRecord;
    const s = await client();
    const intruder = generateIdentity();
    s.send({
      t: 'auth',
      pub: toB64(r.alex.identity.publicKey),
      peerPub: a.peerPub,
      sig: toB64(intruder.sign(new Uint8Array(8))),
    });
    const err = await s.waitFor(['auth.ok'], 2000).catch((e: unknown) => e);
    assert.ok(err instanceof SignalingError);
    assert.equal(err.code, 'bad-auth');
  });
});
