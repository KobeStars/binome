import type { SignalingClient } from './signaling.ts';
import { BaseTransport, HIGH_WATER, LOW_WATER, type Route } from './transport.ts';

/**
 * Transport de secours : les trames passent par le WebSocket du serveur.
 * Elles sont déjà chiffrées par la session, le serveur ne voit que du bruit.
 */
export class RelayTransport extends BaseTransport {
  private readonly offBinary: () => void;
  private readonly offClose: () => void;

  constructor(private readonly sig: SignalingClient) {
    super();
    this.offBinary = sig.onBinary((frame) => this.deliver(frame.slice()));
    this.offClose = sig.onClose(() => this.close());
  }

  route(): Route {
    return 'relay';
  }

  send(frame: Uint8Array): void {
    if (this.closed) throw new Error('Relais fermé');
    this.sig.sendBinary(frame);
  }

  async drain(): Promise<void> {
    if (this.sig.bufferedAmount < HIGH_WATER) return;
    while (!this.closed && this.sig.bufferedAmount > LOW_WATER) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  protected shutdown(): void {
    this.offBinary();
    this.offClose();
  }
}
