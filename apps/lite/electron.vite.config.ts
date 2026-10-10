import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      // Only package.json `dependencies` (native modules) stay external; everything else is bundled in.
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
    build: { rollupOptions: { input: { index: resolve(__dirname, 'renderer/index.html') } } },
  },
});
