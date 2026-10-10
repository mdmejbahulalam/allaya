import type { ToolDefinition } from '@allaya/ai';

export interface ToolContext {
  signal: AbortSignal;
}

/**
 * Something the model may do. `read` tools only look (a web page, a list) and run freely. `write` tools change
 * something outside Allaya (send an email, open an issue) and always ask the person first.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: 'read' | 'write';
  /** One line a person can read for what this call does, shown in the chat and in the question. */
  summarize?(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }
  unregister(name: string): void {
    this.tools.delete(name);
  }
  /** Remove every tool whose name starts with `prefix` (a connection that was removed or switched off). */
  unregisterPrefix(prefix: string): void {
    for (const name of [...this.tools.keys()]) if (name.startsWith(prefix)) this.tools.delete(name);
  }
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  list(): Tool[] {
    return [...this.tools.values()];
  }
}

export const toDefinitions = (tools: readonly Tool[]): ToolDefinition[] =>
  tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
