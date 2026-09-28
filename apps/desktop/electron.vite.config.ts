import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { buildCsp } from './main/security/csp';

/** Embeds the production CSP as a <meta> tag: response-header hooks are unreliable for file:// loads. */
function cspMetaPlugin(): Plugin {
  return {
    name: 'allaya-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: buildCsp() },
        injectTo: 'head-prepend',
      },
    ],
  };
}

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
    plugins: [react(), tailwindcss(), cspMetaPlugin()],
    resolve: { alias: { '@renderer': resolve(__dirname, 'renderer/src') } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'renderer/index.html') } } },
  },
});
