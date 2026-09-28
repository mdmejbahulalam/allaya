/**
 * Strict Content Security Policy. The renderer never talks to the network — every AI, browser
 * and file operation goes through the trusted main process — so `connect-src` is `'self'` only.
 * Dev mode additionally allows the Vite HMR websocket and the inline scripts/styles Vite injects.
 * Pure module (no Electron imports) so the renderer build can embed the same policy as a <meta> tag.
 */
export function buildCsp(devServerUrl?: string): string {
  const dev = Boolean(devServerUrl);
  const ws = devServerUrl ? devServerUrl.replace(/^http/, 'ws') : '';
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': dev ? ["'self'", ws, devServerUrl ?? ''] : ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.filter(Boolean).join(' ')}`)
    .join('; ');
}
