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
  /** What it belongs to ("browser", a connection's name…), so a whole group can be switched off or granted to a task. */
  group?: string;
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
  /** Every tool, or only those of the given groups (a tool with no group is always included). */
  list(options: { groups?: readonly string[] } = {}): Tool[] {
    const all = [...this.tools.values()];
    const { groups } = options;
    return groups ? all.filter((t) => !t.group || groups.includes(t.group)) : all;
  }
}

export const toDefinitions = (tools: readonly Tool[]): ToolDefinition[] =>
  tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
