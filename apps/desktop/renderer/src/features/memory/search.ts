/** Case- and composition-insensitive text for the search box (never for what is stored or shown). */
/** Zero-width characters: written as escapes so no invisible character sits in the source. */
const INVISIBLE = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g');

export const fold = (text: string): string =>
  text.normalize('NFC').replace(INVISIBLE, '').toLowerCase();
