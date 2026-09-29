import { AllayaError } from '@allaya/shared';
import type { KeyChord } from './types';

const NAMED = new Set([
  'enter',
  'tab',
  'escape',
  'space',
  'backspace',
  'delete',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'insert',
]);
/** Names people (and models) use for keys, mapped to the canonical ones. */
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  spacebar: 'space',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};
const MODIFIERS = new Set([
  'ctrl',
  'control',
  'shift',
  'alt',
  'win',
  'windows',
  'meta',
  'cmd',
  'super',
]);

const canonicalModifier = (m: string): 'ctrl' | 'shift' | 'alt' | 'win' =>
  m === 'control'
    ? 'ctrl'
    : m === 'windows' || m === 'meta' || m === 'cmd' || m === 'super'
      ? 'win'
      : (m as 'ctrl' | 'shift' | 'alt');

/** Whether a single key name is one Allaya will press. */
export function isKnownKey(key: string): boolean {
  const k = key.toLowerCase();
  return /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-2])$/.test(k) || NAMED.has(k);
}

/**
 * Parses "Ctrl+Shift+T" / "ctrl + c" / "Enter" into a chord. Case, spacing and modifier synonyms are tolerated;
 * an unknown key or a chord with no key is refused.
 */
export function parseChord(text: string): KeyChord {
  const parts = text
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) throw new AllayaError('No key was given', { code: 'INVALID_INPUT' });
  const key = KEY_ALIASES[parts[parts.length - 1]!] ?? parts[parts.length - 1]!;
  const modifiers = new Set<'ctrl' | 'shift' | 'alt' | 'win'>();
  for (const part of parts.slice(0, -1)) {
    if (!MODIFIERS.has(part))
      throw new AllayaError(`"${part}" is not a modifier key`, { code: 'INVALID_INPUT' });
    modifiers.add(canonicalModifier(part));
  }
  if (MODIFIERS.has(key))
    throw new AllayaError('A shortcut needs a key besides the modifiers', {
      code: 'INVALID_INPUT',
    });
  if (!isKnownKey(key))
    throw new AllayaError(`"${key}" is not a key Allaya can press`, { code: 'INVALID_INPUT' });
  return { modifiers: [...modifiers].sort(), key };
}

export const formatChord = (chord: KeyChord): string =>
  [
    ...chord.modifiers.map((m) => m[0]!.toUpperCase() + m.slice(1)),
    chord.key.length === 1
      ? chord.key.toUpperCase()
      : chord.key[0]!.toUpperCase() + chord.key.slice(1),
  ].join('+');

/**
 * Chords that are refused outright, because they leave the current window or take over the system rather than
 * work inside it. (The list is intentionally short and obvious; anything subtler is caught by the target-window rule.)
 */
export function blockedChordReason(chord: KeyChord): string | undefined {
  const has = (m: 'ctrl' | 'shift' | 'alt' | 'win') => chord.modifiers.includes(m);
  const key = chord.key.toLowerCase();
  if (has('win'))
    return 'Shortcuts using the Windows key can open system tools and are not allowed';
  if (has('alt') && key === 'f4')
    return 'Alt+F4 closes windows without asking; use the close tool instead';
  if (has('ctrl') && has('alt') && key === 'delete')
    return 'Ctrl+Alt+Delete is reserved for the system';
  if (has('ctrl') && has('shift') && key === 'escape') return 'Ctrl+Shift+Esc opens Task Manager';
  return undefined;
}
