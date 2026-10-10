import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AllayaError, nullLogger, type Logger } from '@allaya/shared';

export const CONNECT_TIMEOUT_MS = 20_000;
/** A program on this computer may have to be downloaded the first time it starts. */
export const STDIO_CONNECT_TIMEOUT_MS = 90_000;
export const CALL_TIMEOUT_MS = 2 * 60_000;
export const CALL_MAX_TOTAL_MS = 10 * 60_000;
export const MAX_RESULT_CHARS = 20_000;
const MAX_TOOLS_PER_SERVER = 300;
const MAX_TOOL_PAGES = 20;

export interface McpToolInfo {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What the service says. A claim, not a promise. */
  readOnly: boolean;
}

export type McpEndpoint =
  | {
      kind: 'http';
      url: string;
      /** A key the person pasted, sent as `Authorization: Bearer`. */
      token?: string | undefined;
      /** Signing in on the service's own page. */
      authProvider?: OAuthClientProvider | undefined;
    }
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> };

export interface McpOpenOptions {
  logger?: Logger;
  /** Told when the connection goes away by itself (a program quit, the network dropped). */
  onClosed?: (reason: string) => void;
  /** Told when the service says its tools changed. */
  onToolsChanged?: () => void;
}

/** Text from a service, with control characters (other than tab and line breaks) taken out, and cut to length. */
const clean = (text: unknown, max: number): string =>
  [...(typeof text === 'string' ? text.slice(0, max) : '')]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return !(
        code < 9 ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      );
    })
    .join('');

/** What a tool sent back, as the text the model reads. Pictures and sound are named, not carried. */
export function formatToolResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}): { text: string; isError: boolean } {
  const parts: string[] = [];
  const blocks = Array.isArray(result.content)
    ? (result.content as Array<Record<string, unknown>>)
    : [];
  for (const block of blocks) {
    switch (block['type']) {
      case 'text':
        parts.push(clean(block['text'], MAX_RESULT_CHARS + 1));
        break;
      case 'image':
        parts.push('[The tool returned an image, which cannot be shown here.]');
        break;
      case 'audio':
        parts.push('[The tool returned sound, which cannot be played here.]');
        break;
      case 'resource_link':
        parts.push(`[Link: ${clean(block['uri'], 500)}]`);
        break;
      case 'resource': {
        const resource = block['resource'] as Record<string, unknown> | undefined;
        if (resource && typeof resource['text'] === 'string')
          parts.push(clean(resource['text'], MAX_RESULT_CHARS + 1));
        else
          parts.push(
            `[The tool returned a file (${clean(resource?.['uri'], 300)}), which cannot be shown here.]`,
          );
        break;
      }
      default:
        break;
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2).slice(0, MAX_RESULT_CHARS + 1));
    } catch {
      /* not printable */
    }
  }
  let text = parts.join('\n').trim();
  if (text.length > MAX_RESULT_CHARS)
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n[The rest was cut off.]`;
  return { text: text || '(The tool returned nothing.)', isError: result.isError === true };
}

/**
 * A live connection to one MCP server: the connection itself, its tools, and calling them. Remote servers are tried
 * the current way (Streamable HTTP) first and the older way (SSE) if the address does not speak the current one. A
 * program on this computer is started with only the few environment variables a program needs, plus the ones the
 * person gave it.
 */
export class McpConnection {
  tools: McpToolInfo[] = [];
  private closed = false;
  /** Connected, and its tools listed: from here on, if it goes away, someone should be told. */
  private opened = false;

  private constructor(
    private readonly client: Client,
    private readonly onClosed?: (reason: string) => void,
  ) {}

  static async open(endpoint: McpEndpoint, options: McpOpenOptions = {}): Promise<McpConnection> {
    const logger = options.logger ?? nullLogger;
    const timeout = endpoint.kind === 'stdio' ? STDIO_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;

    const attempt = async (transport: Transport): Promise<McpConnection> => {
      const client = new Client({ name: 'allaya', version: '0.2.0' }, { capabilities: {} });
      const connection = new McpConnection(client, options.onClosed);
      client.onclose = () => {
        if (connection.closed) return;
        connection.closed = true;
        // A connection that never got going is not "lost": the attempt itself reports how it failed.
        if (connection.opened) options.onClosed?.('The connection was closed.');
      };
      client.onerror = (error) =>
        logger.warn('An MCP connection reported a problem', { error: String(error).slice(0, 160) });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void connection
          .refreshTools()
          .then(() => options.onToolsChanged?.())
          .catch(() => undefined);
      });
      try {
        await client.connect(transport, { timeout });
        await connection.refreshTools();
        connection.opened = true;
      } catch (error) {
        connection.closed = true;
        await client.close().catch(() => undefined);
        throw error;
      }
      return connection;
    };

    try {
      if (endpoint.kind === 'stdio') {
        return await attempt(
          new StdioClientTransport({
            command: endpoint.command,
            args: endpoint.args,
            env: { ...getDefaultEnvironment(), ...endpoint.env },
            stderr: 'ignore',
          }),
        );
      }
      const url = new URL(endpoint.url);
      const common = {
        ...(endpoint.token
          ? { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } }
          : {}),
        ...(endpoint.authProvider ? { authProvider: endpoint.authProvider } : {}),
      };
      try {
        return await attempt(new StreamableHTTPClientTransport(url, common));
      } catch (error) {
        // An address that does not speak the current way (it answers "no such thing" or "not allowed") may speak the
        // older one. Anything else — a wrong key, no network — is the answer.
        const code = error instanceof StreamableHTTPError ? error.code : undefined;
        if (code !== 400 && code !== 404 && code !== 405) throw error;
        logger.info('Trying the older way of connecting', { code });
        return await attempt(new SSEClientTransport(url, common));
      }
    } catch (error) {
      throw explain(error);
    }
  }

  /** Asks the service for its tools (all pages, up to a sensible limit). */
  async refreshTools(): Promise<void> {
    const found: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.client.listTools(cursor ? { cursor } : {}, {
        timeout: CONNECT_TIMEOUT_MS,
      });
      for (const tool of result.tools) {
        if (found.length >= MAX_TOOLS_PER_SERVER) break;
        found.push({
          name: tool.name,
          ...(tool.title ? { title: clean(tool.title, 120) } : {}),
          description: clean(tool.description ?? '', 1000),
          inputSchema: { ...(tool.inputSchema as Record<string, unknown>) },
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    this.tools = found;
  }

  /** Runs a tool. A tool that reports an error throws it, so the model is told it failed. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (this.closed)
      throw new AllayaError('This app is not connected', { code: 'PROVIDER_UNAVAILABLE' });
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, {
        ...(signal ? { signal } : {}),
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: CALL_MAX_TOTAL_MS,
      });
      const { text, isError } = formatToolResult(result as Parameters<typeof formatToolResult>[0]);
      if (isError) throw new AllayaError(text, { code: 'PROVIDER_ERROR' });
      return text;
    } catch (error) {
      if (error instanceof AllayaError) throw error;
      if (signal?.aborted) throw error;
      // A refusal or a timeout from the service itself is its answer. Anything else — the network, a session the
      // service forgot — means this connection is no good any more: say so, and let the caller connect again.
      if (error instanceof McpError || error instanceof UnauthorizedError) throw explain(error);
      this.lose('The connection was lost.');
      throw new AllayaError('The connection was lost', {
        code: 'PROVIDER_UNAVAILABLE',
        details: { reason: 'connection_lost' },
      });
    }
  }

  /** The connection is gone from our side, though nobody closed it. */
  private lose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    void this.client.close().catch(() => undefined);
    this.onClosed?.(reason);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }

  /** Still connected (it has not been closed, by us or by the other side). */
  get alive(): boolean {
    return !this.closed;
  }
}

/** A failure in words that name what to do about it, and never the key. */
function explain(error: unknown): AllayaError {
  if (error instanceof AllayaError) return error;
  if (error instanceof UnauthorizedError) {
    return new AllayaError('Sign-in is needed', {
      code: 'PROVIDER_AUTH_FAILED',
      details: { reason: 'unauthorized' },
    });
  }
  const code =
    error instanceof StreamableHTTPError
      ? error.code
      : (error as { code?: unknown } | undefined)?.code;
  if (code === 401 || code === 403) {
    return new AllayaError('The app did not accept the sign-in', {
      code: 'PROVIDER_AUTH_FAILED',
      details: { reason: 'unauthorized' },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout/i.test(message) || code === -32001) {
    return new AllayaError('The app took too long to answer', {
      code: 'TIMEOUT',
      details: { reason: 'timeout' },
    });
  }
  if (code === 'ENOENT') {
    return new AllayaError('That program was not found on this computer', {
      code: 'NOT_FOUND',
      details: { reason: 'command_not_found' },
    });
  }
  return new AllayaError(`Could not connect: ${message.replace(/\s+/g, ' ').slice(0, 200)}`, {
    code: 'PROVIDER_UNAVAILABLE',
    details: { reason: 'connect_failed' },
  });
}
