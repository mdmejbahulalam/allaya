import { tokens } from '@allaya/memory';
import type { SkillView } from './types';

/** The most skills brought into one reply: each adds to what is sent to the AI service. */
export const MAX_ACTIVE_SKILLS = 2;

/**
 * A word in the request matches a keyword when it is that word, or begins with it ("posting" for "post"). Not the other
 * way round, and not for short words: "time" must not bring in "timetable".
 */
const wordMatches = (queryWord: string, keywordWord: string): boolean =>
  queryWord === keywordWord ||
  (Array.from(keywordWord).length >= 4 && queryWord.startsWith(keywordWord));

const hits = (queryWords: readonly string[], phrase: string): boolean => {
  const words = tokens(phrase);
  if (words.length === 0) return false;
  return words.every((word) => queryWords.some((q) => wordMatches(q, word)));
};

/** How many of a skill's keywords the text contains. */
export function score(skill: Pick<SkillView, 'keywords'>, text: string): number {
  const queryWords = tokens(text);
  if (queryWords.length === 0) return 0;
  let total = 0;
  for (const keyword of skill.keywords) if (hits(queryWords, keyword)) total += 1;
  return total;
}

/**
 * The skills that bear on this conversation, best first. `messages` are the person's recent messages, newest first:
 * the newest counts double, so a follow-up such as "make it shorter" still has the skill from the message before it,
 * while a change of subject drops it. Plain word matching — nothing is sent anywhere to decide.
 */
export function relevant(
  skills: readonly SkillView[],
  messages: readonly string[],
  max = MAX_ACTIVE_SKILLS,
): SkillView[] {
  const ranked = skills
    .map((skill, order) => {
      const latest = messages[0] ? score(skill, messages[0]) : 0;
      const before = messages[1] ? score(skill, messages[1]) : 0;
      return { skill, order, value: latest * 2 + before };
    })
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.order - b.order);
  return ranked.slice(0, max).map((r) => r.skill);
}
