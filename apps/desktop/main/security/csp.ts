/**
 * Strict Content Security Policy. The renderer never talks to the network — every AI, browser
 * and file operation goes through the trusted main process — so `connect-src` is `'self'` only.
 *
 * Production: no `unsafe-inline`/`unsafe-eval` anywhere. Injected <style> elements (Radix scroll-lock,
 * Select viewport) are allowed only when they carry the per-response nonce.
 * Dev additionally allows the Vite HMR websocket and the inline scripts/styles Vite injects.
 * Pure module (no Electron imports) so it can be unit-tested and shared.
 */
export interface CspOptions {
  devServerUrl?: string | undefined;
  /** Per-response nonce for library-injected <style> elements. */
  nonce?: string | undefined;
}

export function buildCsp({ devServerUrl, nonce }: CspOptions = {}): string {
  const dev = Boolean(devServerUrl);
  const ws = devServerUrl ? devServerUrl.replace(/^http/, 'ws') : '';
  const styleElem = dev
    ? ["'self'", "'unsafe-inline'"]
    : ["'self'", ...(nonce ? [`'nonce-${nonce}'`] : [])];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // Inline style *attributes* written by markup stay blocked; React/motion use the CSSOM, which CSP allows.
    'style-src': ["'self'"],
    'style-src-elem': styleElem,
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': dev ? ["'self'", ws, devServerUrl ?? ''] : ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.filter(Boolean).join(' ')}`)
    .join('; ');
}
