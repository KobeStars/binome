// Fin d'un journal en mémoire : ce qu'un processus a écrit juste avant de planter.

export class LogTail {
  private text = '';

  constructor(private readonly max = 16_000) {}

  push(chunk: string | Buffer): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Coupe au début d'une ligne pour ne pas garder un morceau de ligne.
    if (this.text.length > this.max * 2) {
      const cut = this.text.length - this.max;
      const nl = this.text.indexOf('\n', cut);
      this.text = this.text.slice(nl >= 0 && nl - cut < 2_000 ? nl + 1 : cut);
    }
  }

  get value(): string {
    return this.text.length > this.max ? this.text.slice(-this.max) : this.text;
  }

  /** Dernière ligne qui ressemble à une erreur : sert de résumé. */
  lastError(): string | null {
    const lines = this.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/error|erreur|exception|fatal|uncaught|rejection/i.test(lines[i]!)) return lines[i]!.slice(0, 200);
    }
    return null;
  }

  clear(): void {
    this.text = '';
  }
}
