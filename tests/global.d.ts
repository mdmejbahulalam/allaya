import type { AllayaBridge } from '@allaya/validation';

declare global {
  interface Window {
    allaya: AllayaBridge;
  }
}
