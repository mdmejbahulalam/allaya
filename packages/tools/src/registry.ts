import { z } from 'zod';
import { AllayaError } from '@allaya/shared';
import type { ToolDefinition } from './types';

/** Providers restrict tool names; a strict shape also keeps the model's vocabulary predictable. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{2,47}$/;

/** Provider-neutral description sent to the model. */
export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// The registry stores erased tools; `defineTool` gives call sites their precise types.
type AnyTool = ToolDefinition<z.ZodType, unknown>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register<S extends z.ZodType, O>(tool: ToolDefinition<S, O>): this {
    if (!TOOL_NAME.test(tool.name)) {
      throw new AllayaError(`Invalid tool name "${tool.name}"`, { code: 'INVALID_INPUT' });
    }
    if (this.tools.has(tool.name)) {
      throw new AllayaError(`Tool "${tool.name}" is already registered`, { code: 'CONFLICT' });
    }
    if (tool.description.trim().length < 10) {
      throw new AllayaError(`Tool "${tool.name}" needs a real description for the model`, {
        code: 'INVALID_INPUT',
      });
    }
    // A state-changing tool that claims LOW risk unconditionally would bypass every confirmation.
    if (!tool.readOnly && tool.risk === 'LOW') {
      throw new AllayaError(
        `Tool "${tool.name}" changes state, so it cannot be statically LOW risk`,
        {
          code: 'INVALID_INPUT',
        },
      );
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyTool | undefined {
    // A Map: keys are data, never properties, so names like "__proto__" or "constructor" simply are not found.
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** The tools to offer the model on this platform. */
  toModelTools(platform: NodeJS.Platform = process.platform): ModelToolSpec[] {
    return this.list()
      .filter((tool) => !tool.platforms || tool.platforms.includes(platform))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: toJsonSchema(tool.parameters),
      }));
  }
}

/**
 * JSON Schema for what the *model* must send (`io: 'input'`, so fields with defaults stay optional), without the
 * metadata providers reject.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  }) as Record<string, unknown>;
  void _ignored;
  return rest;
}
