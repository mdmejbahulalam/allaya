import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from '@allaya/validation';
import { AllayaError, StructuredLogger, MemorySink, type Logger } from '@allaya/shared';
import {
  ConfirmationBroker,
  DEFAULT_PERMISSION_MODES,
  ToolExecutor,
  ToolRegistry,
  defineTool,
  formatResultForModel,
  getDatetime,
  type ExecutionProgress,
  type ExecutionResult,
  type ToolAuditSink,
  type ToolDefinition,
} from '@allaya/tools';
import type { PermissionMode, PermissionSubject } from '@allaya/types';

class MemoryAudit implements ToolAuditSink {
  begun: Array<Parameters<ToolAuditSink['begin']>[0]> = [];
  finished: ExecutionResult[] = [];
  begin(entry: Parameters<ToolAuditSink['begin']>[0]) {
    this.begun.push(entry);
  }
  finish(result: ExecutionResult) {
    this.finished.push(result);
  }
}

const logs = new MemorySink();
const logger: Logger = new StructuredLogger([logs], 'test', 'DEBUG');

interface Rig {
  executor: ToolExecutor;
  broker: ConfirmationBroker;
  audit: MemoryAudit;
  registry: ToolRegistry;
  modes: Partial<Record<PermissionSubject, PermissionMode>>;
}

function rig(
  options: { platform?: NodeJS.Platform; defaultTimeoutMs?: number; verifyTimeoutMs?: number } = {},
): Rig {
  const registry = new ToolRegistry();
  const broker = new ConfirmationBroker({ timeoutMs: 60_000 });
  const audit = new MemoryAudit();
  const modes: Rig['modes'] = {};
  const executor = new ToolExecutor({
    registry,
    modeFor: (s) => modes[s] ?? DEFAULT_PERMISSION_MODES[s],
    broker,
    audit,
    logger,
    ...options,
  });
  return { executor, broker, audit, registry, modes };
}

const run = (
  r: Rig,
  name: string,
  args: unknown,
  over: {
    signal?: AbortSignal;
    onProgress?: (p: ExecutionProgress) => void;
    language?: 'bn' | 'en';
  } = {},
) =>
  r.executor.execute(
    { id: `call_${name}`, name, arguments: args },
    {
      signal: over.signal ?? new AbortController().signal,
      language: over.language ?? 'en',
      ...(over.onProgress ? { onProgress: over.onProgress } : {}),
    },
  );

/** A fully configurable fake tool. */
function fakeTool(
  over: Partial<ToolDefinition<z.ZodObject<{ path: z.ZodString }>, unknown>> & {
    name?: string;
  } = {},
) {
  const execute = vi.fn(async () => ({ done: true }));
  const def = defineTool<z.ZodObject<{ path: z.ZodString }>, unknown>({
    name: 'fake_tool',
    description: 'A fake tool used by the executor tests.',
    category: 'files',
    parameters: z.object({ path: z.string().min(1) }),
    readOnly: false,
    risk: 'MEDIUM',
    requires: ['file_access'],
    describe: (a: { path: string }, l: string) =>
      l === 'bn' ? `${a.path} নিয়ে কাজ` : `Work on ${a.path}`,
    execute,
    verify: async () => ({ verified: true, evidence: 'checked' }),
    ...over,
  });
  return { def, execute: def.execute as unknown as ReturnType<typeof vi.fn> };
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => (logs.records.length = 0));
afterEach(() => vi.useRealTimers());

describe('lookup and validation', () => {
  it('an unknown tool is a normal, audited result — not an exception', async () => {
    const r = rig();
    const result = await run(r, 'launch_missiles', { x: 1 });
    expect(result).toMatchObject({
      status: 'unknown_tool',
      ok: false,
      error: { code: 'TOOL_NOT_FOUND' },
    });
    expect(r.audit.begun).toHaveLength(1);
    expect(r.audit.finished).toHaveLength(1);
  });

  it('a tool that exists only on another platform is unsupported here', async () => {
    const r = rig({ platform: 'linux' });
    const { def, execute } = fakeTool({ platforms: ['win32'] });
    r.registry.register(def);
    expect(await run(r, 'fake_tool', { path: 'a' })).toMatchObject({
      status: 'unsupported',
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('invalid arguments never reach the tool, and the error names the problem without echoing the values', async () => {
    const r = rig();
    const { def, execute } = fakeTool();
    r.registry.register(def);
    const secret = 'sk-ant-api03-SUPERSECRETSUPERSECRET';
    const result = await run(r, 'fake_tool', { path: 42, extra: secret });
    expect(result).toMatchObject({
      status: 'invalid',
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(result.error!.message).toMatch(/path/);
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
    expect(execute).not.toHaveBeenCalled();
    // Even an invalid call is audited, with the secret masked.
    expect(JSON.stringify(r.audit.begun)).not.toContain('SUPERSECRET');
  });

  it.each([undefined, null, 'a string', 5, [], {}])(
    'rejects non-object/missing arguments (%j)',
    async (args) => {
      const r = rig();
      const { def, execute } = fakeTool();
      r.registry.register(def);
      expect((await run(r, 'fake_tool', args)).status).toBe('invalid');
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('computes risk and permissions from the VALIDATED arguments (a hostile "recursive" flag cannot hide)', async () => {
    const r = rig();
    const { def } = fakeTool({
      name: 'remove_path',
      parameters: z.object({ path: z.string(), recursive: z.boolean().default(false) }),
      risk: ((a: { recursive: boolean }) => (a.recursive ? 'CRITICAL' : 'HIGH')) as never,
      requires: ((a: { recursive: boolean }) =>
        a.recursive ? ['delete_files', 'file_access'] : ['file_access']) as never,
    });
    r.registry.register(def);
    const seen: string[] = [];
    r.broker.events.on('requested', (q) => seen.push(`${q.risk}:${q.subjects.join('+')}`));
    void run(r, 'remove_path', { path: 'x', recursive: true });
    await nextTick();
    void run(r, 'remove_path', { path: 'y' });
    await nextTick();
    expect(seen).toEqual(['CRITICAL:delete_files+file_access', 'HIGH:file_access']);
    r.broker.cancelAll();
  });
});

describe('permissions and confirmation', () => {
  it('LOW-risk read-only tools run immediately with no question', async () => {
    const r = rig();
    r.registry.register(getDatetime);
    const requested = vi.fn();
    r.broker.events.on('requested', requested);
    const result = await run(r, 'get_datetime', {});
    expect(result).toMatchObject({
      status: 'success',
      ok: true,
      permission: 'not_required',
      verification: 'not_applicable',
    });
    expect(requested).not.toHaveBeenCalled();
  });

  it('a subject set to "never" refuses the action before anything runs', async () => {
    const r = rig();
    const { def, execute } = fakeTool();
    r.registry.register(def);
    r.modes.file_access = 'never';
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({
      status: 'denied',
      ok: false,
      permission: 'denied',
      error: { code: 'PERMISSION_DENIED', details: { subject: 'file_access' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('never runs the tool before the user says yes, then runs exactly the validated arguments', async () => {
    const r = rig();
    const { def, execute } = fakeTool();
    r.registry.register(def);
    const progress: string[] = [];
    const pending = run(
      r,
      'fake_tool',
      { path: 'Downloads/a.txt' },
      { onProgress: (p) => progress.push(p.type) },
    );
    await nextTick();
    expect(execute).not.toHaveBeenCalled(); // waiting for the user
    expect(progress).toEqual(['started', 'awaiting_confirmation']);
    const [question] = r.broker.pending();
    expect(question).toMatchObject({
      tool: 'fake_tool',
      risk: 'MEDIUM',
      summary: 'Work on Downloads/a.txt',
      channels: ['ui', 'voice', 'text'],
    });

    r.broker.respond(question!.id, 'approved', 'ui');
    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ path: 'Downloads/a.txt' });
    expect(result).toMatchObject({
      status: 'success',
      ok: true,
      permission: 'allowed_by_user',
      verification: 'verified',
    });
    expect(progress).toEqual(['started', 'awaiting_confirmation', 'running', 'finished']);
  });

  it('a rejected action never runs and tells the model not to retry', async () => {
    const r = rig();
    const { def, execute } = fakeTool();
    r.registry.register(def);
    const pending = run(r, 'fake_tool', { path: 'a' });
    await nextTick();
    r.broker.respond(r.broker.pending()[0]!.id, 'rejected', 'ui');
    const result = await pending;
    expect(result).toMatchObject({
      status: 'rejected',
      ok: false,
      permission: 'denied_by_user',
      error: { code: 'CONFIRMATION_REJECTED' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(formatResultForModel(result).content).toMatch(/declined.*Do not try it again/);
  });

  it('an unanswered confirmation expires as a refusal', async () => {
    vi.useFakeTimers();
    const r = rig();
    const { def, execute } = fakeTool();
    r.registry.register(def);
    const pending = run(r, 'fake_tool', { path: 'a' });
    await vi.advanceTimersByTimeAsync(61_000);
    const result = await pending;
    expect(result).toMatchObject({
      status: 'rejected',
      error: { code: 'CONFIRMATION_REJECTED', details: { reason: 'expired' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('STOP while waiting for the user cancels the action', async () => {
    const r = rig();
    const { def, execute } = fakeTool();
    r.registry.register(def);
    const controller = new AbortController();
    const pending = run(r, 'fake_tool', { path: 'a' }, { signal: controller.signal });
    await nextTick();
    controller.abort();
    expect(await pending).toMatchObject({ status: 'cancelled', ok: false });
    expect(execute).not.toHaveBeenCalled();
    expect(r.broker.pending()).toEqual([]);
  });

  it('an already-cancelled call does nothing at all', async () => {
    const r = rig();
    const { def, execute } = fakeTool();
    r.registry.register(def);
    const controller = new AbortController();
    controller.abort();
    expect(await run(r, 'fake_tool', { path: 'a' }, { signal: controller.signal })).toMatchObject({
      status: 'cancelled',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(r.broker.pending()).toEqual([]);
  });

  it('always-allow skips the question for MEDIUM, but CRITICAL still asks', async () => {
    const r = rig();
    r.modes.file_access = 'always_allow';
    r.modes.delete_files = 'always_allow';
    const medium = fakeTool();
    const critical = fakeTool({ name: 'wipe_it', risk: 'CRITICAL', requires: ['delete_files'] });
    r.registry.register(medium.def).register(critical.def);
    expect((await run(r, 'fake_tool', { path: 'a' })).status).toBe('success');
    const pending = run(r, 'wipe_it', { path: 'a' });
    await nextTick();
    expect(critical.execute).not.toHaveBeenCalled();
    expect(r.broker.pending()[0]).toMatchObject({ risk: 'CRITICAL', channels: ['ui'] });
    r.broker.cancelAll();
    expect((await pending).status).toBe('cancelled');
  });

  it('localises the summary for the confirmation', async () => {
    const r = rig();
    r.registry.register(fakeTool().def);
    void run(r, 'fake_tool', { path: 'ফাইল.txt' }, { language: 'bn' });
    await nextTick();
    expect(r.broker.pending()[0]!.summary).toBe('ফাইল.txt নিয়ে কাজ');
    r.broker.cancelAll();
  });

  it('a describe() that throws cannot bypass the safety pipeline', async () => {
    const r = rig();
    const { def, execute } = fakeTool({
      describe: () => {
        throw new Error('boom');
      },
    });
    r.registry.register(def);
    const pending = run(r, 'fake_tool', { path: 'a' });
    await nextTick();
    expect(r.broker.pending()[0]!.summary).toBe('fake_tool'); // still asks
    expect(execute).not.toHaveBeenCalled();
    r.broker.cancelAll();
    await pending;
  });
});

describe('running: errors, timeouts and cancellation', () => {
  const allow = (r: Rig) => {
    r.modes.file_access = 'always_allow';
  };

  it('a tool error becomes a failed result with its code, and secrets in the message are masked', async () => {
    const r = rig();
    allow(r);
    r.registry.register(
      fakeTool({
        execute: async () => {
          throw new AllayaError(
            'Cannot read D:\\x with key sk-ant-api03-SECRETSECRETSECRETSECRET',
            { code: 'PATH_NOT_ALLOWED' },
          );
        },
      }).def,
    );
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({
      status: 'failed',
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED' },
    });
    expect(result.error!.message).not.toContain('SECRETSECRET');
  });

  it('an unexpected exception is a failed result, never a crash', async () => {
    const r = rig();
    allow(r);
    r.registry.register(
      fakeTool({
        execute: async () => {
          throw new TypeError('x is undefined');
        },
      }).def,
    );
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({ status: 'failed', ok: false });
  });

  it('times out a tool that runs too long, even if it ignores the abort signal', async () => {
    const r = rig({ defaultTimeoutMs: 50 });
    allow(r);
    r.registry.register(fakeTool({ execute: () => new Promise(() => undefined) }).def);
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({
      status: 'failed',
      ok: false,
      error: { code: 'TIMEOUT', retryable: true },
    });
  });

  it('a per-tool timeout overrides the default', async () => {
    const r = rig({ defaultTimeoutMs: 60_000 });
    allow(r);
    r.registry.register(
      fakeTool({ timeoutMs: 30, execute: () => new Promise(() => undefined) }).def,
    );
    expect((await run(r, 'fake_tool', { path: 'a' })).error?.code).toBe('TIMEOUT');
  });

  it('STOP mid-run cancels the tool: the signal is aborted and the result says cancelled', async () => {
    const r = rig();
    allow(r);
    let toolSignal: AbortSignal | undefined;
    r.registry.register(
      fakeTool({
        execute: (_args: unknown, ctx: { signal: AbortSignal }) => {
          toolSignal = ctx.signal;
          return new Promise(() => undefined); // an uncooperative tool
        },
      }).def,
    );
    const controller = new AbortController();
    const pending = run(r, 'fake_tool', { path: 'a' }, { signal: controller.signal });
    await nextTick();
    controller.abort();
    expect(await pending).toMatchObject({
      status: 'cancelled',
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(toolSignal?.aborted).toBe(true);
  });

  it('gives the tool its context: call id, language, a live signal', async () => {
    const r = rig();
    allow(r);
    const seen: Array<{ callId: string; language: string; aborted: boolean }> = [];
    r.registry.register(
      fakeTool({
        execute: async (
          _a: unknown,
          ctx: { callId: string; language: string; signal: AbortSignal },
        ) => {
          seen.push({ callId: ctx.callId, language: ctx.language, aborted: ctx.signal.aborted });
          return 1;
        },
      }).def,
    );
    await run(r, 'fake_tool', { path: 'a' }, { language: 'bn' });
    expect(seen).toEqual([{ callId: 'call_fake_tool', language: 'bn', aborted: false }]);
  });
});

describe('verification', () => {
  const setup = (over: Record<string, unknown>) => {
    const r = rig();
    r.modes.file_access = 'always_allow';
    r.registry.register(fakeTool(over as never).def);
    return r;
  };

  it('a verified effect is reported with its evidence', async () => {
    const r = setup({
      verify: async () => ({ verified: true, evidence: 'file exists, 12 bytes' }),
    });
    expect(await run(r, 'fake_tool', { path: 'a' })).toMatchObject({
      status: 'success',
      ok: true,
      verification: 'verified',
      evidence: 'file exists, 12 bytes',
    });
  });

  it('a FAILED verification makes the whole action a failure — the tool ran, but success is not claimed', async () => {
    const r = setup({ verify: async () => ({ verified: false, evidence: 'file is not there' }) });
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({
      status: 'failed',
      ok: false,
      verification: 'failed',
      error: { code: 'VERIFICATION_FAILED' },
    });
    expect(result.error!.message).toContain('file is not there');
    expect(result.output).toEqual({ done: true }); // what the tool returned is still available for diagnosis
  });

  it('a state-changing tool with no check is "unverified" — ok, but the model is told not to claim success', async () => {
    const r = setup({ verify: undefined });
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({ status: 'success', ok: true, verification: 'unverified' });
    const { content, isError } = formatResultForModel(result);
    expect(isError).toBe(false);
    expect(content).toMatch(/could NOT be confirmed/);
    expect(content).toMatch(/Do not tell the user it succeeded/);
  });

  it('a check that crashes leaves the result unverified rather than failing the action', async () => {
    const r = setup({
      verify: async () => {
        throw new Error('window list unavailable');
      },
    });
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({ status: 'success', verification: 'unverified' });
    expect(result.evidence).toMatch(/could not run/);
  });

  it('a check that hangs is abandoned', async () => {
    const r = rig({ verifyTimeoutMs: 40 });
    r.modes.file_access = 'always_allow';
    r.registry.register(fakeTool({ verify: () => new Promise(() => undefined) }).def);
    expect(await run(r, 'fake_tool', { path: 'a' })).toMatchObject({
      status: 'success',
      verification: 'unverified',
    });
  });

  it('read-only tools need no verification', async () => {
    const r = rig();
    r.registry.register(
      fakeTool({ readOnly: true, risk: 'LOW', requires: [], verify: undefined }).def,
    );
    expect(await run(r, 'fake_tool', { path: 'a' })).toMatchObject({
      verification: 'not_applicable',
      ok: true,
    });
  });
});

describe('audit trail', () => {
  it('records every attempt exactly once at start and once at finish — including refusals', async () => {
    const r = rig();
    r.registry.register(fakeTool().def);
    r.modes.file_access = 'never';
    await run(r, 'fake_tool', { path: 'a' }); // denied
    await run(r, 'nope', {}); // unknown
    await run(r, 'fake_tool', {}); // invalid
    expect(r.audit.begun.map((b) => b.tool)).toEqual(['fake_tool', 'nope', 'fake_tool']);
    expect(r.audit.finished.map((f) => f.status)).toEqual(['denied', 'unknown_tool', 'invalid']);
  });

  it('stores redacted, size-limited arguments — file contents and secrets never land in the log', async () => {
    const r = rig();
    r.modes.file_access = 'always_allow';
    r.registry.register(
      fakeTool({
        parameters: z.object({
          path: z.string(),
          content: z.string(),
          apiKey: z.string(),
        }),
        describe: () => 'write',
      }).def,
    );
    await run(r, 'fake_tool', {
      path: 'a.txt',
      content: 'x'.repeat(5000),
      apiKey: 'sk-ant-api03-SECRETSECRETSECRETSECRET',
    });
    const stored = JSON.stringify(r.audit.begun[0]!.arguments);
    expect(stored).not.toContain('SECRETSECRET');
    expect(stored.length).toBeLessThan(1500);
    expect(stored).toContain('5000 chars');
  });

  it('a tool can supply its own redaction', async () => {
    const r = rig();
    r.modes.file_access = 'always_allow';
    r.registry.register(fakeTool({ redactArgs: () => ({ path: '<hidden>' }) }).def);
    await run(r, 'fake_tool', { path: '/home/user/private/diary.txt' });
    expect(r.audit.begun[0]!.arguments).toEqual({ path: '<hidden>' });
  });

  it('records the risk and the summary the user was shown', async () => {
    const r = rig();
    r.modes.file_access = 'always_allow';
    r.registry.register(fakeTool().def);
    await run(r, 'fake_tool', { path: 'a' });
    expect(r.audit.begun[0]).toMatchObject({
      tool: 'fake_tool',
      risk: 'MEDIUM',
      summary: 'Work on a',
    });
    expect(r.audit.finished[0]).toMatchObject({ permission: 'allowed', risk: 'MEDIUM' });
  });
});

describe('fail closed', () => {
  it('if the action cannot be recorded, it is not run — for known, unknown and invalid calls alike', async () => {
    const r = rig();
    r.modes.file_access = 'always_allow';
    const { def, execute } = fakeTool();
    r.registry.register(def);
    r.audit.begin = () => {
      throw new Error('disk full');
    };
    for (const [name, args] of [
      ['fake_tool', { path: 'a' }],
      ['fake_tool', {}],
      ['nope', {}],
    ] as const) {
      const result = await run(r, name, args);
      expect(result, name).toMatchObject({
        ok: false,
        status: 'failed',
        error: { code: 'INTERNAL' },
      });
      expect(result.error!.message).toMatch(/could not be recorded/);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('losing the record of a finished action does not turn success into failure', async () => {
    const r = rig();
    r.modes.file_access = 'always_allow';
    r.registry.register(fakeTool().def);
    r.audit.finish = () => {
      throw new Error('disk full');
    };
    const result = await run(r, 'fake_tool', { path: 'a' });
    expect(result).toMatchObject({ ok: true, status: 'success' });
    expect(logs.records.some((entry) => JSON.stringify(entry).includes('final audit record'))).toBe(
      true,
    );
  });
});

describe('result for the model', () => {
  it('is compact JSON with the outcome, verification and (bounded) output', async () => {
    const r = rig();
    r.registry.register(getDatetime);
    const result = await run(r, 'get_datetime', {});
    const { content, isError } = formatResultForModel(result);
    expect(isError).toBe(false);
    const parsed = JSON.parse(content) as {
      ok: boolean;
      output: { localDate: string; weekday: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.output.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('truncates huge output', () => {
    const { content } = formatResultForModel({
      callId: 'c',
      tool: 't',
      status: 'success',
      ok: true,
      permission: 'not_required',
      verification: 'not_applicable',
      summary: '',
      startedAt: 0,
      durationMs: 1,
      output: 'y'.repeat(50_000),
    });
    expect(content.length).toBeLessThan(9000);
    expect(content).toMatch(/truncated/);
  });

  it('marks failures as errors and never leaks internal structure', () => {
    const { content, isError } = formatResultForModel({
      callId: 'c',
      tool: 't',
      status: 'failed',
      ok: false,
      permission: 'allowed',
      verification: 'not_applicable',
      summary: 'Do it',
      startedAt: 0,
      durationMs: 1,
      error: { code: 'TIMEOUT', message: 'took too long', retryable: true },
    });
    expect(isError).toBe(true);
    expect(JSON.parse(content)).toMatchObject({
      ok: false,
      status: 'failed',
      error: 'took too long',
    });
  });
});

describe('get_datetime (the first real tool)', () => {
  it('reports local time through the whole pipeline', async () => {
    const r = rig();
    r.registry.register(getDatetime);
    const result = await run(r, 'get_datetime', {});
    expect(result.output).toMatchObject({
      weekday: expect.any(String),
      weekdayBn: expect.any(String),
      timeZone: expect.any(String),
    });
  });

  it('rejects unexpected arguments (strict schema)', async () => {
    const r = rig();
    r.registry.register(getDatetime);
    expect((await run(r, 'get_datetime', { timezone: 'x' })).status).toBe('invalid');
  });
});
