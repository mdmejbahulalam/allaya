import { createServer } from 'node:http';
import { AllayaError } from '@allaya/shared';

const PAGE = (ok: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Allaya</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">` +
  (ok
    ? `<h1>You are signed in</h1><p>You can close this tab and go back to Allaya.</p>` +
      `<p lang="bn">আপনি সাইন ইন করেছেন। এই ট্যাব বন্ধ করে আলেয়ায় ফিরে যান।</p>`
    : `<h1>Sign-in did not finish</h1><p>Go back to Allaya and try again.</p>` +
      `<p lang="bn">সাইন ইন শেষ হয়নি। আলেয়ায় ফিরে গিয়ে আবার চেষ্টা করুন।</p>`) +
  `</body></html>`;

export interface CodeListener {
  /** The listener is ready for the browser to come back to it (or could not start: this rejects). */
  ready: Promise<void>;
  /** The code the service sent back; rejects if it was refused, never came, or was cancelled. */
  result: Promise<string>;
  close: () => void;
}

/**
 * Where a service sends the person back to after they sign in: a tiny web server on this computer's own address
 * (127.0.0.1), for one visit. Only a visit that carries the secret `state` this sign-in made is accepted, and only
 * from a page addressed to 127.0.0.1 or localhost (a web page cannot trick it through another name). What the visit
 * says is never shown back on the page.
 */
export function listenForAuthorizationCode(options: {
  port: number;
  state: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}): CodeListener {
  let finish: (outcome: { code: string } | { error: Error }) => void = () => undefined;
  const outcome = new Promise<{ code: string } | { error: Error }>((resolve) => {
    finish = resolve;
  });
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const allowedHost = [`127.0.0.1:${options.port}`, `localhost:${options.port}`];
    const reply = (status: number, ok = false) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end(PAGE(ok));
    };
    if (!allowedHost.includes(host)) return reply(403);
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method !== 'GET' || url.pathname !== '/callback') return reply(404);
    if (url.searchParams.get('state') !== options.state) return reply(400);
    const refusal = url.searchParams.get('error');
    if (refusal !== null) {
      reply(200);
      finish({
        error: new AllayaError('The service did not let you sign in', {
          code: 'PERMISSION_DENIED',
          details: { reason: 'denied' },
        }),
      });
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || code.length > 4000) return reply(400);
    reply(200, true);
    finish({ code });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new AllayaError('Another program is using the port Allaya signs in through', {
              code: 'LIMIT_EXCEEDED',
              details: { reason: 'port_busy' },
            })
          : error,
      );
      finish({ error });
    });
    server.listen(options.port, '127.0.0.1', () => resolve());
  });
  ready.catch(() => undefined);

  /** Stops listening, and resolves once the port really is free again. */
  const shutdown = () =>
    new Promise<void>((resolve) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      server.close(() => resolve());
      server.closeAllConnections();
    });
  const close = () => void shutdown();
  const timer = setTimeout(
    () =>
      finish({
        error: new AllayaError('Signing in took too long', {
          code: 'TIMEOUT',
          details: { reason: 'sign_in_timeout' },
        }),
      }),
    options.timeoutMs,
  );
  const onAbort = () => finish({ error: new AllayaError('Cancelled', { code: 'CANCELLED' }) });
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const result = outcome.then(async (o) => {
    // The page has been answered by now; give the browser a moment to read it, then free the port before going on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await shutdown();
    if ('error' in o) throw o.error;
    return o.code;
  });
  result.catch(() => undefined);
  return { ready, result, close };
}
