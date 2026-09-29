import { describe, expect, it } from 'vitest';
import { classifyComplexity, needsPlanning } from '@allaya/agent';

const NOW = new Date('2026-05-01T10:00:00');

const cases: [string, string, 'trivial' | 'simple' | 'multi_step' | 'complex'][] = [
  ['en one command', 'open notepad', 'trivial'],
  ['bn one command', 'Notepad খোলো', 'trivial'],
  ['banglish one command', 'notepad open koro', 'trivial'],
  ['en one short request', 'What is in my downloads folder', 'simple'],
  ['en sequence', 'Find the invoice PDF and then move it to Documents', 'multi_step'],
  ['en first/then', 'First open the report, then summarise it', 'multi_step'],
  ['bn sequence', 'ডাউনলোড ফোল্ডার খুলে তারপর সবচেয়ে বড় ফাইলটা দেখাও', 'multi_step'],
  ['banglish sequence', 'downloads folder e giye tarpor boro file ta dekhao', 'multi_step'],
  ['two sentences', 'Open the browser. Search for cheap flights to Dhaka.', 'multi_step'],
  [
    'a list',
    'Please do this:\n1. Open the folder\n2. Find the newest file\n3. Copy it to the desktop\n4. Rename it',
    'complex',
  ],
];

describe('classifyComplexity', () => {
  it.each(cases)('%s', (_name, text, expected) => {
    expect(classifyComplexity(text, NOW).complexity).toBe(expected);
  });

  it('treats a very long request as complex, whatever it says', () => {
    const long = `Please tidy up my files ${'and make sure everything is in the right place '.repeat(12)}`;
    expect(classifyComplexity(long, NOW).complexity).toBe('complex');
  });

  it('explains itself', () => {
    const result = classifyComplexity('Find it and then move it. Then tell me.', NOW);
    expect(result.reasons.join(' ')).toMatch(/sequencing/);
  });

  it('plans only when it pays', () => {
    expect(needsPlanning('trivial')).toBe(false);
    expect(needsPlanning('simple')).toBe(false);
    expect(needsPlanning('multi_step')).toBe(true);
    expect(needsPlanning('complex')).toBe(true);
  });

  it('never throws, on any input', () => {
    for (const text of ['', '   ', '\u0000', 'ঃ', '🙂'.repeat(500), '.'.repeat(1000)]) {
      expect(() => classifyComplexity(text, NOW)).not.toThrow();
    }
  });
});
