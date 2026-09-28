import { pathToFileURL } from 'node:url';
import { shell, session, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { Logger } from '@allaya/shared';
import type { SenderInfo } from '../ipc/dispatcher';
import { buildCsp } from './csp';

export interface SecurityConfig {
  /** Dev-server origin (electron-vite) or undefined in packaged/production mode. */
  devServerUrl?: string;
  rendererIndexPath: string;
  logger: Logger;
}

export function isTrustedRendererUrl(
  url: string,
  config: Pick<SecurityConfig, 'devServerUrl' | 'rendererIndexPath'>,
): boolean {
  try {
    const parsed = new URL(url);
    if (config.devServerUrl) {
      const dev = new URL(config.devServerUrl);
      if (parsed.origin === dev.origin) return true;
    }
    if (parsed.protocol === 'file:') {
      const expected = pathToFileURL(config.rendererIndexPath);
      return parsed.pathname === expected.pathname;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:'
    );
  } catch {
    return false;
  }
}

/** Session-level hardening applied once at startup. */
export function hardenSession(target: Session, config: SecurityConfig): void {
  const csp = buildCsp(config.devServerUrl);
  target.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    // Only inject on our own documents; leave third-party responses alone.
    if (isTrustedRendererUrl(details.url, config) || details.url.startsWith('file:')) {
      headers['Content-Security-Policy'] = [csp];
    }
    callback({ responseHeaders: headers });
  });

  // Deny every web-platform permission by default. Microphone is enabled explicitly by the
  // voice feature (through the permission center) for our own origin only.
  target.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed = permission === 'media' && isTrustedRendererUrl(details.requestingUrl, config);
    if (!allowed) config.logger.warn('Denied web permission request', { permission });
    callback(allowed && microphoneAllowed.value);
  });
  target.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return (
      permission === 'media' &&
      microphoneAllowed.value &&
      isTrustedRendererUrl(requestingOrigin, config)
    );
  });
}

/** Toggled by the permissions center; the renderer cannot flip this itself. */
export const microphoneAllowed = { value: false };

/** Per-webContents hardening: no popups, no navigation away, no webviews. */
export function hardenWebContents(contents: WebContents, config: SecurityConfig): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, config)) {
      event.preventDefault();
      config.logger.warn('Blocked navigation');
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function senderFromEvent(event: {
  sender: WebContents;
  senderFrame?: { url: string; parent: unknown } | null;
}): SenderInfo {
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
