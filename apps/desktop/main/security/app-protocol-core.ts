import { randomBytes } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';

/** Pure (Electron-free) parts of the app protocol so they can be unit-tested in plain Node. */
export const APP_SCHEME = 'allaya-app';
export const APP_ORIGIN = `${APP_SCHEME}://app`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;
export const NONCE_PLACEHOLDER = '__CSP_NONCE__';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export type ResolvedRequest =
  { ok: true; filePath: string; isHtml: boolean } | { ok: false; status: 400 | 403 | 404 };

/**
 * Maps a request URL to a file inside `root`, or rejects it. Pure (no I/O) so traversal handling is
 * unit-tested exhaustively. Anything that could escape `root` — encoded dots/slashes, backslashes,
 * drive letters, NUL bytes, absolute paths — is refused, never "normalised into" something valid.
 */
export function resolveAppRequest(requestUrl: string, root: string): ResolvedRequest {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, status: 400 };
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== 'app') return { ok: false, status: 403 };

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  if (pathname.includes('\0') || pathname.includes('\\') || /^\/[a-zA-Z]:/.test(pathname)) {
    return { ok: false, status: 403 };
  }
  if (pathname.split('/').some((segment) => segment === '..' || segment === '.')) {
    return { ok: false, status: 403 };
  }

  const rootResolved = resolve(root);
  const filePath = resolve(join(rootResolved, pathname));
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + sep)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, filePath, isHtml: extname(filePath).toLowerCase() === '.html' };
}

export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Injects the nonce the renderer bootstrap reads (see renderer `main.tsx`). */
export function injectNonce(html: string, nonce: string): string {
  return html.split(NONCE_PLACEHOLDER).join(nonce);
}
