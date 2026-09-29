import { describe, expect, it } from 'vitest';
import { z } from '@allaya/validation';
import {
  DEFAULT_PERMISSION_MODES,
  TOOL_NAME,
  ToolRegistry,
  defineTool,
  evaluatePolicy,
  toJsonSchema,
  type PolicyDecision,
} from '@allaya/tools';
import {
  PERMISSION_MODES,
  PERMISSION_SUBJECTS,
  RISK_LEVELS,
  SENSITIVE_ACTIONS,
  type PermissionMode,
  type PermissionSubject,
  type RiskLevel,
} from '@allaya/types';

const tool = (over: Record<string, unknown> = {}) =>
  defineTool({
    name: 'do_thing',
    description: 'Does a thing for the tests.',
    category: 'system',
    parameters: z.object({ path: z.string(), count: z.number().int().min(1).default(1) }),
    readOnly: false,
    risk: 'MEDIUM',
    requires: ['file_access'],
    describe: (a) => `do ${a.path}`,
    execute: async () => 'ok',
    ...over,
  });

describe('tool registry', () => {
  it('accepts well-formed tools and finds them by name', () => {
    const registry = new ToolRegistry().register(tool());
    expect(registry.has('do_thing')).toBe(true);
    expect(registry.get('do_thing')?.name).toBe('do_thing');
    expect(registry.list()).toHaveLength(1);
  });

  it.each([
    'Do_Thing',
    'do-thing',
    'do thing',
    'do.thing',
    'a',
    '1abc',
    '',
    'x'.repeat(49),
    '../etc',
    'ünï',
  ])('rejects the tool name %j', (name) => {
    expect(TOOL_NAME.test(name)).toBe(false);
    expect(() => new ToolRegistry().register(tool({ name }))).toThrow(/Invalid tool name/);
  });

  it('rejects duplicates and useless descriptions', () => {
    const registry = new ToolRegistry().register(tool());
    expect(() => registry.register(tool())).toThrow(/already registered/);
    expect(() =>
      new ToolRegistry().register(tool({ name: 'other_thing', description: 'hi' })),
    ).toThrow(/description/);
  });

  it('refuses a state-changing tool that is statically LOW risk (it would bypass every confirmation)', () => {
    expect(() => new ToolRegistry().register(tool({ risk: 'LOW', readOnly: false }))).toThrow(
      /cannot be statically LOW/,
    );
    // Read-only LOW is fine, and a *dynamic* risk function is the tool's responsibility.
    expect(() =>
      new ToolRegistry().register(tool({ name: 'read_thing', risk: 'LOW', readOnly: true })),
    ).not.toThrow();
    expect(() =>
      new ToolRegistry().register(tool({ name: 'edit_thing', risk: () => 'LOW', readOnly: false })),
    ).not.toThrow();
  });

  it('never resolves prototype-chain names as tools', () => {
    const registry = new ToolRegistry().register(tool());
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(registry.get(name)).toBeUndefined();
      expect(registry.has(name)).toBe(false);
    }
  });

  it('describes tools to the model as JSON Schema without provider-hostile metadata', () => {
    const [spec] = new ToolRegistry().register(tool()).toModelTools();
    expect(spec).toMatchObject({ name: 'do_thing', description: 'Does a thing for the tests.' });
    expect(spec!.inputSchema).not.toHaveProperty('$schema');
    expect(spec!.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, count: { type: 'integer', minimum: 1 } },
      required: ['path'],
    });
  });

  it('offers only the tools that exist on this platform', () => {
    const registry = new ToolRegistry()
      .register(tool())
      .register(tool({ name: 'windows_only', platforms: ['win32'] }));
    expect(registry.toModelTools('win32').map((t) => t.name)).toEqual(['do_thing', 'windows_only']);
    expect(registry.toModelTools('linux').map((t) => t.name)).toEqual(['do_thing']);
  });

  it('converts enums, unions and nested objects', () => {
    const schema = z.object({
      mode: z.enum(['a', 'b']),
      nested: z.object({ n: z.number() }),
      list: z.array(z.string()).max(3),
    });
    expect(toJsonSchema(schema)).toMatchObject({
      properties: {
        mode: { enum: ['a', 'b'] },
        nested: { type: 'object' },
        list: { type: 'array', maxItems: 3 },
      },
    });
  });
});

const modeMap =
  (over: Partial<Record<PermissionSubject, PermissionMode>> = {}) =>
  (subject: PermissionSubject) =>
    over[subject] ?? DEFAULT_PERMISSION_MODES[subject];

const decide = (
  risk: RiskLevel,
  subjects: PermissionSubject[],
  over: Partial<Record<PermissionSubject, PermissionMode>> = {},
) => evaluatePolicy({ risk, subjects, modeFor: modeMap(over) });

describe('permission and risk policy', () => {
  it('lets harmless observation through without asking', () => {
    expect(decide('LOW', [])).toEqual({ action: 'allow', permission: 'not_required' });
    expect(decide('LOW', ['file_access'])).toEqual({ action: 'allow', permission: 'allowed' });
  });

  it('asks before MEDIUM actions unless the user always-allowed them', () => {
    expect(decide('MEDIUM', ['file_access'])).toMatchObject({
      action: 'confirm',
      reason: 'ask_mode',
    });
    expect(decide('MEDIUM', ['file_access'], { file_access: 'always_allow' })).toEqual({
      action: 'allow',
      permission: 'allowed',
    });
    expect(decide('MEDIUM', [])).toEqual({ action: 'allow', permission: 'not_required' });
  });

  it('asks before HIGH actions unless every subject is always-allowed — and never for sensitive actions', () => {
    expect(decide('HIGH', ['file_access'])).toMatchObject({
      action: 'confirm',
      reason: 'high_risk',
    });
    expect(decide('HIGH', ['file_access'], { file_access: 'always_allow' })).toEqual({
      action: 'allow',
      permission: 'allowed',
    });
    expect(
      decide('HIGH', ['file_access', 'clipboard'], { file_access: 'always_allow' }),
    ).toMatchObject({ action: 'confirm' });
    expect(decide('HIGH', ['delete_files'], { delete_files: 'always_allow' })).toMatchObject({
      action: 'confirm',
    });
    // A HIGH action that declares no permission subject is not silently allowed either.
    expect(decide('HIGH', [])).toMatchObject({ action: 'confirm' });
  });

  it('CRITICAL always needs an on-screen confirmation, whatever the settings', () => {
    for (const mode of PERMISSION_MODES.filter((m) => m !== 'never')) {
      expect(decide('CRITICAL', ['delete_files'], { delete_files: mode })).toEqual({
        action: 'confirm',
        reason: 'critical',
        channels: ['ui'],
      });
    }
    expect(decide('CRITICAL', [])).toMatchObject({ action: 'confirm', channels: ['ui'] });
  });

  it('a subject set to "never" denies the action at every risk level, and reports which subject', () => {
    for (const risk of RISK_LEVELS) {
      expect(decide(risk, ['file_access', 'camera'])).toEqual({
        action: 'deny',
        subject: 'camera',
      });
    }
  });

  it('camera and administrator commands are off by default', () => {
    expect(DEFAULT_PERMISSION_MODES.camera).toBe('never');
    expect(DEFAULT_PERMISSION_MODES.administrator_commands).toBe('never');
    expect(decide('LOW', ['administrator_commands'])).toMatchObject({ action: 'deny' });
  });

  it('voice and text confirmations are only ever offered below CRITICAL', () => {
    const channels = (d: PolicyDecision) => (d.action === 'confirm' ? d.channels : []);
    expect(channels(decide('MEDIUM', ['file_access']))).toEqual(['ui', 'voice', 'text']);
    expect(channels(decide('HIGH', ['file_access']))).toEqual(['ui', 'voice', 'text']);
    expect(channels(decide('CRITICAL', ['file_access']))).toEqual(['ui']);
  });

  it('every subject has a default mode', () => {
    for (const subject of PERMISSION_SUBJECTS)
      expect(PERMISSION_MODES).toContain(DEFAULT_PERMISSION_MODES[subject]);
  });

  it('exhaustive invariants over risk × mode × subject', () => {
    for (const risk of RISK_LEVELS) {
      for (const subject of PERMISSION_SUBJECTS) {
        for (const mode of PERMISSION_MODES) {
          const d = decide(risk, [subject], { [subject]: mode });
          // never ⇒ deny
          if (mode === 'never') expect(d.action, `${risk}/${subject}/${mode}`).toBe('deny');
          // CRITICAL is never allowed without confirmation
          if (risk === 'CRITICAL' && mode !== 'never') expect(d.action).toBe('confirm');
          // sensitive HIGH+ is never allowed without confirmation
          if (
            risk === 'HIGH' &&
            mode !== 'never' &&
            (SENSITIVE_ACTIONS as readonly string[]).includes(subject)
          ) {
            expect(d.action, `${risk}/${subject}/${mode}`).toBe('confirm');
          }
          // LOW never asks
          if (risk === 'LOW' && mode !== 'never') expect(d.action).toBe('allow');
          // a confirmation is only ever requested for something that could be allowed
          if (d.action === 'confirm') expect(d.channels.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
