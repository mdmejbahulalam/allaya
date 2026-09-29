/**
 * Accent colour derivation. A user-picked accent must still produce accessible UI, so from one hex
 * we derive: `solid` (filled backgrounds carrying white text) and `text` (accent-coloured text
 * on the current surface), each nudged in lightness until it reaches WCAG AA (4.5:1).
 */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function hexToHsl(hex: string): Hsl {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves lightness in `direction` until `foreground` vs `background` reaches `target`. */
function adjustForContrast(
  hex: string,
  background: string,
  direction: 1 | -1,
  target = 4.5,
): string {
  const hsl = hexToHsl(hex);
  for (let i = 0; i < 60; i += 1) {
    const candidate = hslToHex(hsl);
    if (contrastRatio(candidate, background) >= target) return candidate;
    hsl.l = Math.min(1, Math.max(0, hsl.l + direction * 0.015));
  }
  return hslToHex(hsl);
}

export interface AccentTokens {
  accent: string;
  solid: string;
  text: string;
}

export function deriveAccentTokens(
  accent: string,
  theme: 'dark' | 'light',
  surface: string,
): AccentTokens {
  return {
    accent,
    // Darken until white text on it is readable.
    solid: adjustForContrast(accent, '#ffffff', -1),
    // Lighten on dark surfaces, darken on light ones.
    text: adjustForContrast(accent, surface, theme === 'dark' ? 1 : -1),
  };
}
