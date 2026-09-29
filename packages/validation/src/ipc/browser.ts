import { z } from 'zod';
import { noPayload, spec } from './common';
import { riskSchema } from './tools';

export const browserTabSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Without its query string or fragment (which can carry tokens). */
  url: z.string(),
  active: z.boolean(),
});

export const browserStatusSchema = z.object({
  /** A compatible browser (Microsoft Edge or Google Chrome) is installed. */
  available: z.boolean(),
  engine: z.enum(['edge', 'chrome', 'chromium']).nullable(),
  /** The browser window is open right now. */
  running: z.boolean(),
  headless: z.boolean(),
  tabs: z.array(browserTabSchema),
  trustedDomains: z.array(z.string()),
  blockedDomains: z.array(z.string()),
  profileFolder: z.string().optional(),
  /** The tools the model is offered for the browser, with how risky each is treated. */
  tools: z.array(
    z.object({ name: z.string(), readOnly: z.boolean(), risk: riskSchema.or(z.literal('varies')) }),
  ),
});
export type BrowserStatus = z.infer<typeof browserStatusSchema>;

export const browserContract = {
  invoke: {
    'browser:getStatus': spec(noPayload, browserStatusSchema),
    /** Adds or removes a site from the trusted or blocked list. The name is checked and normalised in the main process. */
    'browser:setDomain': spec(
      z.object({
        list: z.enum(['trusted', 'blocked']),
        domain: z.string().min(1).max(253),
        present: z.boolean(),
      }),
      browserStatusSchema,
    ),
    /** Opens Allaya's browser window so the person can sign in to sites themselves. */
    'browser:openWindow': spec(
      z.object({ url: z.string().max(2048).optional() }),
      browserStatusSchema,
    ),
    'browser:close': spec(noPayload, browserStatusSchema),
  },
  events: {
    'browser:changed': z.object({}),
  },
} as const;
