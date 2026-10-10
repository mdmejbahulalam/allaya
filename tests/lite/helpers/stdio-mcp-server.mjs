// A small MCP server that runs as a program on this computer, for testing the "program" kind of connection.
import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const mcp = new McpServer({ name: 'local-tools', version: '1.0.0' });
mcp.registerTool(
  'show_env',
  {
    description: 'Says which environment variables this program can see.',
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: `given=${process.env.GREETING ?? 'none'}; parent=${process.env.ALLAYA_TEST_PARENT_SECRET ?? 'hidden'}; args=${process.argv.slice(2).join(',')}`,
      },
    ],
  }),
);
await mcp.connect(new StdioServerTransport());
