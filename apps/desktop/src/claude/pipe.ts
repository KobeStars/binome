// Canal local entre le serveur MCP (lancé par Claude) et le moteur de Binôme déjà ouvert.
// Un « named pipe » Windows par profil, et un jeton lu dans les données de l'app :
// seul le compte Windows de l'utilisateur peut lire ce fichier.
// Format : une ligne JSON par message.

import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { ToolName, ToolResult } from './tools.ts';

export const TOKEN_FILE = 'claude-token';

/** Nom du canal, dérivé du dossier de données normalisé (barres, casse) : même résultat des deux côtés. */
export function pipePath(dataDir: string): string {
  const id = createHash('sha256').update(resolve(dataDir).toLowerCase()).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\binome-${id}` : join(dataDir, 'claude.sock');
}

export async function readToken(dataDir: string): Promise<string | null> {
  return readFile(join(dataDir, TOKEN_FILE), 'utf8').then(
    (t) => t.trim() || null,
    () => null,
  );
}

export async function readOrCreateToken(dataDir: string): Promise<string> {
  const existing = await readToken(dataDir);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  await writeFile(join(dataDir, TOKEN_FILE), token, { mode: 0o600 });
  return token;
}

export type PipeRequest =
  | { id: number; token: string; op: 'list' }
  | { id: number; token: string; op: 'call'; tool: ToolName; args: Record<string, unknown> };

export type PipeResponse =
  | { id: number; ok: true; enabled?: ToolName[]; result?: ToolResult }
  | { id: number; ok: false; error: string };

/** Omit appliqué à chaque membre de l'union. */
type WithoutAuth<T> = T extends unknown ? Omit<T, 'id' | 'token'> : never;

/** Découpe un flux en lignes JSON. */
export function lines(socket: Socket, onLine: (line: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
    // Une ligne de plus de 8 Mo est un abus : on coupe.
    if (buf.length > 8 * 1024 * 1024) socket.destroy();
  });
}

/** Client du canal, côté serveur MCP. Se reconnecte à chaque appel si l'app a redémarré. */
export class PipeClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, (r: PipeResponse) => void>();

  constructor(
    private readonly path: string,
    private readonly token: () => Promise<string | null>,
  ) {}

  private async open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(this.path);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    lines(socket, (line) => {
      try {
        const r = JSON.parse(line) as PipeResponse;
        this.waiting.get(r.id)?.(r);
        this.waiting.delete(r.id);
      } catch {
        // ligne illisible : ignorée
      }
    });
    socket.on('close', () => {
      for (const fn of this.waiting.values()) fn({ id: 0, ok: false, error: 'Binôme s’est fermé pendant l’appel' });
      this.waiting.clear();
      if (this.socket === socket) this.socket = null;
    });
    socket.on('error', () => {});
    this.socket = socket;
    return socket;
  }

  async request(req: WithoutAuth<PipeRequest>, timeoutMs = 180_000): Promise<PipeResponse> {
    const token = await this.token();
    if (!token) return { id: 0, ok: false, error: 'Binôme n’a jamais été lancé sur ce PC' };
    let socket: Socket;
    try {
      socket = await this.open();
    } catch {
      return { id: 0, ok: false, error: 'Binôme n’est pas ouvert. Lance l’app, puis réessaie' };
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ id, ok: false, error: 'Binôme ne répond pas' });
      }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      socket.write(`${JSON.stringify({ ...req, id, token })}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}
