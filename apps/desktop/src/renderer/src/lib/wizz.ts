// Effet d'un wizz reçu : un bourdonnement bref et le contenu de la fenêtre qui tremble.
// Le son est synthétisé : pas de fichier audio à embarquer.

let ctx: AudioContext | null = null;

function buzz(): void {
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    // Deux bourdonnements rapprochés.
    for (const [start, freq] of [
      [0, 190],
      [0.16, 150],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, now + start);
      osc.connect(gain);
      gain.gain.exponentialRampToValueAtTime(0.08, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.13);
      osc.start(now + start);
      osc.stop(now + start + 0.14);
    }
  } catch {
    // Pas de sortie audio : la secousse suffit.
  }
}

/** Secousse du contenu (la fenêtre elle-même est secouée par le main quand elle peut bouger). */
export function wizzEffect(): void {
  buzz();
  const root = document.documentElement;
  root.classList.remove('is-wizzed');
  // Relance l'animation si un wizz arrive pendant la précédente.
  void root.offsetWidth;
  root.classList.add('is-wizzed');
  setTimeout(() => root.classList.remove('is-wizzed'), 700);
}
