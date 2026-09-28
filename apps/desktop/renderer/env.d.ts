/// <reference types="vite/client" />
import type { AllayaBridge } from '@allaya/validation';

declare global {
  interface Window {
    /** Injected by the sandboxed preload script; the renderer's only door to the main process. */
    allaya: AllayaBridge;
  }
}
