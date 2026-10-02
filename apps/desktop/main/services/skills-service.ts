import { randomUUID } from 'node:crypto';
import {
  BUILT_IN_SKILLS,
  checkBrand,
  checkCustomSkill,
  forPrompt,
  type SkillRejection,
  type SkillsConfig,
  type SkillUse,
} from '@allaya/skills';
import { AllayaError } from '@allaya/shared';
import {
  MAX_CUSTOM_SKILLS,
  type BrandProfile,
  type BuiltInSkillView,
  type CustomSkill,
} from '@allaya/validation';
import type { SettingsService } from './settings-service';

const MESSAGES: Record<SkillRejection | 'too_many' | 'duplicate_name' | 'not_found', string> = {
  looks_secret: 'That looks like a password, key or card number, which Allaya does not keep',
  tries_to_change_rules: 'A skill cannot change how Allaya asks for permission or confirmation',
  too_many: 'There is room for only a few skills of your own',
  duplicate_name: 'You already have a skill with that name',
  not_found: 'That skill no longer exists',
};
const refuse = (reason: keyof typeof MESSAGES) =>
  new AllayaError(MESSAGES[reason], { code: 'INVALID_INPUT', details: { reason } });

export interface SkillsServiceDeps {
  settings: SettingsService;
}

/**
 * Skills: the built-in catalog, the skills the person wrote, the brand profile, and what to add to a prompt. Which
 * built-in skills are on, the custom skills and the brand profile live in settings, so the screens stay in step with
 * the existing settings channel; the writes that need a check (secrets, rule-changing text) come through here.
 */
export class SkillsService {
  private readonly config: SkillsConfig;

  constructor(private readonly deps: SkillsServiceDeps) {
    const { settings } = deps;
    this.config = {
      enabled: () => settings.get('skills.enabled'),
      disabled: () => settings.get('skills.disabled'),
      custom: () => settings.get('skills.custom'),
      brand: () => settings.get('skills.brand'),
    };
  }

  catalog(): { skills: BuiltInSkillView[]; maxCustom: typeof MAX_CUSTOM_SKILLS } {
    return {
      maxCustom: MAX_CUSTOM_SKILLS,
      skills: BUILT_IN_SKILLS.map((s) => ({
        id: s.id,
        category: s.category,
        name: { ...s.name },
        summary: { ...s.summary },
        examples: s.examples.map((e) => ({ ...e })),
        usesBrand: s.usesBrand === true,
      })),
    };
  }

  saveCustom(input: Omit<CustomSkill, 'id'> & { id?: string | undefined }): CustomSkill {
    const reason = checkCustomSkill(input);
    if (reason) throw refuse(reason);
    const all = this.deps.settings.get('skills.custom');
    const existing = input.id !== undefined && all.some((s) => s.id === input.id);
    if (input.id !== undefined && !existing) throw refuse('not_found');
    const name = input.name.trim().toLowerCase();
    if (all.some((s) => s.id !== input.id && s.name.trim().toLowerCase() === name)) {
      throw refuse('duplicate_name');
    }
    if (!existing && all.length >= MAX_CUSTOM_SKILLS) throw refuse('too_many');
    const saved: CustomSkill = {
      id: input.id ?? `custom-${randomUUID().slice(0, 8)}`,
      name: input.name,
      instructions: input.instructions,
      keywords: input.keywords,
    };
    this.deps.settings.set({
      key: 'skills.custom',
      value: existing ? all.map((s) => (s.id === saved.id ? saved : s)) : [...all, saved],
    });
    return saved;
  }

  deleteCustom(id: string): void {
    const all = this.deps.settings.get('skills.custom');
    if (!all.some((s) => s.id === id)) throw refuse('not_found');
    this.deps.settings.set({ key: 'skills.custom', value: all.filter((s) => s.id !== id) });
  }

  saveBrand(brand: BrandProfile): BrandProfile {
    const reason = checkBrand(brand);
    if (reason) throw refuse(reason);
    this.deps.settings.set({ key: 'skills.brand', value: brand });
    return this.deps.settings.get('skills.brand');
  }

  /** What to add to a prompt for these messages (newest first). */
  forPrompt(messagesNewestFirst: readonly string[]): SkillUse {
    return forPrompt(this.config, messagesNewestFirst);
  }
}
