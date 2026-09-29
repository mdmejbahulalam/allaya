import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      // Only package.json `dependencies` (native / dynamically loaded modules) stay external.
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'main/index.ts') } },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads can only require('electron'); everything else must be bundled in.
      externalizeDeps: false,
      rollupOptions: { input: { index: resolve(__dirname, 'preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@renderer': resolve(__dirname, 'renderer/src') } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'renderer/index.html') } } },
  },
});
