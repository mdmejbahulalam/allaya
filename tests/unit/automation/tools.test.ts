import { describe, expect, it } from 'vitest';
import {
  CHAT_ONLY_AUTOMATION_TOOLS,
  MAX_TOOL_INSTRUCTION_CHARS,
  createAutomationTools,
  type AutomationSummary,
  type AutomationsPort,
} from '@allaya/automation';
import {
  ConfirmationBroker,
  ToolExecutor,
  ToolRegistry,
  evaluatePolicy,
  type ToolAuditSink,
} from '@allaya/tools';
import { nullLogger } from '@allaya/shared';
import type { AutomationInput } from '@allaya/validation';

function port(): AutomationsPort & { created: AutomationInput[]; all: AutomationSummary[] } {
  const all: AutomationSummary[] = [];
  const created: AutomationInput[] = [];
  return {
    all,
    created,
    async create(input) {
      created.push(input);
      const made: AutomationSummary = {
        id: `auto_${all.length + 1}`,
        name: input.name,
        enabled: true,
        trigger: input.trigger,
        instruction: input.instruction,
        nextRunAt: 123,
      };
      all.push(made);
      return made;
    },
    get: (id) => all.find((a) => a.id === id),
    list: () => all,
  };
}

const valid = {
  name: 'Morning check',
  instruction: 'List my Downloads folder',
  trigger: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
};

describe('the automation tools', () => {
  it('creating one is CRITICAL: an on-screen click, never a spoken or typed yes, and no permission setting silences it', () => {
    const [create] = createAutomationTools(port());
    expect(create!.name).toBe('create_automation');
    expect(create!.risk).toBe('CRITICAL');
    expect(create!.readOnly).toBe(false);
    for (const mode of ['always_allow', 'ask'] as const) {
      const decision = evaluatePolicy({ risk: 'CRITICAL', subjects: [], modeFor: () => mode });
      expect(decision).toEqual({ action: 'confirm', reason: 'critical', channels: ['ui'] });
    }
  });

  it('shows the person the name, the schedule and the whole instruction they are approving', () => {
    const [create] = createAutomationTools(port());
    const args = create!.parameters.parse(valid) as never;
    expect(create!.describe(args, 'en')).toBe(
      'Create the automation “Morning check”, which will run by itself — Weekdays at 09:00: “List my Downloads folder”',
    );
    expect(create!.describe(args, 'bn')).toContain('সপ্তাহের কর্মদিবসে 09:00-এ');
    expect(create!.describe(args, 'bn')).toContain('List my Downloads folder');
    // The audit trail keeps what and when, not the instruction text.
    expect(create!.auditSummary?.(args, 'en')).toBe(
      'Create the automation “Morning check” — Weekdays at 09:00',
    );
  });

  it('accepts only well-formed, bounded arguments', () => {
    const [create] = createAutomationTools(port());
    const ok = (value: unknown) => create!.parameters.safeParse(value).success;
    expect(ok(valid)).toBe(true);
    expect(ok({ ...valid, instruction: 'x'.repeat(MAX_TOOL_INSTRUCTION_CHARS + 1) })).toBe(false);
    expect(ok({ ...valid, instruction: '   ' })).toBe(false);
    expect(ok({ ...valid, name: '' })).toBe(false);
    expect(ok({ ...valid, name: 'n'.repeat(81) })).toBe(false);
    expect(ok({ ...valid, trigger: { kind: 'interval', everyMinutes: 1 } })).toBe(false);
    expect(ok({ ...valid, trigger: { kind: 'cron', expression: '* * * * *' } })).toBe(false);
    expect(ok({ ...valid, extra: 'field' })).toBe(false);
    expect(ok({ ...valid, options: { missed: 'run_forever' } })).toBe(false);
    expect(ok({ ...valid, options: { planFirst: true, missed: 'run_once' } })).toBe(true);
  });

  it('is described to the model with a schema it can follow', () => {
    const registry = new ToolRegistry();
    for (const tool of createAutomationTools(port())) registry.register(tool);
    const specs = registry.toModelTools();
    expect(specs.map((s) => s.name)).toEqual(['create_automation', 'list_automations']);
    const schema = JSON.stringify(specs[0]!.inputSchema);
    expect(schema).toContain('daily');
    expect(schema).toContain('new_file');
    expect(specs[0]!.description).toMatch(/always asked first, on the screen/);
  });

  it('creates through the port and verifies it exists afterwards; a missing one is reported', async () => {
    const p = port();
    const [create] = createAutomationTools(p);
    const args = create!.parameters.parse(valid) as never;
    const output = (await create!.execute(args, {} as never)) as { id: string; name: string };
    expect(output).toMatchObject({ id: 'auto_1', name: 'Morning check' });
    expect(p.created).toHaveLength(1);
    expect(await create!.verify?.(args, output as never, {} as never)).toMatchObject({
      verified: true,
    });
    p.all.length = 0;
    expect(await create!.verify?.(args, output as never, {} as never)).toMatchObject({
      verified: false,
    });
  });

  it('lists what exists, read-only, with the instruction cut short', async () => {
    const p = port();
    p.all.push({
      id: 'a1',
      name: 'Long',
      enabled: false,
      trigger: { kind: 'new_file', folder: 'Downloads' },
      instruction: 'y'.repeat(500),
    });
    const list = createAutomationTools(p)[1]!;
    expect(list.readOnly).toBe(true);
    expect(list.risk).toBe('LOW');
    const out = (await list.execute({}, {} as never)) as {
      automations: Array<{ when: string; instruction: string; nextRunAt: number | null }>;
    };
    expect(out.automations[0]).toMatchObject({
      when: 'When a new file appears in “Downloads”',
      nextRunAt: null,
    });
    expect(out.automations[0]!.instruction).toHaveLength(200);
  });

  it('through the real pipeline: nothing is created until the person says yes, and "no" creates nothing', async () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const p = port();
      const registry = new ToolRegistry();
      for (const tool of createAutomationTools(p)) registry.register(tool);
      const broker = new ConfirmationBroker({ timeoutMs: 5000 });
      const audit: ToolAuditSink = { begin: () => undefined, finish: () => undefined };
      const executor = new ToolExecutor({
        registry,
        modeFor: () => 'always_allow',
        broker,
        audit,
        logger: nullLogger,
      });
      broker.events.on('requested', (request) => {
        expect(request.risk).toBe('CRITICAL');
        expect(request.channels).toEqual(['ui']);
        // A typed or spoken "yes" is refused; only the screen counts.
        expect(broker.respond(request.id, 'approved', 'voice')).toEqual({
          ok: false,
          reason: 'channel_not_allowed',
        });
        expect(broker.respond(request.id, 'approved', 'text')).toEqual({
          ok: false,
          reason: 'channel_not_allowed',
        });
        expect(p.created).toHaveLength(0);
        broker.respond(request.id, decision, 'ui');
      });
      const result = await executor.execute(
        { id: 'c1', name: 'create_automation', arguments: valid },
        { signal: new AbortController().signal, language: 'en' },
      );
      if (decision === 'approved') {
        expect(result).toMatchObject({ ok: true, verification: 'verified', status: 'success' });
        expect(p.created).toHaveLength(1);
      } else {
        expect(result.status).toBe('rejected');
        expect(p.created).toHaveLength(0);
      }
    }
  });

  it('is for chat only', () => {
    expect(CHAT_ONLY_AUTOMATION_TOOLS).toEqual(['create_automation']);
  });
});
