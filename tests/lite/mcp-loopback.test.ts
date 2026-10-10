import { request, type IncomingMessage } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenForAuthorizationCode, type CodeListener } from '@lite/main/mcp/loopback';

const listeners: CodeListener[] = [];
afterEach(() => {
  for (const l of listeners.splice(0)) l.close();
});

const freePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

async function listen(options: { timeoutMs?: number; signal?: AbortSignal; port?: number } = {}) {
  const port = options.port ?? (await freePort());
  const listener = listenForAuthorizationCode({
    port,
    state: 'the-state',
    timeoutMs: options.timeoutMs ?? 5000,
    signal: options.signal,
  });
  listeners.push(listener);
  await listener.ready;
  return { port, listener };
}

/** A visit to the listener, by a browser (or by anything else that can reach 127.0.0.1). */
function visit(port: number, path: string, options: { host?: string; method?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: options.method ?? 'GET',
          headers: { host: options.host ?? `127.0.0.1:${port}` },
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

describe('where a service sends the person back to', () => {
  it('takes the code from the visit that carries the right secret, and says so on a page', async () => {
    const { port, listener } = await listen();
    const answer = await visit(port, '/callback?code=abc123&state=the-state');
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('You are signed in');
    expect(answer.body).toContain('আলেয়া');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(await listener.result).toBe('abc123');
  });

  it('never shows back what the visit said', async () => {
    const { port, listener } = await listen();
    const answer = await visit(
      port,
      '/callback?code=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=the-state',
    );
    expect(answer.body).not.toContain('script');
    expect(answer.body).not.toContain('alert');
    await listener.result;
  });

  it('ignores a visit with the wrong secret and keeps waiting for the right one', async () => {
    const { port, listener } = await listen();
    expect((await visit(port, '/callback?code=evil&state=other')).status).toBe(400);
    expect((await visit(port, '/callback?code=evil')).status).toBe(400);
    expect((await visit(port, '/callback?state=the-state')).status).toBe(400);
    expect((await visit(port, `/callback?code=${'x'.repeat(5000)}&state=the-state`)).status).toBe(
      400,
    );
    await visit(port, '/callback?code=good&state=the-state');
    expect(await listener.result).toBe('good');
  });

  it('answers only a page addressed to this computer, so another web page cannot reach it by name', async () => {
    const { port, listener } = await listen();
    expect(
      (await visit(port, '/callback?code=c&state=the-state', { host: `evil.example:${port}` }))
        .status,
    ).toBe(403);
    expect(
      (await visit(port, '/callback?code=c&state=the-state', { host: '127.0.0.1:1' })).status,
    ).toBe(403);
    expect(
      (await visit(port, '/callback?code=ok&state=the-state', { host: `localhost:${port}` }))
        .status,
    ).toBe(200);
    expect(await listener.result).toBe('ok');
  });

  it('answers nothing but the one address, with the one method', async () => {
    const { port, listener } = await listen();
    expect((await visit(port, '/')).status).toBe(404);
    expect((await visit(port, '/callback/extra?code=c&state=the-state')).status).toBe(404);
    expect((await visit(port, '/callback?code=c&state=the-state', { method: 'POST' })).status).toBe(
      404,
    );
    await visit(port, '/callback?code=fine&state=the-state');
    expect(await listener.result).toBe('fine');
  });

  it('reports a refusal, with the state right, as a refusal — and a refusal with the state wrong is ignored', async () => {
    const { port, listener } = await listen();
    await visit(port, '/callback?error=access_denied&state=other');
    const done = visit(
      port,
      '/callback?error=access_denied&error_description=%3Cb%3E&state=the-state',
    );
    await expect(listener.result).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { reason: 'denied' },
    });
    const page = await done;
    expect(page.body).toContain('did not finish');
    expect(page.body).not.toContain('<b>');
  });

  it('gives up after the time allowed, and when told to stop', async () => {
    const slow = await listen({ timeoutMs: 80 });
    await expect(slow.listener.result).rejects.toMatchObject({
      code: 'TIMEOUT',
      details: { reason: 'sign_in_timeout' },
    });
    const controller = new AbortController();
    const stopped = await listen({ signal: controller.signal });
    controller.abort();
    await expect(stopped.listener.result).rejects.toMatchObject({ code: 'CANCELLED' });
    const already = new AbortController();
    already.abort();
    const never = await listen({ signal: already.signal });
    await expect(never.listener.result).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('lets go of the port when it is done, however it ended', async () => {
    const { port, listener } = await listen();
    await visit(port, '/callback?code=c&state=the-state');
    await listener.result;
    // The same port can be used again at once.
    const again = await listen({ port });
    again.listener.close();
    await expect(visit(port, '/')).rejects.toBeDefined();
  });

  it('says so when another program has the port', async () => {
    const taker = createServer();
    await new Promise<void>((resolve) => taker.listen(0, '127.0.0.1', resolve));
    const { port } = taker.address() as AddressInfo;
    const listener = listenForAuthorizationCode({ port, state: 's', timeoutMs: 1000 });
    await expect(listener.ready).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: { reason: 'port_busy' },
    });
    await expect(listener.result).rejects.toBeDefined();
    listener.close();
    await new Promise<void>((resolve) => taker.close(() => resolve()));
  });
});
