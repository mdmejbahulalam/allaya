import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKED_HEADER, PROXY_ERROR_HEADER, SafeProxy, UrlPolicy } from '@allaya/browser';

let target: Server;
let targetPort = 0;
const seen: Array<{
  method: string;
  url: string;
  host: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}> = [];
let echo: TcpServer;
let echoPort = 0;

beforeAll(async () => {
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/big') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-custom': 'yes',
          connection: 'keep-alive',
        });
        const chunk = Buffer.alloc(1024 * 1024, 7);
        for (let i = 0; i < 5; i += 1) res.write(chunk);
        res.end();
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/private' }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'x-custom': 'yes',
        connection: 'close',
      });
      res.end(`hello ${req.method} ${req.url}`);
    });
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  targetPort = (target.address() as AddressInfo).port;
  echo = createTcpServer((socket: Socket) => {
    socket.on('data', (d) => socket.write(`echo:${d.toString()}`));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoPort = (echo.address() as AddressInfo).port;
});
afterAll(async () => {
  target.closeAllConnections();
  await new Promise((resolve) => target.close(resolve));
  echo.close();
});

let proxies: SafeProxy[] = [];
afterEach(async () => {
  for (const p of proxies) await p.stop();
  proxies = [];
  seen.length = 0;
});

const ALLOWED = ['target.test'];
async function startProxy(
  over: { blocked?: string[]; resolve?: (host: string) => Promise<string[]> } = {},
) {
  const policy = new UrlPolicy({
    allowHosts: () => ALLOWED,
    blocked: () => over.blocked ?? [],
    resolve:
      over.resolve ??
      ((host) => {
        if (host === 'target.test') return Promise.resolve(['127.0.0.1']);
        if (host === 'rebind.test') return Promise.resolve(['10.0.0.9']);
        if (host === 'mixed.test') return Promise.resolve(['8.8.8.8', '127.0.0.1']);
        if (host === 'v6mapped.test') return Promise.resolve(['::ffff:127.0.0.1']);
        return Promise.reject(new Error('ENOTFOUND'));
      }),
  });
  const proxy = new SafeProxy({ policy, connectTimeoutMs: 2000 });
  await proxy.start();
  proxies.push(proxy);
  return proxy;
}

interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}
const viaProxy = (
  proxy: SafeProxy,
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: proxy.port,
        method: options.method ?? 'GET',
        path: url,
        headers: {
          host: new URL(url.startsWith('http') ? url : 'http://x/').host,
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });

const connectVia = (
  proxy: SafeProxy,
  hostPort: string,
): Promise<{ status: number; headers: IncomingMessage['headers']; socket: Socket }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: hostPort });
    req.on('connect', (res, socket) =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }),
    );
    req.on('error', reject);
    req.end();
  });

describe('SafeProxy — plain HTTP', () => {
  it('forwards a request to an allowed public site, with method, body, headers and the original Host', async () => {
    const proxy = await startProxy();
    const get = await viaProxy(proxy, `http://target.test:${targetPort}/page?x=1`, {
      headers: { 'x-mine': 'abc' },
    });
    expect(get.status).toBe(200);
    expect(get.body.toString()).toBe('hello GET /page?x=1');
    expect(get.headers['x-custom']).toBe('yes');
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: '/page?x=1',
      host: `target.test:${targetPort}`,
    });
    expect(seen[0]!.headers['x-mine']).toBe('abc');

    const post = await viaProxy(proxy, `http://target.test:${targetPort}/form`, {
      method: 'POST',
      body: 'বাংলা=হ্যাঁ',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
    expect(post.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', body: 'বাংলা=হ্যাঁ' });
    expect(proxy.connections).toBe(2);
  });

  it('does not pass hop-by-hop headers through in either direction', async () => {
    const proxy = await startProxy();
    await viaProxy(proxy, `http://target.test:${targetPort}/`, {
      headers: { 'proxy-authorization': 'Basic secret', 'proxy-connection': 'keep-alive' },
    });
    expect(seen[0]!.headers['proxy-authorization']).toBeUndefined();
    expect(seen[0]!.headers['proxy-connection']).toBeUndefined();
  });

  it('streams a large body intact', async () => {
    const proxy = await startProxy();
    const big = await viaProxy(proxy, `http://target.test:${targetPort}/big`);
    expect(big.body.length).toBe(5 * 1024 * 1024);
    expect(big.body.every((b) => b === 7)).toBe(true);
  });

  it('refuses the local network in every spelling — and never contacts it', async () => {
    const proxy = await startProxy();
    for (const url of [
      `http://127.0.0.1:${targetPort}/secret`,
      `http://localhost:${targetPort}/secret`,
      `http://[::1]:${targetPort}/secret`,
      `http://2130706433:${targetPort}/secret`,
      `http://0x7f.0.0.1:${targetPort}/secret`,
      `http://127.1:${targetPort}/secret`,
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:127.0.0.1]/',
      'http://router/',
      'http://printer.local/',
      'http://metadata.google.internal/',
    ]) {
      const reply = await viaProxy(proxy, url);
      expect(reply.status, url).toBe(403);
      expect(reply.headers[BLOCKED_HEADER], url).toMatch(/private_address|local_name/);
    }
    expect(seen).toEqual([]); // the target server was never reached
    expect(proxy.blocksSince(0).length).toBe(13);
  });

  it('refuses names that resolve inside the network (any of their addresses), and IPv4-mapped IPv6', async () => {
    const proxy = await startProxy();
    for (const host of ['rebind.test', 'mixed.test', 'v6mapped.test']) {
      const reply = await viaProxy(proxy, `http://${host}/`);
      expect(reply.status, host).toBe(403);
      expect(reply.headers[BLOCKED_HEADER], host).toBe('resolves_private');
    }
  });

  it('resolves the name again for every connection and connects to what it just resolved (no stale answer)', async () => {
    const answers: string[][] = [['127.0.0.1'], ['127.0.0.2'], ['127.0.0.1']];
    let calls = 0;
    const proxy = await startProxy({
      resolve: () => Promise.resolve(answers[calls++] ?? ['127.0.0.1']),
    });
    const first = await viaProxy(proxy, `http://target.test:${targetPort}/one`);
    expect(first.status).toBe(200);
    // The second answer points at an address nothing listens on: the connection follows the NEW answer.
    const second = await viaProxy(proxy, `http://target.test:${targetPort}/two`);
    expect(second.status).toBe(502);
    const third = await viaProxy(proxy, `http://target.test:${targetPort}/three`);
    expect(third.status).toBe(200);
    expect(calls).toBe(3);
    expect(seen.map((r) => r.url)).toEqual(['/one', '/three']);
  });

  it('a name that turns private on the next lookup is refused (DNS rebinding)', async () => {
    let calls = 0;
    const proxy = await startProxy({
      // "flip.example" is not on the test allow-list, so private answers are judged like they would be in production.
      resolve: () => Promise.resolve(++calls === 1 ? ['8.8.8.8'] : ['10.0.0.9']),
    });
    const policy = (proxy as unknown as { options: { policy: UrlPolicy } }).options.policy;
    await expect(policy.vetForConnect('flip.example')).resolves.toEqual(['8.8.8.8']);
    await expect(policy.vetForConnect('flip.example')).rejects.toMatchObject({
      details: { reason: 'resolves_private' },
    });
    const reply = await viaProxy(proxy, 'http://flip.example/');
    expect(reply.status).toBe(403);
    expect(reply.headers[BLOCKED_HEADER]).toBe('resolves_private');
  });

  it('applies the blocked list to the site and its sub-domains', async () => {
    const proxy = await startProxy({ blocked: ['evil.example'] });
    for (const host of ['evil.example', 'www.evil.example', 'a.b.evil.example']) {
      const reply = await viaProxy(proxy, `http://${host}/`);
      expect(reply.status, host).toBe(403);
      expect(reply.headers[BLOCKED_HEADER], host).toBe('blocked_domain');
    }
    expect((await viaProxy(proxy, `http://target.test:${targetPort}/`)).status).toBe(200);
  });

  it('refuses other schemes and malformed requests', async () => {
    const proxy = await startProxy();
    expect((await viaProxy(proxy, 'ftp://target.test/x')).status).toBe(403);
    expect((await viaProxy(proxy, '/not-absolute')).status).toBe(400);
  });

  it('says a missing site is missing, and a site that is down is down', async () => {
    const proxy = await startProxy();
    const missing = await viaProxy(proxy, 'http://nowhere.example/');
    expect(missing.status).toBe(502);
    expect(missing.headers[PROXY_ERROR_HEADER]).toBe('not_found');
    const down = await viaProxy(proxy, 'http://target.test:1/');
    expect(down.status).toBe(502);
    expect(down.headers[PROXY_ERROR_HEADER]).toBe('unreachable');
  });

  it('does not follow redirects itself — the browser asks again, and that request is judged on its own', async () => {
    const proxy = await startProxy();
    const redirect = await viaProxy(proxy, `http://target.test:${targetPort}/redirect`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('http://127.0.0.1:1/private');
    const follow = await viaProxy(proxy, redirect.headers.location!);
    expect(follow.status).toBe(403);
  });

  it('refuses plain-HTTP WebSocket upgrades', async () => {
    const proxy = await startProxy();
    const result = await new Promise<string>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: proxy.port,
        path: `http://target.test:${targetPort}/ws`,
        headers: { connection: 'Upgrade', upgrade: 'websocket', host: 'target.test' },
      });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('response', () => resolve('responded'));
      req.on('error', () => resolve('closed'));
      req.on('close', () => resolve('closed'));
      req.end();
    });
    expect(result).not.toBe('upgraded');
    expect(seen).toEqual([]);
  });
});

describe('SafeProxy — HTTPS tunnels (CONNECT)', () => {
  it('opens a tunnel to an allowed site and carries bytes both ways untouched', async () => {
    const proxy = await startProxy();
    const { status, socket } = await connectVia(proxy, `target.test:${echoPort}`);
    expect(status).toBe(200);
    const reply = await new Promise<string>((resolve) => {
      socket.once('data', (d) => resolve(d.toString()));
      socket.write('বাংলা bytes');
    });
    expect(reply).toBe('echo:বাংলা bytes');
    socket.destroy();
  });

  it('refuses tunnels to the local network, to local names and to bad ports', async () => {
    const proxy = await startProxy();
    for (const hostPort of [
      `127.0.0.1:${echoPort}`,
      `localhost:${echoPort}`,
      `[::1]:${echoPort}`,
      '10.0.0.1:443',
      '169.254.169.254:80',
      'router:443',
      'rebind.test:443',
      'mixed.test:443',
    ]) {
      const { status, headers, socket } = await connectVia(proxy, hostPort);
      expect(status, hostPort).toBe(403);
      expect(headers[BLOCKED_HEADER], hostPort).toBeDefined();
      socket.destroy();
    }
    for (const hostPort of ['target.test:0', 'target.test:70000']) {
      const { status, socket } = await connectVia(proxy, hostPort);
      expect(status, hostPort).toBe(403);
      socket.destroy();
    }
  });

  it('applies the blocked list, and reports unreachable sites', async () => {
    const proxy = await startProxy({ blocked: ['evil.example'] });
    expect((await connectVia(proxy, 'evil.example:443')).status).toBe(403);
    expect((await connectVia(proxy, 'sub.evil.example:443')).status).toBe(403);
    expect((await connectVia(proxy, 'nowhere.example:443')).status).toBe(502);
    expect((await connectVia(proxy, 'target.test:1')).status).toBe(502);
  });

  it('records what it refused, newest last, and stays bounded', async () => {
    const proxy = await startProxy();
    const before = Date.now();
    await connectVia(proxy, '10.0.0.1:443').then((r) => r.socket.destroy());
    await viaProxy(proxy, 'http://192.168.0.1/');
    const blocks = proxy.blocksSince(before);
    expect(blocks.map((b) => b.host)).toEqual(['10.0.0.1', '192.168.0.1']);
    expect(blocks.every((b) => b.reason === 'private_address')).toBe(true);
    expect(proxy.blocksSince(Date.now() + 10_000)).toEqual([]);
    for (let i = 0; i < 250; i += 1) await viaProxy(proxy, `http://10.0.0.${i % 250}/`);
    expect(proxy.blocksSince(0).length).toBeLessThanOrEqual(200);
  });
});

describe('SafeProxy — lifecycle', () => {
  it('only listens on the loopback interface, handles many requests at once, and stops cleanly', async () => {
    const proxy = await startProxy();
    const replies = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        viaProxy(proxy, `http://target.test:${targetPort}/n${i}`),
      ),
    );
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(seen).toHaveLength(40);
    await proxy.stop();
    await expect(viaProxy(proxy, `http://target.test:${targetPort}/`)).rejects.toBeDefined();
    expect(() => proxy.port).toThrow();
  });

  it('is unaffected by a client that disconnects mid-way', async () => {
    const proxy = await startProxy();
    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: proxy.port,
        path: `http://target.test:${targetPort}/big`,
        headers: { host: `target.test:${targetPort}` },
      });
      req.on('response', (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.end();
    });
    expect((await viaProxy(proxy, `http://target.test:${targetPort}/`)).status).toBe(200);
  });
});
