import { CornerDownLeft, Search, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog } from 'radix-ui';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { scoreMatch } from '@renderer/lib/search';
import { useRegisterOverlay } from '@renderer/stores/overlays';

export interface PaletteItem {
  id: string;
  label: string;
  icon?: ReactNode;
  group: 'suggested' | 'navigate' | 'actions';
  /** Extra search terms (both languages, plus Banglish) so typing in any language finds it. */
  keywords?: string[];
  run: () => void;
}

interface PaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaletteItem[];
  /** Free text → Allaya. */
  onAsk: (query: string) => void;
}

/**
 * Shell only: the dialog chrome and animation. The interactive body mounts fresh every time the palette
 * opens, so its query/selection state resets naturally — no effects syncing state.
 */
export function CommandPalette({ open, onOpenChange, items, onAsk }: PaletteProps) {
  const t = useT();
  useRegisterOverlay(open);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </Dialog.Overlay>
            <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]">
              <Dialog.Content asChild forceMount aria-describedby={undefined}>
                <motion.div
                  className="glass w-full max-w-xl overflow-hidden rounded-card border border-line shadow-elevated"
                  initial={{ opacity: 0, y: -8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Dialog.Title className="sr-only">{t.t('nav.primary')}</Dialog.Title>
                  <PaletteBody items={items} onAsk={onAsk} onClose={() => onOpenChange(false)} />
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function PaletteBody({
  items,
  onAsk,
  onClose,
}: {
  items: PaletteItem[];
  onAsk: (query: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const listId = useId();
  // Query and highlighted row change together: typing always resets the highlight to the top.
  const [{ query, active }, setState] = useState({ query: '', active: 0 });
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const trimmed = query.trim();
    const out: PaletteItem[] = [];
    if (trimmed) {
      out.push({
        id: '__ask',
        label: t.t('palette.askAllaya', { query: trimmed }),
        icon: <Sparkles size={16} />,
        group: 'suggested',
        run: () => onAsk(trimmed),
      });
    }
    if (trimmed) {
      items
        .map((item) => ({
          item,
          score: scoreMatch(trimmed, [item.label, ...(item.keywords ?? [])]),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .forEach(({ item }) => out.push(item));
    } else {
      out.push(...items); // no query: keep declaration order
    }
    return out;
  }, [items, query, t, onAsk]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const move = (delta: number) =>
    setState((s) => ({
      ...s,
      active: results.length ? (s.active + delta + results.length) % results.length : 0,
    }));

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      // isComposing: don't fire while a Bengali/IME composition is being confirmed.
      event.preventDefault();
      run(results[active]);
    }
  };

  const groupLabel = (group: PaletteItem['group']) =>
    group === 'suggested'
      ? t.t('palette.groupSuggested')
      : group === 'navigate'
        ? t.t('palette.groupNavigate')
        : t.t('palette.groupActions');

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search aria-hidden size={18} className="text-muted" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
          aria-label={t.t('palette.placeholder')}
          value={query}
          onChange={(event) => setState({ query: event.target.value, active: 0 })}
          onKeyDown={onKeyDown}
          placeholder={t.t('palette.placeholder')}
          className="h-14 w-full bg-transparent text-h3 text-fg outline-none placeholder:text-muted"
        />
      </div>
      <ul ref={listRef} id={listId} role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
        {results.length === 0 && (
          <li className="px-3 py-8 text-center text-body text-muted">{t.t('palette.noResults')}</li>
        )}
        {results.map((item, index) => {
          const showHeading = index === 0 || results[index - 1]!.group !== item.group;
          return (
            <li key={item.id} role="presentation">
              {showHeading && (
                <div className="px-3 pt-2 pb-1 text-caption font-semibold tracking-wider text-muted uppercase">
                  {groupLabel(item.group)}
                </div>
              )}
              <div
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                onMouseMove={() => index !== active && setState((s) => ({ ...s, active: index }))}
                onClick={() => run(item)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-control px-3 py-2.5 text-body text-fg',
                  index === active ? 'bg-elevated' : 'hover:bg-elevated/60',
                )}
              >
                <span
                  aria-hidden
                  className={cn('text-muted', index === active && 'text-accent-text')}
                >
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {index === active && (
                  <CornerDownLeft aria-hidden size={14} className="text-muted" />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line px-4 py-2 text-caption text-muted">
        {t.t('palette.navigateHint')}
      </div>
    </>
  );
}
