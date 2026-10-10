/** Search engine for what is not an address. A page with no script needed, so it works for reading too. */
export const SEARCH_URL = 'https://duckduckgo.com/?q=';

/** A scheme is letters and then a colon — but not "localhost:3000", where digits follow: that is a port. */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;
/** "example.com", "sub.example.co.uk/path", "localhost:3000" — a name and maybe a path, no spaces. */
const LOOKS_LIKE_HOST = /^(?:[\p{L}\p{M}\p{N}-]+\.)+[\p{L}\p{M}]{2,}(?::\d+)?(?:[/?#]\S*)?$/u;

/** What the person typed in the address box: an address, or words to search for. */
export function addressFromInput(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (SCHEME.test(text) && !/^[a-z]:[\\/]/i.test(text)) {
    // "javascript:", "file:", "data:" and the rest are not for the browser pane; only web addresses are.
    return /^https?:\/\//i.test(text) ? text : undefined;
  }
  if (!/\s/.test(text)) {
    // "localhost" is on this computer, which does not speak https unless it has been set up to.
    if (/^localhost(?::\d+)?(?:[/?#]\S*)?$/i.test(text)) return `http://${text}`;
    if (LOOKS_LIKE_HOST.test(text)) return `https://${text}`;
  }
  return `${SEARCH_URL}${encodeURIComponent(text)}`;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: UrlRefusal };
export type UrlRefusal = 'malformed' | 'scheme' | 'credentials' | 'private_network';

const PRIVATE_V4: Array<(a: number, b: number) => boolean> = [
  (a) => a === 0,
  (a) => a === 10,
  (a) => a === 127,
  (a, b) => a === 169 && b === 254,
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
  (a, b) => a === 100 && b >= 64 && b <= 127, // carrier-grade NAT
];

/** A name that can only reach this computer or a private network: nothing the open web has. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home.arpa')
  )
    return true;
  if (!host.includes('.') && !host.includes(':')) return true; // a bare name ("intranet", "router")
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return PRIVATE_V4.some((test) => test(a, b));
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true; // unique-local, link-local
    const mapped = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(
      host,
    );
    if (mapped) {
      if (mapped[1]) return isPrivateHost(mapped[1]);
      const hi = parseInt(mapped[2]!, 16);
      const lo = parseInt(mapped[3]!, 16);
      return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return false;
}

/**
 * Whether Allaya itself (not the person) may go to an address. Only the open web: a page cannot talk Allaya into
 * reading something on this computer or the private network by getting it to follow a link there. The person can still
 * open such an address by hand.
 */
export function checkAgentUrl(
  raw: string,
  options: { allowPrivate?: (hostname: string) => boolean } = {},
): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (isPrivateHost(url.hostname) && !options.allowPrivate?.(url.hostname)) {
    return { ok: false, reason: 'private_network' };
  }
  return { ok: true, url: url.toString() };
}

/** A short, readable form of an address for a one-line summary: no scheme, no "www.", no tracking tail. */
export function shortUrl(raw: string, max = 70): string {
  try {
    const url = new URL(raw);
    const text = `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  } catch {
    return raw.slice(0, max);
  }
}
