import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from '@allaya/validation';
import { createFileTools } from '@allaya/filesystem';
import { ToolRegistry, evaluatePolicy, type ToolContext, type ToolDefinition } from '@allaya/tools';
import type { PermissionMode, PermissionSubject, RiskLevel } from '@allaya/types';
import { fsFixture, type FsFixture } from '../../helpers/fs-fixture';

let fx: FsFixture;
afterEach(() => fx?.cleanup());

const setup = () => {
  fx = fsFixture();
  const tools = createFileTools(fx.manager);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const get = (name: string): ToolDefinition => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool;
  };
  const ctx: ToolContext = {
    callId: 'c1',
    signal: new AbortController().signal,
    language: 'en',
    now: new Date(),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
  };
  const call = async (name: string, raw: unknown) => {
    const tool = get(name);
    const args = tool.parameters.parse(raw);
    const output = await tool.execute(args, ctx);
    return { tool, args, output: output as never as Record<string, unknown> };
  };
  return { tools, get, ctx, call };
};

const risk = (tool: ToolDefinition, args: unknown): RiskLevel => {
  const parsed = tool.parameters.parse(args);
  return typeof tool.risk === 'function' ? tool.risk(parsed) : tool.risk;
};
const subjects = (tool: ToolDefinition, args: unknown): readonly PermissionSubject[] => {
  const parsed = tool.parameters.parse(args);
  return typeof tool.requires === 'function' ? tool.requires(parsed) : tool.requires;
};
const decide = (
  tool: ToolDefinition,
  args: unknown,
  modes: Partial<Record<PermissionSubject, PermissionMode>> = {},
) =>
  evaluatePolicy({
    risk: risk(tool, args),
    subjects: subjects(tool, args),
    modeFor: (subject) => modes[subject] ?? 'ask',
  });

describe('file tools — registration', () => {
  it('registers cleanly, with strict schemas the model can be shown', () => {
    const { tools } = setup();
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const specs = registry.toModelTools('win32');
    expect(specs.map((s) => s.name).sort()).toEqual(
      [
        'copy_file',
        'create_folder',
        'delete_file',
        'delete_folder',
        'find_files',
        'get_file_info',
        'list_file_actions',
        'list_folder',
        'move_file',
        'open_file',
        'read_file',
        'rename_file',
        'undo_file_action',
        'write_file',
      ].sort(),
    );
    for (const spec of specs) {
      expect(spec.description.length).toBeGreaterThan(40);
      expect(JSON.stringify(spec.inputSchema)).toContain('"additionalProperties":false');
    }
  });

  it('never offers a tool that runs commands, deletes permanently, or takes a wildcard', () => {
    const { tools } = setup();
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/exec|shell|run|permanent|purge|wipe|shred|empty_trash/);
      expect(JSON.stringify(z.toJSONSchema(tool.parameters, { io: 'input' }))).not.toMatch(
        /glob|wildcard|recursive/i,
      );
    }
  });

  it('describes every action in both languages', () => {
    const { tools } = setup();
    const samples: Record<string, unknown> = {
      list_folder: { path: 'Documents' },
      find_files: { query: 'report' },
      get_file_info: { path: 'Documents/a.txt' },
      read_file: { path: 'Documents/a.txt' },
      create_folder: { path: 'Documents/New' },
      write_file: { path: 'Documents/a.txt', content: 'hi' },
      copy_file: { source: 'Documents/a', destinationFolder: 'Desktop' },
      move_file: { source: 'Documents/a', destinationFolder: 'Desktop' },
      rename_file: { path: 'Documents/a', newName: 'b' },
      delete_file: { path: 'Documents/a.txt' },
      delete_folder: { path: 'Documents/dir' },
      open_file: { path: 'Documents/a.docx' },
      list_file_actions: {},
      undo_file_action: {},
    };
    for (const tool of tools) {
      const args = tool.parameters.parse(samples[tool.name]);
      const en = tool.describe(args, 'en');
      const bn = tool.describe(args, 'bn');
      expect(en.length, tool.name).toBeGreaterThan(5);
      expect(bn, tool.name).toMatch(/[ঀ-৿]/);
      expect(bn).not.toBe(en);
    }
  });
});

describe('file tools — risk and permission policy', () => {
  it('grades by what can be lost', () => {
    const { get } = setup();
    expect(risk(get('list_folder'), { path: 'Documents' })).toBe('LOW');
    expect(risk(get('find_files'), { query: 'x' })).toBe('LOW');
    expect(risk(get('create_folder'), { path: 'Documents/x' })).toBe('LOW');
    expect(risk(get('read_file'), { path: 'Documents/a.txt' })).toBe('MEDIUM');
    expect(risk(get('write_file'), { path: 'Documents/a.txt', content: 'x' })).toBe('MEDIUM');
    expect(
      risk(get('write_file'), { path: 'Documents/a.txt', content: 'x', overwrite: true }),
    ).toBe('HIGH');
    expect(risk(get('copy_file'), { source: 'Documents/a', destinationFolder: 'Desktop' })).toBe(
      'MEDIUM',
    );
    expect(risk(get('move_file'), { source: 'Documents/a', destinationFolder: 'Desktop' })).toBe(
      'MEDIUM',
    );
    expect(risk(get('rename_file'), { path: 'Documents/a', newName: 'b' })).toBe('MEDIUM');
    expect(risk(get('delete_file'), { path: 'Documents/a' })).toBe('HIGH');
    expect(risk(get('delete_folder'), { path: 'Documents/a' })).toBe('CRITICAL');
  });

  it('asks before anything that changes or discloses, and never interrupts plain looking', () => {
    const { get } = setup();
    expect(decide(get('list_folder'), { path: 'Documents' }).action).toBe('allow');
    expect(decide(get('find_files'), { query: 'x' }).action).toBe('allow');
    expect(decide(get('create_folder'), { path: 'Documents/x' }).action).toBe('allow');
    for (const [name, args] of [
      ['read_file', { path: 'Documents/a.txt' }],
      ['write_file', { path: 'Documents/a.txt', content: 'x' }],
      ['move_file', { source: 'Documents/a', destinationFolder: 'Desktop' }],
      ['delete_file', { path: 'Documents/a.txt' }],
    ] as const) {
      expect(decide(get(name), args).action, name).toBe('confirm');
    }
  });

  it('lets the user trust reading and moving, but never silences deleting or replacing', () => {
    const { get } = setup();
    const trusting = {
      file_access: 'always_allow',
      delete_files: 'always_allow',
      application_launch: 'always_allow',
    } as const;
    expect(decide(get('read_file'), { path: 'Documents/a.txt' }, trusting).action).toBe('allow');
    expect(
      decide(get('move_file'), { source: 'Documents/a', destinationFolder: 'Desktop' }, trusting)
        .action,
    ).toBe('allow');
    expect(decide(get('delete_file'), { path: 'Documents/a.txt' }, trusting).action).toBe(
      'confirm',
    );
    expect(
      decide(
        get('write_file'),
        { path: 'Documents/a.txt', content: 'x', overwrite: true },
        trusting,
      ).action,
    ).toBe('confirm');
  });

  it('requires an on-screen click for deleting a folder, whatever the settings', () => {
    const { get } = setup();
    const trusting = { file_access: 'always_allow', delete_files: 'always_allow' } as const;
    expect(decide(get('delete_folder'), { path: 'Documents/dir' }, trusting)).toMatchObject({
      action: 'confirm',
      reason: 'critical',
      channels: ['ui'],
    });
  });

  it('is denied outright when file access is switched off', () => {
    const { tools } = setup();
    for (const tool of tools) {
      const decision = evaluatePolicy({
        risk: 'LOW',
        subjects: typeof tool.requires === 'function' ? ['file_access'] : tool.requires,
        modeFor: () => 'never',
      });
      expect(decision.action, tool.name).toBe('deny');
    }
  });

  it('treats replacing as deleting for permission purposes, but plain creation as not', () => {
    const { get } = setup();
    expect(subjects(get('write_file'), { path: 'Documents/a', content: '' })).toEqual([
      'file_access',
    ]);
    expect(
      subjects(get('write_file'), { path: 'Documents/a', content: '', overwrite: true }),
    ).toEqual(['file_access', 'delete_files']);
    expect(subjects(get('delete_file'), { path: 'Documents/a' })).toContain('delete_files');
    expect(subjects(get('open_file'), { path: 'Documents/a' })).toContain('application_launch');
  });
});

describe('file tools — arguments are validated', () => {
  it('rejects unknown fields, empty paths and oversized content', () => {
    const { get } = setup();
    const write = get('write_file');
    expect(
      write.parameters.safeParse({ path: 'Documents/a', content: 'x', mode: 'root' }).success,
    ).toBe(false);
    expect(write.parameters.safeParse({ path: '', content: 'x' }).success).toBe(false);
    expect(
      write.parameters.safeParse({ path: 'Documents/a', content: 'x'.repeat(600_000) }).success,
    ).toBe(false);
    expect(
      get('list_folder').parameters.safeParse({ path: 'Documents', recursive: true }).success,
    ).toBe(false);
    expect(get('delete_file').parameters.safeParse({ path: ['a', 'b'] }).success).toBe(false);
    expect(get('rename_file').parameters.safeParse({ path: 'Documents/a' }).success).toBe(false);
  });
});

describe('file tools — behaviour', () => {
  it('lists, finds, reads and gives the model folder-relative paths only', async () => {
    const { call } = setup();
    fx.write('Documents/Reports/summary.txt', 'quarterly numbers');
    const listing = await call('list_folder', { path: 'Documents' });
    expect(listing.output['entries']).toEqual([
      expect.objectContaining({ name: 'Reports', type: 'directory' }),
    ]);
    const found = await call('find_files', { query: 'summary' });
    expect(found.output['results']).toEqual([
      expect.objectContaining({ path: 'Documents/Reports/summary.txt' }),
    ]);
    const read = await call('read_file', { path: 'Documents/Reports/summary.txt' });
    expect(read.output['text']).toBe('quarterly numbers');
    for (const result of [listing, found, read])
      expect(JSON.stringify(result.output)).not.toContain(fx.base);
  });

  it('writes and verifies; verification notices when the file is not what was written', async () => {
    const { call } = setup();
    const { tool, args, output } = await call('write_file', {
      path: 'Documents/note.txt',
      content: 'নোট ১',
    });
    expect(output['created']).toBe(true);
    const ok = await tool.verify!(args, output, {} as never);
    expect(ok.verified).toBe(true);
    writeFileSync(join(fx.documents, 'note.txt'), 'tampered');
    expect((await tool.verify!(args, output, {} as never)).verified).toBe(false);
    expect(
      (
        await tool.verify!(
          { ...(args as object), path: 'Documents/absent.txt' },
          output,
          {} as never,
        )
      ).verified,
    ).toBe(false);
  });

  it('delete verification fails if the item is still there', async () => {
    const { get, call } = setup();
    fx.write('Documents/x.txt');
    const { output, args } = await call('delete_file', { path: 'Documents/x.txt' });
    expect(output).toMatchObject({ movedToTrash: true, canBeUndone: true });
    expect((await get('delete_file').verify!(args, output, {} as never)).verified).toBe(true);
    fx.write('Documents/x.txt', 'back again');
    expect((await get('delete_file').verify!(args, output, {} as never)).verified).toBe(false);
  });

  it('a file tool refuses a folder and the folder tool refuses a file', async () => {
    const { call } = setup();
    fx.write('Documents/dir/a.txt');
    fx.write('Documents/f.txt');
    await expect(call('delete_file', { path: 'Documents/dir' })).rejects.toMatchObject({
      details: { reason: 'not_file' },
    });
    await expect(call('delete_folder', { path: 'Documents/f.txt' })).rejects.toMatchObject({
      details: { reason: 'not_directory' },
    });
  });

  it('lists undoable actions and undoes by id', async () => {
    const { call } = setup();
    const made = await call('write_file', { path: 'Documents/u.txt', content: 'x' });
    const actions = await call('list_file_actions', {});
    expect(actions.output['actions']).toEqual([
      expect.objectContaining({
        actionId: made.output['actionId'],
        canBeUndone: true,
        path: 'Documents/u.txt',
      }),
    ]);
    const undone = await call('undo_file_action', { actionId: made.output['actionId'] });
    expect(undone.output['result']).toContain('trash');
    expect(
      (
        (await call('list_file_actions', {})).output['actions'] as Array<{ canBeUndone: boolean }>
      )[0]!.canBeUndone,
    ).toBe(false);
  });

  it('describes an undo by the file it would affect', async () => {
    const { get } = setup();
    await fx.manager.writeFile('Documents/u.txt', 'x');
    await fx.manager.writeFile('Documents/v.txt', 'x');
    expect(get('undo_file_action').describe({}, 'en')).toContain('Documents/v.txt');
  });
});

describe('file tools — nothing private reaches the audit trail', () => {
  it('records that a file was read, not what it said', async () => {
    const { get, call } = setup();
    fx.write('Documents/private.txt', 'my bank PIN is 4711');
    const { output, args } = await call('read_file', { path: 'Documents/private.txt' });
    expect(output['text']).toContain('4711');
    const audited = JSON.stringify(get('read_file').auditOutput!(output));
    expect(audited).not.toContain('4711');
    expect(get('read_file').auditSummary!(args, 'en')).toContain('Documents/private.txt');
  });

  it('records the size of written text, not the text', () => {
    const { get } = setup();
    const args = get('write_file').parameters.parse({
      path: 'Documents/a.txt',
      content: 'SECRET-TEXT-123',
    });
    expect(JSON.stringify(get('write_file').redactArgs!(args))).not.toContain('SECRET');
    expect(get('write_file').auditSummary!(args, 'en')).not.toContain('SECRET');
  });
});
