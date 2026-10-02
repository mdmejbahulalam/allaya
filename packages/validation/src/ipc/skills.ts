import { z } from 'zod';
import { brandProfileSchema, customSkillSchema, skillIdSchema, MAX_CUSTOM_SKILLS } from '../skills';
import { noPayload, okSchema, spec } from './common';

const localized = z.object({ en: z.string(), bn: z.string() });

/** A skill that ships with Allaya, with its words in both languages (the screen picks one). */
export const builtInSkillSchema = z.object({
  id: skillIdSchema,
  category: z.enum(['marketing', 'writing', 'research', 'learning', 'life']),
  name: localized,
  summary: localized,
  examples: z.array(localized),
  /** The skill makes use of the brand profile. */
  usesBrand: z.boolean(),
});
export type BuiltInSkillView = z.infer<typeof builtInSkillSchema>;

/** Save a skill the person wrote: with an `id` it replaces that skill, without one it is added. */
export const saveCustomSkillSchema = customSkillSchema.omit({ id: true }).extend({
  id: skillIdSchema.optional(),
});

export const skillsContract = {
  invoke: {
    /** The skills that ship with Allaya. Which are on, the custom skills and the brand profile are settings. */
    'skills:catalog': spec(
      noPayload,
      z.object({ skills: z.array(builtInSkillSchema), maxCustom: z.literal(MAX_CUSTOM_SKILLS) }),
    ),
    'skills:saveCustom': spec(saveCustomSkillSchema, customSkillSchema),
    'skills:deleteCustom': spec(z.object({ id: skillIdSchema }), okSchema),
    'skills:saveBrand': spec(brandProfileSchema, brandProfileSchema),
  },
  events: {},
} as const;
