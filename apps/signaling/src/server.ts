import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
  MAX_RELAY_FRAME,
  NAMEPLATE_DIGITS,
  SIGNALING_VERSION,
  parseMessage,
  type ClientMessage,
} from '@binome/protocol';
import { Conn } from './conn.ts';
import { Pairings } from './pairing.ts';
import { Rooms } from './rooms.ts';

const HEARTBEAT_MS = 25_000;
const NAMEPLATE_RE = new RegExp(`^\\d{${NAMEPLATE_DIGITS}}$`);

function clientIp(req: IncomingMessage): string {
  // Railway place le client en tête de X-Forwarded-For.
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

export interface SignalingServer {
  port: number;
  close(): Promise<void>;
}

export interface ServerOptions {
  /** Limite par IP des créations et essais de code. 10 par défaut. */
  pairingAttemptsPerMinute?: number;
}

export function startServer(port: number, host = '0.0.0.0', options: ServerOptions = {}): Promise<SignalingServer> {
  const pairings = new Pairings(options.pairingAttemptsPerMinute);
  const rooms = new Rooms();
  const conns = new Set<Conn>();

  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, v: SIGNALING_VERSION, conns: conns.size, rooms: rooms.size }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, maxPayload: MAX_RELAY_FRAME });

  wss.on('connection', (ws, req) => {
    const conn = new Conn(ws, clientIp(req));
    conns.add(conn);
    conn.send({ t: 'challenge', nonce: conn.nonce, v: SIGNALING_VERSION });

    ws.on('pong', () => {
      conn.alive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!conn.frames.take()) return ws.close(4008, 'rate-limited');
        return rooms.relay(conn, raw as Buffer);
      }
      if (!conn.messages.take()) return ws.close(4008, 'rate-limited');
      const msg = parseMessage<ClientMessage>(raw.toString());
      if (!msg) return conn.error('bad-message', 'Message illisible');

      switch (msg.t) {
        case 'pair.create':
          return pairings.create(conn);
        case 'pair.join':
          if (typeof msg.nameplate !== 'string' || !NAMEPLATE_RE.test(msg.nameplate)) {
            return conn.error('bad-message', 'Code mal formé');
          }
          return pairings.join(conn, msg.nameplate);
        case 'pair.msg':
          if (typeof msg.data !== 'string') return conn.error('bad-message', 'Données manquantes');
          return pairings.forward(conn, msg.data);
        case 'pair.done':
          return pairings.done(conn);
        case 'pair.fail':
          return pairings.fail(conn);
        case 'auth':
          if (typeof msg.pub !== 'string' || typeof msg.peerPub !== 'string' || typeof msg.sig !== 'string') {
            return conn.error('bad-message', 'Champs manquants');
          }
          return rooms.auth(conn, msg.pub, msg.peerPub, msg.sig);
        case 'signal':
          if (typeof msg.data !== 'string') return conn.error('bad-message', 'Données manquantes');
          return rooms.signal(conn, msg.data);
        default:
          return conn.error('bad-message', 'Type inconnu');
      }
    });

    ws.on('close', () => {
      conns.delete(conn);
      pairings.left(conn);
      rooms.leave(conn);
    });
  });

  // Les connexions mortes (Wi-Fi coupé, veille) ne ferment pas toujours proprement.
  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
    pairings.sweep();
  }, HEARTBEAT_MS);

  return new Promise((resolve) => {
    http.listen(port, host, () => {
      resolve({
        port: (http.address() as AddressInfo).port,
        close: () =>
          new Promise((done) => {
            clearInterval(heartbeat);
            for (const conn of conns) conn.ws.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}
