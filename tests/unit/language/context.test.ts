import { describe, expect, it } from 'vitest';
import {
  interpret,
  parseAnswer,
  stripCorrectionMarker,
  updateContext,
  type ConversationContext,
} from '@allaya/language';

const time = { today: { year: 2026, month: 9, day: 29 } };
const run = (text: string, context: ConversationContext = {}) => interpret(text, context, time);

describe('reference resolution ("this folder", "inside it")', () => {
  it('fills "এই folder এর মধ্যে" from the folder opened earlier', () => {
    const first = run('Downloads folder টা খুলে দাও');
    const context = updateContext({}, first.clauses[0]!);
    const second = run('এই folder এর মধ্যে "invoices" নামে একটা নতুন folder বানাও', context);
    expect(second.clauses[0]).toMatchObject({
      type: 'CREATE_FOLDER',
      params: { name: 'invoices', folder: 'Downloads' },
      fromContext: ['folder'],
    });
    expect(second.needsPlanner).toBe(false);
  });

  it('asks instead of guessing when there is nothing to refer to', () => {
    const result = run('এই folder এর মধ্যে "invoices" নামে একটা নতুন folder বানাও');
    expect(result.clauses[0]!.missing).toContain('folder');
    expect(result.needsPlanner).toBe(true);
  });

  it('resolves "close it" to the app opened last', () => {
    const context = updateContext({}, run('Open Chrome').clauses[0]!);
    const result = run('এটা বন্ধ করো', context);
    expect(result.clauses[0]).toMatchObject({ type: 'CLOSE_APP', params: { app: 'Chrome' } });
  });

  it('does not use context for an explicit target', () => {
    const context = updateContext({}, run('Open Chrome').clauses[0]!);
    const result = run('close Edge', context);
    expect(result.clauses[0]!.params.app).toBe('Edge');
  });

  it('never resolves a delete from context alone', () => {
    const context = updateContext({}, run('Downloads খুলে দাও').clauses[0]!);
    for (const text of ['এটা মুছে ফেলো', 'delete this', 'delete it', 'ওটা ডিলিট করে দাও']) {
      const result = run(text, context);
      const clause = result.clauses[0]!;
      // "this" could be a file, the whole folder or everything in it: the user must say which.
      expect(clause.type, text).toBe('DELETE_FILE');
      expect(clause.destructive, text).toBe(true);
      expect(clause.missing, text).toContain('target');
      expect(clause.params.folder, text).toBeUndefined();
      expect(clause.params.fileName, text).toBeUndefined();
      expect(result.needsPlanner, text).toBe(true);
    }
  });
});

describe('corrections', () => {
  const previous = (text: string) => updateContext({}, run(text).clauses[0]!);

  it('detects the correction marker in Bengali, Banglish and English', () => {
    expect(stripCorrectionMarker('না, Edge খুলে দাও')).toBe('Edge খুলে দাও');
    expect(stripCorrectionMarker('না না Edge খুলে দাও')).toBe('Edge খুলে দাও');
    expect(stripCorrectionMarker('no, Edge please')).toBe('Edge please');
    expect(stripCorrectionMarker('actually open Edge')).toBe('open Edge');
    expect(stripCorrectionMarker('sorry, Edge')).toBe('Edge');
  });

  it('does not mistake words that merely start with a marker for a correction', () => {
    expect(stripCorrectionMarker('নাম বদলাও')).toBeUndefined();
    expect(stripCorrectionMarker('notepad open koro')).toBeUndefined();
    expect(stripCorrectionMarker('Chrome খুলে দাও')).toBeUndefined();
  });

  it('replaces the whole command with a corrected complete command', () => {
    const result = run('না, Edge খুলে দাও', previous('Open Chrome'));
    expect(result.isCorrection).toBe(true);
    expect(result.clauses[0]).toMatchObject({ type: 'OPEN_APP', params: { app: 'Edge' } });
  });

  it('swaps only the changed entity when the correction is partial', () => {
    const result = run('না, Edge', previous('Open Chrome'));
    expect(result.isCorrection).toBe(true);
    expect(result.clauses[0]).toMatchObject({ type: 'OPEN_APP', params: { app: 'Edge' } });
  });

  it('corrects a folder: "Downloads না, Desktop"', () => {
    const result = run('না না Desktop', previous('Downloads folder খুলে দাও'));
    expect(result.clauses[0]).toMatchObject({ type: 'OPEN_FOLDER', params: { folder: 'Desktop' } });
  });

  it('ignores a correction marker when there is nothing to correct', () => {
    const result = run('না, Edge খুলে দাও');
    expect(result.isCorrection).toBe(false);
    expect(result.clauses[0]).toMatchObject({ type: 'OPEN_APP', params: { app: 'Edge' } });
  });

  it('leaves a bare "না" to the confirmation flow rather than treating it as a correction', () => {
    const result = run('না', previous('Open Chrome'));
    expect(result.isCorrection).toBe(false);
    expect(result.needsPlanner).toBe(true);
  });
});

describe('yes / no answers to a confirmation', () => {
  it.each([
    'yes',
    'Yes!',
    'ok',
    'okay',
    'sure',
    'confirm',
    'go ahead',
    'হ্যাঁ',
    'হ্যাঁ।',
    'জি',
    'ঠিক আছে',
    'ha',
    'haan',
    'thik ache',
  ])('%s → yes', (text) => {
    expect(parseAnswer(text)).toBe('yes');
  });

  it.each([
    'no',
    'No.',
    'cancel',
    'stop',
    "don't",
    'না',
    'না না',
    'থাক',
    'বাদ দাও',
    'na',
    'thak',
    'dorkar nei',
  ])('%s → no', (text) => {
    expect(parseAnswer(text)).toBe('no');
  });

  it.each([
    'yes but not that one',
    'হ্যাঁ কিন্তু শুধু PDF',
    'maybe',
    'হয়তো',
    'not sure',
    'ok cancel',
    'করো', // "do it" — too ambiguous to authorise a destructive action
    'delete it',
    '',
    '   ',
    '???',
  ])('%j → unclear (never confirms)', (text) => {
    expect(parseAnswer(text)).toBe('unclear');
  });

  it('is robust to Unicode variants of হ্যাঁ', () => {
    expect(parseAnswer('হ্যাঁ')).toBe('yes');
    expect(parseAnswer('হ্যাঁ')).toBe('yes');
    expect(parseAnswer('হ্যা')).toBe('yes');
  });
});
