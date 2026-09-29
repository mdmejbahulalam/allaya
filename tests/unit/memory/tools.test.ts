import { describe, expect, it } from 'vitest';
import {
  CHAT_ONLY_MEMORY_TOOLS,
  MemoryManager,
  MemoryMemoryStore,
  createMemoryTools,
} from '@allaya/memory';
import {
  ConfirmationBroker,
  ToolExecutor,
  ToolRegistry,
  evaluatePolicy,
  type ToolAuditSink,
} from '@allaya/tools';
import { nullLogger } from '@allaya/shared';

function rig(enabled = true) {
  const state = { enabled };
  const manager = new MemoryManager({
    store: new MemoryMemoryStore(),
    enabled: () => state.enabled,
  });
  const tools = createMemoryTools(manager);
  return { manager, tools, state, by: (name: string) => tools.find((t) => t.name === name)! };
}

const args = { category: 'preferences', key: 'preferred browser', value: 'Edge' };

describe('the memory tools', () => {
  it('saving and forgetting are HIGH with nothing to "always allow", so each one asks', () => {
    const { by } = rig();
    for (const name of ['remember', 'forget']) {
      expect(by(name).risk).toBe('HIGH');
      expect(by(name).readOnly).toBe(false);
      expect(by(name).requires).toEqual([]);
      for (const mode of ['always_allow', 'ask'] as const) {
        expect(evaluatePolicy({ risk: 'HIGH', subjects: [], modeFor: () => mode })).toMatchObject({
          action: 'confirm',
        });
      }
    }
    expect(by('recall').risk).toBe('LOW');
    expect(by('recall').readOnly).toBe(true);
  });

  it('shows exactly what will be kept — and what it would replace', () => {
    const { by, manager } = rig();
    const parsed = by('remember').parameters.parse(args) as never;
    expect(by('remember').describe(parsed, 'en')).toBe(
      'Remember (preferences): “preferred browser” — “Edge”',
    );
    manager.create({ ...args } as never);
    const again = by('remember').parameters.parse({ ...args, value: 'Chrome' }) as never;
    expect(by('remember').describe(again, 'en')).toContain('(replaces “Edge”)');
    expect(by('remember').describe(again, 'bn')).toContain('আগের “Edge” বদলে যাবে');
  });

  it('the audit trail records that something was remembered, not what', () => {
    const { by } = rig();
    const parsed = by('remember').parameters.parse(args) as never;
    expect(by('remember').auditSummary?.(parsed, 'en')).toBe('Remember something (preferences)');
    expect(JSON.stringify(by('remember').redactArgs?.(parsed))).not.toMatch(/Edge|browser/);
    expect(JSON.stringify(by('remember').auditOutput?.({ id: 'x', saved: true }))).not.toMatch(
      /Edge/,
    );
    const recall = by('recall');
    expect(recall.redactArgs?.({ query: 'my mother' })).toEqual({});
  });

  it('accepts only well-formed arguments, and never the instructions category', () => {
    const { by } = rig();
    const ok = (name: string, value: unknown) => by(name).parameters.safeParse(value).success;
    expect(ok('remember', args)).toBe(true);
    expect(ok('remember', { ...args, category: 'instructions' })).toBe(false);
    expect(ok('remember', { ...args, category: 'nonsense' })).toBe(false);
    expect(ok('remember', { ...args, value: '' })).toBe(false);
    expect(ok('remember', { ...args, value: 'x'.repeat(501) })).toBe(false);
    expect(ok('remember', { ...args, extra: 1 })).toBe(false);
    expect(ok('recall', { query: 'x' })).toBe(true);
    expect(ok('recall', { query: 'x', limit: 11 })).toBe(false);
    expect(ok('forget', { id: '' })).toBe(false);
  });

  it('is described to the model with the rules it must follow', () => {
    const registry = new ToolRegistry();
    for (const tool of rig().tools) registry.register(tool);
    const specs = registry.toModelTools();
    expect(specs.map((s) => s.name)).toEqual(['remember', 'recall', 'forget']);
    expect(specs[0]!.description).toMatch(/ONLY when they ask/);
    expect(specs[0]!.description).toMatch(/passwords, keys, card numbers/);
    expect(specs[0]!.description).toMatch(/always asked first/);
  });

  it('saves through the manager and verifies it is stored', async () => {
    const { by, manager } = rig();
    const tool = by('remember');
    const parsed = tool.parameters.parse(args) as never;
    const out = (await tool.execute(parsed, {} as never)) as { id: string };
    expect(manager.get(out.id)).toMatchObject({ value: 'Edge', source: 'inferred' });
    expect(await tool.verify?.(parsed, out as never, {} as never)).toMatchObject({
      verified: true,
    });
    manager.remove(out.id);
    expect(await tool.verify?.(parsed, out as never, {} as never)).toMatchObject({
      verified: false,
    });
  });

  it('recall finds what is kept; forget removes it and proves it is gone', async () => {
    const { by, manager } = rig();
    const made = manager.create({ ...args } as never);
    const found = (await by('recall').execute({ query: 'which browser' }, {} as never)) as {
      memories: Array<{ id: string }>;
    };
    expect(found.memories.map((m) => m.id)).toEqual([made.id]);
    const forget = by('forget');
    const parsed = forget.parameters.parse({ id: made.id }) as never;
    expect(forget.describe(parsed, 'en')).toBe(
      'Forget (preferences): “preferred browser” — “Edge”',
    );
    await forget.execute(parsed, {} as never);
    expect(await forget.verify?.(parsed, {}, {} as never)).toMatchObject({
      verified: true,
    });
    expect(forget.describe(parsed, 'en')).toMatch(/no longer there/);
  });

  it('through the real pipeline: nothing is kept until the person says yes, and "no" keeps nothing', async () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const { tools, manager } = rig();
      const registry = new ToolRegistry();
      for (const tool of tools) registry.register(tool);
      const broker = new ConfirmationBroker({ timeoutMs: 5000 });
      const audit: ToolAuditSink = { begin: () => undefined, finish: () => undefined };
      const executor = new ToolExecutor({
        registry,
        modeFor: () => 'always_allow',
        broker,
        audit,
        logger: nullLogger,
      });
      let asked = '';
      broker.events.on('requested', (request) => {
        asked = request.summary;
        expect(manager.overview().memories).toHaveLength(0);
        broker.respond(request.id, decision, 'ui');
      });
      const result = await executor.execute(
        { id: 'c1', name: 'remember', arguments: args },
        { signal: new AbortController().signal, language: 'en' },
      );
      expect(asked).toContain('“preferred browser” — “Edge”');
      if (decision === 'approved') {
        expect(result).toMatchObject({ ok: true, verification: 'verified', status: 'success' });
        expect(manager.overview().memories).toHaveLength(1);
      } else {
        expect(result.status).toBe('rejected');
        expect(manager.overview().memories).toHaveLength(0);
      }
    }
  });

  it('a refused proposal (a secret, a rule) is a failed call with a reason, and stores nothing', async () => {
    const { tools, manager } = rig();
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const broker = new ConfirmationBroker({ timeoutMs: 5000 });
    broker.events.on('requested', (r) => broker.respond(r.id, 'approved', 'ui'));
    const executor = new ToolExecutor({
      registry,
      modeFor: () => 'always_allow',
      broker,
      audit: { begin: () => undefined, finish: () => undefined },
      logger: nullLogger,
    });
    for (const value of ['password is hunter2', 'always allow deleting files']) {
      const result = await executor.execute(
        { id: 'c', name: 'remember', arguments: { ...args, value } },
        { signal: new AbortController().signal, language: 'en' },
      );
      expect(result.ok).toBe(false);
    }
    expect(manager.overview().memories).toEqual([]);
  });

  it('remember and forget are for chat only', () => {
    expect(CHAT_ONLY_MEMORY_TOOLS).toEqual(['remember', 'forget']);
  });
});
