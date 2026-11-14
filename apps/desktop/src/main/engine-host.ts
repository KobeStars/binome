import { join } from 'node:path';
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import type { EngineCommand, EngineEvent } from '../engine/api.ts';
import type { EngineInit } from '../engine/index.ts';
import { LogTail } from './log-tail.ts';

export interface EngineCrash {
  code: number;
  /** Fin de ce que le moteur a écrit avant de s'arrêter. */
  log: string;
  /** Dernière ligne d'erreur, sert de résumé. */
  lastError: string | null;
}

/**
 * Lance le moteur dans un processus à part et le relance s'il plante.
 * Chaque chargement de l'interface reçoit son propre MessagePort vers le moteur :
 * l'état et la progression ne passent pas par le main.
 */
export class EngineHost {
  private child: UtilityProcess | null = null;
  private quitting = false;
  private readonly views = new Set<WebContents>();
  /** Ce que le moteur écrit, gardé pour le rapport de plantage. */
  private readonly log = new LogTail();
  /** Commandes du main arrivées pendant une relance du moteur. */
  private pending: EngineCommand[] = [];

  constructor(
    private readonly init: EngineInit,
    private readonly onEvent: (event: EngineEvent) => void,
    private readonly onCrash: (crash: EngineCrash) => void = () => {},
  ) {}

  start(): void {
    const child = utilityProcess.fork(join(import.meta.dirname, 'engine.mjs'), [], {
      serviceName: 'Binôme moteur',
      // Sorties récupérées pour le journal de plantage, puis recopiées dans celles du main.
      stdio: 'pipe',
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => {
      this.log.push(d);
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      this.log.push(d);
      process.stderr.write(d);
    });
    child.postMessage({ type: 'init', init: this.init });
    for (const command of this.pending.splice(0)) child.postMessage({ type: 'command', command });
    child.on('message', (event: EngineEvent) => this.onEvent(event));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.quitting) return;
      console.error(`moteur arrêté (code ${code}), relance dans 1 s`);
      if (code !== 0) this.onCrash({ code, log: this.log.value, lastError: this.log.lastError() });
      this.log.clear();
      setTimeout(() => {
        this.start();
        for (const view of this.views) this.connect(view);
      }, 1000);
    });
  }

  /** Commande du main (rapport de plantage, wizz). Moteur en train de redémarrer : elle attend. */
  command(command: EngineCommand): void {
    if (this.child) this.child.postMessage({ type: 'command', command });
    else this.pending.push(command);
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
