import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Size in bytes of a multipart upload (speech-to-text). */
  uploadBytes?: number;
  /** Text fields of a multipart upload. */
  fields?: Record<string, string>;
}

/** A minimal, valid, silent MP3 (a run of MPEG-1 Layer III frames) for the text-to-speech endpoint. */
const SILENT_MP3 = Buffer.concat(
  Array.from({ length: 12 }, () =>
    Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]),
  ),
);

/** Pulls plain-text form fields and the upload size out of a multipart body (enough for assertions). */
function parseMultipart(
  buffer: Buffer,
  contentType: string,
): { fields: Record<string, string>; uploadBytes: number } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  const fields: Record<string, string> = {};
  let uploadBytes = 0;
  if (!boundary) return { fields, uploadBytes };
  for (const part of buffer.toString('latin1').split(`--${boundary}`)) {
    const head = /Content-Disposition: form-data; name="([^"]+)"(; filename="[^"]*")?/.exec(part);
    if (!head) continue;
    const bodyStart = part.indexOf('\r\n\r\n') + 4;
    const value = part.slice(bodyStart, part.length - 2);
    if (head[2]) uploadBytes = value.length;
    else fields[head[1]!] = Buffer.from(value, 'latin1').toString('utf8');
  }
  return { fields, uploadBytes };
}

/**
 * A local stand-in for the Anthropic API, so E2E exercises the real app → main → HTTP path without a network
 * or a real key. It validates `x-api-key`, serves `/v1/models`, and streams `/v1/messages` as SSE.
 */
export class FakeAi {
  static readonly VALID_KEY = 'sk-ant-api03-E2EVALIDKEYE2EVALIDKEY0123';
  static readonly OPENAI_KEY = 'sk-proj-E2EVALIDOPENAIKEY0123456789';
  readonly requests: FakeRequest[] = [];
  /** Produces the streamed pieces for a given last user message. */
  reply: (userText: string) => string[] = (text) => ['Echo: ', text];
  chunkDelayMs = 0;
  /** When true the stream sends its first piece then stalls until the client disconnects. */
  stall = false;
  /** What the speech-to-text endpoint hears. */
  transcript = { text: 'Chrome খুলে দাও', avgLogprob: -0.08, noSpeechProb: 0.01 };
  private server!: Server;

  static async start(): Promise<FakeAi> {
    const fake = new FakeAi();
    fake.server = createServer((req, res) => void fake.handle(req, res));
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const buffer = Buffer.concat(chunks);
    const contentType = String(req.headers['content-type'] ?? '');
    const multipart = contentType.startsWith('multipart/form-data');
    const raw = multipart ? '' : buffer.toString('utf8');
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    const upload = multipart ? parseMultipart(buffer, contentType) : undefined;
    this.requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '',
      headers: req.headers,
      body,
      ...(upload ? { uploadBytes: upload.uploadBytes, fields: upload.fields } : {}),
    });

    // OpenAI-style endpoints (speech) authenticate with a bearer token.
    if (req.headers['authorization'] !== undefined) {
      if (req.headers['authorization'] !== `Bearer ${FakeAi.OPENAI_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
        // No chat models on purpose: chat keeps routing to Anthropic in these tests.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
        const { text, avgLogprob, noSpeechProb } = this.transcript;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            text,
            language: 'bengali',
            duration: 2.1,
            segments: [
              {
                text,
                start: 0,
                end: 2.1,
                avg_logprob: avgLogprob,
                no_speech_prob: noSpeechProb,
                compression_ratio: 1.1,
              },
            ],
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(SILENT_MP3);
        return;
      }
      res.writeHead(404).end();
      return;
    }

    if (req.headers['x-api-key'] !== FakeAi.VALID_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      );
      return;
    }

    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'claude-sonnet-5-5',
              display_name: 'Claude Sonnet 5.5',
              max_input_tokens: 200_000,
              max_tokens: 64_000,
            },
            {
              id: 'claude-haiku-4-5-20251001',
              display_name: 'Claude Haiku 4.5',
              max_input_tokens: 200_000,
              max_tokens: 8_192,
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages') {
      const messages = (
        body as { messages: Array<{ role: string; content: Array<{ text?: string }> }> }
      ).messages;
      const last =
        messages
          .filter((m) => m.role === 'user')
          .at(-1)
          ?.content.map((c) => c.text ?? '')
          .join('') ?? '';
      const pieces = this.reply(last);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', {
        type: 'message_start',
        message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 12, output_tokens: 1 } },
      });
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      let closed = false;
      req.on('close', () => (closed = true));
      for (let i = 0; i < pieces.length; i += 1) {
        if (closed) return;
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: pieces[i] },
        });
        if (this.stall && i === 0) {
          await new Promise<void>((resolve) => req.on('close', resolve));
          return;
        }
        if (this.chunkDelayMs) await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 9 },
      });
      send('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }

    res.writeHead(404).end();
  }
}
