/**
 * Software Allaya can be connected to. Each one is an MCP server — a standard way for a program to offer "tools"
 * (search email, open an issue, read a report) to an AI. Most are on the internet and need only an address and a way
 * to sign in; a few run as a program on this computer.
 */

/** How a connection signs in. `token`: a key the person pastes. `oauth`: sign in on the service's own page.
 *  `oauth_own_client`: like `oauth`, but the person first makes an "app" in the service's console (Google asks this). */
export const MCP_AUTH_KINDS = ['none', 'token', 'oauth', 'oauth_own_client'] as const;
export type McpAuthKind = (typeof MCP_AUTH_KINDS)[number];

export interface McpPreset {
  id: string;
  name: string;
  /** Where the server is. */
  url: string;
  /** The ways to sign in that the service offers, the best one first. */
  auth: readonly McpAuthKind[];
  /** Where a token comes from, in a few words (shown under the field). */
  tokenFrom?: string;
}

/**
 * What a "read-only" claim by the service is worth. The standard lets a tool say it only reads; for these services
 * Allaya believes that and runs such tools without asking. For any other address it does not: every action asks.
 */
export const TRUSTED_PRESET_IDS: readonly string[] = [
  'github',
  'gmail',
  'ahrefs',
  'notion',
  'linear',
  'sentry',
  'supabase',
  'canva',
  'vercel',
  'figma',
  'atlassian',
];

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: ['token'],
    tokenFrom: 'GitHub → Settings → Developer settings → Personal access tokens',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: ['oauth_own_client'],
  },
  {
    id: 'ahrefs',
    name: 'Ahrefs',
    url: 'https://api.ahrefs.com/mcp/mcp',
    auth: ['token', 'oauth'],
    tokenFrom: 'Ahrefs → Account settings → API keys → Generate MCP key',
  },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: ['oauth'] },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: ['oauth'] },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: ['oauth'] },
  { id: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', auth: ['oauth'] },
  { id: 'canva', name: 'Canva', url: 'https://mcp.canva.com/mcp', auth: ['oauth'] },
  { id: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', auth: ['oauth'] },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', auth: ['oauth'] },
  {
    id: 'atlassian',
    name: 'Jira and Confluence',
    url: 'https://mcp.atlassian.com/v1/mcp',
    auth: ['oauth'],
  },
];

export const mcpPresetById = (id: string | null | undefined): McpPreset | undefined =>
  MCP_PRESETS.find((p) => p.id === id);

/** The address a person signs in to the service from, so they can register it where a service asks for one. */
export const OAUTH_PORT = 38943;
export const OAUTH_REDIRECT_URL = `http://127.0.0.1:${OAUTH_PORT}/callback`;

/** Tools of one connection share a group, which is how a task is allowed some connections and not others. */
export const mcpGroup = (serverId: string): string => `mcp:${serverId}`;
