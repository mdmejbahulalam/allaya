import type { BrandProfile, CustomSkill } from '@allaya/validation';
import { EMPTY_BRAND } from '@allaya/validation';
import { BUILT_IN_SKILLS } from './catalog';
import { checkBrand, checkCustomSkill } from './guard';
import { relevant } from './match';
import { skillsBlock } from './prompt';
import type { SkillView } from './types';

/** What the skills need to know about the person's choices. The desktop app backs it with settings. */
export interface SkillsConfig {
  enabled: () => boolean;
  disabled: () => readonly string[];
  custom: () => readonly CustomSkill[];
  brand: () => BrandProfile;
}

export interface SkillUse {
  /** The block to add to the prompt; absent when no skill bears on the request. */
  text?: string | undefined;
  /** Which skills it came from, so the reply can show what shaped it. */
  used: Array<{ id: string; name: string }>;
}

/** Built-in skills first, then the person's own. */
export function allSkills(config: SkillsConfig): SkillView[] {
  const builtIn: SkillView[] = BUILT_IN_SKILLS.map((s) => ({
    id: s.id,
    builtIn: true,
    category: s.category,
    name: s.name.en,
    keywords: s.keywords,
    instructions: s.instructions,
    usesBrand: s.usesBrand === true,
  }));
  const custom: SkillView[] = config.custom().map((s) => ({
    id: s.id,
    builtIn: false,
    category: 'custom',
    name: s.name,
    keywords: s.keywords,
    instructions: s.instructions,
    usesBrand: false,
  }));
  return [...builtIn, ...custom];
}

/**
 * What to add to the prompt for these messages (newest first). Nothing when skills are off. A skill the person wrote is
 * checked again here — however it got into the settings — so one that holds a secret or tries to rewrite the rules
 * is never sent.
 */
export function forPrompt(config: SkillsConfig, messagesNewestFirst: readonly string[]): SkillUse {
  if (!config.enabled()) return { used: [] };
  const off = new Set(config.disabled());
  const candidates = allSkills(config).filter(
    (s) => !off.has(s.id) && (s.builtIn || checkCustomSkill(skillOf(s)) === undefined),
  );
  const active = relevant(candidates, messagesNewestFirst);
  if (active.length === 0) return { used: [] };
  const brand = config.brand();
  const safeBrand = checkBrand(brand) === undefined ? brand : EMPTY_BRAND;
  return {
    text: skillsBlock(active, safeBrand),
    used: active.map((s) => ({ id: s.id, name: s.name })),
  };
}

const skillOf = (s: SkillView) => ({
  name: s.name,
  instructions: s.instructions,
  keywords: [...s.keywords],
});
