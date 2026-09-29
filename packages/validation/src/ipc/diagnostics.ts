import { z } from 'zod';
import { emergencyStopStatusSchema } from './agent';
import { noPayload, spec } from './common';

/** One line of the health report. `attention` means something the person may want to look at. */
const tone = z.enum(['ok', 'attention', 'off']);

/**
 * What Allaya knows about its own health, for the Diagnostics page and the exported file. It holds statuses and counts
 * only — never a key, a message, a memory, a task or a file's contents.
 */
export const diagnosticsSchema = z.object({
  generatedAt: z.number(),
  app: z.object({
    name: z.string(),
    version: z.string(),
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
    platform: z.string(),
    osVersion: z.string(),
    arch: z.string(),
    packaged: z.boolean(),
    environment: z.string(),
  }),
  database: z.object({
    tone,
    ok: z.boolean(),
    migrations: z.number(),
    tables: z.number(),
    journalMode: z.string(),
    foreignKeys: z.boolean(),
    error: z.string().optional(),
  }),
  providers: z.object({
    tone,
    connected: z.number(),
    total: z.number(),
    items: z.array(
      z.object({
        name: z.string(),
        status: z.enum(['connected', 'not_configured', 'error']),
        models: z.number(),
        errorCode: z.string().optional(),
      }),
    ),
  }),
  voice: z.object({
    tone,
    enabled: z.boolean(),
    speechEngine: z.enum(['system', 'cloud']),
    inputLanguage: z.enum(['auto', 'bn', 'en']),
    cloudSpeechReady: z.boolean(),
  }),
  computer: z.object({
    tone,
    adapter: z.string(),
    platform: z.string(),
    capabilities: z.record(z.string(), z.boolean()),
  }),
  browser: z.object({
    tone,
    available: z.boolean(),
    engine: z.string().nullable(),
    running: z.boolean(),
  }),
  automations: z.object({
    tone,
    total: z.number(),
    enabled: z.number(),
    paused: z.boolean(),
  }),
  memory: z.object({ tone, enabled: z.boolean(), count: z.number() }),
  permissions: z.object({
    tone,
    /** Only the ones that are not at their cautious default. */
    changed: z.array(z.object({ subject: z.string(), mode: z.string() })),
  }),
  shell: z.object({
    tone,
    trayAvailable: z.boolean(),
    launchAtLoginSupported: z.boolean(),
    emergencyStop: emergencyStopStatusSchema,
    showAppKey: emergencyStopStatusSchema,
  }),
  updates: z.object({ tone, state: z.string() }),
  logs: z.object({ folder: z.string().optional() }),
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

export const diagnosticsContract = {
  invoke: {
    'diagnostics:get': spec(noPayload, diagnosticsSchema),
    /** Saves the report and the recent log lines, with secrets and the person's folder names removed, to a file they choose. */
    'diagnostics:export': spec(noPayload, z.object({ saved: z.boolean() })),
  },
  events: {},
} as const;
