export type ResponseLanguagePolicy = 'auto' | 'bn' | 'en' | 'mixed';

export interface SystemPromptOptions {
  /** User's chosen reply-language policy (settings). */
  responseLanguage: ResponseLanguagePolicy;
  /** Display name for natural address; omitted if empty. */
  userName?: string;
  /** Whether tool calling is wired up for this request. Controls what the model may claim it can do. */
  toolsAvailable: boolean;
  /** Local time, so relative dates ("today", "গতকাল") resolve correctly. */
  now?: Date;
}

const LANGUAGE_RULES: Record<ResponseLanguagePolicy, string> = {
  auto:
    'Reply in the language the user writes in. If they write Bengali — in Bengali script or in romanized "Banglish" ' +
    '(e.g. "amar Downloads folder ta open koro") — reply in natural Bengali script. If they mix Bengali and English, ' +
    'answer in the same natural mix. Never translate literally; write the way a fluent speaker would.',
  bn: 'Always reply in natural Bengali (Bengali script), whatever language the user writes in.',
  en: 'Always reply in clear English, whatever language the user writes in.',
  mixed:
    'Reply in a natural mix of Bengali and English, the way a bilingual Bengali speaker would, using Bengali script for the Bengali parts.',
};

const PRESERVE_RULE =
  'Keep file names, folder names, URLs, application and product names, code, and technical terms exactly as written — ' +
  'never transliterate or translate them.';

/**
 * Builds Allaya's system prompt. The capability paragraph is deliberately explicit: without tools the model
 * must never claim to have performed an action on the computer (§131: no completion claims without verification).
 */
export function buildSystemPrompt(options: SystemPromptOptions): string {
  const lines: string[] = [
    "You are Allaya, a personal AI assistant that lives on the user's Windows computer.",
    'Be concise, calm, and action-oriented. After a simple action, answer in one short sentence.',
    `Language: ${LANGUAGE_RULES[options.responseLanguage]}`,
    PRESERVE_RULE,
  ];

  if (options.toolsAvailable) {
    lines.push(
      'You can act on the computer only by calling the provided tools. Never describe an action as done unless a tool ' +
        'result confirms it. If a tool fails, say so plainly and suggest what to do next.',
    );
  } else {
    lines.push(
      'In this conversation you have NO tools and cannot control the computer, open files or apps, browse, or change ' +
        'anything. Never claim or imply that you performed such an action. If asked to, explain that you cannot do it ' +
        'from here yet and, where helpful, tell the user how they could do it themselves.',
    );
  }

  if (options.userName?.trim()) lines.push(`The user's name is ${options.userName.trim()}.`);
  if (options.now) {
    lines.push(
      `Current local date and time: ${options.now.toLocaleString('en-CA', { hour12: false })}.`,
    );
  }
  return lines.join('\n');
}
