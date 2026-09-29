export interface SseMessage {
  event?: string;
  data: string;
}

/**
 * Incremental Server-Sent Events parser (WHATWG spec subset used by AI providers).
 *
 * Correctness points that hand-rolled `split('\n')` parsers get wrong:
 *  - a network chunk can end mid-line, mid-event, or mid-UTF-8 sequence (Bengali is 3 bytes/char)
 *  - line endings may be LF, CRLF, or CR
 *  - an event may have several `data:` lines that join with "\n"
 *  - lines starting with ":" are comments/keep-alives and must be ignored
 *  - one leading space after the colon is stripped, no more
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      event = undefined;
      return undefined;
    }
    const message: SseMessage = {
      data: dataLines.join('\n'),
      ...(event !== undefined ? { event } : {}),
    };
    event = undefined;
    dataLines = [];
    return message;
  };

  const handleLine = (line: string): SseMessage | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalise line endings, but keep a trailing lone "\r" for the next chunk (could be half of "\r\n").
      let cursor = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        if (ch === '\r' && i === buffer.length - 1) break; // wait to see if "\n" follows
        const message = handleLine(buffer.slice(cursor, i));
        if (ch === '\r' && buffer[i + 1] === '\n') i += 1;
        cursor = i + 1;
        if (message) yield message;
      }
      buffer = buffer.slice(cursor);
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const trailing = handleLine(buffer.replace(/\r$/, ''));
      if (trailing) yield trailing;
    }
    // A stream that ends without a blank line still delivers its last complete event.
    const last = dispatch();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
