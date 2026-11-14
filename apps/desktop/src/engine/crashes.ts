// Rapports de plantage : enregistrés sur ce PC et envoyés à l'autre dès que le canal est ouvert.
// Même principe que le chat : file d'attente hors ligne, accusé de réception, dédoublonnage.

import { randomBytes } from 'node:crypto';
import type { PeerMessage } from '@binome/protocol';
import type { Db } from './db/index.ts';

/** Fin du journal gardée dans un rapport : tient largement dans une trame chiffrée. */
export const CRASH_LOG_MAX = 16_000;
const SUMMARY_MAX = 300;
const KEEP = 50;

export type CrashStatus = 'local' | 'pending' | 'sent' | 'received' | 'seen';

export interface CrashReport {
  /** Partie de l'app qui a planté : engine, renderer, main. */
  kind: string;
  summary: string;
  log: string;
  /** Version de l'app au moment du plantage. */
  app: string;
  at?: number;
}

export interface CrashEntry {
  id: string;
  mine: boolean;
  at: number;
  app: string;
  kind: string;
  summary: string;
  log: string;
  status: CrashStatus;
}

interface Row extends Omit<CrashEntry, 'mine'> {
  mine: number;
}

const fromRow = (r: Row): CrashEntry => ({ ...r, mine: r.mine === 1 });

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.slice(0, max) : '');
/** Garde la fin d'un journal : c'est là que se trouve l'erreur. */
const tail = (s: unknown, max: number): string => (typeof s === 'string' ? s.slice(-max) : '');

export class Crashes {
  private readonly q;
  private send: ((m: PeerMessage) => boolean) | null = null;
  /** Plantages de l'autre pas encore vus. */
  unseen: number;
  revision = 0;

  constructor(
    db: Db,
    private readonly onReceive: (c: CrashEntry) => void,
    private readonly onChange: () => void,
  ) {
    this.q = {
      insert: db.prepare(
        'INSERT OR IGNORE INTO crashes (id, mine, at, app, kind, summary, log, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      status: db.prepare('UPDATE crashes SET status = ? WHERE id = ? AND mine = 1'),
      pending: db.prepare("SELECT * FROM crashes WHERE mine = 1 AND status = 'pending' ORDER BY at"),
      list: db.prepare('SELECT * FROM crashes ORDER BY at DESC LIMIT ?'),
      unseen: db.prepare("SELECT COUNT(*) AS n FROM crashes WHERE mine = 0 AND status = 'received'"),
      seenAll: db.prepare("UPDATE crashes SET status = 'seen' WHERE mine = 0 AND status = 'received'"),
      unshare: db.prepare("UPDATE crashes SET status = 'local' WHERE mine = 1 AND status = 'pending'"),
      prune: db.prepare('DELETE FROM crashes WHERE id NOT IN (SELECT id FROM crashes ORDER BY at DESC LIMIT ?)'),
    };
    this.unseen = (this.q.unseen.get() as { n: number }).n;
  }

  /** Canal ouvert : les rapports en attente partent, si le partage est activé. */
  attach(send: (m: PeerMessage) => boolean, share: boolean): void {
    this.send = send;
    if (!share) return;
    for (const c of (this.q.pending.all() as unknown as Row[]).map(fromRow)) this.transmit(c);
  }

  detach(): void {
    this.send = null;
  }

  /** Nouveau plantage sur ce PC. `share` : à envoyer à l'autre. */
  record(r: CrashReport, share: boolean): CrashEntry {
    const c: CrashEntry = {
      id: randomBytes(12).toString('hex'),
      mine: true,
      at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : Date.now(),
      app: clip(r.app, 32) || '?',
      kind: clip(r.kind, 32) || 'app',
      summary: clip(r.summary, SUMMARY_MAX) || 'Plantage',
      log: tail(r.log, CRASH_LOG_MAX),
      status: share ? 'pending' : 'local',
    };
    this.q.insert.run(c.id, 1, c.at, c.app, c.kind, c.summary, c.log, c.status);
    this.prune();
    this.changed();
    if (share) this.transmit(c);
    return c;
  }

  /** Partage coupé : ce qui attendait reste sur ce PC. */
  stopSharing(): void {
    this.q.unshare.run();
    this.changed();
  }

  handle(msg: Extract<PeerMessage, { t: 'crash' | 'crash.ack' }>): void {
    if (msg.t === 'crash.ack') {
      if (typeof msg.id === 'string' && this.q.status.run('sent', msg.id).changes > 0) this.changed();
      return;
    }
    if (typeof msg.id !== 'string' || !/^[0-9a-f]{8,64}$/.test(msg.id)) return;
    const c: CrashEntry = {
      id: msg.id,
      mine: false,
      at: Number.isFinite(msg.at) ? msg.at : Date.now(),
      app: clip(msg.app, 32) || '?',
      kind: clip(msg.kind, 32) || 'app',
      summary: clip(msg.summary, SUMMARY_MAX) || 'Plantage',
      log: tail(msg.log, CRASH_LOG_MAX),
      status: 'received',
    };
    // Un renvoi après coupure a le même identifiant : on ne l'ajoute qu'une fois, mais on l'accuse toujours.
    const inserted = this.q.insert.run(c.id, 0, c.at, c.app, c.kind, c.summary, c.log, c.status).changes > 0;
    this.send?.({ t: 'crash.ack', id: c.id });
    if (!inserted) return;
    this.prune();
    this.changed();
    this.onReceive(c);
  }

  /** Garde les 50 derniers rapports ; le compteur de non-vus suit. */
  private prune(): void {
    this.q.prune.run(KEEP);
    this.unseen = (this.q.unseen.get() as { n: number }).n;
  }

  /** Du plus récent au plus ancien. */
  list(limit = KEEP): CrashEntry[] {
    return (this.q.list.all(limit) as unknown as Row[]).map(fromRow);
  }

  markSeen(): void {
    if (this.unseen === 0) return;
    this.q.seenAll.run();
    this.unseen = 0;
    this.changed();
  }

  private transmit(c: CrashEntry): void {
    this.send?.({ t: 'crash', id: c.id, at: c.at, app: c.app, kind: c.kind, summary: c.summary, log: c.log });
  }

  private changed(): void {
    this.revision++;
    this.onChange();
  }
}
