import { looksSecret, triesToChangeRules } from '@allaya/memory';
import type { BrandProfile, CustomSkill } from '@allaya/validation';

/** Why a skill or brand profile was not accepted. */
export type SkillRejection = 'looks_secret' | 'tries_to_change_rules';

const textOf = (skill: Pick<CustomSkill, 'name' | 'instructions' | 'keywords'>) =>
  [skill.name, skill.instructions, ...skill.keywords].join('\n');

/**
 * A skill is advice about doing a kind of work. It cannot hold a password or key (it is sent to the AI service), and it
 * cannot say how Allaya should treat its own rules — permissions and confirmations belong to the app, not to text.
 */
export function checkCustomSkill(
  skill: Pick<CustomSkill, 'name' | 'instructions' | 'keywords'>,
): SkillRejection | undefined {
  const text = textOf(skill);
  if (looksSecret(text)) return 'looks_secret';
  if (triesToChangeRules(text)) return 'tries_to_change_rules';
  return undefined;
}

export function checkBrand(brand: BrandProfile): SkillRejection | undefined {
  const text = [
    brand.businessName,
    brand.about,
    brand.audience,
    brand.tone,
    brand.languages,
    brand.goals,
    brand.avoid,
  ].join('\n');
  if (looksSecret(text)) return 'looks_secret';
  if (triesToChangeRules(text)) return 'tries_to_change_rules';
  return undefined;
}
