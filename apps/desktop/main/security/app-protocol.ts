import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { protocol } from 'electron';
import type { Logger } from '@allaya/shared';
import { APP_SCHEME, MIME, injectNonce, newNonce, resolveAppRequest } from './app-protocol-core';
import { buildCsp } from './csp';

export { APP_INDEX_URL, APP_ORIGIN, APP_SCHEME } from './app-protocol-core';

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

export function installAppProtocol(options: { rendererRoot: string; logger: Logger }): void {
  const { rendererRoot, logger } = options;
  protocol.handle(APP_SCHEME, async (request) => {
    const resolved = resolveAppRequest(request.url, rendererRoot);
    if (!resolved.ok) {
      logger.warn('Blocked app protocol request', { status: resolved.status });
      return new Response(null, { status: resolved.status });
    }
    try {
      if (!(await stat(resolved.filePath)).isFile()) return new Response(null, { status: 404 });
      const body = await readFile(resolved.filePath);
      const headers: Record<string, string> = {
        'Content-Type':
          MIME[extname(resolved.filePath).toLowerCase()] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      };
      if (resolved.isHtml) {
        const nonce = newNonce();
        headers['Content-Security-Policy'] = buildCsp({ nonce });
        return new Response(injectNonce(body.toString('utf8'), nonce), { headers });
      }
      return new Response(new Uint8Array(body), { headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
