const TITLE_MAX = 60;

/** A one-line title from free text, cut by code point so a Bengali conjunct or emoji is never split in half. */
export function titleFromText(text: string, max = TITLE_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : oneLine;
}
