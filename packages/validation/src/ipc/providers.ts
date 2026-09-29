import { PROVIDER_IDS, ROUTING_PURPOSES } from '@allaya/types';
import { z } from 'zod';
import { noPayload, spec } from './common';

export const providerIdSchema = z.enum(PROVIDER_IDS);

export const modelCapabilitiesSchema = z.object({
  vision: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
  reasoning: z.boolean(),
  contextWindow: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative().optional(),
});

export const modelViewSchema = z.object({
  providerId: providerIdSchema,
  modelId: z.string(),
  displayName: z.string(),
  tier: z.enum(['fast', 'balanced', 'frontier']),
  capabilities: modelCapabilitiesSchema,
  cost: z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }).optional(),
  capabilitySource: z.enum(['provider', 'inferred']),
});
export type ModelView = z.infer<typeof modelViewSchema>;

export const providerViewSchema = z.object({
  id: providerIdSchema,
  name: z.string(),
  status: z.enum(['connected', 'not_configured', 'error']),
  /** Masked hint only (e.g. `sk-…a1b2`). The full key never leaves the main process. */
  maskedKey: z.string().optional(),
  models: z.array(modelViewSchema),
  lastCheckedAt: z.number().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  /** Set when the key was saved but doesn't look like this provider's usual format. */
  keyWarning: z.enum(['unexpected_prefix']).optional(),
});
export type ProviderView = z.infer<typeof providerViewSchema>;

export const modelRefSchema = z.object({
  providerId: providerIdSchema,
  modelId: z.string().min(1).max(200),
});
export type ModelRefView = z.infer<typeof modelRefSchema>;

export const routingViewSchema = z.object({
  autoRouting: z.boolean(),
  assignments: z.partialRecord(z.enum(ROUTING_PURPOSES), modelRefSchema),
});
export type RoutingView = z.infer<typeof routingViewSchema>;

export const connectionResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  modelCount: z.number().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

/** Sent renderer → main once, when the user saves a key. Never echoed back, never logged. */
const hasControlChars = (value: string): boolean =>
  Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

export const apiKeyInputSchema = z
  .string()
  .min(8)
  .max(600)
  .refine((v) => !hasControlChars(v.trim()), 'invalid characters');

export const providersContract = {
  invoke: {
    'providers:list': spec(noPayload, z.array(providerViewSchema)),
    'providers:setKey': spec(
      z.object({ providerId: providerIdSchema, apiKey: apiKeyInputSchema }),
      providerViewSchema,
    ),
    'providers:removeKey': spec(z.object({ providerId: providerIdSchema }), providerViewSchema),
    'providers:test': spec(
      z.object({ providerId: providerIdSchema }),
      z.object({ result: connectionResultSchema, provider: providerViewSchema }),
    ),
    'providers:refreshModels': spec(z.object({ providerId: providerIdSchema }), providerViewSchema),
    'models:list': spec(noPayload, z.array(modelViewSchema)),
    'models:getRouting': spec(noPayload, routingViewSchema),
    'models:setRouting': spec(
      z.object({
        autoRouting: z.boolean().optional(),
        /** `null` clears an assignment. */
        assignments: z
          .partialRecord(z.enum(ROUTING_PURPOSES), modelRefSchema.nullable())
          .optional(),
      }),
      routingViewSchema,
    ),
  },
  events: {
    'providers:changed': z.array(providerViewSchema),
  },
} as const;
