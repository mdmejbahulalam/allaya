import type { LucideIcon } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Card } from '@renderer/components/ui/card';
import { EmptyState } from '@renderer/components/ui/empty-state';
import type { TranslationKey } from '@allaya/localization';

/**
 * Screen scaffold with its meaningful empty state. Each feature phase replaces the body
 * of its screen; the empty state stays as the zero-data view.
 */
export function EmptyScreen({
  icon,
  titleKey,
  emptyTitleKey,
  emptyBodyKey,
  action,
}: {
  icon: LucideIcon;
  titleKey: TranslationKey;
  emptyTitleKey: TranslationKey;
  emptyBodyKey: TranslationKey;
  action?: React.ReactNode;
}) {
  const t = useT();
  return (
    <ScreenFrame title={t.t(titleKey)}>
      <Card padded={false}>
        <EmptyState
          icon={icon}
          title={t.t(emptyTitleKey)}
          description={t.t(emptyBodyKey)}
          action={action}
        />
      </Card>
    </ScreenFrame>
  );
}
