import {
  request as httpRequest,
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { AllayaError } from '@allaya/shared';
import type { UrlPolicy, UrlRefusalReason } from './url-policy';

export interface BlockedRequest {
  at: number;
  /** The site the browser tried to reach. */
  host: string;
  reason: UrlRefusalReason | 'port' | 'scheme';
}

/** A connection the proxy could not make for a reason other than policy: the site does not exist, or is down. */
export interface ProxyFailure {
  at: number;
  host: string;
  kind: 'not_found' | 'unreachable';
}

export interface SafeProxyOptions {
  policy: UrlPolicy;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
  now?: () => number;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
export const BLOCKED_HEADER = 'x-allaya-blocked';
/** Set on a refusal to reach a site for a reason that is not policy (it does not exist, it is down). */
export const PROXY_ERROR_HEADER = 'x-allaya-proxy-error';

const forwardHeaders = (headers: IncomingHttpHeaders): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
};

/**
 * Every byte the automated browser sends to the internet goes through here, and the browser is started so that it
 * cannot go around it. This is the one place where "no local network, no blocked sites" is enforced, because it is
 * the only place that sees every hop — a redirect, an image, a script, a WebSocket — *before* a connection is made,
 * and it connects to the addresses it has checked (so DNS cannot answer differently the second time).
 *
 * It tunnels HTTPS without looking inside it (the browser still validates the site's certificate itself).
 * It listens on the loopback interface only and connects only to public addresses, so even another program on this
 * computer cannot use it to reach anything inside the network.
 */
export class SafeProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly blocks: BlockedRequest[] = [];
  private readonly failures: ProxyFailure[] = [];
  private readonly now: () => number;
  /** Connections made to sites, by host — for tests and for the Browser screen. */
  connections = 0;

  constructor(private readonly options: SafeProxyOptions) {
    this.now = options.now ?? Date.now;
  }

  get port(): number {
    const address = this.server?.address() as AddressInfo | null | undefined;
    if (!address) throw new AllayaError('The proxy is not running', { code: 'INTERNAL' });
    return address.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handleRequest(req, res));
    server.on('connect', (req, socket: Socket, head) => void this.handleConnect(req, socket, head));
    // Plain-HTTP WebSocket upgrades are not tunnelled; wss:// and ws:// travel through CONNECT.
    server.on('upgrade', (_req, socket: Socket) => socket.destroy());
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);
    });
    server.maxConnections = this.options.maxConnections ?? 256;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  /** Blocks since `at` (epoch ms), newest last. */
  blocksSince(at: number): BlockedRequest[] {
    return this.blocks.filter((block) => block.at >= at);
  }

  /** Sites that could not be reached since `at`, newest last. */
  failuresSince(at: number): ProxyFailure[] {
    return this.failures.filter((failure) => failure.at >= at);
  }

  private fail(host: string, kind: ProxyFailure['kind']): void {
    this.failures.push({ at: this.now(), host, kind });
    if (this.failures.length > 200) this.failures.shift();
  }

  private block(host: string, reason: BlockedRequest['reason']): void {
    this.blocks.push({ at: this.now(), host, reason });
    if (this.blocks.length > 200) this.blocks.shift();
  }

  private async vet(
    host: string,
    port: number,
  ): Promise<string[] | { blocked: BlockedRequest['reason'] } | { failed: true }> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { blocked: 'port' };
    try {
      return await this.options.policy.vetForConnect(host);
    } catch (error) {
      const reason = error instanceof AllayaError ? error.details?.['reason'] : undefined;
      if (typeof reason === 'string' && reason !== 'unresolvable')
        return { blocked: reason as UrlRefusalReason };
      return { failed: true };
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      this.block(target.hostname, 'scheme');
      res.writeHead(403, { [BLOCKED_HEADER]: 'scheme' }).end();
      return;
    }
    const port = Number(target.port || 80);
    const vetted = await this.vet(target.hostname, port);
    if ('blocked' in vetted) {
      this.block(target.hostname, vetted.blocked);
      res
        .writeHead(403, {
          'content-type': 'text/plain; charset=utf-8',
          [BLOCKED_HEADER]: vetted.blocked,
        })
        .end('Blocked by Allaya: this address is not allowed.');
      return;
    }
    if ('failed' in vetted) {
      res
        .writeHead(502, { 'content-type': 'text/plain', [PROXY_ERROR_HEADER]: 'not_found' })
        .end('That site could not be found.');
      return;
    }
    this.connections += 1;
    const upstream = httpRequest({
      host: vetted[0],
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...forwardHeaders(req.headers), host: target.host },
      agent: false,
      timeout: this.options.connectTimeoutMs ?? 20_000,
    });
    upstream.on('response', (response) => {
      res.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers));
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      this.fail(target.hostname, 'unreachable');
      // A body is required: without one the browser shows its own error page and hides the marker header.
      if (!res.headersSent) {
        res.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
          [PROXY_ERROR_HEADER]: 'unreachable',
        });
      }
      res.end('The site did not respond.');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  private async handleConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '');
    const refuse = (reason: string, status = '403 Forbidden') => {
      client.end(`HTTP/1.1 ${status}\r\n${BLOCKED_HEADER}: ${reason}\r\nConnection: close\r\n\r\n`);
    };
    if (!match) {
      refuse('invalid', '400 Bad Request');
      return;
    }
    const [, host, portText] = match as unknown as [string, string, string];
    const port = Number(portText);
    const vetted = await this.vet(host, port);
    if ('blocked' in vetted) {
      this.block(host, vetted.blocked);
      refuse(vetted.blocked);
      return;
    }
    if ('failed' in vetted) {
      this.fail(host, 'not_found');
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    this.connections += 1;
    let attempt = 0;
    const tryNext = () => {
      const address = vetted[attempt];
      attempt += 1;
      if (address === undefined) {
        this.fail(host, 'unreachable');
        client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
      }
      const upstream = netConnect({ host: address, port });
      this.sockets.add(upstream);
      upstream.setTimeout(this.options.connectTimeoutMs ?? 20_000);
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => {
        // Could not connect to this address: try the next vetted one.
        this.sockets.delete(upstream);
        upstream.destroy();
        if (!client.destroyed) tryNext();
      });
      upstream.once('connect', () => {
        upstream.setTimeout(this.options.idleTimeoutMs ?? 300_000);
        upstream.removeAllListeners('timeout');
        upstream.once('timeout', () => upstream.destroy());
        upstream.removeAllListeners('error');
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => {
          this.sockets.delete(upstream);
          client.destroy();
        });
      });
    };
    tryNext();
  }
}
