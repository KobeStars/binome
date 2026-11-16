import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readToken } from '../apps/desktop/src/claude/pipe.ts';
import { TOOL_NAMES } from '../apps/desktop/src/claude/catalog.ts';
import { couple, put, read, sameContent, until, useSyncEnv, type Device } from './helpers/sync-env.ts';

useSyncEnv();

const SERVER = join(import.meta.dirname, '..', 'apps', 'desktop', 'src', 'claude', 'server.ts');
const clients: Client[] = [];

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

/** Lance le serveur MCP comme le ferait Claude Desktop, et s'y connecte. */
async function claudeFor(d: Device): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', SERVER, '--data', join(d.dir, 'data')],
    cwd: join(import.meta.dirname, '..'),
    stderr: 'inherit',
    // Le SDK ne transmet qu'une liste réduite de variables : sous Electron, ELECTRON_RUN_AS_NODE doit suivre,
    // comme dans la config générée pour Claude Desktop.
    env: { ...(process.env as Record<string, string>) },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

type Content = { type: string; text?: string; data?: string };
const textOf = (r: unknown) => ((r as { content?: Content[] }).content ?? []).map((c) => c.text ?? '').join('\n');
const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

function setAutoConfirm(d: Device, answer: boolean, seen: string[] = []): string[] {
  (d.engine as unknown as { cfg: { autoConfirm?: (t: string) => boolean } }).cfg.autoConfirm = (t) => {
    seen.push(t);
    return answer;
  };
  return seen;
}

describe('serveur MCP', () => {
  test('tant que Claude n’est pas autorisé, chaque appel est refusé et journalisé', async () => {
    const [a] = await couple();
    const claude = await claudeFor(a);
    assert.equal((await names(claude)).length, TOOL_NAMES.length, 'tous les outils sont déclarés, avec un message utile');
    const r = await claude.callTool({ name: 'list_files', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /pas autorisé/);
    const log = await a.engine.request({ req: 'claude.log' });
    assert.equal(log[0]?.outcome, 'refused');
  });

  test('lecture seule par défaut : lister, lire, état, historique, changements', async () => {
    const [a, b] = await couple();
    await put(a, 'docs/brief.md', '# Brief\nAffiche A2');
    await until('reçu', () => sameContent(a, b, 'docs/brief.md'));
    await a.engine.command({ cmd: 'claude.settings', enabled: true });

    const claude = await claudeFor(a);
    assert.deepEqual(await names(claude), ['get_changelog', 'get_history', 'get_library', 'get_status', 'list_files', 'read_file']);

    assert.match(textOf(await claude.callTool({ name: 'list_files', arguments: {} })), /docs\/brief\.md/);
    assert.match(textOf(await claude.callTool({ name: 'read_file', arguments: { path: 'docs/brief.md' } })), /Affiche A2/);
    assert.match(textOf(await claude.callTool({ name: 'get_status', arguments: {} })), /Binôme : Sam/);
    assert.match(textOf(await claude.callTool({ name: 'get_history', arguments: { path: 'docs/brief.md' } })), /version_id=\d+/);
    assert.match(textOf(await claude.callTool({ name: 'get_changelog', arguments: {} })), /Alex a ajouté docs\/brief\.md/);

    const escape = await claude.callTool({ name: 'read_file', arguments: { path: '../data/claude-token' } });
    assert.equal(escape.isError, true, 'impossible de sortir du dossier partagé');

    // Un outil d'écriture désactivé est refusé même si un client l'appelle quand même.
    const write = await claude.callTool({ name: 'send_message', arguments: { text: 'salut' } });
    assert.equal(write.isError, true);
  });

  test('écriture : message et restauration marqués « via Claude » des deux côtés, avec confirmation', async () => {
    const [a, b] = await couple();
    await put(a, 'devis.txt', 'v1');
    await until('v1', () => sameContent(a, b, 'devis.txt'));
    await put(a, 'devis.txt', 'v2');
    await until('v2', async () => (await read(b, 'devis.txt'))?.toString() === 'v2');
    await a.engine.command({
      cmd: 'claude.settings',
      enabled: true,
      rights: { send_message: true, restore_version: true, send_file: true },
    });
    const claude = await claudeFor(a);

    await claude.callTool({ name: 'send_message', arguments: { text: 'Le devis est prêt', file: 'devis.txt' } });
    await until('message reçu', () => b.state()?.chat.unread === 1);
    const [msg] = await b.engine.request({ req: 'chat.list' });
    assert.equal(msg!.via, 'claude');
    assert.equal(msg!.file, 'devis.txt');

    const history = textOf(await claude.callTool({ name: 'get_history', arguments: { path: 'devis.txt' } }));
    const v1 = Number(/version_id=(\d+)\t[^\n]*restaurable/.exec(history)?.[1]);

    const refused = setAutoConfirm(a, false);
    const no = await claude.callTool({ name: 'restore_version', arguments: { version_id: v1 } });
    assert.equal(no.isError, true);
    assert.match(refused[0] ?? '', /Claude veut restaurer devis\.txt/);
    assert.equal((await read(a, 'devis.txt'))!.toString(), 'v2');

    setAutoConfirm(a, true);
    const yes = await claude.callTool({ name: 'restore_version', arguments: { version_id: v1 } });
    assert.notEqual(yes.isError, true, textOf(yes));
    await until('restauré chez Sam', async () => (await read(b, 'devis.txt'))?.toString() === 'v1');
    await until('marqué via Claude chez Sam', async () => {
      const list = await b.engine.request({ req: 'history.versions', path: 'devis.txt' });
      return list[0]?.via === true;
    });
    const mine = await a.engine.request({ req: 'history.versions', path: 'devis.txt' });
    assert.equal(mine[0]!.via, true);

    // Hors du dossier partagé, l'envoi demande confirmation.
    const asked = setAutoConfirm(a, false);
    const out = await claude.callTool({ name: 'send_file', arguments: { path: 'C:\\Windows\\win.ini' } });
    assert.equal(out.isError, true);
    assert.match(asked[0] ?? '', /Claude veut envoyer/);
  });

  test('option HTTP locale, protégée par le jeton', async () => {
    const [a] = await couple();
    const port = 48_000 + Math.floor(Math.random() * 1000);
    await a.engine.command({ cmd: 'claude.settings', enabled: true, http: { enabled: true, port } });
    const token = await readToken(join(a.dir, 'data'));
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    const denied = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401);

    const client = new Client({ name: 'test-http', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client);
    assert.ok((await names(client)).includes('get_status'));
    assert.match(textOf(await client.callTool({ name: 'get_status', arguments: {} })), /Binôme : Sam/);

    const connect = await a.engine.request({ req: 'claude.connect' });
    assert.match(connect.desktopConfig, /ELECTRON_RUN_AS_NODE/);
    assert.match(connect.codeCommand, /^claude mcp add binome/);
    assert.match(connect.httpCommand ?? '', new RegExp(`127\\.0\\.0\\.1:${port}/mcp`));
  });
});
