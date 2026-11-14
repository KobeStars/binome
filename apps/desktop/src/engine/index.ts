// Point d'entrée du processus moteur (utilityProcess).

import type { MessagePortMain } from 'electron';
import type { EngineEvent, ToEngine } from './api.ts';
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
}

type HostMessage = { type: 'init'; init: EngineInit } | { type: 'port' } | { type: 'stop' };

const parent = process.parentPort;
const ports = new Set<MessagePortMain>();
let engine: Engine | null = null;

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
      },
      broadcast,
    );
    void engine.start();
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
