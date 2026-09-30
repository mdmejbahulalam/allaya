import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AllayaError } from '@allaya/shared';
import {
  BrowserEngine,
  PlaywrightSession,
  SafeProxy,
  UrlPolicy,
  browserCandidates,
  findBrowser,
} from '@allaya/browser';
import { createServer } from 'node:net';
import { startWebFixture, type WebFixture } from '../helpers/web-fixture';

// A real Chromium is driven here. The sandbox provides one; on a machine without it these tests are skipped
// (and the engine rules are still covered against the in-memory web).
const CHROMIUM = ['/opt/pw-browsers/chromium', process.env['ALLAYA_TEST_CHROMIUM'] ?? '']
  .filter(Boolean)
  .find((path) => existsSync(path));
// Starting a real Chromium is slow when the whole suite is running at once, so these tests get a longer limit.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const real = describe.skipIf(!CHROMIUM);

let web: WebFixture;
let cleanup: Array<() => Promise<void> | void> = [];
beforeAll(async () => {
  web = await startWebFixture();
});
afterAll(async () => {
  await web.close();
});
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  web.hits.clear();
  web.posts.length = 0;
  web.upgrades.length = 0;
  web.cookies.length = 0;
});

/**
 * The fixture's host names stand for public sites. The proxy resolves them to this machine (the only way to reach
 * the fixture); `third.test` stands for a site whose DNS points into the network; everything else does not exist.
 */
const testResolve = (host: string): Promise<string[]> => {
  if (host === 'fake.test' || host === 'other.test') return Promise.resolve(['127.0.0.1']);
  if (host === 'third.test') return Promise.resolve(['10.1.2.3']);
  return Promise.reject(new Error('ENOTFOUND'));
};

async function launch(options: { profileDir?: string; blocked?: string[] } = {}) {
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'allaya-profile-'));
  const policy = new UrlPolicy({
    resolve: testResolve,
    allowHosts: () => ['fake.test', 'other.test'], // the loopback test seam: ONLY these names may reach this machine
    blocked: () => options.blocked ?? [],
  });
  const proxy = new SafeProxy({ policy, connectTimeoutMs: 3000 });
  await proxy.start();
  const session = await PlaywrightSession.launch({
    profileDir,
    executablePath: CHROMIUM!,
    proxy,
    headless: true,
    noSandbox: true,
    navigationTimeoutMs: 15_000,
    actionTimeoutMs: 2_000,
  });
  const engine = new BrowserEngine({ session, policy });
  cleanup.push(async () => {
    await engine.close();
    await proxy.stop();
    if (!options.profileDir) rmSync(profileDir, { recursive: true, force: true });
  });
  return { engine, session, policy, proxy, profileDir };
}

/** A port on this machine that nothing listens on. */
const closedPort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

const refOf = (snap: { elements: Array<{ ref: string; name: string }> }, name: string) => {
  const found = snap.elements.find((e) => e.name === name);
  if (!found)
    throw new Error(`no element "${name}" in ${JSON.stringify(snap.elements.map((e) => e.name))}`);
  return found.ref;
};
const reasonOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    if (!(error instanceof AllayaError)) return `other:${String(error)}`;
    const why = error.details?.['reason'];
    return typeof why === 'string' ? why : error.code;
  }
};

describe('browser discovery', () => {
  it('lists Edge before Chrome on Windows, in the standard install folders only', () => {
    const list = browserCandidates('win32', {
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    });
    expect(list[0]).toMatchObject({ kind: 'edge' });
    expect(list.map((c) => c.path)).toContain(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    );
    expect(list.map((c) => c.path)).toContain(
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    );
    expect(list.findIndex((c) => c.kind === 'chrome')).toBeGreaterThan(
      list.findLastIndex((c) => c.kind === 'edge'),
    );
  });

  it('picks the first that exists, and reports none when none does', () => {
    const chromeOnly = (path: string) => path.endsWith('chrome.exe');
    expect(findBrowser('win32', { ProgramFiles: 'C:\\PF' }, chromeOnly)?.kind).toBe('chrome');
    expect(findBrowser('win32', { ProgramFiles: 'C:\\PF' }, () => false)).toBeUndefined();
    expect(findBrowser('linux', {}, (p) => p === '/usr/bin/chromium')?.kind).toBe('chromium');
  });

  it('never offers a path taken from the environment', () => {
    const list = browserCandidates('win32', {
      ProgramFiles: 'C:\\PF',
      ALLAYA_BROWSER_PATH: 'C:\\evil.exe',
    });
    expect(list.every((c) => !c.path.includes('evil'))).toBe(true);
  });
});

real('a real browser: reading and acting', () => {
  it('opens a page, reads its visible text (Bengali intact) and lists what can be clicked', async () => {
    const { engine } = await launch();
    const opened = await engine.open(web.url('/'));
    expect(opened).toMatchObject({ status: 200, tab: { title: 'Home' } });
    const snap = await engine.read();
    expect(snap.text).toContain('স্বাগতম Welcome');
    expect(snap.text).not.toContain('HIDDEN-TEXT-SHOULD-NOT-APPEAR');
    const names = snap.elements.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Products', 'Form', 'Popup page', 'Redirect']));
    expect(names).not.toContain('Hidden button');
    expect(names).not.toContain('Aria hidden button');
    expect(snap.elements.find((e) => e.name === 'Products')).toMatchObject({
      role: 'link',
      href: web.url('/products'),
    });
    expect(snap.elements[0]!.ref).toMatch(/^e1_1$/);
  });

  it('clicks a link, and refs from before the navigation are refused', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/'));
    const snap = await engine.read();
    const result = await engine.click(refOf(snap, 'Products'));
    expect(result).toMatchObject({ navigated: true, tab: { title: 'Products' } });
    await expect(engine.click(refOf(snap, 'Form'))).rejects.toMatchObject({
      details: { reason: 'stale_ref' },
    });
    expect((await engine.read()).elements.map((e) => e.name)).toContain('Home');
  });

  it('types Bengali into a search box, submits, and the server really received it', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/form'));
    const snap = await engine.read();
    const typed = await engine.type(refOf(snap, 'Search the site'), 'দাম কম ঢাকা', {
      submit: true,
    });
    expect(typed).toMatchObject({ matches: true, value: 'দাম কম ঢাকা' });
    expect(typed.submitted?.navigated).toBe(true);
    expect((await engine.read()).text).toContain('Results for দাম কম ঢাকা');
  });

  it('submits a form, and what the server received is exactly what was typed — never a password', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/form'));
    const snap = await engine.read();
    await engine.type(refOf(snap, 'Your name'), 'রহিম উদ্দিন');
    await expect(engine.type(refOf(snap, 'Password'), 'hunter2')).rejects.toMatchObject({
      details: { reason: 'sensitive_field' },
    });
    await expect(engine.type(refOf(snap, 'Card number'), '4111111111111111')).rejects.toMatchObject(
      { details: { reason: 'sensitive_field' } },
    );
    const sent = await engine.click(refOf(snap, 'Send message'));
    expect(sent.navigated).toBe(true);
    expect(web.posts).toHaveLength(1);
    expect(web.posts[0]!.body).toContain('name=রহিম উদ্দিন');
    expect(web.posts[0]!.body).toMatch(/pw=(&|$)/); // empty: the password was never typed
    expect(web.posts[0]!.body).not.toContain('hunter2');
    expect(web.posts[0]!.body).not.toContain('4111');
  });

  it('flags a page that tries to instruct the AI, and leaves out text the user cannot see', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/inject'));
    const snap = await engine.read();
    expect(snap.suspiciousText.join(' ')).toContain('you must do the following');
    expect(snap.text).not.toContain('(hidden)');
    await engine.open(web.url('/products'));
    expect((await engine.read()).suspiciousText).toEqual([]);
  });

  it('keeps a page dialog from freezing anything, and reports it as untrusted text', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/dialog'));
    const snap = await engine.read();
    const clicked = await engine.click(refOf(snap, 'Alert me'));
    expect(clicked.dialog).toContain('Are you sure?');
    expect((await engine.read()).title).toBe('after-alert'); // the page carried on
  });

  it('opens a target=_blank link as a new tab that becomes current; tabs can be listed, switched and closed', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/popup'));
    const snap = await engine.read();
    const result = await engine.click(refOf(snap, 'Open other'));
    expect(result.newTab?.title).toBe('Other page');
    const tabs = await engine.tabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.active)?.title).toBe('Other page');
    const first = tabs.find((t) => !t.active)!;
    await engine.switchTab(first.id);
    expect((await engine.tabs()).find((t) => t.active)?.id).toBe(first.id);
    await engine.closeTab(tabs.find((t) => t.title === 'Other page')!.id);
    expect(await engine.tabs()).toHaveLength(1);
  });

  it('takes a real PNG screenshot', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/'));
    const png = await engine.screenshot();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeGreaterThan(2000);
  });

  it('goes back, and says so when something covers a button instead of clicking blindly', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/'));
    await engine.open(web.url('/products'));
    expect((await engine.back()).tab.title).toBe('Home');
    await engine.open(web.url('/covered'));
    const snap = await engine.read();
    await expect(engine.click(refOf(snap, 'Underneath'))).rejects.toMatchObject({
      message: expect.stringContaining('covering'),
    });
  });

  it('will not type into a file chooser, and clicking it does not hang', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/form'));
    const snap = await engine.read();
    await expect(engine.type(refOf(snap, 'Upload'), 'C:\\secret.txt')).rejects.toBeInstanceOf(
      AllayaError,
    );
    await expect(engine.click(refOf(snap, 'Upload'))).resolves.toMatchObject({ navigated: false });
  });

  it('caps a huge page and a page with too many controls', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/big'));
    const big = await engine.read({ maxChars: 1000 });
    expect(Array.from(big.text)).toHaveLength(1000);
    expect(big.truncated).toBe(true);
    await engine.open(web.url('/many'));
    const many = await engine.read({ maxElements: 25 });
    expect(many.elements).toHaveLength(25);
    expect(many.elementsTruncated).toBe(true);
  });
});

real('a real browser: the network rules hold', () => {
  it('refuses the local network at the address, whatever the spelling — and the "router" is never contacted', async () => {
    const { engine } = await launch();
    for (const url of [
      `http://127.0.0.1:${web.port}/secret`,
      `http://localhost:${web.port}/secret`,
      `http://[::1]:${web.port}/secret`,
      `http://2130706433:${web.port}/secret`,
      `http://0x7f.1:${web.port}/secret`,
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      expect(await reasonOf(() => engine.open(url)), url).not.toBe('allowed');
    }
    expect(web.hits.get('/secret') ?? 0).toBe(0);
  });

  it('stops a redirect from a public site into the local network, before the request is made', async () => {
    const { engine } = await launch();
    const result = await engine.open(web.url('/redirect-private'));
    expect(result.blocked).toContain('127.0.0.1');
    expect(result.blockedRequests).toBeGreaterThan(0);
    expect(web.hits.get('/secret') ?? 0).toBe(0);
    expect(web.hits.get('/redirect-private')).toBe(1); // the public site itself was contacted; only the redirect target was not
    expect(engine.isTrusted('fake.test')).toBe(false);
  });

  it('follows a redirect to another public site', async () => {
    const { engine } = await launch();
    const result = await engine.open(web.url('/redirect-ok'));
    expect(result.blocked).toBeUndefined();
    expect(result.tab.url).toBe(web.url('/products', 'other.test'));
  });

  it('a page cannot reach the local network by any route: images, scripts, frames, styles, fetch, XHR, WebSocket', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/subresources'));
    await new Promise((r) => setTimeout(r, 1200));
    const text = (await engine.read()).text;
    expect(text).toMatch(/results:/);
    // fetch(127), fetch(localhost), fetch([::1]), xhr, ws all rejected; the one public fetch succeeded
    expect(text).toContain('results:rejected,rejected,rejected,rejected,rejected,fulfilled');
    expect(web.hits.get('/secret') ?? 0).toBe(0);
    expect(web.upgrades).toEqual([]);
    expect(web.hits.get('/beacon')).toBe(1);
  });

  it('a popup to the local network never opens', async () => {
    const { engine } = await launch();
    await engine.open(web.url('/popup'));
    const snap = await engine.read();
    await engine.click(refOf(snap, 'Open the router')).catch(() => undefined);
    expect(web.hits.get('/secret') ?? 0).toBe(0);
    expect((await engine.tabs()).every((t) => !t.url.includes('127.0.0.1'))).toBe(true);
  });

  it('refuses a public-looking name that resolves to the local network (DNS rebinding)', async () => {
    const { engine } = await launch();
    expect(await reasonOf(() => engine.open(web.url('/', 'third.test')))).toBe('resolves_private');
    expect(web.hits.size).toBe(0);
    await expect(engine.open(web.url('/', 'fake.test'))).resolves.toBeDefined();
  });

  it('applies the blocked list to redirects too', async () => {
    const { engine } = await launch({ blocked: ['other.test'] });
    const result = await engine.open(web.url('/redirect-ok')); // → other.test, which is blocked
    expect(result.blocked).toContain('other.test');
    expect(web.hits.get('/products') ?? 0).toBe(0);
    expect(await reasonOf(() => engine.open(web.url('/', 'other.test')))).toBe('blocked_domain');
  });

  it('blocks downloads: an attachment is refused, and clicking a download link saves nothing', async () => {
    const { engine } = await launch();
    await expect(engine.open(web.url('/download'))).rejects.toMatchObject({
      message: expect.stringContaining('download'),
    });
    await engine.open(web.url('/download-link'));
    const snap = await engine.read();
    const result = await engine.click(refOf(snap, 'Get the installer'));
    expect(result.newTab).toBeUndefined();
    expect(result.tab.url).toBe(web.url('/download-link')); // it stayed where it was
  });

  it('reports a site that is down or does not exist in plain words', async () => {
    const { engine } = await launch();
    const down = await engine
      .open(`http://fake.test:${await closedPort()}/`)
      .catch((e: Error) => e);
    expect(down).toBeInstanceOf(AllayaError);
    expect((down as Error).message).toBe('The site did not respond');
    const gone = await engine.open('https://no-such-site.invalid/').catch((e: Error) => e);
    expect(gone).toBeInstanceOf(AllayaError);
    expect((gone as Error).message).toMatch(/could not be found|could not be reached/);
    // ...and neither left an error page or a stuck tab behind
    await expect(engine.open(web.url('/products'))).resolves.toMatchObject({ status: 200 });
  });
});

real('a real browser: control, cancellation and the profile', () => {
  it('cancels a slow page quickly, and is still usable afterwards', async () => {
    const { engine } = await launch();
    const controller = new AbortController();
    const started = Date.now();
    const pending = engine.open(web.url('/slow'), { signal: controller.signal });
    setTimeout(() => controller.abort(new AllayaError('stop', { code: 'CANCELLED' })), 300);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(engine.open(web.url('/products'))).resolves.toMatchObject({ status: 200 });
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it("keeps cookies in Allaya's own profile between runs (so a sign-in the user did stays), and only for that site", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-profile-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = await launch({ profileDir: dir });
    await first.engine.open(web.url('/set-cookie'));
    await first.engine.close();

    const second = await launch({ profileDir: dir });
    await second.engine.open(web.url('/echo-cookie'));
    expect((await second.engine.read()).text).toContain('session=signed-in-as-rahim');
    await second.engine.open(web.url('/echo-cookie', 'other.test'));
    expect((await second.engine.read()).text).toContain('cookie:(none)');
  });

  it('announces tab changes, and reports when the browser is closed', async () => {
    const { engine } = await launch();
    let changes = 0;
    engine.onChange(() => (changes += 1));
    await engine.open(web.url('/'));
    await engine.open(web.url('/products'), { newTab: true });
    expect(changes).toBeGreaterThan(1);
    await engine.close();
    expect(engine.isOpen()).toBe(false);
  });

  it('a second run on the same profile while the first is open is refused clearly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allaya-profile-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    await launch({ profileDir: dir });
    await expect(launch({ profileDir: dir })).rejects.toBeInstanceOf(AllayaError);
  });
});
