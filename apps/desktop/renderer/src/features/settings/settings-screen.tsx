import { useEffect, useState } from 'react';
import type { LanguagePreference } from '@allaya/types';
import type { SettingKey, SettingValue } from '@allaya/validation';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { IpcError } from '@renderer/lib/api';
import { useSettingsStore } from '@renderer/stores/settings';
import { toast } from '@renderer/stores/toasts';
import { ScreenFrame } from '@renderer/components/shell/screen-frame';
import { Card } from '@renderer/components/ui/card';
import { Dropdown } from '@renderer/components/ui/dropdown';
import { EmptyState } from '@renderer/components/ui/empty-state';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { Settings2 } from 'lucide-react';
import { SettingRow } from './setting-row';
import { ShortcutRecorder } from './shortcut-recorder';
import { pickVoice, type VoiceInfo } from '@allaya/speech';
import { toVoiceInfo } from '@renderer/lib/voice/speaker';
import { useVoiceStore } from '@renderer/stores/voice';
import type { TranslationKey } from '@allaya/localization';

const SECTIONS = [
  'general',
  'appearance',
  'language',
  'voice',
  'models',
  'api',
  'computer',
  'browser',
  'files',
  'memory',
  'automations',
  'permissions',
  'security',
  'privacy',
  'notifications',
  'shortcuts',
  'updates',
  'advanced',
] as const;
type Section = (typeof SECTIONS)[number];

const ACCENTS = ['#7C5CFF', '#00C2FF', '#22C55E', '#F59E0B', '#EC4899', '#EF4444'];
const QUICK_ACTION_IDS = [
  'open_folder',
  'open_browser',
  'open_app',
  'screenshot',
  'find_file',
  'run_task',
] as const;

function useSetting() {
  const values = useSettingsStore((s) => s.values);
  const update = useSettingsStore((s) => s.update);
  const t = useT();
  const set = async <K extends SettingKey>(key: K, value: SettingValue<K>) => {
    try {
      await update(key, value);
    } catch (error) {
      const code = error instanceof IpcError ? error.code : 'UNKNOWN';
      toast.error(t.t(`errors.ipc.${code as 'UNKNOWN'}`));
    }
  };
  return { values, set };
}

function GeneralSection() {
  const t = useT();
  const { values, set } = useSetting();
  const [name, setName] = useState(values['profile.displayName']);
  const actions = values['general.quickActions'];
  return (
    <Card>
      <SettingRow
        label={t.t('settings.displayName')}
        description={t.t('settings.displayNameHint')}
        htmlFor="display-name"
      >
        <Input
          id="display-name"
          value={name}
          maxLength={60}
          className="w-56"
          onChange={(event) => setName(event.target.value)}
          onBlur={() =>
            name.trim() !== values['profile.displayName'] &&
            void set('profile.displayName', name.trim())
          }
        />
      </SettingRow>
      <SettingRow label={t.t('settings.general.startWithWindows')}>
        <Switch
          label={t.t('settings.general.startWithWindows')}
          checked={values['general.startWithWindows']}
          onCheckedChange={(v) => void set('general.startWithWindows', v)}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.general.minimizeToTray')}>
        <Switch
          label={t.t('settings.general.minimizeToTray')}
          checked={values['general.minimizeToTray']}
          onCheckedChange={(v) => void set('general.minimizeToTray', v)}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.general.floating')}>
        <Switch
          label={t.t('settings.general.floating')}
          checked={values['general.showFloatingAssistant']}
          onCheckedChange={(v) => void set('general.showFloatingAssistant', v)}
        />
      </SettingRow>
      <SettingRow
        label={t.t('settings.general.quickActions')}
        description={t.t('settings.general.quickActionsHint')}
      >
        <fieldset className="flex max-w-md flex-wrap justify-end gap-x-4 gap-y-2">
          <legend className="sr-only">{t.t('settings.general.quickActions')}</legend>
          {QUICK_ACTION_IDS.map((id) => (
            <label key={id} className="flex cursor-pointer items-center gap-2 text-small text-fg">
              <input
                type="checkbox"
                checked={actions.includes(id)}
                className="size-4 accent-[var(--accent)]"
                onChange={(event) =>
                  void set(
                    'general.quickActions',
                    event.target.checked
                      ? QUICK_ACTION_IDS.filter((x) => x === id || actions.includes(x))
                      : actions.filter((x) => x !== id),
                  )
                }
              />
              {t.t(`quickActions.${id}`)}
            </label>
          ))}
        </fieldset>
      </SettingRow>
    </Card>
  );
}

function AppearanceSection() {
  const t = useT();
  const { values, set } = useSetting();
  const accent = values['appearance.accent'];
  return (
    <Card>
      <SettingRow label={t.t('settings.appearance.theme')}>
        <Dropdown
          label={t.t('settings.appearance.theme')}
          value={values['appearance.theme']}
          onValueChange={(v) => void set('appearance.theme', v as 'dark' | 'light' | 'system')}
          options={[
            { value: 'dark', label: t.t('settings.appearance.themeDark') },
            { value: 'light', label: t.t('settings.appearance.themeLight') },
            { value: 'system', label: t.t('settings.appearance.themeSystem') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.appearance.accent')}>
        <div
          role="radiogroup"
          aria-label={t.t('settings.appearance.accent')}
          className="flex items-center gap-2"
        >
          {ACCENTS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={accent.toLowerCase() === color.toLowerCase()}
              aria-label={color}
              onClick={() => void set('appearance.accent', color)}
              className={cn(
                'size-7 rounded-full border-2 transition-transform duration-150 hover:scale-110',
                accent.toLowerCase() === color.toLowerCase() ? 'border-fg' : 'border-transparent',
              )}
              style={{ backgroundColor: color }}
            />
          ))}
          <input
            type="color"
            aria-label={t.t('settings.appearance.accent')}
            value={accent}
            onChange={(event) => void set('appearance.accent', event.target.value)}
            className="size-7 cursor-pointer rounded-full border border-line bg-transparent p-0"
          />
        </div>
      </SettingRow>
      <SettingRow label={t.t('settings.appearance.density')}>
        <Dropdown
          label={t.t('settings.appearance.density')}
          value={values['appearance.density']}
          onValueChange={(v) => void set('appearance.density', v as 'comfortable' | 'compact')}
          options={[
            { value: 'comfortable', label: t.t('settings.appearance.densityComfortable') },
            { value: 'compact', label: t.t('settings.appearance.densityCompact') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.appearance.animations')}>
        <Dropdown
          label={t.t('settings.appearance.animations')}
          value={values['appearance.animations']}
          onValueChange={(v) =>
            void set('appearance.animations', v as 'full' | 'reduced' | 'system')
          }
          options={[
            { value: 'system', label: t.t('settings.appearance.animationsSystem') },
            { value: 'full', label: t.t('settings.appearance.animationsFull') },
            { value: 'reduced', label: t.t('settings.appearance.animationsReduced') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.appearance.glass')}>
        <Switch
          label={t.t('settings.appearance.glass')}
          checked={values['appearance.glass']}
          onCheckedChange={(v) => void set('appearance.glass', v)}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.appearance.sidebar')}>
        <Dropdown
          label={t.t('settings.appearance.sidebar')}
          value={values['appearance.sidebar']}
          onValueChange={(v) => void set('appearance.sidebar', v as 'expanded' | 'collapsed')}
          options={[
            { value: 'expanded', label: t.t('settings.appearance.sidebarExpanded') },
            { value: 'collapsed', label: t.t('settings.appearance.sidebarCollapsed') },
          ]}
        />
      </SettingRow>
      <SettingRow
        label={t.t('settings.appearance.scale')}
        description={t.t('settings.uiScaleHint')}
      >
        <Dropdown
          label={t.t('settings.appearance.scale')}
          value={String(values['appearance.uiScale'])}
          onValueChange={(v) => void set('appearance.uiScale', Number(v))}
          options={[0.9, 1, 1.1, 1.25].map((v) => ({
            value: String(v),
            label: `${Math.round(v * 100)}%`,
          }))}
        />
      </SettingRow>
    </Card>
  );
}

function LanguageSection() {
  const t = useT();
  const { values, set } = useSetting();
  return (
    <Card>
      <SettingRow label={t.t('settings.language.ui')} description={t.t('settings.language.hint')}>
        <Dropdown
          label={t.t('settings.language.ui')}
          value={values['language.ui']}
          onValueChange={(v) => void set('language.ui', v as LanguagePreference)}
          options={[
            { value: 'auto', label: t.t('settings.language.auto') },
            { value: 'bn', label: t.t('settings.language.bn') },
            { value: 'en', label: t.t('settings.language.en') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.language.response')}>
        <Dropdown
          label={t.t('settings.language.response')}
          value={values['language.response']}
          onValueChange={(v) => void set('language.response', v as 'auto' | 'bn' | 'en' | 'mixed')}
          options={[
            { value: 'auto', label: t.t('settings.language.auto') },
            { value: 'bn', label: t.t('settings.language.bn') },
            { value: 'en', label: t.t('settings.language.en') },
            { value: 'mixed', label: t.t('settings.language.responseMixed') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.language.numerals')}>
        <Dropdown
          label={t.t('settings.language.numerals')}
          value={values['language.numerals']}
          onValueChange={(v) => void set('language.numerals', v as 'auto' | 'bengali' | 'latin')}
          options={[
            { value: 'auto', label: t.t('settings.language.numeralsAuto') },
            { value: 'bengali', label: t.t('settings.language.numeralsBengali') },
            { value: 'latin', label: t.t('settings.language.numeralsLatin') },
          ]}
        />
      </SettingRow>
    </Card>
  );
}

function PrivacySection() {
  const t = useT();
  const { values, set } = useSetting();
  const options = [
    { value: 'ask', label: t.t('settings.privacy.ask') },
    { value: 'never', label: t.t('settings.privacy.neverOption') },
    { value: 'always', label: t.t('settings.privacy.always') },
  ];
  return (
    <Card>
      <p className="mb-4 rounded-control bg-elevated px-3 py-2 text-small text-muted">
        {t.t('settings.privacy.note')}
      </p>
      <SettingRow label={t.t('settings.privacy.screenshots')}>
        <Dropdown
          label={t.t('settings.privacy.screenshots')}
          options={options}
          value={values['privacy.screenshotsToProvider']}
          onValueChange={(v) =>
            void set('privacy.screenshotsToProvider', v as 'ask' | 'never' | 'always')
          }
        />
      </SettingRow>
      <SettingRow label={t.t('settings.privacy.fileContents')}>
        <Dropdown
          label={t.t('settings.privacy.fileContents')}
          options={options}
          value={values['privacy.fileContentsToProvider']}
          onValueChange={(v) =>
            void set('privacy.fileContentsToProvider', v as 'ask' | 'never' | 'always')
          }
        />
      </SettingRow>
    </Card>
  );
}

/** Installed microphones. Labels are empty until the user has granted microphone access once. */
function useMicrophones(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled)
          setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default'));
      } catch {
        if (!cancelled) setDevices([]);
      }
    };
    void load();
    const onChange = () => void load();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
    };
  }, []);
  return devices;
}

/** Voices installed on this PC (the list arrives asynchronously). */
function useSystemVoices(): VoiceInfo[] {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  useEffect(() => {
    const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis;
    if (!synth) return;
    const load = () => setVoices(synth.getVoices().map(toVoiceInfo));
    load();
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, []);
  return voices;
}

const CLOUD_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
];

function VoiceSection() {
  const t = useT();
  const { values, set } = useSetting();
  const microphones = useMicrophones();
  const voices = useSystemVoices();
  const capabilities = useVoiceStore((s) => s.capabilities);
  const enabled = values['voice.enabled'];
  const bengaliVoice = pickVoice(voices, 'bn');
  const systemVoiceOptions = [
    { value: '', label: t.t('settings.voice.systemVoiceAuto') },
    ...voices
      .filter((v) => v.lang.toLowerCase().startsWith('bn') || v.lang.toLowerCase().startsWith('en'))
      .map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` })),
  ];
  // The dropdown must offer the stored value even if that voice is not installed right now.
  if (
    values['voice.systemVoice'] &&
    !systemVoiceOptions.some((o) => o.value === values['voice.systemVoice'])
  ) {
    systemVoiceOptions.push({
      value: values['voice.systemVoice'],
      label: values['voice.systemVoice'],
    });
  }

  return (
    <Card>
      <p className="mb-4 rounded-control bg-elevated px-3 py-2 text-small text-muted">
        {t.t('settings.voice.note')}
      </p>
      <SettingRow
        label={t.t('settings.voice.enabled')}
        description={t.t('settings.voice.enabledHint')}
      >
        <Switch
          label={t.t('settings.voice.enabled')}
          checked={enabled}
          onCheckedChange={(v) => void set('voice.enabled', v)}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.voice.device')}>
        <Dropdown
          label={t.t('settings.voice.device')}
          value={values['voice.inputDeviceId']}
          onValueChange={(v) => void set('voice.inputDeviceId', v)}
          options={[
            { value: '', label: t.t('settings.voice.deviceDefault') },
            ...microphones.map((d, i) => ({
              value: d.deviceId,
              label: d.label || `${t.t('settings.voice.device')} ${i + 1}`,
            })),
          ]}
        />
      </SettingRow>
      <SettingRow
        label={t.t('settings.voice.inputLanguage')}
        description={t.t('settings.voice.inputLanguageHint')}
      >
        <Dropdown
          label={t.t('settings.voice.inputLanguage')}
          value={values['voice.inputLanguage']}
          onValueChange={(v) => void set('voice.inputLanguage', v as 'auto' | 'bn' | 'en')}
          options={[
            { value: 'auto', label: t.t('settings.language.auto') },
            { value: 'bn', label: t.t('chat.autonym.bn') },
            { value: 'en', label: t.t('chat.autonym.en') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.voice.autoSend')}>
        <Dropdown
          label={t.t('settings.voice.autoSend')}
          value={values['voice.autoSend']}
          onValueChange={(v) => void set('voice.autoSend', v as 'never' | 'confident' | 'always')}
          className="min-w-64"
          options={[
            { value: 'never', label: t.t('settings.voice.autoSendNever') },
            { value: 'confident', label: t.t('settings.voice.autoSendConfident') },
            { value: 'always', label: t.t('settings.voice.autoSendAlways') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.voice.threshold')} htmlFor="voice-threshold">
        <div className="flex items-center gap-3">
          <input
            id="voice-threshold"
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={values['voice.confidenceThreshold']}
            disabled={values['voice.autoSend'] !== 'confident'}
            onChange={(event) => void set('voice.confidenceThreshold', Number(event.target.value))}
            className="w-40 accent-[var(--accent)]"
          />
          <span className="w-12 text-small text-muted tabular-nums">
            {t.formatNumber(values['voice.confidenceThreshold'], { style: 'percent' })}
          </span>
        </div>
      </SettingRow>
      <SettingRow label={t.t('settings.voice.speakReplies')}>
        <Switch
          label={t.t('settings.voice.speakReplies')}
          checked={values['voice.speakReplies']}
          onCheckedChange={(v) => void set('voice.speakReplies', v)}
        />
      </SettingRow>
      <SettingRow label={t.t('settings.voice.engine')}>
        <Dropdown
          label={t.t('settings.voice.engine')}
          value={values['voice.speechEngine']}
          onValueChange={(v) => void set('voice.speechEngine', v as 'system' | 'cloud')}
          className="min-w-64"
          options={[
            { value: 'system', label: t.t('settings.voice.engineSystem') },
            {
              value: 'cloud',
              label: t.t('settings.voice.engineCloud'),
              disabled: capabilities?.cloudTtsAvailable === false,
            },
          ]}
        />
      </SettingRow>
      {values['voice.speechEngine'] === 'system' ? (
        <SettingRow
          label={t.t('settings.voice.systemVoice')}
          {...(!bengaliVoice ? { description: t.t('voice.notice.no_voice_bn') } : {})}
        >
          <Dropdown
            label={t.t('settings.voice.systemVoice')}
            value={values['voice.systemVoice']}
            onValueChange={(v) => void set('voice.systemVoice', v)}
            className="min-w-64"
            options={systemVoiceOptions}
          />
        </SettingRow>
      ) : (
        <SettingRow label={t.t('settings.voice.cloudVoice')}>
          <Dropdown
            label={t.t('settings.voice.cloudVoice')}
            value={values['voice.cloudVoice']}
            onValueChange={(v) => void set('voice.cloudVoice', v)}
            options={CLOUD_VOICES.map((v) => ({ value: v, label: v }))}
          />
        </SettingRow>
      )}
      <SettingRow label={t.t('settings.voice.rate')} htmlFor="voice-rate">
        <div className="flex items-center gap-3">
          <input
            id="voice-rate"
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={values['voice.speechRate']}
            onChange={(event) => void set('voice.speechRate', Number(event.target.value))}
            className="w-40 accent-[var(--accent)]"
          />
          <span className="w-12 text-small text-muted tabular-nums">
            {t.formatNumber(values['voice.speechRate'], { maximumFractionDigits: 1 })}×
          </span>
        </div>
      </SettingRow>
    </Card>
  );
}

const SHORTCUT_ROWS = [
  ['shortcuts.commandPalette', 'commandPalette'],
  ['shortcuts.newTask', 'newTask'],
  ['shortcuts.voice', 'voice'],
  ['shortcuts.emergencyStop', 'emergencyStop'],
  ['shortcuts.search', 'search'],
] as const satisfies ReadonlyArray<readonly [SettingKey, string]>;

function ShortcutsSection() {
  const t = useT();
  const { values, set } = useSetting();
  return (
    <Card>
      <p className="mb-4 rounded-control bg-elevated px-3 py-2 text-small text-muted">
        {t.t('settings.shortcuts.hint')}
      </p>
      {SHORTCUT_ROWS.map(([key, name]) => (
        <SettingRow key={key} label={t.t(`settings.shortcuts.${name}`)}>
          <ShortcutRecorder
            label={t.t(`settings.shortcuts.${name}`)}
            value={values[key]}
            onChange={(combo) => void set(key, combo)}
          />
        </SettingRow>
      ))}
    </Card>
  );
}

export function SettingsScreen() {
  const t = useT();
  const [section, setSection] = useState<Section>('general');

  const body = (() => {
    switch (section) {
      case 'general':
        return <GeneralSection />;
      case 'appearance':
        return <AppearanceSection />;
      case 'language':
        return <LanguageSection />;
      case 'voice':
        return <VoiceSection />;
      case 'privacy':
        return <PrivacySection />;
      case 'shortcuts':
        return <ShortcutsSection />;
      default:
        return (
          <Card padded={false}>
            <EmptyState
              icon={Settings2}
              title={t.t('settings.comingSoonTitle')}
              description={t.t('settings.comingSoonBody')}
            />
          </Card>
        );
    }
  })();

  return (
    <ScreenFrame title={t.t('settings.title')} width="wide">
      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label={t.t('settings.title')}>
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => setSection(id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-start text-body whitespace-nowrap transition-colors duration-150',
                    section === id
                      ? 'bg-elevated font-medium text-fg'
                      : 'text-muted hover:bg-elevated/60 hover:text-fg',
                  )}
                >
                  {t.t(`settings.sections.${id}` as TranslationKey)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div
          className="min-w-0"
          role="region"
          aria-label={t.t(`settings.sections.${section}` as TranslationKey)}
        >
          {body}
        </div>
      </div>
    </ScreenFrame>
  );
}
