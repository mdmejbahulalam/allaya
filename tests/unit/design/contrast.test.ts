import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.x contrast check computed from the real stylesheet, so a token edit that
 * breaks accessibility fails CI instead of shipping.
 */
const css = readFileSync(
  new URL('../../../apps/desktop/renderer/src/styles/index.css', import.meta.url),
  'utf8',
);

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const dark = block(':root');
const light = { ...dark, ...block(":root[data-theme='light']") };

describe.each([
  ['dark', dark],
  ['light', light],
] as const)('%s theme meets WCAG AA (4.5:1) for text', (_name, t) => {
  const surfaces = ['bg', 'bg-2', 'card', 'elevated'] as const;

  it.each(surfaces)('body and muted text on %s', (surface) => {
    expect(contrast(t['fg']!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['fg-muted']!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces)('accent, success, warning, danger text on %s', (surface) => {
    for (const token of ['accent-text', 'success', 'warning', 'danger-text']) {
      expect(contrast(t[token]!, t[surface]!), `${token} on ${surface}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('white text on filled accent and danger buttons', () => {
    expect(contrast(t['accent-fg']!, t['accent-solid']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', t['danger-solid']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('borders are distinguishable from surfaces (non-text 1.15:1 minimum)', () => {
    expect(contrast(t['line']!, t['card']!)).toBeGreaterThanOrEqual(1.15);
  });
});
