// Pont entre Claude (serveur MCP) et le moteur. Tout appel passe ici :
// vérification du jeton, de l'autorisation globale et du droit de l'outil, puis journal.

import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { lines, pipePath, readOrCreateToken, type PipeRequest, type PipeResponse } from '../claude/pipe.ts';
import {
  TOOL_NAMES,
  defaultRights,
  errorResult,
  registerTools,
  type ToolName,
  type ToolResult,
} from '../claude/tools.ts';
import type { Db } from './db/index.ts';

export interface ClaudeSettings {
  /** Claude autorisé à utiliser Binôme. Désactivé tant que l'utilisateur ne l'a pas connecté. */
  enabled: boolean;
  rights: Record<ToolName, boolean>;
  /** Option : serveur MCP en HTTP sur 127.0.0.1, pour Claude Code. */
  http: { enabled: boolean; port: number };
}

export const DEFAULT_HTTP_PORT = 47821;

export function defaultClaudeSettings(): ClaudeSettings {
  return { enabled: false, rights: defaultRights(), http: { enabled: false, port: DEFAULT_HTTP_PORT } };
}

/** Complète des réglages lus sur disque (anciennes versions, champs manquants). */
export function normalizeClaudeSettings(raw: Partial<ClaudeSettings> | undefined): ClaudeSettings {
  const d = defaultClaudeSettings();
  const rights = { ...d.rights };
  for (const name of TOOL_NAMES) if (typeof raw?.rights?.[name] === 'boolean') rights[name] = raw.rights[name];
  const port = Number(raw?.http?.port);
  return {
    enabled: raw?.enabled === true,
    rights,
    http: {
      enabled: raw?.http?.enabled === true,
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_HTTP_PORT,
    },
  };
}

export interface ClaudeLogEntry {
  id: number;
  at: number;
  tool: string;
  summary: string;
  outcome: 'ok' | 'refused' | 'error';
  detail: string | null;
}

/** Journal des actions de Claude, dans app.sqlite. */
export class ClaudeLog {
  private readonly q;
  revision = 0;

  constructor(db: Db) {
    this.q = {
      add: db.prepare('INSERT INTO claude_log (at, tool, summary, outcome, detail) VALUES (?, ?, ?, ?, ?)'),
      list: db.prepare('SELECT * FROM claude_log ORDER BY id DESC LIMIT ?'),
      prune: db.prepare('DELETE FROM claude_log WHERE id NOT IN (SELECT id FROM claude_log ORDER BY id DESC LIMIT 1000)'),
    };
  }

  add(e: Omit<ClaudeLogEntry, 'id' | 'at'>): void {
    this.q.add.run(Date.now(), e.tool, e.summary.slice(0, 300), e.outcome, e.detail?.slice(0, 500) ?? null);
    this.q.prune.run();
    this.revision++;
  }

  list(limit = 200): ClaudeLogEntry[] {
    return this.q.list.all(limit) as unknown as ClaudeLogEntry[];
  }
}

/** Résumé lisible d'un appel, pour le journal. */
function summarize(tool: ToolName, args: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (tool) {
    case 'list_files':
      return args.folder ? `dossier ${s(args.folder)}` : 'dossier partagé';
    case 'read_file':
    case 'get_history':
    case 'send_file':
      return s(args.path);
    case 'restore_version':
      return `version ${s(args.version_id)}`;
    case 'send_message':
      return s(args.text).slice(0, 120);
    case 'get_changelog':
      return args.since ? `depuis ${s(args.since)}` : 'récents';
    default:
      return '';
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class ClaudeBridge {
  private pipe: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private http: HttpServer | null = null;
  private httpPort = 0;
  private token = '';

  constructor(
    private readonly opts: {
      dataDir: string;
      settings(): ClaudeSettings;
      exec(tool: ToolName, args: Record<string, unknown>): Promise<ToolResult>;
      log: ClaudeLog;
      onActivity(): void;
    },
  ) {}

  get pipeName(): string {
    return pipePath(this.opts.dataDir);
  }

  async start(): Promise<void> {
    this.token = await readOrCreateToken(this.opts.dataDir);
    if (process.platform !== 'win32') await rm(this.pipeName, { force: true });
    this.pipe = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      lines(socket, (line) => {
        let req: PipeRequest;
        try {
          req = JSON.parse(line) as PipeRequest;
        } catch {
          return socket.destroy();
        }
        const reply = (r: PipeResponse) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(r)}\n`);
        };
        if (typeof req.token !== 'string' || !sameToken(req.token, this.token)) {
          reply({ id: req.id, ok: false, error: 'Jeton invalide' });
          return socket.destroy();
        }
        if (req.op === 'list') return reply({ id: req.id, ok: true, enabled: this.enabledTools() });
        if (req.op === 'call') {
          void this.call(req.tool, req.args ?? {}).then((result) => reply({ id: req.id, ok: true, result }));
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      this.pipe!.once('error', reject);
      this.pipe!.listen(this.pipeName, () => resolve());
    });
    await this.applySettings();
  }

  /** Outils proposés à Claude, selon l'autorisation et les droits. */
  enabledTools(): ToolName[] {
    const s = this.opts.settings();
    return s.enabled ? TOOL_NAMES.filter((n) => s.rights[n]) : [];
  }

  async call(tool: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
    const s = this.opts.settings();
    const summary = TOOL_NAMES.includes(tool) ? summarize(tool, args) : '';
    const done = (outcome: ClaudeLogEntry['outcome'], result: ToolResult, detail: string | null = null) => {
      this.opts.log.add({ tool: String(tool), summary, outcome, detail });
      this.opts.onActivity();
      return result;
    };
    if (!TOOL_NAMES.includes(tool)) return done('refused', errorResult(`Outil inconnu : ${String(tool)}`));
    if (!s.enabled) {
      return done('refused', errorResult('Claude n’est pas autorisé dans Binôme. Active-le dans Paramètres, section Claude'));
    }
    if (!s.rights[tool]) {
      return done('refused', errorResult(`L’outil ${tool} est désactivé dans les réglages de Binôme`));
    }
    try {
      const result = await this.opts.exec(tool, args);
      const text = result.content.find((c) => c.type === 'text')?.text ?? null;
      return done(result.isError ? 'error' : 'ok', result, result.isError ? text : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return done('error', errorResult(message), message);
    }
  }

  /** Démarre ou arrête le serveur HTTP local selon les réglages. */
  async applySettings(): Promise<void> {
    const { http } = this.opts.settings();
    const wanted = http.enabled ? http.port : 0;
    if (wanted === this.httpPort) return;
    await this.stopHttp();
    if (wanted) await this.startHttp(wanted);
  }

  private async startHttp(port: number): Promise<void> {
    const server = createHttpServer(async (req, res) => {
      // Uniquement depuis ce PC, avec le jeton de l'app.
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), this.token)) {
        res.writeHead(401).end();
        return;
      }
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== 'POST') {
        // Mode sans session : pas de flux serveur vers client.
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const mcp = new McpServer({ name: 'binome', version: '1.0.0' });
      const enabled = new Set(this.enabledTools());
      registerTools(mcp, (n, a) => this.call(n, a), (n) => enabled.has(n));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    }).then(
      () => {
        this.http = server;
        this.httpPort = port;
      },
      (err: unknown) => console.error('serveur MCP HTTP :', err),
    );
  }

  private async stopHttp(): Promise<void> {
    const server = this.http;
    this.http = null;
    this.httpPort = 0;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  }

  async stop(): Promise<void> {
    await this.stopHttp();
    const pipe = this.pipe;
    this.pipe = null;
    if (!pipe) return;
    // close() attend la fin des connexions : les serveurs MCP encore branchés sont coupés.
    const closed = new Promise<void>((resolve) => pipe.close(() => resolve()));
    for (const s of this.sockets) s.destroy();
    await closed;
  }
}
