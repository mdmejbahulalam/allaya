import { describe, expect, it } from 'vitest';
import { parseSse } from '@allaya/ai';
import { byteChunks, streamResponse } from '../../helpers/fetch';

async function collect(chunks: Array<string | Uint8Array>) {
  const out = [];
  for await (const message of parseSse(streamResponse(chunks).body!)) out.push(message);
  return out;
}

describe('SSE parser', () => {
  it('parses events with names and JSON data', async () => {
    expect(
      await collect(['event: message_start\ndata: {"a":1}\n\nevent: ping\ndata: {}\n\n']),
    ).toEqual([
      { event: 'message_start', data: '{"a":1}' },
      { event: 'ping', data: '{}' },
    ]);
  });

  it('is independent of where the network splits the stream — every byte boundary', async () => {
    const text = 'event: x\ndata: {"t":"hello"}\n\ndata: second\n\n';
    const expected = await collect([text]);
    for (let size = 1; size < text.length; size += 1) {
      expect(await collect(byteChunks(text, size)), `chunk size ${size}`).toEqual(expected);
    }
  });

  it('reassembles multi-byte Bengali characters that are cut across chunks', async () => {
    const payload = JSON.stringify({ text: 'আমার Downloads folder খুলে দাও ✓' });
    const text = `data: ${payload}\n\n`;
    for (let size = 1; size <= 5; size += 1) {
      const [message] = await collect(byteChunks(text, size));
      expect(JSON.parse(message!.data).text, `chunk size ${size}`).toBe(
        'আমার Downloads folder খুলে দাও ✓',
      );
    }
  });

  it('handles LF, CRLF and CR line endings, including a CRLF split between chunks', async () => {
    expect(await collect(['data: a\r\n\r\ndata: b\r\r'])).toEqual([{ data: 'a' }, { data: 'b' }]);
    expect(await collect(['data: a\r', '\n\r', '\ndata: b\n\n'])).toEqual([
      { data: 'a' },
      { data: 'b' },
    ]);
  });

  it('joins multiple data lines with newlines', async () => {
    expect(await collect(['data: line1\ndata: line2\n\n'])).toEqual([{ data: 'line1\nline2' }]);
  });

  it('ignores comments and keep-alives, and strips exactly one leading space', async () => {
    expect(
      await collect([': OPENROUTER PROCESSING\n\n: ping\ndata:  two spaces\n\ndata:none\n\n']),
    ).toEqual([{ data: ' two spaces' }, { data: 'none' }]);
  });

  it('delivers the final event even if the stream ends without a blank line', async () => {
    expect(await collect(['data: tail'])).toEqual([{ data: 'tail' }]);
    expect(await collect(['data: tail\n'])).toEqual([{ data: 'tail' }]);
  });

  it('does not emit events that have no data', async () => {
    expect(await collect(['event: only-a-name\n\n'])).toEqual([]);
  });

  it('passes the [DONE] sentinel through as data', async () => {
    expect(await collect(['data: [DONE]\n\n'])).toEqual([{ data: '[DONE]' }]);
  });
});
