/** 'bn' when the text is mostly Bengali script, otherwise 'en'. Enough to pick a voice for a reply. */
export function speechLanguage(text: string): 'bn' | 'en' {
  let bengali = 0;
  let letters = 0;
  for (const char of text) {
    if (/\p{L}/u.test(char)) {
      letters += 1;
      const code = char.codePointAt(0) ?? 0;
      if (code >= 0x0980 && code <= 0x09ff) bengali += 1;
    }
  }
  return letters > 0 && bengali / letters >= 0.3 ? 'bn' : 'en';
}
