import { useEffect, useState } from 'react';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { Kbd } from '@renderer/components/ui/kbd';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** Builds a combo string like `Ctrl+Shift+V` from a keydown, or null if it isn't a valid shortcut. */
export function comboFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(event.key);
  // Require Ctrl/Alt (or an F-key) so a shortcut can never swallow ordinary typing.
  if (!(event.ctrlKey || event.metaKey || event.altKey) && !isFunctionKey) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const key =
    event.key === ' '
      ? 'Space'
      : event.key === 'Escape'
        ? 'Escape'
        : event.key.length === 1
          ? event.key.toUpperCase()
          : event.key;
  parts.push(key);
  return parts.join('+');
}

export function ShortcutRecorder({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (combo: string) => void;
  label: string;
}) {
  const t = useT();
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey) {
        setRecording(false);
        return;
      }
      const combo = comboFromEvent(event);
      if (combo) {
        onChange(combo);
        setRecording(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, onChange]);

  return (
    <button
      type="button"
      aria-label={`${label}: ${value}`}
      onClick={() => setRecording((r) => !r)}
      onBlur={() => setRecording(false)}
      className={cn(
        'flex min-w-36 items-center justify-center gap-1 rounded-control border px-3 py-1.5 transition-colors duration-150',
        recording
          ? 'border-accent bg-accent/10 text-accent-text'
          : 'border-line hover:border-line-strong',
      )}
    >
      {recording ? (
        <span className="text-small">{t.t('settings.shortcuts.pressKeys')}</span>
      ) : (
        value.split('+').map((part) => <Kbd key={part}>{part}</Kbd>)
      )}
    </button>
  );
}
