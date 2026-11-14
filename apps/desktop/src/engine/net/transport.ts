/** Par où passent les octets. Affiché dans l'interface. */
export type Route = 'lan' | 'internet' | 'relay';

/**
 * Un tuyau de trames binaires fiable et ordonné vers l'autre appareil.
 * Il ne chiffre rien : c'est le rôle de `crypto/session`.
 */
export interface Transport {
  route(): Route;
  send(frame: Uint8Array): void;
  /** Se résout quand le tampon d'envoi a assez baissé pour continuer. */
  drain(): Promise<void>;
  /** Un seul écouteur. Les trames arrivées avant sont gardées. */
  onFrame(fn: (frame: Uint8Array) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

export const HIGH_WATER = 4 * 1024 * 1024;
export const LOW_WATER = 1024 * 1024;

/** Base commune : file d'attente des trames et des écouteurs de fermeture. */
export abstract class BaseTransport implements Transport {
  private frameListener: ((frame: Uint8Array) => void) | null = null;
  private pending: Uint8Array[] = [];
  private closeListeners: (() => void)[] = [];
  protected closed = false;

  abstract route(): Route;
  abstract send(frame: Uint8Array): void;
  abstract drain(): Promise<void>;
  protected abstract shutdown(): void;

  onFrame(fn: (frame: Uint8Array) => void): void {
    this.frameListener = fn;
    const queued = this.pending;
    this.pending = [];
    for (const f of queued) fn(f);
  }

  onClose(fn: () => void): void {
    if (this.closed) queueMicrotask(fn);
    else this.closeListeners.push(fn);
  }

  protected deliver(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.frameListener) this.frameListener(frame);
    else this.pending.push(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdown();
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const fn of listeners) fn();
  }
}
