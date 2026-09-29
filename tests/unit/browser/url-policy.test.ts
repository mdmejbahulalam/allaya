import { describe, expect, it } from 'vitest';
import { AllayaError } from '@allaya/shared';
import {
  UrlPolicy,
  classifyHost,
  hostMatches,
  isPrivateIPv4,
  isPrivateIPv6,
  normalizeDomain,
  parseIPv6,
  redactUrl,
  type UrlRefusalReason,
} from '@allaya/browser';

const policy = (opts: ConstructorParameters<typeof UrlPolicy>[0] = {}) => new UrlPolicy(opts);
const reasonOf = (run: () => unknown): UrlRefusalReason | 'allowed' => {
  try {
    run();
    return 'allowed';
  } catch (error) {
    expect(error).toBeInstanceOf(AllayaError);
    return (error as AllayaError).details?.['reason'] as UrlRefusalReason;
  }
};

describe('IP classification', () => {
  it('recognises every non-public IPv4 range and lets public addresses through', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '127.0.0.1',
      '127.8.8.8',
      '100.64.0.1',
      '100.127.255.255',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '192.0.0.1',
      '192.0.2.5',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateIPv4(ip), ip).toBe(true);
    }
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '172.15.0.1',
      '172.32.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '192.169.0.1',
      '11.0.0.1',
    ]) {
      expect(isPrivateIPv4(ip), ip).toBe(false);
    }
  });

  it('parses IPv6 in all its forms', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('2001:db8::ff00:42:8329')).toEqual([
      0x2001, 0xdb8, 0, 0, 0, 0xff00, 0x42, 0x8329,
    ]);
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6('fe80::1%eth0')?.[0]).toBe(0xfe80);
    for (const bad of [
      ':::',
      '1::2::3',
      '12345::1',
      'g::1',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '',
    ]) {
      expect(parseIPv6(bad), bad).toBeUndefined();
    }
  });

  it('recognises non-public IPv6, including IPv4 carried inside it', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      'ff02::1',
      '2001:db8::1',
      '100::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '2002:c0a8:101::1',
    ]) {
      expect(isPrivateIPv6(ip), ip).toBe(true);
    }
    for (const ip of [
      '2606:4700:4700::1111',
      '2a00:1450:4001:81b::200e',
      '::ffff:8.8.8.8',
      '2002:0808:0808::1',
    ]) {
      expect(isPrivateIPv6(ip), ip).toBe(false);
    }
    expect(isPrivateIPv6('not-an-address')).toBe(true); // what cannot be parsed is not trusted
  });

  it('classifies hostnames: single-label and local suffixes are not the public internet', () => {
    for (const host of [
      'localhost',
      'router',
      'intranet',
      'printer.local',
      'a.b.localhost',
      'nas.lan',
      'x.internal',
      'metadata.google.internal',
      'x.home.arpa',
      'app.corp',
      'host.localdomain',
      'LOCALHOST.',
    ]) {
      expect(classifyHost(host), host).toBe('local_name');
    }
    for (const host of ['127.0.0.1', '10.1.2.3', '[::1]', '[fe80::1]', '[::ffff:192.168.0.1]']) {
      expect(classifyHost(host), host).toBe('ip_private');
    }
    for (const host of [
      'example.com',
      'www.wikipedia.org',
      'xn--mgbh0fb.example',
      '8.8.8.8',
      '[2606:4700:4700::1111]',
      'localhost.example.com',
      'notlocal.com',
      'lan.example.org',
    ]) {
      expect(classifyHost(host), host).toBe('public');
    }
  });
});

describe('UrlPolicy.parse', () => {
  const p = policy();

  it('accepts ordinary addresses and assumes https when the scheme is missing', () => {
    expect(p.parse('https://example.com/a?b=1#c').href).toBe('https://example.com/a?b=1#c');
    expect(p.parse('example.com').href).toBe('https://example.com/');
    expect(p.parse('http://example.com:8080/x').host).toBe('example.com');
    expect(p.parse('example.com:8080/path').href).toBe('https://example.com:8080/path');
    expect(p.parse('  https://Example.COM/Path  ').host).toBe('example.com');
    expect(p.parse('//example.com/x').host).toBe('example.com');
  });

  it('accepts only http and https', () => {
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'ftp://example.com',
      'chrome://settings',
      'about:blank',
      'blob:https://example.com/x',
      'view-source:https://example.com',
      'mailto:a@b.c',
      'ws://example.com',
      'FILE:///C:/Windows',
    ]) {
      expect(
        reasonOf(() => p.parse(bad)),
        bad,
      ).toBe('scheme');
    }
  });

  it('refuses credentials in the address (the usual phishing trick)', () => {
    expect(reasonOf(() => p.parse('https://user:pass@example.com'))).toBe('credentials');
    expect(reasonOf(() => p.parse('https://paypal.com@evil.example/'))).toBe('credentials');
    expect(reasonOf(() => p.parse('https://a@example.com'))).toBe('credentials');
  });

  it('refuses the local network and this computer, however the address is written', () => {
    for (const bad of [
      'http://localhost',
      'http://localhost:3000',
      'http://LOCALHOST./',
      'http://127.0.0.1',
      'http://127.1',
      'http://2130706433',
      'http://0x7f000001',
      'http://0177.0.0.1',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0',
      'http://10.0.0.5/admin',
      'http://192.168.1.1',
      'http://172.16.0.1',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/',
      'http://router/',
      'http://printer.local',
      'http://[fe80::1]/',
      'http://[fd00::1]/',
      'http://100.64.0.1',
      'http://foo.localhost',
    ]) {
      expect(['private_address', 'local_name'], bad).toContain(reasonOf(() => p.parse(bad)));
    }
  });

  it('refuses empty, malformed, oversized and whitespace-laden input', () => {
    expect(reasonOf(() => p.parse(''))).toBe('invalid_url');
    expect(reasonOf(() => p.parse('   '))).toBe('invalid_url');
    expect(reasonOf(() => p.parse('https://'))).toBe('invalid_url');
    expect(reasonOf(() => p.parse('exa mple.com'))).toBe('invalid_url');
    expect(reasonOf(() => p.parse('https://example.com/a\nb'))).toBe('invalid_url');
    expect(reasonOf(() => p.parse(`https://example.com/${'a'.repeat(2100)}`))).toBe('too_long');
  });

  it('flags look-alike (internationalised) names and shows what they really are', () => {
    const cyrillic = p.parse('https://аррӏе.com/'); // Cyrillic letters that resemble "apple"
    expect(cyrillic.idn).toBe(true);
    expect(cyrillic.host).toMatch(/^xn--/);
    expect(cyrillic.displayHost).toBe('аррӏе.com');
    const bengali = p.parse('https://বাংলা.com/');
    expect(bengali.idn).toBe(true);
    expect(bengali.displayHost).toBe('বাংলা.com');
    expect(p.parse('https://example.com').idn).toBe(false);
  });

  it('applies the blocked list to the domain and its sub-domains, but not to look-alike suffixes', () => {
    const blocking = policy({ blocked: () => ['evil.example', 'bad.org'] });
    expect(reasonOf(() => blocking.parse('https://evil.example/'))).toBe('blocked_domain');
    expect(reasonOf(() => blocking.parse('https://www.evil.example/'))).toBe('blocked_domain');
    expect(reasonOf(() => blocking.parse('https://a.b.bad.org'))).toBe('blocked_domain');
    expect(reasonOf(() => blocking.parse('https://notevil.example/'))).toBe('allowed');
    expect(reasonOf(() => blocking.parse('https://evil.example.com/'))).toBe('allowed');
  });

  it('reads the blocked list live, so a change takes effect at once', () => {
    const list: string[] = [];
    const live = policy({ blocked: () => list });
    expect(reasonOf(() => live.parse('https://later.example'))).toBe('allowed');
    list.push('later.example');
    expect(reasonOf(() => live.parse('https://later.example'))).toBe('blocked_domain');
  });

  it('lets a test seam treat one loopback host as public — and nothing else', () => {
    const seam = policy({ allowHosts: () => ['127.0.0.1'] });
    expect(seam.parse('http://127.0.0.1:8080/x').host).toBe('127.0.0.1');
    expect(reasonOf(() => seam.parse('http://127.0.0.2/'))).toBe('private_address');
    expect(reasonOf(() => seam.parse('http://localhost/'))).toBe('local_name');
  });
});

describe('UrlPolicy.check (DNS)', () => {
  it('refuses a public-looking name that resolves inside the network', async () => {
    const p = policy({
      resolve: (host) =>
        Promise.resolve(host === 'sneaky.example' ? ['10.0.0.7'] : ['93.184.216.34']),
    });
    await expect(p.check('https://sneaky.example/')).rejects.toMatchObject({
      details: { reason: 'resolves_private' },
    });
    await expect(p.check('https://fine.example/')).resolves.toMatchObject({ host: 'fine.example' });
  });

  it('refuses when ANY of the addresses is private (a split answer is a rebinding trick)', async () => {
    const p = policy({ resolve: () => Promise.resolve(['93.184.216.34', '::1']) });
    await expect(p.check('https://mixed.example/')).rejects.toMatchObject({
      details: { reason: 'resolves_private' },
    });
  });

  it('lets an unresolvable name through: nothing is reached, and the browser reports it', async () => {
    const p = policy({ resolve: () => Promise.reject(new Error('ENOTFOUND')) });
    await expect(p.check('https://nowhere.example/')).resolves.toBeDefined();
  });

  it('does not look up literal addresses, and remembers answers briefly', async () => {
    let lookups = 0;
    const p = policy({ resolve: () => ((lookups += 1), Promise.resolve(['8.8.8.8'])) });
    await p.check('https://8.8.8.8/');
    expect(lookups).toBe(0);
    await p.check('https://cached.example/');
    await p.check('https://cached.example/again');
    expect(lookups).toBe(1);
  });

  it('checkRequest gives the reason, and allows inline content', async () => {
    const p = policy({ resolve: () => Promise.resolve(['8.8.8.8']) });
    expect(await p.checkRequest('http://192.168.1.1/')).toBe('private_address');
    expect(await p.checkRequest('file:///etc/passwd')).toBe('scheme');
    expect(await p.checkRequest('https://ok.example/')).toBeUndefined();
    expect(await p.checkRequest('data:image/png;base64,AAAA')).toBeUndefined();
    expect(await p.checkRequest('about:blank')).toBeUndefined();
    expect(await p.checkRequest('blob:https://ok.example/uuid')).toBeUndefined();
  });
});

describe('domain lists', () => {
  it('normalises what a person types', () => {
    expect(normalizeDomain('Example.COM')).toBe('example.com');
    expect(normalizeDomain('*.example.com')).toBe('example.com');
    expect(normalizeDomain('  example.com. ')).toBe('example.com');
    expect(normalizeDomain('বাংলা.com')).toMatch(/^xn--.+\.com$/);
    expect(normalizeDomain('a-b.co.uk')).toBe('a-b.co.uk');
  });

  it('rejects things that are not domains', () => {
    for (const bad of [
      '',
      'localhost',
      'https://example.com',
      'example.com/path',
      'a b.com',
      '-bad.com',
      'bad-.com',
      '1.2.3.4',
      'user@example.com',
      'example',
      'a..com',
      'exa:mple.com',
      `${'a'.repeat(64)}.com`,
    ]) {
      expect(() => normalizeDomain(bad), bad).toThrow(AllayaError);
    }
  });

  it('matches on label boundaries only', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('www.example.com', 'example.com')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostMatches('example.com.evil.org', 'example.com')).toBe(false);
  });

  it('trusts by the same rule', () => {
    const p = policy({ trusted: () => ['wikipedia.org'] });
    expect(p.isTrusted('en.wikipedia.org')).toBe(true);
    expect(p.isTrusted('wikipedia.org.evil.example')).toBe(false);
  });
});

describe('redactUrl', () => {
  it('drops the query and fragment, which can carry tokens', () => {
    expect(redactUrl('https://example.com/reset?token=SECRET#frag')).toBe(
      'https://example.com/reset?…',
    );
    expect(redactUrl('https://example.com/')).toBe('https://example.com');
    expect(redactUrl('https://example.com/a/b')).toBe('https://example.com/a/b');
    expect(redactUrl('https://example.com/?q=1')).toBe('https://example.com?…');
    expect(redactUrl('not a url at all')).toBe('not a url at all');
  });
});
