import { createContext, useContext } from 'react';
import type { PreviewTarget } from './preview.ts';

/** Actions qui traversent les vues : ouvrir un aperçu, commenter un fichier dans le chat. */
export interface Ui {
  openPreview(target: PreviewTarget): void;
  discuss(path: string): void;
}

export const UiContext = createContext<Ui>({ openPreview: () => {}, discuss: () => {} });

export const useUi = (): Ui => useContext(UiContext);
