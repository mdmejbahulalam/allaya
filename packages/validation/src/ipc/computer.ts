import { z } from 'zod';
import { noPayload, spec } from './common';
import { riskSchema } from './tools';

export const computerStatusSchema = z.object({
  platform: z.string(),
  adapter: z.string(),
  capabilities: z.object({
    windows: z.boolean(),
    launch: z.boolean(),
    screenshot: z.boolean(),
    clipboard: z.boolean(),
    mouse: z.boolean(),
    keyboard: z.boolean(),
    uiAutomation: z.boolean(),
  }),
  /** The tools the model is offered on this computer, with how risky each is treated. */
  tools: z.array(
    z.object({
      name: z.string(),
      category: z.string(),
      readOnly: z.boolean(),
      risk: riskSchema.or(z.literal('varies')),
    }),
  ),
  screenshotsFolder: z.string().optional(),
});
export type ComputerStatus = z.infer<typeof computerStatusSchema>;

export const selfTestResultSchema = z.object({
  /** `skipped`: the feature does not exist on this platform — not a failure. */
  steps: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string(),
      skipped: z.boolean().optional(),
    }),
  ),
  ok: z.boolean(),
});
export type SelfTestResult = z.infer<typeof selfTestResultSchema>;

export const computerContract = {
  invoke: {
    'computer:getStatus': spec(noPayload, computerStatusSchema),
    /** Safe, read-only checks that the platform integration works (lists windows, captures the screen). */
    'computer:selfTest': spec(noPayload, selfTestResultSchema),
  },
  events: {},
} as const;
