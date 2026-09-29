import { z } from 'zod';
import { defineTool, type ToolDefinition, type ToolLanguage } from '@allaya/tools';
import {
  automationInputSchema,
  type AutomationInput,
  type AutomationTrigger,
} from '@allaya/validation';
import { describeTrigger } from './describe';

const pick = (language: ToolLanguage, en: string, bn: string) => (language === 'bn' ? bn : en);

/** A model-made automation shows its whole instruction to the person who must approve it, so it stays short. */
export const MAX_TOOL_INSTRUCTION_CHARS = 600;

export interface AutomationSummary {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  instruction: string;
  nextRunAt?: number | undefined;
}

/** What the tools need from the automation service. */
export interface AutomationsPort {
  create(input: AutomationInput): Promise<AutomationSummary>;
  get(id: string): AutomationSummary | undefined;
  list(): AutomationSummary[];
}

const createParameters = automationInputSchema
  .extend({ instruction: z.string().trim().min(1).max(MAX_TOOL_INSTRUCTION_CHARS) })
  .strict();

/**
 * The automation tools the model may call. Creating one is the most persistent thing Allaya can do — it will run
 * again and again without anyone watching — so it is CRITICAL: it always needs an on-screen click on a question that
 * shows the name, the schedule and the whole instruction. They are for chat only: a task (including the unattended
 * run of an automation) is never offered them, so nothing that runs by itself can create more things that run by
 * themselves.
 */
export function createAutomationTools(port: AutomationsPort): ToolDefinition[] {
  const tools: unknown[] = [
    defineTool({
      name: 'create_automation',
      description:
        'Creates an automation: something Allaya does by itself later or again and again, such as "every weekday at ' +
        '9:00 list my Downloads" or "when a new file appears in Downloads, tell me what it is". Only when the user ' +
        'clearly asks for something to happen on a schedule or automatically. "instruction" is what to do each time, ' +
        'in the user\'s words. "trigger" is when: manual (only when they run it), once (an exact moment), interval ' +
        '(every N minutes, at least 5), daily (a time on chosen weekdays, 0 = Sunday), monthly (a day 1–28) or ' +
        "new_file (a folder). Times are the computer's local time. The user is always asked first, on the screen.",
      category: 'meta',
      parameters: createParameters,
      readOnly: false,
      risk: 'CRITICAL',
      requires: [],
      describe: (a, l) =>
        pick(
          l,
          `Create the automation “${a.name}”, which will run by itself — ${describeTrigger(a.trigger, l)}: “${a.instruction}”`,
          `স্বয়ংক্রিয় কাজ “${a.name}” তৈরি, যেটি নিজে নিজে চলবে — ${describeTrigger(a.trigger, l)}: “${a.instruction}”`,
        ),
      auditSummary: (a, l) =>
        pick(
          l,
          `Create the automation “${a.name}” — ${describeTrigger(a.trigger, l)}`,
          `স্বয়ংক্রিয় কাজ “${a.name}” তৈরি — ${describeTrigger(a.trigger, l)}`,
        ),
      async execute(args) {
        const made = await port.create(args);
        return {
          id: made.id,
          name: made.name,
          nextRunAt: made.nextRunAt ?? null,
          enabled: made.enabled,
        };
      },
      verify(args, output) {
        const found = port.get(output.id);
        const ok =
          found !== undefined && found.instruction === args.instruction && found.name === args.name;
        return Promise.resolve({
          verified: ok,
          evidence: ok
            ? `The automation “${args.name}” exists${found.enabled ? ' and is switched on' : ''}.`
            : 'The automation could not be found afterwards.',
        });
      },
    }),
    defineTool({
      name: 'list_automations',
      description:
        "Lists the user's automations: name, when each runs, whether it is switched on, and what it does. Does not " +
        'change anything.',
      category: 'meta',
      parameters: z.object({}).strict(),
      readOnly: true,
      risk: 'LOW',
      requires: [],
      describe: (_a, l) => pick(l, 'List your automations', 'আপনার স্বয়ংক্রিয় কাজগুলোর তালিকা'),
      execute() {
        return Promise.resolve({
          automations: port.list().map((a) => ({
            id: a.id,
            name: a.name,
            enabled: a.enabled,
            when: describeTrigger(a.trigger, 'en'),
            instruction: a.instruction.slice(0, 200),
            nextRunAt: a.nextRunAt ?? null,
          })),
        });
      },
    }),
  ];
  return tools as ToolDefinition[];
}

/** Tool names a task must never be offered (see above). */
export const CHAT_ONLY_AUTOMATION_TOOLS: readonly string[] = ['create_automation'];
