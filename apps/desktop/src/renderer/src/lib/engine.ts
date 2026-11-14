import { useEffect, useState } from 'react';
import type {
  EngineCommand,
  EngineEvent,
  EngineReplies,
  EngineRequest,
  EngineState,
  ToEngine,
} from '../../../engine/api.ts';
import type { BinomeApi } from '../../../preload/index.ts';

declare global {
  interface Window {
    binome: BinomeApi;
  }
}

let port: MessagePort | null = null;
const listeners = new Set<(s: EngineState) => void>();
let latest: EngineState | null = null;

// Le preload relaie le port à chaque (re)lancement du moteur.
window.addEventListener('message', (e) => {
  if (e.data !== 'binome:engine-port' || !e.ports[0]) return;
  port?.close();
  port = e.ports[0];
  port.onmessage = (m: MessageEvent<EngineEvent>) => {
    const ev = m.data;
    if (ev.ev === 'reply') {
      const p = pending.get(ev.id);
      pending.delete(ev.id);
      if (ev.ok) p?.resolve(ev.data);
      else p?.reject(new Error(ev.error ?? 'Erreur'));
      return;
    }
    if (ev.ev !== 'state') return;
    latest = ev.state;
    for (const fn of listeners) fn(latest);
  };
});

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;

export function send(command: EngineCommand): void {
  port?.postMessage(command satisfies ToEngine);
}

/** Question au moteur, avec réponse. */
export function request<R extends EngineRequest>(r: R): Promise<EngineReplies[R['req']]> {
  if (!port) return Promise.reject(new Error('Moteur non connecté'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    port!.postMessage({ id, request: r } satisfies ToEngine);
  });
}

export function useEngine(): EngineState | null {
  const [state, setState] = useState(latest);
  useEffect(() => {
    listeners.add(setState);
    if (latest) setState(latest);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

export const api = (): BinomeApi => window.binome;
