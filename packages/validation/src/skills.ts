import { z } from 'zod';

/**
 * Skills: know-how Allaya brings to a request when it is relevant — a way of working, not a new power. A skill
 * only shapes what the AI writes and how it approaches the job; every action still goes through the same tools,
 * permissions and confirmations as anything else.
 */
export const MAX_CUSTOM_SKILLS = 10;
export const MAX_SKILL_NAME_CHARS = 60;
export const MAX_SKILL_INSTRUCTION_CHARS = 1500;
export const MAX_SKILL_KEYWORDS = 12;
export const MAX_SKILL_KEYWORD_CHARS = 40;

export const skillIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/** A skill the person wrote themselves. */
export const customSkillSchema = z
  .object({
    id: skillIdSchema,
    name: z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS),
    /** How the person wants this kind of work done, in their own words. */
    instructions: z.string().trim().min(1).max(MAX_SKILL_INSTRUCTION_CHARS),
    /** Words in a request that bring this skill in. */
    keywords: z
      .array(z.string().trim().min(1).max(MAX_SKILL_KEYWORD_CHARS))
      .min(1)
      .max(MAX_SKILL_KEYWORDS),
  })
  .strict();
export type CustomSkill = z.infer<typeof customSkillSchema>;

export const SOCIAL_PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'x',
  'linkedin',
  'pinterest',
  'threads',
  'whatsapp',
  'telegram',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** Who the person (or their business) is, for the social media skill. Everything is optional. */
export const brandProfileSchema = z
  .object({
    businessName: z.string().trim().max(80),
    /** What the business does, in a sentence or two. */
    about: z.string().trim().max(400),
    audience: z.string().trim().max(300),
    /** How the brand sounds: "warm and playful", "professional but friendly". */
    tone: z.string().trim().max(200),
    platforms: z.array(z.enum(SOCIAL_PLATFORMS)).max(SOCIAL_PLATFORMS.length),
    /** The language(s) the posts are written in. */
    languages: z.string().trim().max(100),
    goals: z.string().trim().max(300),
    /** Topics, words or claims to stay away from. */
    avoid: z.string().trim().max(300),
  })
  .strict();
export type BrandProfile = z.infer<typeof brandProfileSchema>;

export const EMPTY_BRAND: BrandProfile = {
  businessName: '',
  about: '',
  audience: '',
  tone: '',
  platforms: [],
  languages: '',
  goals: '',
  avoid: '',
};
