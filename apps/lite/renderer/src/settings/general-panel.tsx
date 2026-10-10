import { useId, useState } from 'react';
import type { Settings } from '../../../shared/ipc';
import { ModelPicker } from '../components/model-picker';
import { Field, Input, Select, Textarea } from '../components/ui';
import { useT } from '../i18n';
import { useAppStore } from '../stores/app';

function Switch({
  checked,
  label,
  help,
  onChange,
}: {
  checked: boolean;
  label: string;
  help: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 accent-[var(--accent)]"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-sm text-muted">{help}</span>
      </span>
    </label>
  );
}

export function GeneralPanel() {
  const t = useT();
  const ids = useId();
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.update);
  const go = useAppStore((s) => s.go);
  const [name, setName] = useState(settings.userName);
  const [instructions, setInstructions] = useState(settings.instructions);
  const [saved, setSaved] = useState<'saved' | 'failed' | null>(null);

  const save = async (changes: Partial<Settings>) => {
    try {
      await update(changes);
      setSaved('saved');
    } catch {
      setSaved('failed');
    }
    window.setTimeout(() => setSaved(null), 2500);
  };

  return (
    <section aria-labelledby="general-title" className="space-y-5">
      <h2 id="general-title" className="text-xl font-semibold">
        {t.t('general.title')}
      </h2>

      <Field label={t.t('general.language')} htmlFor={`${ids}-lang`}>
        <Select
          id={`${ids}-lang`}
          value={settings.language}
          onChange={(e) => void save({ language: e.target.value as Settings['language'] })}
        >
          <option value="auto">{t.t('general.language.auto')}</option>
          <option value="en">{t.t('general.language.en')}</option>
          <option value="bn">{t.t('general.language.bn')}</option>
        </Select>
      </Field>

      <Field label={t.t('general.theme')} htmlFor={`${ids}-theme`}>
        <Select
          id={`${ids}-theme`}
          value={settings.theme}
          onChange={(e) => void save({ theme: e.target.value as Settings['theme'] })}
        >
          <option value="system">{t.t('general.theme.system')}</option>
          <option value="dark">{t.t('general.theme.dark')}</option>
          <option value="light">{t.t('general.theme.light')}</option>
        </Select>
      </Field>

      <Field
        label={t.t('general.yourName')}
        help={t.t('general.yourNameHelp')}
        htmlFor={`${ids}-name`}
      >
        <Input
          id={`${ids}-name`}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== settings.userName && void save({ userName: name.trim() })}
        />
      </Field>

      <Field
        label={t.t('general.instructions')}
        help={t.t('general.instructionsHelp')}
        htmlFor={`${ids}-instructions`}
      >
        <Textarea
          id={`${ids}-instructions`}
          rows={4}
          maxLength={4000}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => instructions !== settings.instructions && void save({ instructions })}
        />
      </Field>

      <Switch
        checked={settings.browserTools}
        label={t.t('general.browserTools')}
        help={t.t('general.browserToolsHelp')}
        onChange={(browserTools) => void save({ browserTools })}
      />

      <Switch
        checked={settings.notifyTasks}
        label={t.t('general.notifyTasks')}
        help={t.t('general.notifyTasksHelp')}
        onChange={(notifyTasks) => void save({ notifyTasks })}
      />
      <Switch
        checked={settings.background}
        label={t.t('general.background')}
        help={t.t('general.backgroundHelp')}
        onChange={(background) => void save({ background })}
      />
      <Switch
        checked={settings.startWithWindows}
        label={t.t('general.startWithWindows')}
        help={t.t('general.startWithWindowsHelp')}
        onChange={(startWithWindows) => void save({ startWithWindows })}
      />

      <div>
        <p className="mb-1.5 text-sm font-medium">{t.t('general.defaultModel')}</p>
        <div className="inline-block rounded-lg border border-line-strong">
          <ModelPicker
            value={settings.defaultModel}
            onPick={(model) => void save({ defaultModel: model })}
            onConnect={() => go('settings', 'providers')}
          />
        </div>
        <p className="mt-1 text-sm text-muted">{t.t('general.defaultModelHelp')}</p>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={saved === 'failed' ? 'h-5 text-sm text-danger' : 'h-5 text-sm text-success'}
      >
        {saved === 'saved' ? t.t('general.saved') : saved === 'failed' ? t.t('general.failed') : ''}
      </p>
    </section>
  );
}
