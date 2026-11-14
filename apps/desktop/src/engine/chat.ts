// Mini chat entre les deux PC, dans le canal chiffré. Un message écrit hors ligne
// attend dans la base et part à la reconnexion ; l'accusé de réception le marque envoyé.

import { randomBytes } from 'node:crypto';
import type { PeerMessage } from '@binome/protocol';
import type { Db } from './db/index.ts';

export const MAX_MESSAGE = 4000;

export interface ChatMessage {
  id: string;
  mine: boolean;
  text: string;
  file: string | null;
  at: number;
  status: 'pending' | 'sent' | 'received' | 'read';
  via: 'claude' | null;
}

interface Row {
  id: string;
  mine: number;
  text: string;
  file: string | null;
  at: number;
  status: ChatMessage['status'];
  via: string | null;
}

const fromRow = (r: Row): ChatMessage => ({ ...r, mine: r.mine === 1, via: r.via === 'claude' ? 'claude' : null });

export class Chat {
  private readonly q;
  private send: ((m: PeerMessage) => boolean) | null = null;
  /** Messages reçus pas encore lus (survit à un redémarrage). */
  unread: number;
  revision = 0;

  constructor(
    db: Db,
    private readonly onReceive: (m: ChatMessage) => void,
    private readonly onChange: () => void,
  ) {
    this.q = {
      insert: db.prepare('INSERT OR IGNORE INTO chat (id, mine, text, file, at, status, via) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      status: db.prepare('UPDATE chat SET status = ? WHERE id = ?'),
      pending: db.prepare("SELECT * FROM chat WHERE mine = 1 AND status = 'pending' ORDER BY at"),
      page: db.prepare('SELECT * FROM chat WHERE at < ? ORDER BY at DESC LIMIT ?'),
      unread: db.prepare("SELECT COUNT(*) AS n FROM chat WHERE mine = 0 AND status = 'received'"),
      readAll: db.prepare("UPDATE chat SET status = 'read' WHERE mine = 0 AND status = 'received'"),
    };
    this.unread = (this.q.unread.get() as { n: number }).n;
  }

  /** Canal ouvert : on vide la file d'attente. */
  attach(send: (m: PeerMessage) => boolean): void {
    this.send = send;
    for (const m of (this.q.pending.all() as unknown as Row[]).map(fromRow)) this.transmit(m);
  }

  detach(): void {
    this.send = null;
  }

  write(text: string, file: string | null = null, via: 'claude' | null = null): ChatMessage {
    const clean = text.trim().slice(0, MAX_MESSAGE);
    if (!clean) throw new Error('Message vide');
    const m: ChatMessage = {
      id: randomBytes(12).toString('hex'),
      mine: true,
      text: clean,
      file: file && file.length <= 1024 ? file : null,
      at: Date.now(),
      status: 'pending',
      via,
    };
    this.q.insert.run(m.id, 1, m.text, m.file, m.at, m.status, m.via);
    this.changed();
    this.transmit(m);
    return m;
  }

  private transmit(m: ChatMessage): void {
    this.send?.({ t: 'chat', id: m.id, text: m.text, file: m.file, at: m.at, ...(m.via ? { via: m.via } : {}) });
  }

  handle(msg: Extract<PeerMessage, { t: 'chat' | 'chat.ack' }>): void {
    if (msg.t === 'chat.ack') {
      if (typeof msg.id === 'string') {
        this.q.status.run('sent', msg.id);
        this.changed();
      }
      return;
    }
    if (typeof msg.id !== 'string' || msg.id.length > 64 || typeof msg.text !== 'string') return;
    const text = msg.text.slice(0, MAX_MESSAGE);
    const file = typeof msg.file === 'string' && msg.file.length <= 1024 ? msg.file : null;
    const at = Number.isFinite(msg.at) ? msg.at : Date.now();
    const via = msg.via === 'claude' ? 'claude' : null;
    // Un renvoi après coupure a le même identifiant : on ne l'ajoute qu'une fois.
    const inserted = this.q.insert.run(msg.id, 0, text, file, at, 'received', via).changes > 0;
    this.send?.({ t: 'chat.ack', id: msg.id });
    if (!inserted) return;
    this.unread++;
    this.changed();
    this.onReceive({ id: msg.id, mine: false, text, file, at, status: 'received', via });
  }

  /** Les `limit` messages avant `before`, du plus ancien au plus récent. */
  page(before = Number.MAX_SAFE_INTEGER, limit = 100): ChatMessage[] {
    return (this.q.page.all(before, limit) as unknown as Row[]).map(fromRow).reverse();
  }

  markRead(): void {
    if (this.unread === 0) return;
    this.q.readAll.run();
    this.unread = 0;
    this.changed();
  }

  private changed(): void {
    this.revision++;
    this.onChange();
  }
}
