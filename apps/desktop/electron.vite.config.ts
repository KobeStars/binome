import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// @binome/protocol est du TypeScript source : on l'intègre au bundle au lieu de l'externaliser.
const externalizeDeps = { exclude: ['@binome/protocol', '@noble/curves', '@noble/hashes'] };

export default defineConfig({
  main: {
    build: {
      externalizeDeps,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
          mcp: resolve(__dirname, 'src/claude/server.ts'),
        },
        // .mjs : le serveur MCP tourne hors de l'archive asar, loin du package.json qui déclare l'ESM.
        output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps,
      rollupOptions: {
        // Preload en CommonJS : obligatoire avec le bac à sable activé.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    // Pas de PostCSS : sans ça, Vite remonte l'arborescence et prend une config d'un autre projet.
    css: { postcss: {} },
  },
});
