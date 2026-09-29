/**
 * The few sentences the task engine writes itself (as opposed to the model): why a step was skipped, what could
 * not be confirmed, why a task stopped. They are shown to the user, so they exist in both languages. Text meant
 * for the *model* (retry notes) is always English.
 */
type Language = 'bn' | 'en';

interface Messages {
  skippedEarlierFailed: string;
  skippedDependency: string;
  declined: string;
  unanswered: string;
  noOutcome: string;
  cutOff: string;
  noToolRun: string;
  lastChangeFailed: (detail: string) => string;
  allCallsFailed: string;
  tooManyRounds: (n: number) => string;
  limitTools: (n: number) => string;
  limitTime: (minutes: number) => string;
  interrupted: string;
  planFailed: string;
  needsInformation: (question: string) => string;
  stepsDone: (done: number, total: number) => string;
  unverified: (n: number) => string;
  notDone: (titles: string) => string;
  goalNotMet: string;
  cancelled: string;
}

const EN: Messages = {
  skippedEarlierFailed: 'Not run because an earlier step failed.',
  skippedDependency: 'Not run because a step it depends on did not finish.',
  declined: 'You declined this action.',
  unanswered: 'There was no answer in time, so this was not done.',
  noOutcome: 'The step ended without saying what happened.',
  cutOff: 'The answer was cut off before the step was reported.',
  noToolRun: 'The step was reported done, but no action was taken to do it.',
  lastChangeFailed: (detail) => `The last change it tried did not work: ${detail}`,
  allCallsFailed: 'Every action in this step failed, so it cannot be counted as done.',
  tooManyRounds: (n) => `The step did not finish within ${n} rounds.`,
  limitTools: (n) => `Stopped: the task used up its limit of ${n} actions.`,
  limitTime: (minutes) => `Stopped: the task ran longer than ${minutes} minutes.`,
  interrupted: 'Allaya was closed while this was running.',
  planFailed: 'Could not make a usable plan for this request.',
  needsInformation: (question) => `More information is needed: ${question}`,
  stepsDone: (done, total) => `Finished ${done} of ${total} steps.`,
  unverified: (n) =>
    `${n} ${n === 1 ? 'action' : 'actions'} could not be independently confirmed, so it is not certain ${
      n === 1 ? 'it' : 'they'
    } worked.`,
  notDone: (titles) => `Not done: ${titles}.`,
  goalNotMet: 'The request was not met.',
  cancelled: 'Cancelled.',
};

const BN: Messages = {
  skippedEarlierFailed: 'আগের একটি ধাপ ব্যর্থ হওয়ায় এটি চালানো হয়নি।',
  skippedDependency: 'যে ধাপের ওপর এটি নির্ভর করে সেটি শেষ হয়নি, তাই এটি চালানো হয়নি।',
  declined: 'আপনি এই কাজটি করতে দেননি।',
  unanswered: 'সময়মতো উত্তর না পাওয়ায় এটি করা হয়নি।',
  noOutcome: 'কী হলো তা না জানিয়েই ধাপটি শেষ হয়েছে।',
  cutOff: 'ধাপের ফলাফল জানানোর আগেই উত্তর কেটে গেছে।',
  noToolRun: 'ধাপটি হয়ে গেছে বলা হয়েছে, কিন্তু সেটি করার জন্য কোনো কাজই করা হয়নি।',
  lastChangeFailed: (detail) => `শেষ যে পরিবর্তনটি করার চেষ্টা হয়েছিল তা হয়নি: ${detail}`,
  allCallsFailed: 'এই ধাপের প্রতিটি কাজ ব্যর্থ হয়েছে, তাই এটিকে সম্পন্ন ধরা যায় না।',
  tooManyRounds: (n) => `ধাপটি ${n} দফায়ও শেষ হয়নি।`,
  limitTools: (n) => `থামানো হয়েছে: কাজটি ${n}টি অ্যাকশনের সীমায় পৌঁছে গেছে।`,
  limitTime: (minutes) => `থামানো হয়েছে: কাজটি ${minutes} মিনিটের বেশি সময় নিয়েছে।`,
  interrupted: 'এটি চলার সময় Allaya বন্ধ হয়ে গিয়েছিল।',
  planFailed: 'এই অনুরোধের জন্য ব্যবহারযোগ্য পরিকল্পনা তৈরি করা যায়নি।',
  needsInformation: (question) => `আরও তথ্য দরকার: ${question}`,
  stepsDone: (done, total) => `${total}টির মধ্যে ${done}টি ধাপ শেষ হয়েছে।`,
  unverified: (n) =>
    `${n}টি কাজ আলাদাভাবে যাচাই করা যায়নি, তাই সেগুলো ঠিকভাবে হয়েছে কি না নিশ্চিত নয়।`,
  notDone: (titles) => `করা হয়নি: ${titles}।`,
  goalNotMet: 'অনুরোধটি পূরণ হয়নি।',
  cancelled: 'বাতিল করা হয়েছে।',
};

export const messagesFor = (language: Language): Messages => (language === 'bn' ? BN : EN);

/** What the model is told at the start of a retry — English, since it is for the model. */
export const retryNoteFor = (attempt: number, error: string): string =>
  `This is attempt ${attempt}. The previous attempt did not work: ${error}\n` +
  'Look at the current state first (something may already be done), and if the same approach failed, try a ' +
  'different one. If the problem is one you cannot fix with the tools you have, report "failed" and say why.';

export const INTERRUPTED_NOTE =
  'This step was interrupted earlier, so part of it may already be done. Check the current state before ' +
  'repeating anything.';

export const NUDGE_TO_FINISH =
  'Report the outcome by calling finish_step (outcome "done" or "failed", with a short summary). Do not reply with ' +
  'plain text alone.';
