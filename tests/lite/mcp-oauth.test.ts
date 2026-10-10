import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { McpService } from '@lite/main/mcp/service';
import { Events } from '@lite/main/core/events';
import { OAUTH_PORT, OAUTH_REDIRECT_URL } from '@lite/shared/mcp-presets';
import type { McpServerInput, McpServerView } from '@lite/shared/ipc';
import { createLiteBackend, data, failure, type LiteBackend } from './helpers/backend';
import { FakeMcp } from './helpers/fake-mcp';

// All of these use the one fixed port a sign-in comes back to, so they run one after the other, in this one file.

const backends: LiteBackend[] = [];
const fakes: FakeMcp[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) {
    await b.mcp.settled();
    await b.mcp.dispose();
    b.dispose();
  }
  for (const f of fakes.splice(0)) await f.stop();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const fake = async (options: ConstructorParameters<typeof FakeMcp>[0] = {}) => {
  const f = await FakeMcp.start({ auth: 'oauth', ...options });
  fakes.push(f);
  return f;
};
/** The person's browser, as a test has it: it visits the sign-in page and follows the answer back to the app. */
const follow = async (url: string) => {
  await fetch(url, { redirect: 'follow' });
};
const backend = (options: Parameters<typeof createLiteBackend>[0] = {}) => {
  const b = createLiteBackend({ openBrowser: follow, ...options });
  backends.push(b);
  return b;
};
const input = (f: FakeMcp, over: Partial<McpServerInput> = {}): McpServerInput => ({
  name: 'Notes',
  transport: 'http',
  url: f.url,
  auth: 'oauth',
  ...over,
});
const toolNames = (b: LiteBackend) => b.tools.list().map((t) => t.name);

describe('signing in on the service’s own page', () => {
  it('is asked for before anything is tried, then registers, signs in, connects, and keeps the sign-in encrypted', async () => {
    const f = await fake();
    const b = backend();
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    await b.mcp.settled();
    expect(b.mcp.get(added.id)).toMatchObject({
      status: 'needs_sign_in',
      signedIn: false,
      error: null,
    });
    expect(f.requests).toEqual([]);

    const view = data<McpServerView>(await b.call('mcp:signIn', { id: added.id }));
    expect(view).toMatchObject({ status: 'connected', signedIn: true, error: null });
    expect(toolNames(b)).toContain('mcp__notes__search_notes');
    // It registered itself under its own name, with the one address it can be sent back to.
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0]).toMatchObject({
      client_name: 'Allaya',
      redirect_uris: [OAUTH_REDIRECT_URL],
      token_endpoint_auth_method: 'none',
    });
    expect(f.tokenGrants).toEqual(['authorization_code']);
    // Nothing secret reaches the screen or the disk in the open.
    const everything =
      JSON.stringify(view) + JSON.stringify(b.db.prepare('select * from secrets').all());
    expect(everything).not.toMatch(/at_[0-9a-f]{10}|rt_[0-9a-f]{10}/);
    expect(b.secrets.get(`mcp:${added.id}:oauth-tokens`)).toMatch(/at_/);
    // The tools can be used.
    expect(
      await b.tools
        .get('mcp__notes__search_notes')!
        .run({ query: 'tea' }, { signal: new AbortController().signal }),
    ).toContain('Found 2 notes about tea.');
  });

  it('comes back signed in when the app starts again, renewing a sign-in that has run out', async () => {
    const f = await fake({ accessTtlMs: 400 });
    const b = backend();
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    await b.call('mcp:signIn', { id: added.id });
    await b.mcp.dispose();
    // The access token the first sign-in gave runs out while the app is closed.
    await new Promise((r) => setTimeout(r, 450));

    const next = new McpService({
      db: b.db,
      secrets: b.secrets,
      events: new Events(),
      tools: b.tools,
      host: { openBrowser: follow },
    });
    next.start();
    await next.settled();
    expect(next.list()[0]).toMatchObject({ status: 'connected', error: null });
    expect(f.tokenGrants).toEqual(['authorization_code', 'refresh_token']);
    await next.dispose();
  });

  it('asks to sign in again, without an error, when the service has taken access back', async () => {
    const f = await fake();
    const b = backend();
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    await b.call('mcp:signIn', { id: added.id });
    f.revokeAll();
    await b.mcp.connect(added.id);
    expect(b.mcp.get(added.id)).toMatchObject({ status: 'needs_sign_in', error: null });
    expect(toolNames(b).some((n) => n.startsWith('mcp__'))).toBe(false);
    // And it can be done again.
    await b.call('mcp:signIn', { id: added.id });
    expect(b.mcp.get(added.id).status).toBe('connected');
  });

  it('tells the person, and keeps nothing, when the service does not let them in', async () => {
    const f = await fake({ consent: 'deny' });
    const b = backend();
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    expect(failure(await b.call('mcp:signIn', { id: added.id }))).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { reason: 'denied' },
    });
    expect(b.mcp.get(added.id)).toMatchObject({
      status: 'needs_sign_in',
      signedIn: false,
      error: 'The service did not let you sign in',
    });
    expect(f.tokenGrants).toEqual([]);
  });

  it('can be cancelled while waiting for the person, and then tried again', async () => {
    const f = await fake();
    // At first nobody answers the sign-in page; later somebody does.
    let visit: (url: string) => Promise<void> = () => Promise.resolve();
    const b = backend({ openBrowser: (url) => visit(url) });
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    const first = b.call('mcp:signIn', { id: added.id });
    await expect.poll(() => b.mcp.get(added.id).status).toBe('signing_in');
    await b.call('mcp:cancelSignIn', { id: added.id });
    expect(failure(await first)).toMatchObject({ code: 'CANCELLED' });
    expect(b.mcp.get(added.id)).toMatchObject({ status: 'needs_sign_in', error: null });
    visit = follow;
    expect(data<McpServerView>(await b.call('mcp:signIn', { id: added.id })).status).toBe(
      'connected',
    );
  });

  it('gives up after the time allowed', async () => {
    const f = await fake();
    const b = backend({ openBrowser: () => Promise.resolve(), signInTimeoutMs: 150 });
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    expect(failure(await b.call('mcp:signIn', { id: added.id }))).toMatchObject({
      code: 'TIMEOUT',
      details: { reason: 'sign_in_timeout' },
    });
    expect(b.mcp.get(added.id).status).toBe('needs_sign_in');
  });

  it('does not start a second sign-in while one is waiting', async () => {
    const f = await fake();
    const b = backend({ openBrowser: () => Promise.resolve() });
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    const first = b.call('mcp:signIn', { id: added.id });
    await expect.poll(() => b.mcp.get(added.id).status).toBe('signing_in');
    expect(failure(await b.call('mcp:signIn', { id: added.id }))).toMatchObject({
      details: { reason: 'busy' },
    });
    await b.call('mcp:cancelSignIn', { id: added.id });
    await first;
  });

  it('says so when another program is using the port', async () => {
    const f = await fake();
    const taker = createServer();
    servers.push(taker);
    await new Promise<void>((resolve) => taker.listen(OAUTH_PORT, '127.0.0.1', resolve));
    const b = backend();
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    expect(failure(await b.call('mcp:signIn', { id: added.id }))).toMatchObject({
      details: { reason: 'port_busy' },
    });
    expect(b.mcp.get(added.id).status).toBe('needs_sign_in');
  });

  it('will not open an address that is not a web address', async () => {
    const f = await fake({ authorizationEndpoint: 'file:///etc/passwd' });
    const opened: string[] = [];
    const b = backend({
      openBrowser: (url) => {
        opened.push(url);
        return Promise.resolve();
      },
    });
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    expect(failure(await b.call('mcp:signIn', { id: added.id }))).toMatchObject({
      details: { reason: 'bad_sign_in_address' },
    });
    expect(opened).toEqual([]);
  });

  it('signing out forgets the sign-in and the registration, and takes the tools away', async () => {
    const f = await fake();
    const b = backend();
    const added = data<McpServerView>(await b.call('mcp:add', input(f)));
    await b.call('mcp:signIn', { id: added.id });
    const out = data<McpServerView>(await b.call('mcp:signOut', { id: added.id }));
    expect(out).toMatchObject({ status: 'needs_sign_in', signedIn: false });
    expect(toolNames(b).some((n) => n.startsWith('mcp__'))).toBe(false);
    expect(b.secrets.has(`mcp:${added.id}:oauth-tokens`)).toBe(false);
    expect(b.secrets.has(`mcp:${added.id}:oauth-client`)).toBe(false);
    // A new sign-in registers again.
    await b.call('mcp:signIn', { id: added.id });
    expect(f.registrations).toHaveLength(2);
  });

  it('is only for apps that sign in this way', async () => {
    const f = await fake({ auth: 'none' });
    const b = backend();
    const added = data<McpServerView>(await b.call('mcp:add', input(f, { auth: 'none' })));
    expect(failure(await b.call('mcp:signIn', { id: added.id }))).toMatchObject({
      details: { reason: 'bad_auth' },
    });
  });
});

describe('a service that wants the person’s own app (Google’s way)', () => {
  const own = { clientId: 'my-client-id.apps.example', clientSecret: 'my-client-secret-xyz' };

  it('uses the client ID and secret the person gave, does not register, and never shows the secret', async () => {
    const f = await fake({ ownClient: own });
    const b = backend();
    const added = data<McpServerView>(
      await b.call('mcp:add', input(f, { auth: 'oauth_own_client', ...own })),
    );
    expect(added).toMatchObject({
      status: 'needs_sign_in',
      clientId: own.clientId,
      hasClientSecret: true,
    });
    const view = data<McpServerView>(await b.call('mcp:signIn', { id: added.id }));
    expect(view.status).toBe('connected');
    expect(f.registrations).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(own.clientSecret);
    expect(
      b.db
        .prepare('select enc from secrets')
        .all()
        .map((r) => JSON.stringify(r))
        .join(),
    ).not.toContain(own.clientSecret);
  });

  it('is told when the secret is wrong, and can correct it', async () => {
    const f = await fake({ ownClient: own });
    const b = backend();
    const added = data<McpServerView>(
      await b.call(
        'mcp:add',
        input(f, {
          auth: 'oauth_own_client',
          clientId: own.clientId,
          clientSecret: 'wrong-secret-000',
        }),
      ),
    );
    const refused = failure(await b.call('mcp:signIn', { id: added.id }));
    expect(refused.message).toBeTruthy();
    expect(b.mcp.get(added.id)).toMatchObject({ status: 'needs_sign_in', signedIn: false });
    expect(JSON.stringify(b.mcp.get(added.id))).not.toContain('wrong-secret-000');
    await b.call('mcp:update', { id: added.id, changes: { clientSecret: own.clientSecret } });
    expect(data<McpServerView>(await b.call('mcp:signIn', { id: added.id })).status).toBe(
      'connected',
    );
  });

  it('a different client ID means signing in again, and signing out keeps the person’s app', async () => {
    const f = await fake({ ownClient: own });
    const b = backend();
    const added = data<McpServerView>(
      await b.call('mcp:add', input(f, { auth: 'oauth_own_client', ...own })),
    );
    await b.call('mcp:signIn', { id: added.id });
    await b.call('mcp:signOut', { id: added.id });
    expect(b.mcp.get(added.id)).toMatchObject({ clientId: own.clientId, hasClientSecret: true });
    await b.call('mcp:signIn', { id: added.id });
    await b.call('mcp:update', { id: added.id, changes: { clientId: 'another-client' } });
    await b.mcp.settled();
    expect(b.mcp.get(added.id)).toMatchObject({ signedIn: false });
    expect(b.mcp.get(added.id).status).toBe('needs_sign_in');
  });

  it('cannot sign in before the client ID is there', async () => {
    const f = await fake({ ownClient: own });
    const b = backend();
    const id = b.mcp.add({ ...input(f, { auth: 'oauth_own_client', clientId: 'x' }) }).id;
    b.secrets.remove(`mcp:${id}:client-id`);
    expect(failure(await b.call('mcp:signIn', { id }))).toMatchObject({
      details: { reason: 'client_id_required' },
    });
  });
});
