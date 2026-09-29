interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  spacebar: ' ',
  space: ' ',
};

/** Does a keyboard event match a combo string such as `Ctrl+Shift+V`? Order-insensitive for modifiers. */
export function matchesShortcut(event: KeyLike, combo: string): boolean {
  const parts = combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return false;
  const key = ALIASES[parts[parts.length - 1]!] ?? parts[parts.length - 1]!;
  const modifiers = new Set(parts.slice(0, -1));
  const wantsCtrl =
    modifiers.has('ctrl') ||
    modifiers.has('control') ||
    modifiers.has('cmd') ||
    modifiers.has('meta');
  const eventKey = ALIASES[event.key.toLowerCase()] ?? event.key.toLowerCase();
  return (
    eventKey === key &&
    (event.ctrlKey || event.metaKey) === wantsCtrl &&
    event.shiftKey === modifiers.has('shift') &&
    event.altKey === modifiers.has('alt')
  );
}
