import WebSocket from 'ws';
import {
  SIGNALING_VERSION,
  parseMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@binome/protocol';

type MessageOf<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

export class SignalingError extends Error {
  constructor(
    readonly code: ErrorCode | 'timeout' | 'closed' | 'version' | 'pair-closed',
    message: string,
  ) {
    super(message);
  }
}

interface Waiter {
  types: ReadonlySet<ServerMessage['t']>;
  resolve(msg: ServerMessage): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** Types de messages qu'on garde si personne ne les attend encore. */
const BUFFERED = new Set<ServerMessage['t']>(['pair.created', 'pair.peer', 'pair.msg', 'pair.closed', 'auth.ok']);
const MAX_BUFFERED = 32;

/**
 * Connexion au serveur de signalisation.
 * `waitFor` sert aux échanges en question-réponse (appairage, auth),
 * `on` aux messages qui arrivent n'importe quand (présence, signal).
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private inbox: ServerMessage[] = [];
  private waiters = new Set<Waiter>();
  private listeners = new Map<ServerMessage['t'], Set<(msg: ServerMessage) => void>>();
  private binaryListeners = new Set<(frame: Uint8Array) => void>();
  private closeListeners = new Set<() => void>();
  private ended = false;
  nonce = '';

  constructor(readonly url: string) {}

  /** Ouvre la connexion et attend le défi du serveur. */
  async connect(timeoutMs = 10_000): Promise<void> {
    const ws = new WebSocket(this.url, { handshakeTimeout: timeoutMs });
    this.ws = ws;
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) return this.receive(raw.toString());
      const buf = raw as Buffer;
      const frame = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      for (const fn of this.binaryListeners) fn(frame);
    });
    ws.on('close', () => {
      this.ended = true;
      this.failAll(new SignalingError('closed', 'Connexion au serveur perdue'));
      for (const fn of this.closeListeners) fn();
      this.closeListeners.clear();
    });
    ws.on('error', () => {
      // `close` suit toujours `error`, c'est lui qui prévient les attentes.
    });

    const challenge = await this.waitFor(['challenge'], timeoutMs);
    if (challenge.v !== SIGNALING_VERSION) {
      this.close();
      throw new SignalingError('version', 'Le serveur utilise une autre version du protocole');
    }
    this.nonce = challenge.nonce;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new SignalingError('closed', 'Pas connecté au serveur');
    this.ws.send(JSON.stringify(msg));
  }

  /** Trame binaire pour le relais. Le serveur la transmet telle quelle à l'autre appareil. */
  sendBinary(frame: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new SignalingError('closed', 'Pas connecté au serveur');
    this.ws.send(frame, { binary: true });
  }

  /** Octets en attente d'envoi, pour freiner l'émetteur. */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onBinary(fn: (frame: Uint8Array) => void): () => void {
    this.binaryListeners.add(fn);
    return () => this.binaryListeners.delete(fn);
  }

  /** Appelé une fois, quand la connexion se ferme. */
  onClose(fn: () => void): () => void {
    if (this.ended || this.ws === null) {
      queueMicrotask(fn);
      return () => {};
    }
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /**
   * Attend le prochain message d'un des types donnés.
   * Rejette sur un message `error` du serveur, sur la fermeture, ou après `timeoutMs`.
   */
  waitFor<T extends ServerMessage['t']>(types: T[], timeoutMs: number): Promise<MessageOf<T>> {
    const wanted = new Set<ServerMessage['t']>(types);
    const index = this.inbox.findIndex((m) => wanted.has(m.t));
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0] as MessageOf<T>);

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        types: wanted,
        resolve: (msg) => resolve(msg as MessageOf<T>),
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new SignalingError('timeout', 'Le serveur ne répond pas'));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  on<T extends ServerMessage['t']>(type: T, fn: (msg: MessageOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const handler = fn as (msg: ServerMessage) => void;
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private receive(raw: string): void {
    const msg = parseMessage<ServerMessage>(raw);
    if (!msg) return;

    if (msg.t === 'error') {
      // Une erreur répond à la dernière demande : elle rejette les attentes en cours.
      const err = new SignalingError(msg.code, msg.message);
      if (this.waiters.size > 0) this.failAll(err);
      for (const fn of this.listeners.get('error') ?? []) fn(msg);
      return;
    }

    for (const fn of this.listeners.get(msg.t) ?? []) fn(msg);

    for (const waiter of this.waiters) {
      if (waiter.types.has(msg.t)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(msg);
        return;
      }
    }

    if (BUFFERED.has(msg.t) || msg.t === 'challenge') {
      this.inbox.push(msg);
      if (this.inbox.length > MAX_BUFFERED) this.inbox.shift();
    }
  }

  private failAll(err: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.waiters.clear();
  }
}
