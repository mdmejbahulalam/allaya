import { session, shell, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { Logger } from '@allaya/shared';
import type { Sender } from '../ipc/dispatcher';
import { APP_ORIGIN } from './app-protocol-core';
import { buildCsp } from './csp';

export interface SecurityConfig {
  /** The dev server (electron-vite dev), or undefined when packaged. */
  devServerUrl?: string | undefined;
  logger: Logger;
}

export function isTrustedUrl(url: string, config: Pick<SecurityConfig, 'devServerUrl'>): boolean {
  try {
    const parsed = new URL(url);
    if (`${parsed.protocol}//${parsed.host}` === APP_ORIGIN) return true;
    if (config.devServerUrl && parsed.origin === new URL(config.devServerUrl).origin) return true;
  } catch {
    /* not a URL */
  }
  return false;
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

export interface PermissionQuery {
  permission: string;
  url: string;
  mediaTypes: ReadonlyArray<'video' | 'audio' | 'unknown'> | undefined;
}

/**
 * The whole permission policy for the app's own screen: the microphone (never the camera) for our own pages, and
 * nothing else. Web pages in the built-in browser have their own session and their own, stricter, policy.
 */
export function isPermissionAllowed(
  query: PermissionQuery,
  config: Pick<SecurityConfig, 'devServerUrl'>,
): boolean {
  if (query.permission !== 'media') return false;
  if (!isTrustedUrl(query.url, config)) return false;
  const types = query.mediaTypes;
  return Array.isArray(types) && types.length > 0 && types.every((type) => type === 'audio');
}

export function hardenSession(target: Session, config: SecurityConfig): void {
  if (config.devServerUrl) {
    const csp = buildCsp({ devServerUrl: config.devServerUrl });
    const devOrigin = new URL(config.devServerUrl).origin;
    target.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      if (new URL(details.url).origin === devOrigin) headers['Content-Security-Policy'] = [csp];
      callback({ responseHeaders: headers });
    });
  }
  target.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const allowed = isPermissionAllowed(
      {
        permission,
        url: details.requestingUrl,
        mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
      },
      config,
    );
    if (!allowed) config.logger.warn('Denied a permission request', { permission });
    callback(allowed);
  });
  target.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    isPermissionAllowed(
      {
        permission,
        url: requestingOrigin,
        mediaTypes: 'mediaType' in details && details.mediaType === 'audio' ? ['audio'] : undefined,
      },
      config,
    ),
  );
}

/** No popups, no leaving the app's own pages, no embedded web views. */
export function hardenWebContents(contents: WebContents, config: SecurityConfig): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url, config)) {
      event.preventDefault();
      config.logger.warn('Blocked a navigation');
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function senderFromEvent(event: {
  sender: WebContents;
  senderFrame?: { url: string; parent: unknown } | null;
}): Sender {
  return {
    id: event.sender.id,
    frameUrl: event.senderFrame?.url ?? '',
    isMainFrame: event.senderFrame ? event.senderFrame.parent === null : false,
  };
}

export function applySecurity(window: BrowserWindow, config: SecurityConfig): void {
  hardenSession(window.webContents.session ?? session.defaultSession, config);
  hardenWebContents(window.webContents, config);
}
