export type SkillLanguage = 'en' | 'bn';
export type Localized = Record<SkillLanguage, string>;

export type SkillCategory = 'marketing' | 'writing' | 'research' | 'learning' | 'life';

/** A skill that ships with Allaya. */
export interface SkillDef {
  id: string;
  category: SkillCategory;
  /** What the person sees. */
  name: Localized;
  summary: Localized;
  /** What the AI is told, in English (models follow one clear language best); the reply language is set elsewhere. */
  instructions: string;
  /** Words (English and Bengali) in a request that bring this skill in. A phrase needs every word of it. */
  keywords: readonly string[];
  /** Things to try, shown on the Skills screen. */
  examples: readonly Localized[];
  /** The skill makes use of the brand profile. */
  usesBrand?: boolean;
}

/** One skill as the rest of the app sees it: built in or the person's own. */
export interface SkillView {
  id: string;
  builtIn: boolean;
  category: SkillCategory | 'custom';
  name: string;
  keywords: readonly string[];
  instructions: string;
  usesBrand: boolean;
}
