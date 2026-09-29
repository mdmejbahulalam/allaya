import { z } from 'zod';
import { riskSchema } from './tools';
import { noPayload, spec } from './common';

/** One application Allaya knows how to open (from its fixed catalog — never a free-form program). */
export const appViewSchema = z.object({
  name: z.string(),
  /** `unknown`: this computer's adapter cannot tell (anything but Windows). */
  installed: z.enum(['yes', 'no', 'unknown']),
  /** `null`: cannot tell (no window access here). */
  running: z.boolean().nullable(),
  /** The last time Allaya opened or closed it (from the activity record). */
  lastUsedAt: z.number().optional(),
  /**
   * What Allaya can do with it here: `full` (keyboard, mouse and UI Automation), `basic` (open, close, focus),
   * `limited` (a shell: opened and closed, never given typed input), `none` (this computer cannot control apps).
   */
  support: z.enum(['full', 'basic', 'limited', 'none']),
  risk: riskSchema,
});
export type AppView = z.infer<typeof appViewSchema>;

export const appsOverviewSchema = z.object({
  apps: z.array(appViewSchema),
  /** What this computer lets Allaya do at all. */
  can: z.object({ launch: z.boolean(), windows: z.boolean() }),
  platform: z.string(),
});
export type AppsOverview = z.infer<typeof appsOverviewSchema>;

export const appOutcomeSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  summary: z.string(),
  message: z.string().optional(),
});
export type AppOutcome = z.infer<typeof appOutcomeSchema>;

const appName = z.object({ name: z.string().trim().min(1).max(60) }).strict();

export const appsContract = {
  invoke: {
    'apps:list': spec(noPayload, appsOverviewSchema),
    /** These go through the same tool pipeline as everything else: the person's permission settings apply. */
    'apps:open': spec(appName, appOutcomeSchema),
    'apps:close': spec(appName, appOutcomeSchema),
    'apps:focus': spec(appName, appOutcomeSchema),
  },
  events: {},
} as const;
