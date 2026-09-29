import { z } from '@allaya/validation';
import { AllayaError } from '@allaya/shared';
import { defineTool, type ToolDefinition } from '@allaya/tools';
import { RISK_LEVELS } from '@allaya/types';

/**
 * A harmless tool whose risk level the *caller* chooses, so tests can drive every branch of the permission and
 * confirmation pipeline (LOW runs straight through; MEDIUM/HIGH ask; CRITICAL demands an on-screen click)
 * without touching the real computer. Registered only in E2E builds and integration tests — never in production.
 */
export function createProbeTool(record: (note: string) => void = () => undefined): ToolDefinition {
  const ran = new Set<string>();
  return defineTool({
    name: 'e2e_probe',
    description:
      'Test-only tool. Records a note. Use level LOW/MEDIUM/HIGH/CRITICAL to say how risky the action should be treated.',
    category: 'system',
    parameters: z.object({
      level: z.enum(RISK_LEVELS),
      note: z.string().min(1).max(200),
      delayMs: z.number().int().min(0).max(10_000).default(0),
    }),
    readOnly: false,
    risk: (args) => args.level,
    requires: (args) =>
      args.level === 'CRITICAL' ? ['delete_files', 'file_access'] : ['file_access'],
    describe: (args, language) =>
      language === 'bn'
        ? `পরীক্ষা (${args.level}): ${args.note}`
        : `Probe (${args.level}): ${args.note}`,
    async execute(args, context) {
      if (args.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, args.delayMs);
          context.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(
                context.signal.reason instanceof Error
                  ? context.signal.reason
                  : new AllayaError('cancelled', { code: 'CANCELLED' }),
              );
            },
            { once: true },
          );
        });
      }
      record(args.note);
      ran.add(context.callId);
      return { ran: true, note: args.note };
    },
    verify: async (_args, _output, context) => ({
      verified: ran.has(context.callId),
      evidence: ran.has(context.callId) ? 'The probe recorded the note.' : 'The probe did not run.',
    }),
  });
}
