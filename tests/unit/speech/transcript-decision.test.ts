import { describe, expect, it } from 'vitest';
import {
  HARD_CONFIDENCE_FLOOR,
  chunkForSpeech,
  cleanTranscript,
  confidenceFromSegments,
  decideSubmission,
  isLikelyHallucination,
  pickVoice,
  prepareSpeechText,
  type SubmitPolicy,
  type VoiceInfo,
} from '@allaya/speech';

describe('transcript hygiene', () => {
  it('normalises whitespace and zero-width characters', () => {
    expect(cleanTranscript('  Chrome​   খুলে\n দাও  ')).toBe('Chrome খুলে দাও');
    expect(cleanTranscript('   ')).toBe('');
  });

  it('derives confidence from segment log-probabilities, weighted by length', () => {
    expect(confidenceFromSegments(undefined)).toBeNull();
    expect(confidenceFromSegments([])).toBeNull();
    expect(confidenceFromSegments([{ text: 'x' }])).toBeNull(); // no signal is "unknown", never "high"
    const sure = confidenceFromSegments([
      { text: 'open chrome', avgLogprob: -0.05, noSpeechProb: 0.01 },
    ])!;
    const unsure = confidenceFromSegments([
      { text: 'open chrome', avgLogprob: -1.2, noSpeechProb: 0.01 },
    ])!;
    expect(sure).toBeGreaterThan(0.9);
    expect(unsure).toBeLessThan(0.4);
    // A long confident segment outweighs a short shaky one.
    const mixed = confidenceFromSegments([
      { text: 'a'.repeat(90), avgLogprob: -0.1 },
      { text: 'b'.repeat(10), avgLogprob: -2 },
    ])!;
    expect(mixed).toBeGreaterThan(0.7);
    // Likely-not-speech lowers it.
    expect(
      confidenceFromSegments([{ text: 'hello', avgLogprob: -0.1, noSpeechProb: 0.9 }])!,
    ).toBeLessThan(0.6);
  });

  it('always returns a value within 0..1', () => {
    for (const lp of [0, -0.0001, -5, -100, 3, Number.NaN]) {
      const c = confidenceFromSegments([{ text: 'hi', avgLogprob: lp, noSpeechProb: 5 }]);
      if (c !== null) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  describe('hallucination filter', () => {
    it('rejects empty output', () => {
      expect(isLikelyHallucination('')).toBe(true);
      expect(isLikelyHallucination('  ​ ')).toBe(true);
    });
    it('rejects segments the model itself flags as non-speech', () => {
      expect(isLikelyHallucination('Some words', { noSpeechProb: 0.9, avgLogprob: -1.5 })).toBe(
        true,
      );
    });
    it('rejects repetition loops', () => {
      expect(isLikelyHallucination('ha ha ha ha ha ha ha ha', { compressionRatio: 3.5 })).toBe(
        true,
      );
    });
    it('rejects stock silence phrases only when the audio looked like non-speech', () => {
      expect(isLikelyHallucination('Thanks for watching!', { noSpeechProb: 0.5 })).toBe(true);
      expect(isLikelyHallucination('ধন্যবাদ।', { noSpeechProb: 0.5 })).toBe(true);
      // Genuinely said, clearly speech: keep it.
      expect(isLikelyHallucination('Thank you', { noSpeechProb: 0.02 })).toBe(false);
      expect(isLikelyHallucination('Thank you', {})).toBe(false);
    });
    it('keeps real commands', () => {
      expect(
        isLikelyHallucination('Downloads folder টা খুলে দাও', {
          noSpeechProb: 0.05,
          avgLogprob: -0.2,
        }),
      ).toBe(false);
    });
  });
});

const decide = (
  transcript: string,
  confidence: number | null,
  policy: SubmitPolicy = 'confident',
  threshold = 0.7,
) => decideSubmission({ transcript, confidence, policy, threshold, now: new Date(2026, 8, 29) });

describe('submission safety gate', () => {
  it('sends a confident, harmless command', () => {
    expect(decide('Chrome খুলে দাও', 0.9)).toMatchObject({
      action: 'send',
      text: 'Chrome খুলে দাও',
    });
  });

  it('discards empty transcripts', () => {
    expect(decide('   ', 0.99)).toMatchObject({ action: 'discard', reason: 'empty' });
  });

  it('sends "stop" immediately — even with low or unknown confidence, and even under policy "never"', () => {
    for (const [conf, policy] of [
      [0.1, 'confident'],
      [null, 'confident'],
      [0.9, 'never'],
    ] as const) {
      expect(decide('থামাও', conf, policy).action, `${conf}/${policy}`).toBe('send');
      expect(decide('stop', conf, policy).action).toBe('send');
    }
  });

  it('a stop word inside a longer sentence does not get the fast path', () => {
    expect(decide('how do I stop Chrome from starting up', 0.3).action).toBe('review');
  });

  it.each(['report.docx ডিলিট করে দাও', 'delete report.docx', 'Downloads এর সব PDF মুছে ফেলো'])(
    'destructive commands are ALWAYS reviewed: %s',
    (text) => {
      for (const policy of ['never', 'confident', 'always'] as const) {
        for (const confidence of [0.99, 1, null]) {
          const d = decide(text, confidence, policy);
          expect(d.action, `${policy}/${confidence}`).toBe('review');
          expect(d.action === 'review' && d.reasons).toContain('destructive');
        }
      }
    },
  );

  it('low confidence is reviewed under "confident"', () => {
    expect(decide('Chrome খুলে দাও', 0.5)).toMatchObject({
      action: 'review',
      reasons: ['low_confidence'],
    });
    expect(decide('Chrome খুলে দাও', 0.7).action).toBe('send'); // exactly at the threshold is enough
    expect(decide('Chrome খুলে দাও', 0.69).action).toBe('review');
  });

  it('unknown confidence is not treated as high', () => {
    expect(decide('Chrome খুলে দাও', null)).toMatchObject({
      action: 'review',
      reasons: ['unknown_confidence'],
    });
    expect(decide('Chrome খুলে দাও', null, 'always').action).toBe('send');
  });

  it('policy "never" always reviews, "always" still reviews below the hard floor', () => {
    expect(decide('Chrome খুলে দাও', 0.99, 'never')).toMatchObject({
      action: 'review',
      reasons: ['policy'],
    });
    expect(decide('Chrome খুলে দাও', HARD_CONFIDENCE_FLOOR - 0.01, 'always')).toMatchObject({
      action: 'review',
      reasons: ['very_low_confidence'],
    });
    expect(decide('Chrome খুলে দাও', HARD_CONFIDENCE_FLOOR, 'always').action).toBe('send');
    expect(decide('Chrome খুলে দাও', 0.5, 'always').action).toBe('send');
  });

  it('collects every reason when several apply', () => {
    const d = decide('delete report.docx', 0.2, 'never');
    expect(d).toMatchObject({ action: 'review' });
    expect(d.action === 'review' && d.reasons).toEqual(['destructive', 'policy']);
  });
});

describe('speech text preparation', () => {
  const opts = { linkWord: 'link', codeWord: 'code' };

  it('removes Markdown syntax but keeps the words', () => {
    const md =
      '## Result\n\n- **Chrome** is `open`\n- see [the docs](https://example.com/x) or https://a.b/c\n\n> note';
    const out = prepareSpeechText(md, opts);
    expect(out).toBe('Result. Chrome is open. see the docs or link. note.');
    expect(out).not.toMatch(/[*#`>[\]]|https?:/);
  });

  it('does not read code blocks aloud', () => {
    expect(prepareSpeechText('Run this:\n```bash\nrm -rf /\n```\nDone.', opts)).toBe(
      'Run this: code. Done.',
    );
  });

  it('handles Bengali, emoji and the danda', () => {
    const out = prepareSpeechText('হয়ে গেছে 🎉 — Chrome খুলে দিয়েছি ।', {
      linkWord: 'লিংক',
      codeWord: 'কোড',
    });
    expect(out).toBe('হয়ে গেছে — Chrome খুলে দিয়েছি।');
  });

  it('caps the length on a character boundary', () => {
    const out = prepareSpeechText('আমি '.repeat(1000), { ...opts, maxChars: 100 });
    expect(Array.from(out).length).toBeLessThanOrEqual(100);
    expect(out).not.toMatch(/�/);
  });

  it('splits into sentences on . ! ? and the danda, but not inside numbers', () => {
    expect(chunkForSpeech('Hello there. Version 3.5 is ready! Ready?', 22)).toEqual([
      'Hello there.',
      'Version 3.5 is ready!',
      'Ready?',
    ]);
    expect(chunkForSpeech('প্রথম বাক্য। দ্বিতীয় বাক্য। তৃতীয়', 15)).toEqual([
      'প্রথম বাক্য।',
      'দ্বিতীয় বাক্য।',
      'তৃতীয়',
    ]);
  });

  it('packs short sentences together up to the limit and splits over-long ones without cutting words', () => {
    expect(chunkForSpeech('One. Two. Three.', 100)).toEqual(['One. Two. Three.']);
    const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const chunks = chunkForSpeech(long, 20);
    expect(chunks.every((c) => Array.from(c).length <= 20)).toBe(true);
    expect(chunks.join(' ')).toBe(long);
  });

  it('returns nothing for empty text', () => {
    expect(chunkForSpeech('')).toEqual([]);
    expect(chunkForSpeech('   ')).toEqual([]);
  });
});

describe('system voice selection', () => {
  const voices: VoiceInfo[] = [
    { voiceURI: 'en-us', name: 'Microsoft David', lang: 'en-US', localService: true },
    { voiceURI: 'bn-in', name: 'Microsoft Bashkar', lang: 'bn-IN', localService: true },
    { voiceURI: 'bn-bd-online', name: 'Microsoft Nabanita Online (Natural)', lang: 'bn-BD' },
    { voiceURI: 'bn-bd-local', name: 'Local Bangla', lang: 'bn_BD', localService: true },
  ];
  it('prefers a Bangladeshi natural voice for Bengali', () => {
    expect(pickVoice(voices, 'bn')?.voiceURI).toBe('bn-bd-online');
  });
  it('honours an explicit choice when it matches the language', () => {
    expect(pickVoice(voices, 'bn', 'bn-in')?.voiceURI).toBe('bn-in');
    expect(pickVoice(voices, 'en', 'bn-in')?.voiceURI).toBe('en-us'); // wrong-language preference is ignored
  });
  it('returns undefined — not a wrong-language voice — when none is installed', () => {
    expect(pickVoice([voices[0]!], 'bn')).toBeUndefined();
    expect(pickVoice([], 'en')).toBeUndefined();
  });
});
