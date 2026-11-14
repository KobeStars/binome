import { join } from 'node:path';
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import type { EngineEvent } from '../engine/api.ts';
import type { EngineInit } from '../engine/index.ts';

/**
 * Lance le moteur dans un processus à part et le relance s'il plante.
 * Chaque chargement de l'interface reçoit son propre MessagePort vers le moteur :
 * l'état et la progression ne passent pas par le main.
 */
export class EngineHost {
  private child: UtilityProcess | null = null;
  private quitting = false;
  private readonly views = new Set<WebContents>();

  constructor(
    private readonly init: EngineInit,
    private readonly onEvent: (event: EngineEvent) => void,
  ) {}

  start(): void {
    const child = utilityProcess.fork(join(import.meta.dirname, 'engine.mjs'), [], {
      serviceName: 'Binôme moteur',
      stdio: 'inherit',
    });
    this.child = child;
    child.postMessage({ type: 'init', init: this.init });
    child.on('message', (event: EngineEvent) => this.onEvent(event));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.quitting) return;
      console.error(`moteur arrêté (code ${code}), relance dans 1 s`);
      setTimeout(() => {
        this.start();
        for (const view of this.views) this.connect(view);
      }, 1000);
    });
  }

  /** Donne un port vers le moteur à une fenêtre. À rappeler après chaque rechargement. */
  connect(view: WebContents): void {
    this.views.add(view);
    view.once('destroyed', () => this.views.delete(view));
    if (!this.child) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ type: 'port' }, [port1]);
    view.postMessage('engine-port', null, [port2]);
  }

  stop(): void {
    this.quitting = true;
    this.child?.postMessage({ type: 'stop' });
  }
}
