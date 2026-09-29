import { useT } from '@renderer/lib/i18n';
import { useAppInfoStore } from '@renderer/stores/app-info';
import { useSettingsStore } from '@renderer/stores/settings';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { Kbd } from '@renderer/components/ui/kbd';
import { UpdatesCard } from './updates-card';

export function HelpScreen() {
  const t = useT();
  const shortcuts = useSettingsStore((s) => s.values);
  const info = useAppInfoStore();
  const rows = [
    ['commandPalette', shortcuts['shortcuts.commandPalette']],
    ['newTask', shortcuts['shortcuts.newTask']],
    ['voice', shortcuts['shortcuts.voice']],
    ['emergencyStop', shortcuts['shortcuts.emergencyStop']],
    ['showApp', shortcuts['shortcuts.showApp']],
    ['search', shortcuts['shortcuts.search']],
  ] as const;
  return (
    <ScreenFrame title={t.t('help.title')} description={t.t('help.tipsNote')} width="narrow">
      <div className="space-y-4">
        <Card>
          <CardHeader title={t.t('help.tipsTitle')} />
          <ul className="space-y-2 text-body text-fg">
            {(['tip1', 'tip2', 'tip3', 'tip4'] as const).map((key) => (
              <li key={key} className="rounded-control bg-bg-2 px-3 py-2">
                {t.t(`help.${key}`)}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title={t.t('help.shortcutsTitle')} />
          <dl className="divide-y divide-line">
            {rows.map(([name, combo]) => (
              <div key={name} className="flex items-center justify-between py-2.5">
                <dt className="text-body text-fg">{t.t(`settings.shortcuts.${name}`)}</dt>
                <dd className="flex gap-1">
                  {combo.split('+').map((part) => (
                    <Kbd key={part}>{part}</Kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
        <UpdatesCard />
        <Card>
          <CardHeader title={t.t('help.aboutTitle')} />
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-body">
            <dt className="text-muted">{t.t('help.version')}</dt>
            <dd className="text-fg">{info.version ?? '—'}</dd>
            <dt className="text-muted">Electron</dt>
            <dd className="text-fg">{info.electronVersion ?? '—'}</dd>
          </dl>
        </Card>
      </div>
    </ScreenFrame>
  );
}
