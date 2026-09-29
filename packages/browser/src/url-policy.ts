import { lookup } from 'node:dns/promises';
import { domainToUnicode } from 'node:url';
import { AllayaError, type ErrorCode } from '@allaya/shared';

export type UrlRefusalReason =
  | 'invalid_url'
  | 'too_long'
  | 'scheme'
  | 'credentials'
  | 'private_address'
  | 'local_name'
  | 'resolves_private'
  | 'blocked_domain';

export const urlRefusal = (
  reason: UrlRefusalReason,
  message: string,
  code: ErrorCode = 'PATH_NOT_ALLOWED',
): AllayaError => new AllayaError(message, { code, details: { reason } });

const MAX_URL_CHARS = 2048;

// ── IP classification ────────────────────────────────────────────────────────────────────────────────────────

const v4Parts = (host: string): number[] | undefined => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
};

/** Addresses that are not on the public internet: loopback, private, link-local, CGNAT, reserved, multicast, … */
export function isPrivateIPv4(host: string): boolean {
  const p = v4Parts(host);
  if (!p) return false;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal (without brackets) to its eight 16-bit groups, or `undefined` if it is malformed. */
export function parseIPv6(input: string): number[] | undefined {
  let text = input.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  // A trailing dotted IPv4 ("::ffff:127.0.0.1") becomes two groups.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const p = v4Parts(dotted[1]!);
    if (!p) return undefined;
    text = `${text.slice(0, dotted.index)}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(text) || text.includes(':::')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return undefined;
  return groups.map((g) => Number.parseInt(g, 16));
}

const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPrivateIPv6(host: string): boolean {
  const g = parseIPv6(host);
  if (!g) return true; // an address we cannot parse is not one we will trust
  const [a, b, c, d, e, f, x, y] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g.every((n) => n === 0)) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && x === 0 && y === 1)
    return true; // ::1
  if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xff00) === 0xff00) return true; // multicast
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard
  // IPv4 carried inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16)
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff)
    return isPrivateIPv4(embeddedV4(x, y));
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0)
    return isPrivateIPv4(embeddedV4(x, y));
  if (a === 0x0064 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return isPrivateIPv4(embeddedV4(x, y));
  if (a === 0x2002) return isPrivateIPv4(embeddedV4(b, c));
  return false;
}

const LOCAL_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'lan',
  'home',
  'corp',
  'intranet',
  'home.arpa',
  'private',
];

export type HostClass = 'public' | 'ip_private' | 'local_name';

/** Classifies a hostname (as `URL.hostname` gives it: lowercase, punycode, IPv6 in brackets). */
export function classifyHost(hostname: string): HostClass {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    return isPrivateIPv6(host.slice(1, -1)) ? 'ip_private' : 'public';
  }
  if (v4Parts(host)) return isPrivateIPv4(host) ? 'ip_private' : 'public';
  if (!host.includes('.')) return 'local_name'; // "router", "intranet", "localhost"
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return 'local_name';
  }
  return 'public';
}

// ── Domain lists ─────────────────────────────────────────────────────────────────────────────────────────────

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Validates and normalises a domain typed by the user (`Example.COM`, `বাংলা.com`) to lowercase punycode. */
export function normalizeDomain(input: string): string {
  const text = input.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!text || text.length > 253 || /[\s/\\@:?#]/.test(text)) {
    throw urlRefusal(
      'invalid_url',
      `“${input.slice(0, 60)}” is not a domain name`,
      'INVALID_INPUT',
    );
  }
  let ascii: string;
  try {
    ascii = new URL(`https://${text}`).hostname;
  } catch {
    throw urlRefusal(
      'invalid_url',
      `“${input.slice(0, 60)}” is not a domain name`,
      'INVALID_INPUT',
    );
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || v4Parts(ascii)) {
    throw urlRefusal(
      'invalid_url',
      `“${input.slice(0, 60)}” is not a domain name`,
      'INVALID_INPUT',
    );
  }
  return ascii;
}

/** `host` is the domain itself or a sub-domain of it. */
export const hostMatches = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

// ── The policy ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ParsedUrl {
  /** Normalised, safe to navigate to. */
  href: string;
  /** Lowercase, punycode. */
  host: string;
  /** The host as a person reads it (Unicode), for confirmations. */
  displayHost: string;
  /** The host contains non-ASCII characters: it may imitate another site. */
  idn: boolean;
  origin: string;
}

export interface UrlPolicyOptions {
  /** Domains that are never visited (and never followed by a redirect). */
  blocked?: () => readonly string[];
  /** Domains the user has trusted: navigating to them does not ask. */
  trusted?: () => readonly string[];
  /** Resolves a name for the private-address check. Injected so tests need no network. */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Test seam ONLY: treat these hosts as public even though they are loopback (a local fixture server). Production
   * never passes it, and the E2E build gates it behind a compile-time flag.
   */
  allowHosts?: () => readonly string[];
}

const defaultResolve = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Decides which addresses the browser may load. Only http(s); no embedded credentials; no local-network, loopback,
 * link-local or cloud-metadata addresses (so a web page cannot be used to reach the user's router or Allaya's own
 * services); no blocked domains; and names that *resolve* to such an address are refused too.
 */
export class UrlPolicy {
  constructor(private readonly options: UrlPolicyOptions = {}) {}

  /** Syntax and literal-address checks. Throws a refusal. */
  parse(input: string): ParsedUrl {
    const raw = input.trim();
    if (!raw) throw urlRefusal('invalid_url', 'The web address is empty', 'INVALID_INPUT');
    if (raw.length > MAX_URL_CHARS)
      throw urlRefusal('too_long', 'That web address is too long', 'INVALID_INPUT');
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\u0000-\u001f\u007f\s]/.test(raw))
      throw urlRefusal(
        'invalid_url',
        'A web address cannot contain spaces or control characters',
        'INVALID_INPUT',
      );

    // "example.com/path" is what people type; assume https. Anything with another scheme is judged as written.
    const withScheme =
      /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]*:\d+(\/|$)/.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw urlRefusal('invalid_url', 'That is not a valid web address', 'INVALID_INPUT');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw urlRefusal(
        'scheme',
        `Only http and https addresses can be opened (not “${url.protocol}”)`,
      );
    }
    if (url.username || url.password) {
      throw urlRefusal(
        'credentials',
        'Web addresses with a name or password in them are not allowed',
      );
    }
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    if (!host)
      throw urlRefusal('invalid_url', 'That web address has no site name', 'INVALID_INPUT');

    const allowed = this.options.allowHosts?.().includes(host) ?? false;
    if (!allowed) {
      const kind = classifyHost(host);
      if (kind === 'ip_private')
        throw urlRefusal(
          'private_address',
          'Addresses on your own network or computer cannot be opened',
        );
      if (kind === 'local_name')
        throw urlRefusal('local_name', 'Local network names cannot be opened');
    }
    const blocked = this.options.blocked?.() ?? [];
    if (blocked.some((domain) => hostMatches(host, domain))) {
      throw urlRefusal('blocked_domain', `${host} is on your blocked list`);
    }
    const displayHost = domainToUnicode(host) || host;
    return {
      href: url.href,
      host,
      displayHost,
      idn: host.split('.').some((label) => label.startsWith('xn--')),
      origin: url.origin,
    };
  }

  /** `parse` plus the DNS check: a public-looking name that points inside the network is refused. */
  async check(input: string): Promise<ParsedUrl> {
    const parsed = this.parse(input);
    await this.assertResolvesPublicly(parsed.host);
    return parsed;
  }

  /** For every request the browser makes (sub-resources and redirects too). Returns `undefined` if it is fine. */
  async checkRequest(url: string): Promise<UrlRefusalReason | undefined> {
    if (/^(data|blob|about):/i.test(url)) return undefined; // inline content: no network, no address
    try {
      await this.check(url);
      return undefined;
    } catch (error) {
      return error instanceof AllayaError && typeof error.details?.['reason'] === 'string'
        ? (error.details['reason'] as UrlRefusalReason)
        : 'invalid_url';
    }
  }

  /**
   * The addresses a connection to `hostname` may use — the check the network proxy makes for EVERY connection the
   * browser opens (the page, redirects, images, scripts, `fetch`, WebSockets). The proxy connects to exactly these
   * addresses, so a name that answers differently a second time (DNS rebinding) cannot lead inside the network.
   */
  async vetForConnect(hostname: string): Promise<string[]> {
    const host = hostname.replace(/\.$/, '').toLowerCase();
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    const allowed = this.options.allowHosts?.().includes(host) ?? false;
    const blocked = this.options.blocked?.() ?? [];
    if (blocked.some((domain) => hostMatches(host, domain))) {
      throw urlRefusal('blocked_domain', `${host} is on your blocked list`);
    }
    if (!allowed) {
      const kind = classifyHost(host.startsWith('[') ? host : bare);
      if (kind === 'ip_private')
        throw urlRefusal(
          'private_address',
          'Addresses on your own network or computer cannot be opened',
        );
      if (kind === 'local_name')
        throw urlRefusal('local_name', 'Local network names cannot be opened');
      if (host.startsWith('[') || v4Parts(bare)) return [bare]; // a public literal address: use it as it is
    }
    const addresses = await (this.options.resolve ?? defaultResolve)(bare);
    if (addresses.length === 0)
      throw new AllayaError('That site could not be found', {
        code: 'NOT_FOUND',
        details: { reason: 'unresolvable' },
      });
    if (!allowed) {
      const inside = addresses.some((a) => (a.includes(':') ? isPrivateIPv6(a) : isPrivateIPv4(a)));
      if (inside)
        throw urlRefusal('resolves_private', 'That site points to an address inside your network');
    }
    // IPv4 first: it is the more widely reachable family.
    return [...addresses].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
  }

  isTrusted(host: string): boolean {
    return (this.options.trusted?.() ?? []).some((domain) => hostMatches(host, domain));
  }

  private cache = new Map<string, { at: number; ok: boolean }>();

  private async assertResolvesPublicly(host: string): Promise<void> {
    if (host.startsWith('[') || v4Parts(host)) return; // a literal address was already judged
    if (this.options.allowHosts?.().includes(host)) return;
    const cached = this.cache.get(host);
    if (cached && Date.now() - cached.at < 60_000) {
      if (!cached.ok)
        throw urlRefusal('resolves_private', 'That site points to an address inside your network');
      return;
    }
    let addresses: string[];
    try {
      addresses = await (this.options.resolve ?? defaultResolve)(host);
    } catch {
      return; // it does not resolve at all: the browser will report that itself, and nothing is reached
    }
    const ok = !addresses.some((address) =>
      address.includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address),
    );
    this.cache.set(host, { at: Date.now(), ok });
    if (!ok)
      throw urlRefusal('resolves_private', 'That site points to an address inside your network');
  }
}

/** The address without its query string or fragment (which can carry tokens): for logs and confirmations. */
export function redactUrl(href: string): string {
  try {
    const url = new URL(href);
    const shown = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    return url.search || url.hash ? `${shown}?…` : shown;
  } catch {
    return href.slice(0, 80);
  }
}
