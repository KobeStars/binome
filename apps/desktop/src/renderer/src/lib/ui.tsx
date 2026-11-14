import { createContext, useContext } from 'react';
import type { PreviewTarget } from './preview.ts';

/** Actions qui traversent les vues : ouvrir un aperçu, commenter un fichier, message bref, wizz. */
export interface Ui {
  openPreview(target: PreviewTarget): void;
  discuss(path: string): void;
  /** Message bref en bas de la fenêtre. */
  toast(text: string): void;
  wizz(): Promise<void>;
}

export const UiContext = createContext<Ui>({
  openPreview: () => {},
  discuss: () => {},
  toast: () => {},
  wizz: async () => {},
});

export const useUi = (): Ui => useContext(UiContext);
