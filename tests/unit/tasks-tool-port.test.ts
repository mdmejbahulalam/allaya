import { describe, expect, it } from 'vitest';
import { RESERVED_TOOL_NAMES } from '@allaya/agent';
import { ToolServicePort } from '@main/tasks/tool-port';
import type { PermissionService } from '@main/services/permission-service';
import type { ToolService } from '@main/services/tool-service';

const spec = (name: string) => ({ name, description: `${name} does a thing.`, inputSchema: {} });

const stub = (names: string[]) => {
  const executed: unknown[] = [];
  const tools = {
    modelTools: () => names.map(spec),
    registry: { get: () => undefined },
    execute: (call: unknown, options: unknown) => {
      executed.push({ call, options });
      return Promise.resolve({ ok: true });
    },
  } as unknown as ToolService;
  const permissions = { modeFor: () => 'ask' } as unknown as PermissionService;
  return {
    executed,
    port: new ToolServicePort(tools, permissions, (id) => (id === 't1' ? 'conv_1' : undefined)),
  };
};

describe('the tools a task may use', () => {
  it('never include the agent’s own control tools or the tool that starts a task', () => {
    const { port } = stub(['read_file', 'start_task', ...RESERVED_TOOL_NAMES, 'write_file']);
    expect(port.specs().map((s) => s.name)).toEqual(['read_file', 'write_file']);
  });

  it('run through the very same pipeline, carrying the task and its conversation', async () => {
    const { port, executed } = stub(['read_file']);
    const controller = new AbortController();
    await port.execute(
      { id: 'c1', name: 'read_file', arguments: { path: 'a' } },
      { signal: controller.signal, language: 'bn', taskId: 't1', stepId: 's1' },
    );
    await port.execute(
      { id: 'c2', name: 'read_file', arguments: {} },
      { signal: controller.signal, language: 'en', taskId: 'other', stepId: undefined },
    );
    expect(executed).toMatchObject([
      { options: { taskId: 't1', conversationId: 'conv_1', language: 'bn' } },
      { options: { taskId: 'other', language: 'en' } },
    ]);
    expect((executed[1] as { options: Record<string, unknown> }).options).not.toHaveProperty(
      'conversationId',
    );
  });

  it('reports a tool’s facts, and "varies" when its risk depends on the arguments', () => {
    const tools = {
      modelTools: () => [],
      registry: {
        get: (name: string) =>
          name === 'click'
            ? {
                category: 'browser',
                description: 'Clicks.',
                risk: () => 'MEDIUM',
                readOnly: false,
                requires: () => ['browser_automation'],
              }
            : name === 'read'
              ? {
                  category: 'files',
                  description: 'Reads.',
                  risk: 'LOW',
                  readOnly: true,
                  requires: ['file_access'],
                }
              : undefined,
      },
    } as unknown as ToolService;
    const port = new ToolServicePort(
      tools,
      { modeFor: () => 'ask' } as unknown as PermissionService,
      () => undefined,
    );
    expect(port.facts('read')).toMatchObject({
      risk: 'LOW',
      readOnly: true,
      subjects: ['file_access'],
      category: 'files',
    });
    expect(port.facts('click')).toMatchObject({ risk: 'varies', readOnly: false, subjects: [] });
    expect(port.facts('nope')).toBeUndefined();
  });
});
