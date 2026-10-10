import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_RESULT_CHARS,
  McpConnection,
  formatToolResult,
  type McpEndpoint,
} from '@lite/main/mcp/connection';
import { FakeMcp } from './helpers/fake-mcp';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function service(options: ConstructorParameters<typeof FakeMcp>[0] = {}) {
  const fake = await FakeMcp.start(options);
  stops.push(() => fake.stop());
  return fake;
}
async function connect(
  endpoint: McpEndpoint,
  options: Parameters<typeof McpConnection.open>[1] = {},
) {
  const connection = await McpConnection.open(endpoint, options);
  stops.push(() => connection.close());
  return connection;
}

describe('talking to a service that offers tools', () => {
  it('connects to an open address, lists its tools, and runs one', async () => {
    const fake = await service();
    const connection = await connect({ kind: 'http', url: fake.url });
    const names = connection.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['search_notes', 'create_note', 'delete_note', 'broken']),
    );
    const search = connection.tools.find((t) => t.name === 'search_notes')!;
    expect(search).toMatchObject({ title: 'Search notes', readOnly: true });
    expect(search.inputSchema).toMatchObject({ type: 'object', properties: { query: {} } });
    expect(connection.tools.find((t) => t.name === 'create_note')!.readOnly).toBe(false);
    expect(await connection.call('search_notes', { query: 'tea' })).toBe(
      'Found 2 notes about tea.',
    );
    expect(fake.calls).toEqual([{ tool: 'search_notes', args: { query: 'tea' } }]);
  });

  it('falls back to the older way of connecting when the address does not speak the current one', async () => {
    const fake = await service({ legacySse: true });
    const connection = await connect({ kind: 'http', url: fake.url });
    expect(connection.tools.map((t) => t.name)).toContain('search_notes');
    expect(await connection.call('search_notes', { query: 'old' })).toBe(
      'Found 2 notes about old.',
    );
    // The current way was tried first.
    expect(fake.requests[0]).toMatchObject({ method: 'POST', url: '/mcp' });
    expect(fake.requests.some((r) => r.method === 'GET' && r.url === '/mcp')).toBe(true);
  });

  it('does not try the older way when the answer is a refusal to let the person in', async () => {
    const fake = await service({ auth: 'token', token: 'good-key-123', legacySse: true });
    await expect(connect({ kind: 'http', url: fake.url, token: 'bad' })).rejects.toMatchObject({
      details: { reason: 'unauthorized' },
    });
    expect(fake.requests.every((r) => r.method !== 'GET')).toBe(true);
  });

  it('sends a pasted key as a bearer token, and is told so when the key is wrong', async () => {
    const fake = await service({ auth: 'token', token: 'good-key-123' });
    const connection = await connect({ kind: 'http', url: fake.url, token: 'good-key-123' });
    expect(connection.tools.length).toBeGreaterThan(3);
    expect(fake.requests.every((r) => r.authorization === 'Bearer good-key-123')).toBe(true);
    await expect(
      connect({ kind: 'http', url: fake.url, token: 'wrong-key-999' }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
      details: { reason: 'unauthorized' },
    });
    await expect(connect({ kind: 'http', url: fake.url })).rejects.toMatchObject({
      details: { reason: 'unauthorized' },
    });
  });

  it('says plainly when nothing is there, and does not put the key in the message', async () => {
    const fake = await service();
    const dead = fake.origin;
    await fake.stop();
    stops.pop();
    const error = await connect({
      kind: 'http',
      url: `${dead}/mcp`,
      token: 'super-secret-key-1',
    }).catch((e: Error) => e);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { reason: 'connect_failed' },
    });
    expect((error as Error).message).not.toContain('super-secret-key-1');
  });

  it('turns an error from a tool into a failure with the tool’s own words', async () => {
    const fake = await service();
    const connection = await connect({ kind: 'http', url: fake.url });
    await expect(connection.call('broken', {})).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'The note store is closed.',
    });
  });

  it('names a picture instead of carrying it, and cuts a huge answer', async () => {
    const fake = await service();
    const connection = await connect({ kind: 'http', url: fake.url });
    const picture = await connection.call('picture', {});
    expect(picture).toContain('returned an image');
    expect(picture).toContain('A chart.');
    const huge = await connection.call('huge', {});
    expect(huge.length).toBeLessThan(MAX_RESULT_CHARS + 100);
    expect(huge).toContain('The rest was cut off.');
  });

  it('stops waiting for a tool when asked to stop', async () => {
    const fake = await service();
    const connection = await connect({ kind: 'http', url: fake.url });
    const controller = new AbortController();
    const call = connection.call('wait_forever', {}, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(call).rejects.toBeDefined();
  });

  it('hears when the service changes its tools', async () => {
    const fake = await service();
    let told = 0;
    const connection = await connect(
      { kind: 'http', url: fake.url },
      { onToolsChanged: () => (told += 1) },
    );
    expect(connection.tools.some((t) => t.name === 'late_tool')).toBe(false);
    fake.addTool('late_tool');
    await expect.poll(() => told).toBe(1);
    expect(connection.tools.some((t) => t.name === 'late_tool')).toBe(true);
  });

  it('hears when the service goes away, and refuses to call a connection that is gone', async () => {
    const fake = await service();
    let reason = '';
    const connection = await connect(
      { kind: 'http', url: fake.url },
      { onClosed: (r) => (reason = r) },
    );
    expect(connection.alive).toBe(true);
    await connection.close();
    expect(connection.alive).toBe(false);
    await expect(connection.call('search_notes', { query: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(reason).toBe('');
  });

  it('says so when the program to run is not on this computer', async () => {
    await expect(
      connect({ kind: 'stdio', command: 'definitely-not-a-real-program-xyz', args: [], env: {} }),
    ).rejects.toMatchObject({ details: { reason: 'command_not_found' } });
  });
});

describe('what a tool sends back', () => {
  it('joins the text, names what cannot be shown, and takes control characters out', () => {
    const out = formatToolResult({
      content: [
        { type: 'text', text: 'one\u0000\u0007 two' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
        { type: 'audio', data: 'x', mimeType: 'audio/wav' },
        { type: 'resource_link', uri: 'https://example.com/a', name: 'a' },
        { type: 'resource', resource: { uri: 'file:///x', text: 'inside' } },
        { type: 'resource', resource: { uri: 'file:///y', blob: 'AAAA' } },
      ],
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('one two');
    expect(out.text).toContain('image');
    expect(out.text).toContain('sound');
    expect(out.text).toContain('[Link: https://example.com/a]');
    expect(out.text).toContain('inside');
    expect(out.text).toContain('file:///y');
    expect(out.text).not.toContain('\u0000');
  });

  it('falls back to structured data, says when there is nothing, and carries the error flag', () => {
    expect(formatToolResult({ content: [], structuredContent: { n: 1 } }).text).toContain('"n": 1');
    expect(formatToolResult({ content: [] }).text).toBe('(The tool returned nothing.)');
    expect(formatToolResult({ content: [{ type: 'text', text: 'no' }], isError: true })).toEqual({
      text: 'no',
      isError: true,
    });
  });
});
