import { Play, RefreshCw, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  AUDIO_TAG_GROUPS,
  EXPRESSIVE_VOICES,
  STYLE_PRESETS,
  STYLE_TEXT,
  type StylePreset,
} from '@allaya/speech';
import { IpcError, invoke } from '@renderer/lib/api';
import { useT } from '@renderer/lib/i18n';
import { textLang } from '@renderer/lib/text-lang';
import { cn } from '@renderer/lib/cn';
import { CloudSpeaker, SpeechError } from '@renderer/lib/voice/speaker';
import { useSettingsStore } from '@renderer/stores/settings';
import { toast } from '@renderer/stores/toasts';
import { Button } from '@renderer/components/ui/button';
import { Card, CardHeader } from '@renderer/components/ui/card';
import { Dropdown } from '@renderer/components/ui/dropdown';
import { Textarea } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { SettingRow } from './setting-row';
import type { TranslationKey } from '@allaya/localization';

/**
 * Allaya's voice: which of the 30 expressive voices, how it should sound, the tone tags, and a preview that speaks
 * a sample with what is on screen right now — before anything is saved. Speech itself is made in the main
 * process; the Google key never reaches this window.
 */
export function VoiceStudio({
  available,
  onChange,
}: {
  /** A Google key is stored. */
  available: boolean;
  onChange: (
    key: 'voice.geminiVoice' | 'voice.geminiModel' | 'voice.style' | 'voice.expressive',
    value: string | boolean,
  ) => void;
}) {
  const t = useT();
  const values = useSettingsStore((s) => s.values);
  const voice = values['voice.geminiVoice'];
  const model = values['voice.geminiModel'];
  const saved = values['voice.style'];

  const [style, setStyle] = useState(saved);
  const [sample, setSample] = useState(() => t.t('settings.voice.studio.sample'));
  const [models, setModels] = useState<string[]>([model]);
  const [fetched, setFetched] = useState(false);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const speaker = useRef<CloudSpeaker | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    invoke('voice:listSpeechModels').then(
      (out) => {
        if (cancelled) return;
        setModels(out.models.includes(model) ? out.models : [model, ...out.models]);
        setFetched(out.fetched);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // `model` is deliberately not a dependency: choosing one must not refetch the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, tick]);

  useEffect(() => () => speaker.current?.stop(), []);

  const stop = () => {
    speaker.current?.stop();
    setPlaying(false);
  };

  const play = async (overrideVoice?: string) => {
    speaker.current?.stop();
    const next = new CloudSpeaker({
      engine: 'gemini',
      voice: overrideVoice ?? voice,
      style,
      chunkChars: 420,
    });
    speaker.current = next;
    setPlaying(true);
    try {
      await next.speak(sample, textLang(sample) === 'bn' ? 'bn' : 'en');
    } catch (error) {
      const reason = error instanceof SpeechError ? error.cause : error;
      const code = reason instanceof IpcError ? reason.code : 'UNKNOWN';
      toast.error(
        code === 'PROVIDER_NOT_CONFIGURED' || code === 'PERMISSION_REQUIRED'
          ? t.t(`errors.ipc.${code}`)
          : t.t('settings.voice.studio.failed'),
      );
    } finally {
      if (speaker.current === next) setPlaying(false);
    }
  };

  const addTag = (tag: string) => {
    const el = box.current;
    const at = el?.selectionStart ?? sample.length;
    const end = el?.selectionEnd ?? at;
    const before = sample.slice(0, at);
    const glue = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${glue}[${tag}] ${sample.slice(end)}`.replace(/ {2,}/g, ' ');
    setSample(next);
    requestAnimationFrame(() => el?.focus());
  };

  const applyPreset = (preset: StylePreset) => {
    setStyle(STYLE_TEXT[preset]);
    onChange('voice.style', STYLE_TEXT[preset]);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="voice-studio">
      {!available && (
        <p role="status" className="rounded-control bg-elevated px-3 py-2 text-small text-muted">
          {t.t('settings.voice.studio.needKey')}
        </p>
      )}

      <Card>
        <CardHeader
          title={t.t('settings.voice.studio.voices')}
          description={t.t('settings.voice.studio.voicesHint', {
            count: t.formatNumber(EXPRESSIVE_VOICES.length),
          })}
        />
        <div
          role="radiogroup"
          aria-label={t.t('settings.voice.studio.voices')}
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {EXPRESSIVE_VOICES.map((v) => (
            <button
              key={v.name}
              type="button"
              role="radio"
              aria-checked={voice === v.name}
              onClick={() => onChange('voice.geminiVoice', v.name)}
              className={cn(
                'flex flex-col items-start rounded-control border px-3 py-2 text-start transition-colors duration-150',
                voice === v.name
                  ? 'border-accent bg-accent/10'
                  : 'border-line bg-bg-2 hover:border-line-strong',
              )}
            >
              <span className="text-body font-medium text-fg">{v.name}</span>
              <span className="text-caption text-muted">
                {t.t(`settings.voice.studio.tone.${v.tone}` as TranslationKey)}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <SettingRow
          label={t.t('settings.voice.studio.model')}
          description={
            fetched
              ? t.t('settings.voice.studio.modelFetched')
              : t.t('settings.voice.studio.modelDefault')
          }
        >
          <div className="flex items-center gap-2">
            <Dropdown
              label={t.t('settings.voice.studio.model')}
              value={model}
              onValueChange={(v) => onChange('voice.geminiModel', v)}
              className="min-w-64"
              options={models.map((m) => ({ value: m, label: m }))}
            />
            <Button
              variant="ghost"
              disabled={!available}
              aria-label={t.t('settings.voice.studio.refreshModels')}
              onClick={() => setTick((n) => n + 1)}
              leftIcon={<RefreshCw size={16} />}
            />
          </div>
        </SettingRow>
        <SettingRow
          label={t.t('settings.voice.studio.expressive')}
          description={t.t('settings.voice.studio.expressiveHint')}
        >
          <Switch
            label={t.t('settings.voice.studio.expressive')}
            checked={values['voice.expressive']}
            onCheckedChange={(v) => onChange('voice.expressive', v)}
          />
        </SettingRow>
      </Card>

      <Card>
        <CardHeader
          title={t.t('settings.voice.studio.styleTitle')}
          description={t.t('settings.voice.studio.styleHint')}
        />
        <div className="mb-3 flex flex-wrap gap-2">
          {STYLE_PRESETS.map((preset) => (
            <Button key={preset} size="sm" variant="outline" onClick={() => applyPreset(preset)}>
              {t.t(`settings.voice.studio.preset.${preset}` as TranslationKey)}
            </Button>
          ))}
        </div>
        <Textarea
          aria-label={t.t('settings.voice.studio.styleTitle')}
          value={style}
          maxLength={300}
          rows={2}
          placeholder={t.t('settings.voice.studio.stylePlaceholder')}
          onChange={(event) => setStyle(event.target.value)}
          onBlur={() => style !== saved && onChange('voice.style', style.trim())}
        />
      </Card>

      <Card>
        <CardHeader
          title={t.t('settings.voice.studio.previewTitle')}
          description={t.t('settings.voice.studio.tagsHint')}
        />
        <div className="mb-3 flex flex-col gap-2">
          {AUDIO_TAG_GROUPS.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-label={t.t(`settings.voice.studio.group.${group.id}` as TranslationKey)}
              className="flex flex-wrap items-center gap-1.5"
            >
              <span className="me-1 w-20 shrink-0 text-caption text-muted">
                {t.t(`settings.voice.studio.group.${group.id}` as TranslationKey)}
              </span>
              {group.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => addTag(tag)}
                  className="rounded-pill border border-line bg-bg-2 px-2.5 py-0.5 text-caption text-fg transition-colors hover:border-accent hover:text-accent-text"
                >
                  [{tag}]
                </button>
              ))}
            </div>
          ))}
        </div>
        <Textarea
          ref={box}
          aria-label={t.t('settings.voice.studio.sampleLabel')}
          value={sample}
          maxLength={600}
          rows={3}
          onChange={(event) => setSample(event.target.value)}
        />
        <div className="mt-3 flex items-center gap-2">
          {playing ? (
            <Button variant="secondary" leftIcon={<Square size={16} />} onClick={stop}>
              {t.t('settings.voice.studio.stop')}
            </Button>
          ) : (
            <Button
              leftIcon={<Play size={16} />}
              disabled={!available || !sample.trim()}
              onClick={() => void play()}
            >
              {t.t('settings.voice.studio.play')}
            </Button>
          )}
          <span className="text-small text-muted">{t.t('settings.voice.studio.previewNote')}</span>
        </div>
      </Card>
    </div>
  );
}
