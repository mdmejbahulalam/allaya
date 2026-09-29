/**
 * The main process serves index.html with a fresh CSP nonce in <meta name="csp-nonce">.
 * Libraries that inject <style> elements (react-remove-scroll-bar via `__webpack_nonce__`,
 * Radix Select via a `nonce` prop) must stamp them with it or the strict CSP blocks them.
 */
const PLACEHOLDER = '__CSP_NONCE__';

let cached: string | undefined;

export function getStyleNonce(): string | undefined {
  if (cached !== undefined) return cached || undefined;
  const value = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
  // In dev the placeholder is never substituted (and the dev CSP allows inline styles).
  cached = value === PLACEHOLDER ? '' : value;
  return cached || undefined;
}

export function installStyleNonce(): void {
  const nonce = getStyleNonce();
  if (nonce) (globalThis as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
}
