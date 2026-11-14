import type { BrowserWindow } from 'electron';

// Décalages successifs de la fenêtre, en pixels : une secousse courte qui revient au point de départ.
const STEPS: [number, number][] = [
  [-14, 0],
  [12, -5],
  [-10, 5],
  [9, -3],
  [-6, 3],
  [4, -1],
  [-2, 0],
  [0, 0],
];

let shaking = false;

/** Secoue la fenêtre. Agrandie ou plein écran, elle ne peut pas bouger : l'interface secoue son contenu. */
export function shakeWindow(win: BrowserWindow): void {
  if (shaking || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
  if (win.isMaximized() || win.isFullScreen()) return;
  shaking = true;
  const [x, y] = win.getPosition() as [number, number];
  let i = 0;
  const timer = setInterval(() => {
    const step = STEPS[i++];
    if (!step || win.isDestroyed()) {
      clearInterval(timer);
      shaking = false;
      if (!win.isDestroyed()) win.setPosition(x, y);
      return;
    }
    win.setPosition(x + step[0], y + step[1]);
  }, 35);
}
