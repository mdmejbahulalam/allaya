import { canonicalize } from './script';

/**
 * The command vocabulary: Bengali script, romanised Bengali (Banglish) and English, all mapped to
 * language-independent canonical tokens. The execution engine never sees Bengali — only these canonical
 * verbs, entities and intents (§132: the core is language-independent).
 *
 * Matching key: NFC-normalised, zero-width characters removed, Latin lower-cased.
 */
export const matchKey = (text: string): string => canonicalize(text).toLowerCase();

// ── Verbs ────────────────────────────────────────────────────────────────────
export type VerbCanon =
  | 'open'
  | 'close'
  | 'find'
  | 'search'
  | 'delete'
  | 'create'
  | 'copy'
  | 'move'
  | 'rename'
  | 'save'
  | 'download'
  | 'upload'
  | 'screenshot'
  | 'stop'
  | 'cancel'
  | 'start'
  | 'show'
  | 'lock'
  | 'speak'
  | 'go';

/**
 * Light verbs turn a loan word into a Bengali verb: "ওপেন করো" (open koro), "ডিলিট করে দাও" (delete kore dao).
 * They are listed longest-first by the matcher, so "করে দাও" is consumed as one unit.
 */
export const LIGHT_VERBS: readonly string[] = [
  'করো',
  'করুন',
  'কর',
  'করেন',
  'করে দাও',
  'করে দিন',
  'করে দেন',
  'করে দিও',
  'করে ফেলো',
  'কর তো',
  'করবে',
  'করে',
  'koro',
  'korun',
  'kor',
  'koren',
  'kore dao',
  'kore din',
  'kore den',
  'kore dio',
  'kore felo',
  'korbe',
  'kore',
];

/** Bare auxiliaries that can be left over once a verb has been matched ("… দাও", "… nao"). */
export const AUXILIARIES: ReadonlySet<string> = new Set(
  [
    'দাও',
    'দিন',
    'দেন',
    'দিও',
    'নাও',
    'নিন',
    'নেন',
    'ফেলো',
    'তো',
    'dao',
    'din',
    'den',
    'dio',
    'nao',
    'nin',
    'nen',
    'felo',
    'to',
  ].map(matchKey),
);

interface VerbSpec {
  canonical: VerbCanon;
  /** Complete forms (already including any auxiliary). */
  forms?: string[];
  /** Loan-word stems that take a light verb ("ওপেন" + "করো"); the bare stem is also accepted when `bareStem`. */
  loanStems?: string[];
  bareStem?: boolean;
}

const VERB_SPECS: VerbSpec[] = [
  {
    canonical: 'open',
    forms: [
      'খুলে দাও',
      'খুলে দিন',
      'খুলে দেন',
      'খুলে দিও',
      'খুলে দাও তো',
      'খুলুন',
      'খুলো',
      'খোলো',
      'খোল',
      'খুলে',
      'খুলবে',
      'খুলবেন',
      'khule dao',
      'khule din',
      'khule den',
      'khule dio',
      'kholo',
      'khulo',
      'khulun',
      'khol',
      'khule',
    ],
    loanStems: ['ওপেন', 'opn', 'open'],
    bareStem: true,
  },
  { canonical: 'open', forms: ['launch'] },
  {
    canonical: 'close',
    forms: [
      'বন্ধ করো',
      'বন্ধ করুন',
      'বন্ধ কর',
      'বন্ধ করে দাও',
      'বন্ধ করে দিন',
      'বন্ধ করে দেন',
      'বন্ধ করে ফেলো',
      'বন্ধ করে',
      'বন্ধ করবে',
      'বন্ধ',
      'bondho koro',
      'bandho koro',
      'bondo koro',
      'bondho kore dao',
      'bandho kore dao',
      'bondho korun',
      'bandho korun',
      'bondho kor',
      'bondho kore',
      'bondho',
      'bandho',
      'bondo',
    ],
    loanStems: ['ক্লোজ', 'close', 'quit', 'exit'],
    bareStem: true,
  },
  {
    canonical: 'find',
    forms: [
      'খুঁজে দাও',
      'খুঁজে দিন',
      'খুঁজে দেন',
      'খুঁজে দিও',
      'খুঁজে বের করো',
      'খুঁজে বের করুন',
      'খুঁজে বার করো',
      'খুঁজুন',
      'খুঁজো',
      'খোঁজো',
      'খোঁজ করো',
      'খোঁজ করুন',
      'খুঁজে',
      // Very common typing variant without the chandrabindu:
      'খুজে দাও',
      'খুজে দিন',
      'খুজে দেন',
      'খুজুন',
      'খুজো',
      'খোজ করো',
      'খোজ করুন',
      'খুজে',
      'khuje dao',
      'khuje din',
      'khuje den',
      'khuje dio',
      'khuje ber koro',
      'khuje bar koro',
      'khujo',
      'khujun',
      'khuj koro',
      'khoj koro',
      'khuje',
    ],
    loanStems: ['ফাইন্ড', 'find', 'locate'],
    bareStem: true,
  },
  {
    canonical: 'search',
    loanStems: ['সার্চ', 'সার্চ', 'search'],
    bareStem: true,
    forms: ['look for', 'look up'],
  },
  {
    canonical: 'delete',
    forms: [
      'মুছে দাও',
      'মুছে ফেলো',
      'মুছে ফেলুন',
      'মুছে দিন',
      'মুছে ফেল',
      'মুছে ফেলে দাও',
      'মুছুন',
      'মোছো',
      'মুছো',
      'মুছে',
      'ফেলে দাও',
      'ফেলে দিন',
      'muche dao',
      'muche felo',
      'muche din',
      'muchun',
      'mucho',
      'muche',
      'fele dao',
    ],
    loanStems: ['ডিলিট', 'delete', 'remove', 'erase', 'trash'],
    bareStem: true,
  },
  {
    canonical: 'create',
    forms: [
      'তৈরি করো',
      'তৈরি করুন',
      'তৈরি কর',
      'তৈরী করো',
      'তৈরি করে দাও',
      'তৈরি করে',
      'বানাও',
      'বানান',
      'বানিয়ে দাও',
      'বানিয়ে দিন',
      'বানিয়ে দেন',
      'বানিয়ে',
      'বানাবে',
      'toiri koro',
      'toiri korun',
      'toiri kore dao',
      'toiri kore',
      'banao',
      'banan',
      'baniye dao',
      'baniye din',
      'baniye',
    ],
    loanStems: ['ক্রিয়েট', 'create', 'make'],
    bareStem: true,
  },
  { canonical: 'copy', loanStems: ['কপি', 'copy', 'duplicate'], bareStem: true },
  {
    canonical: 'move',
    forms: ['সরাও', 'সরিয়ে দাও', 'সরিয়ে দিন', 'সরান', 'soriye dao', 'sorao', 'sarao'],
    loanStems: ['মুভ', 'move'],
    bareStem: true,
  },
  {
    canonical: 'rename',
    forms: [
      'নাম পরিবর্তন করো',
      'নাম পরিবর্তন করুন',
      'নাম বদলাও',
      'নাম বদলে দাও',
      'নাম বদলান',
      'নাম বদল করো',
      'নাম বদলে দিন',
      'nam poriborton koro',
      'nam bodlao',
      'nam bodle dao',
    ],
    loanStems: ['রিনেম', 'rename'],
    bareStem: true,
  },
  {
    canonical: 'save',
    forms: ['সংরক্ষণ করো', 'সংরক্ষণ করুন'],
    loanStems: ['সেভ', 'save'],
    bareStem: true,
  },
  // Bengali "ডাউনলোড" alone is the *Downloads folder*; only "ডাউনলোড করো" is the verb. English bare "download" is a verb.
  { canonical: 'download', loanStems: ['ডাউনলোড', 'download'], bareStem: false },
  { canonical: 'download', forms: ['download'] },
  { canonical: 'upload', loanStems: ['আপলোড', 'upload'], bareStem: true },
  {
    canonical: 'screenshot',
    forms: [
      'স্ক্রিনশট নাও',
      'স্ক্রিনশট নিন',
      'স্ক্রিনশট নেন',
      'স্ক্রিনশট তোলো',
      'স্ক্রিনশট তুলুন',
      'স্ক্রীনশট নাও',
      'স্ক্রিনশট',
      'স্ক্রীনশট',
      'স্ক্রিন ক্যাপচার করো',
      'screenshot nao',
      'screenshot nin',
      'screenshot tolo',
      'screenshot',
      'screen shot',
      'take a screenshot',
      'take screenshot',
      'capture screen',
      'capture the screen',
    ],
  },
  {
    canonical: 'stop',
    forms: [
      'থামাও',
      'থামুন',
      'থামান',
      'থামো',
      'থাম',
      'স্টপ',
      'thamao',
      'thamun',
      'thamo',
      'tham',
      'stop',
      'halt',
      'enough',
    ],
  },
  {
    canonical: 'cancel',
    forms: [
      'বাতিল করো',
      'বাতিল করুন',
      'বাতিল কর',
      'বাতিল করে দাও',
      'বাতিল',
      'বাদ দাও',
      'বাদ দিন',
      'থাক',
      'ক্যানসেল করো',
      'ক্যান্সেল করো',
      'batil koro',
      'batil',
      'bad dao',
      'thak',
      'cancel',
      'abort',
      'never mind',
      'nevermind',
      'forget it',
    ],
  },
  {
    canonical: 'start',
    forms: [
      'চালু করো',
      'চালু করুন',
      'চালু কর',
      'চালু করে দাও',
      'চালু করে দিন',
      'চালু করে',
      'চালু',
      'চালাও',
      'চালান',
      'শুরু করো',
      'শুরু করুন',
      'chalu koro',
      'chalu korun',
      'chalu kore dao',
      'chalu kore',
      'chalu',
      'chalao',
      'shuru koro',
      'start',
      'run',
    ],
  },
  {
    canonical: 'show',
    forms: [
      'দেখাও',
      'দেখান',
      'দেখিয়ে দাও',
      'দেখিয়ে দিন',
      'দেখা',
      'দেখি',
      'দেখাও তো',
      'দেখো',
      'dekhao',
      'dekhan',
      'dekhiye dao',
      'dekho',
      'show',
      'list',
      'display',
      'view',
    ],
  },
  { canonical: 'lock', loanStems: ['লক', 'lock'], bareStem: true },
  {
    canonical: 'speak',
    forms: [
      'কথা বলো',
      'কথা বলুন',
      'কথা বল',
      'বলো',
      'বলুন',
      'বল',
      'kotha bolo',
      'kotha bolun',
      'bolo',
      'bolun',
      'speak',
      'talk',
      'reply',
      'respond',
      'answer',
      'switch to',
      'switch',
      'change to',
      'বদলাও',
      'বদলে দাও',
      'bodlao',
      'bodle dao',
    ],
  },
  {
    canonical: 'go',
    forms: ['যাও', 'যান', 'jao', 'go', 'navigate', 'visit', 'browse'],
  },
];

export interface VerbForm {
  /** Space-separated tokens, already keyed. */
  tokens: string[];
  canonical: VerbCanon;
  /** True for Bengali/Banglish forms (verb-final: arguments come BEFORE the verb). */
  bengaliOrder: boolean;
  /** A loan stem with no light verb — English word order unless a light verb follows in the text. */
  bareLoan: boolean;
}

/** Latin-script forms that are Bengali (verb-final), not English. */
const BANGLISH_VERB_FORMS = new Set([
  'khule',
  'kholo',
  'khulo',
  'khulun',
  'khol',
  'bondho',
  'bandho',
  'bondo',
  'khuje',
  'khujo',
  'khujun',
  'khuj',
  'muche',
  'mucho',
  'muchun',
  'baniye',
  'banao',
  'banan',
  'toiri',
  'sorao',
  'soriye',
  'sarao',
  'thamao',
  'thamun',
  'thamo',
  'tham',
  'batil',
  'thak',
  'chalu',
  'chalao',
  'dekhao',
  'dekhan',
  'dekho',
  'dekhiye',
  'jao',
  'bolo',
  'bolun',
  'kotha',
  'shuru',
  'nam',
  'nao',
  'nin',
  'tolo',
]);

function buildVerbForms(): VerbForm[] {
  const forms: VerbForm[] = [];
  const push = (raw: string, canonical: VerbCanon, bareLoan = false) => {
    const key = matchKey(raw);
    const first = key.split(' ')[0]!;
    const bengaliOrder =
      /[ঀ-৿]/.test(key) ||
      BANGLISH_VERB_FORMS.has(first) ||
      /\b(koro|korun|kor|kore|koren)\b/.test(key);
    forms.push({ tokens: key.split(' '), canonical, bengaliOrder, bareLoan });
  };
  for (const spec of VERB_SPECS) {
    for (const form of spec.forms ?? []) push(form, spec.canonical);
    for (const stem of spec.loanStems ?? []) {
      for (const light of LIGHT_VERBS) push(`${stem} ${light}`, spec.canonical);
      // A bare loan stem is "English word order" until a light verb follows it in the text.
      if (spec.bareStem) push(stem, spec.canonical, true);
    }
  }
  return forms;
}

export const VERB_FORMS: readonly VerbForm[] = buildVerbForms();

// ── Entities ─────────────────────────────────────────────────────────────────
export interface AliasEntry<T extends string = string> {
  canonical: T;
  aliases: string[];
}

const APP_ENTRIES: AliasEntry[] = [
  {
    canonical: 'Chrome',
    aliases: ['chrome', 'google chrome', 'ক্রোম', 'গুগল ক্রোম', 'crome', 'krom'],
  },
  { canonical: 'Edge', aliases: ['edge', 'microsoft edge', 'এজ', 'মাইক্রোসফট এজ'] },
  { canonical: 'Firefox', aliases: ['firefox', 'ফায়ারফক্স', 'ফায়ারফক্স'] },
  { canonical: 'Brave', aliases: ['brave', 'ব্রেভ'] },
  { canonical: 'Opera', aliases: ['opera', 'অপেরা'] },
  {
    canonical: 'VS Code',
    aliases: [
      'vs code',
      'vscode',
      'visual studio code',
      'ভিএস কোড',
      'ভিএসকোড',
      'ভিসকোড',
      'ভিজ্যুয়াল স্টুডিও কোড',
    ],
  },
  { canonical: 'Visual Studio', aliases: ['visual studio', 'ভিজ্যুয়াল স্টুডিও'] },
  { canonical: 'Notepad', aliases: ['notepad', 'নোটপ্যাড'] },
  { canonical: 'Word', aliases: ['word', 'ms word', 'microsoft word', 'ওয়ার্ড', 'এমএস ওয়ার্ড'] },
  {
    canonical: 'Excel',
    aliases: ['excel', 'ms excel', 'microsoft excel', 'এক্সেল', 'এমএস এক্সেল'],
  },
  {
    canonical: 'PowerPoint',
    aliases: ['powerpoint', 'power point', 'ppt', 'পাওয়ারপয়েন্ট', 'পাওয়ার পয়েন্ট'],
  },
  { canonical: 'Outlook', aliases: ['outlook', 'আউটলুক'] },
  { canonical: 'Teams', aliases: ['teams', 'microsoft teams', 'টিমস'] },
  { canonical: 'Zoom', aliases: ['zoom', 'জুম'] },
  { canonical: 'Slack', aliases: ['slack', 'স্ল্যাক'] },
  { canonical: 'Discord', aliases: ['discord', 'ডিসকর্ড'] },
  { canonical: 'Telegram', aliases: ['telegram', 'টেলিগ্রাম'] },
  {
    canonical: 'WhatsApp',
    aliases: ['whatsapp', 'whats app', 'হোয়াটসঅ্যাপ', 'হোয়াটসঅ্যাপ', 'হোয়াটস অ্যাপ'],
  },
  { canonical: 'Spotify', aliases: ['spotify', 'স্পটিফাই'] },
  { canonical: 'VLC', aliases: ['vlc', 'ভিএলসি'] },
  { canonical: 'Photoshop', aliases: ['photoshop', 'ফটোশপ', 'ফটোশপ'] },
  { canonical: 'Illustrator', aliases: ['illustrator', 'ইলাস্ট্রেটর'] },
  { canonical: 'Premiere Pro', aliases: ['premiere pro', 'premiere', 'প্রিমিয়ার'] },
  { canonical: 'After Effects', aliases: ['after effects', 'আফটার ইফেক্টস'] },
  { canonical: 'Blender', aliases: ['blender', 'ব্লেন্ডার'] },
  {
    canonical: '3ds Max',
    aliases: ['3ds max', '3dsmax', 'থ্রিডিএস ম্যাক্স', 'থ্রি ডি এস ম্যাক্স'],
  },
  { canonical: 'Maya', aliases: ['maya', 'মায়া'] },
  { canonical: 'AutoCAD', aliases: ['autocad', 'অটোক্যাড'] },
  { canonical: 'Unity', aliases: ['unity', 'ইউনিটি'] },
  { canonical: 'Unreal Engine', aliases: ['unreal engine', 'unreal', 'আনরিয়াল'] },
  { canonical: 'Figma', aliases: ['figma', 'ফিগমা'] },
  { canonical: 'Paint', aliases: ['paint', 'পেইন্ট', 'ms paint'] },
  { canonical: 'Calculator', aliases: ['calculator', 'ক্যালকুলেটর', 'calc'] },
  { canonical: 'Task Manager', aliases: ['task manager', 'টাস্ক ম্যানেজার'] },
  { canonical: 'Control Panel', aliases: ['control panel', 'কন্ট্রোল প্যানেল'] },
  { canonical: 'Command Prompt', aliases: ['command prompt', 'cmd', 'কমান্ড প্রম্পট'] },
  { canonical: 'PowerShell', aliases: ['powershell', 'পাওয়ারশেল'] },
  { canonical: 'Terminal', aliases: ['terminal', 'windows terminal', 'টার্মিনাল'] },
  {
    canonical: 'File Explorer',
    aliases: ['file explorer', 'explorer', 'windows explorer', 'ফাইল এক্সপ্লোরার', 'এক্সপ্লোরার'],
  },
  { canonical: 'Steam', aliases: ['steam', 'স্টিম'] },
  { canonical: 'OBS', aliases: ['obs', 'obs studio', 'ওবিএস'] },
  { canonical: 'Postman', aliases: ['postman', 'পোস্টম্যান'] },
];

/** Websites/search engines Allaya can be asked to use (targets of "search Google", "open YouTube"). */
const WEB_ENTRIES: AliasEntry[] = [
  { canonical: 'Google', aliases: ['google', 'গুগল', 'গুগলে'] },
  { canonical: 'Bing', aliases: ['bing', 'বিং'] },
  { canonical: 'DuckDuckGo', aliases: ['duckduckgo', 'ডাকডাকগো'] },
  { canonical: 'YouTube', aliases: ['youtube', 'ইউটিউব', 'you tube'] },
  { canonical: 'Gmail', aliases: ['gmail', 'জিমেইল', 'জিমেল'] },
  { canonical: 'Facebook', aliases: ['facebook', 'ফেসবুক', 'fb'] },
  { canonical: 'GitHub', aliases: ['github', 'গিটহাব'] },
  { canonical: 'Wikipedia', aliases: ['wikipedia', 'উইকিপিডিয়া'] },
  { canonical: 'Amazon', aliases: ['amazon', 'অ্যামাজন', 'আমাজন'] },
  { canonical: 'Twitter', aliases: ['twitter', 'টুইটার'] },
  { canonical: 'LinkedIn', aliases: ['linkedin', 'লিংকডইন'] },
];

export type KnownFolder = 'Downloads' | 'Desktop' | 'Documents' | 'Pictures' | 'Videos' | 'Music';

const FOLDER_ENTRIES: AliasEntry<KnownFolder>[] = [
  { canonical: 'Downloads', aliases: ['downloads', 'ডাউনলোডস', 'ডাউনলোড', 'download folder'] },
  { canonical: 'Desktop', aliases: ['desktop', 'ডেস্কটপ'] },
  { canonical: 'Documents', aliases: ['documents', 'document', 'docs', 'ডকুমেন্টস', 'ডকুমেন্ট'] },
  {
    canonical: 'Pictures',
    aliases: ['pictures', 'picture', 'photos', 'পিকচার্স', 'পিকচার', 'ছবির ফোল্ডার'],
  },
  { canonical: 'Videos', aliases: ['videos', 'ভিডিওস'] },
  { canonical: 'Music', aliases: ['music', 'মিউজিক', 'গানের ফোল্ডার'] },
];

/** File-type words → extensions. */
export interface FileTypeEntry {
  canonical: string;
  aliases: string[];
  extensions: string[];
}
const FILE_TYPES: FileTypeEntry[] = [
  { canonical: 'pdf', aliases: ['pdf', 'পিডিএফ'], extensions: ['.pdf'] },
  {
    canonical: 'word',
    aliases: ['docx', 'doc', 'word file', 'ওয়ার্ড ফাইল'],
    extensions: ['.docx', '.doc'],
  },
  {
    canonical: 'excel',
    aliases: ['xlsx', 'xls', 'excel file', 'spreadsheet', 'এক্সেল ফাইল', 'স্প্রেডশিট'],
    extensions: ['.xlsx', '.xls'],
  },
  {
    canonical: 'powerpoint',
    aliases: ['pptx', 'ppt file', 'slides', 'presentation', 'স্লাইড'],
    extensions: ['.pptx', '.ppt'],
  },
  { canonical: 'text', aliases: ['txt', 'text file', 'টেক্সট ফাইল'], extensions: ['.txt'] },
  { canonical: 'csv', aliases: ['csv'], extensions: ['.csv'] },
  {
    canonical: 'zip',
    aliases: ['zip', 'zip file', 'জিপ', 'archive'],
    extensions: ['.zip', '.rar', '.7z'],
  },
  {
    canonical: 'image',
    aliases: [
      'image',
      'images',
      'photo',
      'photos',
      'picture',
      'jpg',
      'jpeg',
      'png',
      'gif',
      'ছবি',
      'ইমেজ',
      'ফটো',
    ],
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  },
  {
    canonical: 'video',
    aliases: ['video', 'videos', 'mp4', 'movie', 'ভিডিও', 'মুভি'],
    extensions: ['.mp4', '.mkv', '.mov', '.avi'],
  },
  {
    canonical: 'audio',
    aliases: ['audio', 'mp3', 'song', 'songs', 'music file', 'গান', 'অডিও'],
    extensions: ['.mp3', '.wav', '.m4a'],
  },
];

/** Generic nouns. */
export type NounCanon =
  | 'file'
  | 'folder'
  | 'browser'
  | 'app'
  | 'computer'
  | 'screen'
  | 'window'
  | 'tab'
  | 'website'
  | 'settings'
  | 'language';
const NOUN_ENTRIES: AliasEntry<NounCanon>[] = [
  { canonical: 'file', aliases: ['file', 'files', 'ফাইল'] },
  { canonical: 'folder', aliases: ['folder', 'folders', 'directory', 'ফোল্ডার', 'ডিরেক্টরি'] },
  { canonical: 'browser', aliases: ['browser', 'ব্রাউজার', 'browsers'] },
  {
    canonical: 'app',
    aliases: [
      'app',
      'apps',
      'application',
      'program',
      'অ্যাপ',
      'এপ',
      'অ্যাপ্লিকেশন',
      'এপ্লিকেশন',
      'প্রোগ্রাম',
    ],
  },
  {
    canonical: 'computer',
    aliases: ['computer', 'pc', 'laptop', 'কম্পিউটার', 'পিসি', 'ল্যাপটপ', 'কম্পিউটারটা'],
  },
  { canonical: 'screen', aliases: ['screen', 'স্ক্রিন'] },
  { canonical: 'window', aliases: ['window', 'উইন্ডো', 'উইন্ডোজ'] },
  { canonical: 'tab', aliases: ['tab', 'tabs', 'ট্যাব'] },
  { canonical: 'website', aliases: ['website', 'site', 'ওয়েবসাইট', 'সাইট', 'link', 'লিংক'] },
  { canonical: 'settings', aliases: ['settings', 'setting', 'সেটিংস', 'সেটিং'] },
  { canonical: 'language', aliases: ['language', 'ভাষা'] },
];

// ── Function words ───────────────────────────────────────────────────────────
export type RefCanon = 'this' | 'that' | 'here' | 'there' | 'inside_this';
const REFERENCE_ENTRIES: AliasEntry<RefCanon>[] = [
  {
    canonical: 'inside_this',
    aliases: [
      'এর মধ্যে',
      'এর ভিতরে',
      'এর ভেতরে',
      'এটার মধ্যে',
      'এই ফোল্ডারের মধ্যে',
      'ভেতরে',
      'er moddhe',
      'er modhye',
      'er vitore',
      'eta moddhe',
      'inside it',
      'in it',
      'inside this',
      'within it',
      'in this',
    ],
  },
  {
    canonical: 'this',
    aliases: ['এই', 'এটা', 'এটি', 'এইটা', 'ei', 'eta', 'eti', 'eita', 'this', 'it', 'current'],
  },
  { canonical: 'that', aliases: ['ওই', 'ওটা', 'ওটি', 'সেটা', 'সেটি', 'oi', 'ota', 'seta', 'that'] },
  { canonical: 'here', aliases: ['এখানে', 'ekhane', 'here'] },
  { canonical: 'there', aliases: ['সেখানে', 'ওখানে', 'sekhane', 'okhane', 'there'] },
];

export type Preposition = 'from' | 'in' | 'to' | 'with' | 'for';
const PREPOSITION_ENTRIES: AliasEntry<Preposition>[] = [
  { canonical: 'from', aliases: ['থেকে', 'theke', 'from'] },
  {
    canonical: 'in',
    aliases: ['মধ্যে', 'ভিতরে', 'ভেতরে', 'moddhe', 'modhye', 'in', 'inside', 'within', 'under'],
  },
  { canonical: 'to', aliases: ['to', 'into'] },
  { canonical: 'with', aliases: ['সহ', 'দিয়ে', 'with', 'diye', 'soho'] },
  { canonical: 'for', aliases: ['জন্য', 'jonno', 'jonne', 'for'] },
];

export type Quantifier = 'all' | 'new' | 'separate';
const QUANTIFIER_ENTRIES: AliasEntry<Quantifier>[] = [
  {
    canonical: 'all',
    aliases: [
      'সব',
      'সবগুলো',
      'সবগুলি',
      'সকল',
      'সমস্ত',
      'sob',
      'shob',
      'sobgulo',
      'shobgulo',
      'all',
      'every',
      'each',
    ],
  },
  { canonical: 'new', aliases: ['নতুন', 'notun', 'nutun', 'new'] },
  { canonical: 'separate', aliases: ['আলাদা', 'alada', 'separate', 'different'] },
];

export const CONJUNCTIONS: ReadonlySet<string> = new Set(
  [
    'তারপর',
    'এরপর',
    'এবং',
    'আর',
    'ও',
    'tarpor',
    'erpor',
    'ebong',
    'ar',
    'and',
    'then',
    'after that',
    'afterwards',
    'তারপরে',
  ].map(matchKey),
);
export const STRONG_SEQUENCE: ReadonlySet<string> = new Set(
  ['তারপর', 'এরপর', 'tarpor', 'erpor', 'then', 'তারপরে'].map(matchKey),
);

/** Politeness, address, filler and function words that carry no command content. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  [
    'দয়া করে',
    'doya kore',
    'please',
    'plz',
    'pls',
    'একটু',
    'ektu',
    'ভাই',
    'bhai',
    'আপু',
    'apu',
    'দেখি',
    'তো',
    'কি',
    'ki',
    'আমাকে',
    'amake',
    'আমার',
    'amar',
    'my',
    'me',
    'আমাদের',
    'amader',
    'our',
    'তুমি',
    'আপনি',
    'tumi',
    'apni',
    'you',
    'your',
    'একটা',
    'একটি',
    'ekta',
    'ekti',
    'a',
    'an',
    'the',
    'ধরো',
    'যাতে',
    'of',
    'that',
    'কর',
    'হে',
    'hey',
    'hi',
    'hello',
    'allaya',
    'আল্লায়া',
    'অল্লায়া',
    'টা',
    'টি',
    'গুলো',
    'গুলি',
    'গুলা',
    'খানা',
    'খানি',
    'ta',
    'ti',
    'gula',
    'gulo',
    'khana',
    'কে',
    'ke',
    'এ',
    'e',
    'তে',
    'te',
    'য়',
    'র',
    'এর',
    'er',
    'can',
    'could',
    'would',
    'will',
    'kindly',
    'just',
    'now',
    'এখন',
    'ekhon',
    'akhon',
    'take',
    'give',
    'get',
    'let',
    'do',
    'to me',
    'for me',
    'নামে',
    'নামের',
    'named',
    'called',
    'on',
    'some',
    'up',
    'out',
    'আচ্ছা',
    'accha',
    'achha',
  ].map(matchKey),
);

/** Markers that begin a spoken/typed correction ("না, Edge খুলে দাও"). Checked by the caller on raw text. */
export const CORRECTION_MARKERS: readonly string[] = [
  'ওহ না',
  'আরে না',
  'না না',
  'না,',
  'না ',
  'মানে',
  'ভুল হয়েছে',
  'sorry',
  'oh no',
  'no,',
  'no no',
  'nah',
  'actually',
  'i mean',
  'wait',
  'wait,',
  'ohh na',
  'na na',
  'na,',
];

// ── Language names (for "speak Bengali") ─────────────────────────────────────
export const LANGUAGE_NAMES: ReadonlyArray<{ language: 'bn' | 'en'; aliases: string[] }> = [
  {
    language: 'bn',
    aliases: [
      'বাংলা',
      'বাংলায়',
      'বাংলাতে',
      'বাঙলা',
      'bangla',
      'banglay',
      'bangla te',
      'bangla-te',
      'bengali',
      'bengali te',
      'bn',
    ],
  },
  {
    language: 'en',
    aliases: [
      'ইংরেজি',
      'ইংরেজিতে',
      'ইংলিশ',
      'ইংলিশে',
      'english',
      'inglish',
      'ingreji',
      'ingrejite',
      'english e',
      'english-e',
      'en',
    ],
  },
];

// ── Lookup structures ───────────────────────────────────────────────────────
export interface PhraseEntry<T> {
  tokens: string[];
  value: T;
}

function phrases<T>(entries: Array<{ aliases: string[]; canonical: T }>): PhraseEntry<T>[] {
  const out: PhraseEntry<T>[] = [];
  for (const entry of entries)
    for (const alias of entry.aliases)
      out.push({ tokens: matchKey(alias).split(' '), value: entry.canonical });
  return out;
}

export const APP_PHRASES = phrases(APP_ENTRIES);
export const WEB_PHRASES = phrases(WEB_ENTRIES);
export const FOLDER_PHRASES = phrases(FOLDER_ENTRIES);
export const NOUN_PHRASES = phrases(NOUN_ENTRIES);
export const REFERENCE_PHRASES = phrases(REFERENCE_ENTRIES);
export const PREPOSITION_PHRASES = phrases(PREPOSITION_ENTRIES);
export const QUANTIFIER_PHRASES = phrases(QUANTIFIER_ENTRIES);
export const FILE_TYPE_PHRASES: PhraseEntry<FileTypeEntry>[] = FILE_TYPES.flatMap((entry) =>
  entry.aliases.map((alias) => ({ tokens: matchKey(alias).split(' '), value: entry })),
);
export const LANGUAGE_PHRASES: PhraseEntry<'bn' | 'en'>[] = LANGUAGE_NAMES.flatMap((entry) =>
  entry.aliases.map((alias) => ({ tokens: matchKey(alias).split(' '), value: entry.language })),
);

/** Case/classifier suffixes attached to a stem: ফাইলগুলো, ফোল্ডারটা, ক্রোমে, ডাউনলোডে. Longest first. */
export const BENGALI_SUFFIXES: readonly string[] = [
  'গুলোকে',
  'গুলোর',
  'গুলোতে',
  'গুলোই',
  'গুলো',
  'গুলির',
  'গুলি',
  'গুলা',
  'টাকে',
  'টার',
  'টায়',
  'টাই',
  'টা',
  'টির',
  'টিকে',
  'টি',
  'খানা',
  'খানি',
  'দের',
  'কে',
  'ের',
  'তে',
  'য়',
  'র',
  'ে',
  'এ',
  'ও',
  'ই',
].sort((a, b) => b.length - a.length);
