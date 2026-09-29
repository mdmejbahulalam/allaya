import { describe, expect, it } from 'vitest';
import { parseCommand, type IntentParams, type ParsedIntent } from '@allaya/language';

const ctx = { today: { year: 2026, month: 9, day: 29 } };
const parse = (text: string) => parseCommand(text, ctx);
const only = (text: string): ParsedIntent => {
  const result = parse(text);
  expect(result.clauses, text).toHaveLength(1);
  return result.clauses[0]!;
};

interface Case {
  text: string;
  type: ParsedIntent['type'];
  params?: IntentParams;
}

const check = ({ text, type, params }: Case) => {
  const intent = only(text);
  expect(intent.type, text).toBe(type);
  expect(intent.resolved, text).toBe(true);
  if (params) expect(intent.params, text).toEqual(params);
};

describe('open — Bengali, Banglish, English and mixed', () => {
  const cases: Case[] = [
    { text: 'ডাউনলোড ফোল্ডার খুলে দাও', type: 'OPEN_FOLDER', params: { folder: 'Downloads' } },
    { text: 'Downloads folder টা খুলে দাও', type: 'OPEN_FOLDER', params: { folder: 'Downloads' } },
    {
      text: 'amar Downloads folder ta open koro',
      type: 'OPEN_FOLDER',
      params: { folder: 'Downloads' },
    },
    { text: 'Open my Downloads folder', type: 'OPEN_FOLDER', params: { folder: 'Downloads' } },
    { text: 'ডেস্কটপ খুলো', type: 'OPEN_FOLDER', params: { folder: 'Desktop' } },
    { text: 'আমার Documents খুলে দাও', type: 'OPEN_FOLDER', params: { folder: 'Documents' } },
    { text: 'ক্রোম খুলে দাও', type: 'OPEN_APP', params: { app: 'Chrome' } },
    { text: 'Chrome open koro', type: 'OPEN_APP', params: { app: 'Chrome' } },
    { text: 'chrome ta khule dao', type: 'OPEN_APP', params: { app: 'Chrome' } },
    { text: 'ওপেন করো Chrome', type: 'OPEN_APP', params: { app: 'Chrome' } },
    { text: 'Notepad ওপেন করো', type: 'OPEN_APP', params: { app: 'Notepad' } },
    { text: 'নোটপ্যাড খুলে দিন', type: 'OPEN_APP', params: { app: 'Notepad' } },
    { text: 'launch Visual Studio Code', type: 'OPEN_APP', params: { app: 'VS Code' } },
    { text: 'ভিএস কোড চালু করো', type: 'OPEN_APP', params: { app: 'VS Code' } },
    { text: 'Open Word', type: 'OPEN_APP', params: { app: 'Word' } },
    { text: 'ব্রাউজার খুলে দাও', type: 'OPEN_APP', params: { target: 'browser' } },
    { text: 'youtube.com খুলো', type: 'OPEN_URL', params: { url: 'youtube.com' } },
    {
      text: 'open https://example.com/docs',
      type: 'OPEN_URL',
      params: { url: 'https://example.com/docs' },
    },
    { text: 'ইউটিউব খুলে দাও', type: 'OPEN_URL', params: { site: 'YouTube' } },
    {
      text: 'D:\\Work\\report.xlsx open koro',
      type: 'OPEN_FILE',
      params: { path: 'D:\\Work\\report.xlsx' },
    },
    { text: 'D:\\Work খুলে দাও', type: 'OPEN_FOLDER', params: { path: 'D:\\Work' } },
    {
      text: 'Desktop এর notes.txt খুলে দাও',
      type: 'OPEN_FILE',
      params: { fileName: 'notes.txt', folder: 'Desktop' },
    },
    { text: 'settings খুলো', type: 'OPEN_SETTINGS' },
  ];
  it.each(cases)('$text', check);
});

describe('close', () => {
  const cases: Case[] = [
    { text: 'close Chrome', type: 'CLOSE_APP', params: { app: 'Chrome' } },
    { text: 'chrome bondho koro', type: 'CLOSE_APP', params: { app: 'Chrome' } },
    { text: 'ক্রোম বন্ধ করো', type: 'CLOSE_APP', params: { app: 'Chrome' } },
    { text: 'Notepad বন্ধ করে দাও', type: 'CLOSE_APP', params: { app: 'Notepad' } },
  ];
  it.each(cases)('$text', check);

  it('"close this" needs the conversation context — it is not guessed', () => {
    const intent = only('এটা বন্ধ করো');
    expect(intent.type).toBe('CLOSE_APP');
    expect(intent.params.refersToContext).toBe(true);
  });
});

describe('search and find', () => {
  const cases: Case[] = [
    {
      text: 'Google এ "best laptop 2026" search করো',
      type: 'WEB_SEARCH',
      params: { site: 'Google', query: 'best laptop 2026' },
    },
    {
      text: 'গুগলে "আবহাওয়া" সার্চ করো',
      type: 'WEB_SEARCH',
      params: { site: 'Google', query: 'আবহাওয়া' },
    },
    {
      text: 'search Google for weather',
      type: 'WEB_SEARCH',
      params: { site: 'Google', query: 'weather' },
    },
    {
      text: 'YouTube এ গান search করো',
      type: 'WEB_SEARCH',
      params: { site: 'YouTube', query: 'গান' },
    },
    {
      text: 'Desktop এর সব PDF file খুঁজে দাও',
      type: 'FIND_FILES',
      params: { fileTypes: ['pdf'], extensions: ['.pdf'], folder: 'Desktop', all: true },
    },
    {
      text: 'find "invoice" in Downloads',
      type: 'FIND_FILES',
      params: { query: 'invoice', folder: 'Downloads' },
    },
    {
      text: 'আমার সব ছবি খুঁজে দাও',
      type: 'FIND_FILES',
      params: {
        fileTypes: ['image'],
        extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
        all: true,
      },
    },
    {
      text: 'Documents এ "budget" খুঁজে দাও',
      type: 'FIND_FILES',
      params: { query: 'budget', folder: 'Documents' },
    },
    {
      text: 'report.docx খুঁজে দাও',
      type: 'FIND_FILES',
      params: { fileName: 'report.docx', extensions: ['.docx'] },
    },
    {
      text: 'khuje dao "tax" Downloads e',
      type: 'FIND_FILES',
      params: { query: 'tax', folder: 'Downloads' },
    },
  ];
  it.each(cases)('$text', check);

  it('a search with nothing to search for reports the missing query', () => {
    const intent = only('search Google');
    expect(intent.missing).toContain('query');
    expect(intent.resolved).toBe(false);
  });
});

describe('files: create, copy, move, rename, delete', () => {
  const cases: Case[] = [
    {
      text: 'আমার Documents folder এ notes.txt তৈরি করো',
      type: 'CREATE_FILE',
      params: { fileName: 'notes.txt', folder: 'Documents' },
    },
    {
      text: 'create a folder named "Invoices" in Documents',
      type: 'CREATE_FOLDER',
      params: { name: 'Invoices', folder: 'Documents' },
    },
    {
      text: 'Desktop এ "Projects" নামে একটা নতুন folder বানাও',
      type: 'CREATE_FOLDER',
      params: { name: 'Projects', folder: 'Desktop' },
    },
    {
      text: 'Downloads থেকে সব PDF Desktop এ copy করো',
      type: 'COPY_FILE',
      params: {
        fileTypes: ['pdf'],
        extensions: ['.pdf'],
        all: true,
        fromFolder: 'Downloads',
        toFolder: 'Desktop',
      },
    },
    {
      text: 'copy all PDF files from Downloads to Desktop',
      type: 'COPY_FILE',
      params: {
        fileTypes: ['pdf'],
        extensions: ['.pdf'],
        all: true,
        fromFolder: 'Downloads',
        toFolder: 'Desktop',
      },
    },
    {
      text: 'move report.pdf from Desktop to Documents',
      type: 'MOVE_FILE',
      params: { fileName: 'report.pdf', fromFolder: 'Desktop', toFolder: 'Documents' },
    },
    {
      text: 'report.pdf Documents এ সরিয়ে দাও',
      type: 'MOVE_FILE',
      params: { fileName: 'report.pdf', toFolder: 'Documents' },
    },
    {
      text: 'rename report.docx to final.docx',
      type: 'RENAME_FILE',
      params: { fileName: 'report.docx', newName: 'final.docx' },
    },
  ];
  it.each(cases)('$text', check);

  it('copy needs both a source and a destination', () => {
    const intent = only('copy report.pdf');
    expect(intent.type).toBe('COPY_FILE');
    expect(intent.missing).toEqual(['destination']);
    expect(intent.resolved).toBe(false);
    expect(parse('copy report.pdf').needsPlanner).toBe(true);
  });
});

describe('destructive requests are flagged and never guessed', () => {
  it('flags delete as destructive', () => {
    for (const text of [
      'report.docx ডিলিট করে দাও',
      'delete report.docx',
      'report.docx muche dao',
      'remove "old notes.txt"',
    ]) {
      const intent = only(text);
      expect(intent.type, text).toBe('DELETE_FILE');
      expect(intent.destructive, text).toBe(true);
    }
  });

  it('does not accept a bare noun or a whole known folder as a delete target', () => {
    for (const text of [
      'delete all files',
      'ফাইল মুছে দাও',
      'delete the Downloads folder',
      'Downloads folder মুছে ফেলো',
      'delete everything',
    ]) {
      const result = parse(text);
      const intent = result.clauses[0]!;
      expect(intent.destructive, text).toBe(true);
      expect(intent.missing, text).toContain('target');
      expect(result.needsPlanner, text).toBe(true);
    }
  });

  it('marks "all PDFs" deletes as bulk so the risk engine can treat them accordingly', () => {
    const intent = only('Downloads এর সব PDF মুছে ফেলো');
    expect(intent.type).toBe('DELETE_FILE');
    expect(intent.params).toMatchObject({ all: true, fileTypes: ['pdf'], folder: 'Downloads' });
    expect(intent.destructive).toBe(true);
  });

  it('a delete with ignored words is not treated as understood', () => {
    const result = parse('delete report.docx and also the backup thing');
    expect(result.needsPlanner).toBe(true);
  });
});

describe('control intents', () => {
  const cases: Case[] = [
    { text: 'screenshot নাও', type: 'TAKE_SCREENSHOT', params: { target: 'screen' } },
    { text: 'স্ক্রিনশট নাও', type: 'TAKE_SCREENSHOT', params: { target: 'screen' } },
    { text: 'Take a screenshot', type: 'TAKE_SCREENSHOT', params: { target: 'screen' } },
    { text: 'screenshot nao', type: 'TAKE_SCREENSHOT', params: { target: 'screen' } },
    { text: 'কম্পিউটার লক করো', type: 'LOCK_COMPUTER' },
    { text: 'lock the computer', type: 'LOCK_COMPUTER' },
    { text: 'stop', type: 'STOP' },
    { text: 'থামাও', type: 'STOP' },
    { text: 'থামো', type: 'STOP' },
    { text: 'thamao', type: 'STOP' },
    { text: 'বাতিল করো', type: 'CANCEL' },
    { text: 'থাক', type: 'CANCEL' },
    { text: 'never mind', type: 'CANCEL' },
  ];
  it.each(cases)('$text', check);
});

describe('stop and cancel are only commands when they are the whole message', () => {
  it.each([
    'stop',
    'please stop',
    'stop it',
    'থামাও',
    'এটা থামাও',
    'থামো ভাই',
    'cancel',
    'বাতিল করো',
  ])('%s is a control command', (text) => {
    expect(['STOP', 'CANCEL']).toContain(only(text).type);
  });

  it.each([
    'how do I stop Chrome from starting up',
    'stop Chrome',
    'stop the download of setup.exe',
    'Chrome থামাও',
    'cancel my subscription to Spotify',
    'stop "background sync"',
  ])('%s is not', (text) => {
    const result = parse(text);
    expect(
      result.clauses.some((c) => (c.type === 'STOP' || c.type === 'CANCEL' ? c.resolved : false)),
      text,
    ).toBe(false);
    expect(result.needsPlanner, text).toBe(true);
  });
});

describe('language switching', () => {
  const cases: Array<[string, 'bn' | 'en']> = [
    ['বাংলায় কথা বলো', 'bn'],
    ['বাংলাতে কথা বলুন', 'bn'],
    ['Bangla te kotha bolo', 'bn'],
    ['Speak Bengali', 'bn'],
    ['Speak English', 'en'],
    ['ইংরেজিতে কথা বলো', 'en'],
    ['switch to English', 'en'],
    ['inglish e kotha bolo', 'en'],
  ];
  it.each(cases)('%s', (text, language) => {
    const intent = only(text);
    expect(intent.type).toBe('SWITCH_LANGUAGE');
    expect(intent.params.language).toBe(language);
  });

  it('a language name inside a search query is not a switch request', () => {
    const intent = only('Google এ "learn bangla" search করো');
    expect(intent.type).toBe('WEB_SEARCH');
  });
});

describe('multi-step commands', () => {
  it('splits English "and" / "then" into ordered clauses', () => {
    const result = parse('Open Chrome and search Google for weather');
    expect(result.sequential).toBe(true);
    expect(result.clauses.map((c) => c.type)).toEqual(['OPEN_APP', 'WEB_SEARCH']);
    expect(result.clauses[1]!.params).toEqual({ site: 'Google', query: 'weather' });
    expect(result.needsPlanner).toBe(false);
  });

  it('splits verb-final Bengali clauses at each verb', () => {
    const result = parse('Chrome খুলে তারপর YouTube এ গান search করো');
    expect(result.clauses.map((c) => c.type)).toEqual(['OPEN_APP', 'WEB_SEARCH']);
    expect(result.clauses[0]!.params).toEqual({ app: 'Chrome' });
    expect(result.clauses[1]!.params).toEqual({ site: 'YouTube', query: 'গান' });
  });

  it('shares one verb across a list ("Chrome আর Edge খুলে দাও")', () => {
    const bn = parse('Downloads আর Desktop folder খুলে দাও');
    expect(bn.clauses.map((c) => c.params.folder)).toEqual(['Downloads', 'Desktop']);
    const en = parse('Open Chrome and Edge');
    expect(en.clauses.map((c) => c.params.app)).toEqual(['Chrome', 'Edge']);
  });

  it('treats a time expression as metadata, not a clause', () => {
    const result = parse('কাল সকাল ৯টায় Chrome খুলে দাও');
    expect(result.clauses).toHaveLength(1);
    expect(result.times.length).toBeGreaterThan(0);
    expect(result.clauses[0]!.type).toBe('OPEN_APP');
  });
});

describe('uncertainty goes to the planner instead of being guessed', () => {
  const planner = [
    'what is the weather today',
    'আজকের আবহাওয়া কেমন',
    'Open the Reports folder on my Desktop', // unknown folder name "Reports"
    'খুলে দাও', // nothing to open
    'organise my downloads by type and rename the messy ones',
    'আমার কাজগুলো একটু গুছিয়ে দাও',
    '',
  ];
  it.each(planner)('%j', (text) => {
    expect(parse(text).needsPlanner).toBe(true);
  });

  it('reports the words it could not place', () => {
    const intent = only('Open the Reports folder on my Desktop');
    expect(intent.resolved).toBe(false);
    expect(intent.leftovers).toContain('Reports');
  });

  it('never marks a fully understood command as needing the planner', () => {
    for (const text of [
      'Chrome খুলে দাও',
      'screenshot নাও',
      'Open Chrome and search Google for weather',
    ]) {
      expect(parse(text).needsPlanner, text).toBe(false);
    }
  });
});

describe('the parser output is language-independent', () => {
  it('produces identical params for the same request in every language', () => {
    const variants = [
      'Downloads থেকে সব PDF Desktop এ copy করো',
      'copy all PDF files from Downloads to Desktop',
      'Downloads theke shob PDF Desktop e copy koro',
      'ডাউনলোডস থেকে সব পিডিএফ ডেস্কটপ এ কপি করো',
    ];
    const params = variants.map((v) => only(v).params);
    for (const p of params) expect(p).toEqual(params[0]);
    expect(only(variants[0]!).type).toBe('COPY_FILE');
  });

  it('is stable under Unicode noise (zero-width joiners, combining forms, Bengali digits)', () => {
    const plain = only('ক্রোম খুলে দাও');
    const noisy = only('ক্\u200Dরোম খুলে\u200C দাও');
    expect(noisy.params).toEqual(plain.params);
    expect(noisy.type).toBe('OPEN_APP');
  });
});
