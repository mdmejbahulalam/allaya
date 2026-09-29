/**
 * Romanised Bengali ("Banglish") vocabulary used to tell Banglish from English. Only words that are NOT
 * ordinary English words are listed as strong signals — "to", "me", "do", "sat", "tin", "char", "din" and
 * similar homographs are deliberately excluded, because "sat" in "I sat down" must not read as Bengali.
 */
export const BANGLISH_WORDS: ReadonlySet<string> = new Set(
  // pronouns & determiners
  (
    'ami amar amake amader tumi tomar tomake tomader apni apnar apnake apnader tui tor toke se tar take tara tader ' +
    'ei oi eta ota eita oita ekta ekti ekhon ekhane okhane sekhane ekhanei sob shob sobgulo sobkichu kono konta kothay kobe keno kivabe kemon kon kar ' +
    // particles, conjunctions, classifiers
    'ebong othoba abar tarpor tarporei jodi tahole kintu ta ti gula gulo guloke khana khani theke moddhe modhye bhitore ' +
    'upore niche sathe jonno jonne pore ager agami gato shudhu sudhu akhon ' +
    // light verbs & inflections
    'koro koren korun kor kore korbo korle korte korchi korchen korbe dao den dilam nao nen niye niyechi nin ' +
    // command verbs
    'khule kholo khulo khulun khol khuje khujo khujun khuj bondho bandho bondo muche mucho muchun felo felun ' +
    'banao banan baniye toiri thamao thamun thamo batil chalu chalao chalan dekhao dekhan dekho dekhi ' +
    'sorao soriye sarao bodlao bodle poriborton pathao pathan pathiye tulo tolo tulun ' +
    // speech & misc verbs
    'bolo bolun bole bolbo bolchi kotha lagbe lagche pari parbo parbe parle jao jan jabe jachhe hobe hoy hoye hoyeche ache achhe nai ' +
    // evaluation
    'bhalo valo kharap thik thikache accha achha hyan ji na-na ' +
    // time
    'aaj aj ajke kal gotokal agamikal poroshu shokal sokal dupur bikel bikal sondha shondha raat rat somoy shomoy ghonta ghonta minit ' +
    'shoptaho shoptah mash bochor tarikh ' +
    // nouns commonly romanised
    'kaj kajta file-ta folder-ta pdf-gula'
  ).split(/\s+/),
);

/** Common English function/command words: the counterweight when scoring Latin-script text. */
export const ENGLISH_WORDS: ReadonlySet<string> = new Set(
  (
    'the a an is are was were be been am do does did to of in on at by for with from into onto about as and or but not ' +
    'my me you your he she it we they them this that these those there here what which who when where why how ' +
    'can could would should will shall may might must just also then than so if else ' +
    'open close find search show list delete remove create make copy move rename save download upload start stop cancel ' +
    'take capture lock switch go give get set run launch quit exit look view display type click ' +
    'all any some every each new old last next previous first today yesterday tomorrow week month year day days hour hours minute minutes ' +
    'file files folder folders app apps program window tab page site website browser screen screenshot computer settings ' +
    'speak talk reply respond english bengali bangla language mode ' +
    ''
  ).split(/\s+/),
);

/** Spellings that mark British English. Anything else defaults to en-US. */
export const BRITISH_MARKERS: ReadonlySet<string> = new Set(
  'colour colours favourite favourites organise organised organisation centre centres licence programme programmes whilst cheque grey catalogue analyse behaviour honour travelling labour neighbour realise recognise customise'.split(
    ' ',
  ),
);

/**
 * Words bilingual users say in either language ("ok", "yes", "please", "hello"). They carry no information
 * about which language a message is in, so they never count as evidence — otherwise a lone "ok" in a
 * Bengali conversation would flip the assistant into English.
 */
export const UNIVERSAL_WORDS: ReadonlySet<string> = new Set(
  'ok okay k yes yeah yep no nope nah sure please pls plz hello hi hey thanks thank thx haha lol hmm um uh oh wow bye'.split(
    ' ',
  ),
);
