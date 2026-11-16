// Point d'entrée du processus moteur (utilityProcess).

import type { MessagePortMain } from 'electron';
import type { EngineCommand, EngineEvent, ToEngine } from './api.ts';
import { Engine } from './core.ts';
import { loadIdentity } from './crypto/identity.ts';
import { shutdownWebRTC } from './net/peer.ts';

export interface EngineInit {
  dataDir: string;
  inboxDir: string;
  signalingUrl: string;
  defaultName: string;
  identityPkcs8: Uint8Array;
  forceRelay?: boolean;
  appVersion?: string;
  libraryDir?: string;
}

/** `command` : commande venue du main (rapport de plantage, wizz depuis l'icône). */
type HostMessage =
  | { type: 'init'; init: EngineInit }
  | { type: 'port' }
  | { type: 'stop' }
  | { type: 'command'; command: EngineCommand };

const parent = process.parentPort;
const ports = new Set<MessagePortMain>();
let engine: Engine | null = null;
/** Les commandes du main attendent la fin du démarrage (base ouverte). */
let started: Promise<void> | null = null;

function broadcast(event: EngineEvent): void {
  for (const port of ports) port.postMessage(event);
  // Le main ne s'intéresse qu'aux événements qui déclenchent une notification.
  if (event.ev !== 'state') parent.postMessage(event);
}

parent.on('message', (e: { data: HostMessage; ports: MessagePortMain[] }) => {
  const msg = e.data;
  if (msg.type === 'init' && !engine) {
    const { init } = msg;
    engine = new Engine(
      {
        dataDir: init.dataDir,
        inboxDir: init.inboxDir,
        signalingUrl: init.signalingUrl,
        defaultName: init.defaultName,
        identity: loadIdentity(init.identityPkcs8),
        link: { forceRelay: init.forceRelay },
        appVersion: init.appVersion,
        libraryDir: init.libraryDir,
      },
      broadcast,
    );
    started = engine.start().catch((err: unknown) => {
      // Le main relance le moteur et note le plantage avec la fin de ce journal.
      console.error('démarrage du moteur :', err);
      process.exit(1);
    });
  }

  if (msg.type === 'command' && started) {
    const command = msg.command;
    void started
      .then(() => engine?.command(command))
      .catch((err: unknown) => console.error('commande du main :', err));
  }

  if (msg.type === 'port') {
    const port = e.ports[0];
    if (!port) return;
    ports.add(port);
    port.on('message', (m: { data: ToEngine }) => {
      const msg = m.data;
      if ('request' in msg) {
        const reply = (r: Omit<Extract<EngineEvent, { ev: 'reply' }>, 'ev' | 'id'>) =>
          port.postMessage({ ev: 'reply', id: msg.id, ...r } satisfies EngineEvent);
        if (!engine) return reply({ ok: false, error: 'Moteur pas prêt' });
        engine.request(msg.request).then(
          (data) => reply({ ok: true, data }),
          (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
        return;
      }
      void engine?.command(msg);
    });
    port.on('close', () => ports.delete(port));
    port.start();
    if (engine?.ready) port.postMessage({ ev: 'state', state: engine.snapshot } satisfies EngineEvent);
  }

  if (msg.type === 'stop') {
    void engine?.stop().finally(() => {
      shutdownWebRTC();
      process.exit(0);
    });
  }
});
