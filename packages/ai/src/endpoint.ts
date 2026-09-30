import { AllayaError } from '@allaya/shared';

export type EndpointCheck =
  { ok: true; url: string; local: boolean } | { ok: false; reason: EndpointRefusal };

export type EndpointRefusal =
  'empty' | 'malformed' | 'scheme' | 'credentials' | 'query' | 'insecure_remote' | 'too_long';

/** `localhost`, `127.x.x.x` and `::1`: the computer's own address, where nothing crosses a network. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '::1'
  );
}

/**
 * Whether an address is acceptable for sending a key and prompts to. Cleartext (`http:`) is allowed only for this
 * computer; anything on a network must be `https:`, so a key never crosses a network unencrypted. Addresses with a
 * user name, password, query or fragment are refused: those are how secrets leak into logs and screenshots.
 */
export function checkEndpointUrl(raw: string): EndpointCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > 300) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (!url.hostname) return { ok: false, reason: 'malformed' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.search || url.hash) return { ok: false, reason: 'query' };
  const local = isLoopbackHost(url.hostname);
  if (url.protocol === 'http:' && !local) return { ok: false, reason: 'insecure_remote' };
  return { ok: true, url: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), local };
}

/** The same check, as the error the IPC layer returns. */
export function requireEndpointUrl(raw: string): string {
  const check = checkEndpointUrl(raw);
  if (check.ok) return check.url;
  throw new AllayaError('That address cannot be used', {
    code: 'INVALID_INPUT',
    details: { reason: check.reason },
  });
}
