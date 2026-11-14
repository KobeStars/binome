/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
  /** Adresse du serveur de signalisation, fixée au build. */
  readonly MAIN_VITE_SIGNALING_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
