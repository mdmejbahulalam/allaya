import { useEffect, useId, useState } from 'react';
import type { VoiceOptions, VoiceSettings } from '../../../shared/ipc';
import { Button, Field, Select, Textarea } from '../components/ui';
import { useT } from '../i18n';
import { invoke } from '../lib/api';
import { speechLanguage } from '../lib/text-lang';
import { ServiceSpeaker, SystemSpeaker, type Speaker } from '../lib/voice/speaker';
import { useAppStore } from '../stores/app';
import { useConnectionsStore } from '../stores/connections';

export function VoicePanel() {
  const t = useT();
  const ids = useId();
  const voice = useAppStore((s) => s.settings.voice);
  const update = useAppStore((s) => s.update);
  const connections = useConnectionsStore((s) => s.connections);
  const [options, setOptions] = useState<VoiceOptions | null>(null);
  const [saved, setSaved] = useState(false);
  const [playing, setPlaying] = useState<Speaker | null>(null);
  const [style, setStyle] = useState(voice.ttsStyle);

  // What each connected service can do: read again whenever the settings or the services change.
  useEffect(() => {
    let cancelled = false;
    void invoke('voice:options')
      .then((next) => !cancelled && setOptions(next))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [voice, connections]);

  const save = async (changes: Partial<VoiceSettings>) => {
    await update({ voice: { ...voice, ...changes } });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const listeners = options?.engines.filter((e) => e.stt) ?? [];
  const speakers = options?.engines.filter((e) => e.tts) ?? [];
  const speakerId =
    voice.ttsEngine === 'service'
      ? (options?.tts?.connectionId ?? speakers[0]?.connectionId ?? '')
      : '';
  const speaker = speakers.find((e) => e.connectionId === speakerId);

  const preview = () => {
    if (playing) {
      playing.stop();
      setPlaying(null);
      return;
    }
    const text = t.t('voice.previewText');
    const language = speechLanguage(text);
    const made: Speaker = speaker
      ? new ServiceSpeaker({
          connectionId: speaker.connectionId,
          voice: voice.ttsVoice || undefined,
          style,
        })
      : new SystemSpeaker();
    setPlaying(made);
    void made
      .speak(text, language)
      .catch(() => undefined)
      .finally(() => setPlaying((current) => (current === made ? null : current)));
  };

  return (
    <section aria-labelledby="voice-title" className="space-y-5">
      <div>
        <h2 id="voice-title" className="text-xl font-semibold">
          {t.t('voice.title')}
        </h2>
        <p className="mt-1 text-muted">{t.t('voice.intro')}</p>
        <p className="mt-1 text-sm text-muted">{t.t('voice.privacy')}</p>
      </div>

      <Field label={t.t('voice.stt.label')} htmlFor={`${ids}-stt`}>
        {listeners.length === 0 ? (
          <p
            role="status"
            className="rounded-lg border border-dashed border-line-strong p-3 text-sm text-muted"
          >
            {t.t('voice.stt.none')}
          </p>
        ) : (
          <>
            <Select
              id={`${ids}-stt`}
              value={voice.sttConnectionId ?? ''}
              onChange={(e) => void save({ sttConnectionId: e.target.value || null })}
            >
              <option value="">{t.t('voice.stt.auto')}</option>
              {listeners.map((e) => (
                <option key={e.connectionId} value={e.connectionId}>
                  {e.name}
                </option>
              ))}
            </Select>
            {options?.stt && (
              <p className="mt-1 text-sm text-muted">
                {t.t('voice.stt.using', {
                  name:
                    listeners.find((e) => e.connectionId === options.stt?.connectionId)?.name ?? '',
                })}
              </p>
            )}
          </>
        )}
      </Field>

      <Field label={t.t('voice.language')} htmlFor={`${ids}-lang`}>
        <Select
          id={`${ids}-lang`}
          value={voice.inputLanguage}
          onChange={(e) =>
            void save({ inputLanguage: e.target.value as VoiceSettings['inputLanguage'] })
          }
        >
          <option value="auto">{t.t('voice.language.auto')}</option>
          <option value="en">{t.t('voice.language.en')}</option>
          <option value="bn">{t.t('voice.language.bn')}</option>
        </Select>
      </Field>

      <Field label={t.t('voice.tts.label')} htmlFor={`${ids}-tts`}>
        <Select
          id={`${ids}-tts`}
          value={voice.ttsEngine === 'service' ? speakerId : ''}
          onChange={(e) =>
            void save(
              e.target.value
                ? { ttsEngine: 'service', ttsConnectionId: e.target.value, ttsVoice: '' }
                : { ttsEngine: 'system', ttsConnectionId: null, ttsVoice: '' },
            )
          }
        >
          <option value="">{t.t('voice.tts.system')}</option>
          {speakers.map((e) => (
            <option key={e.connectionId} value={e.connectionId}>
              {e.name}
            </option>
          ))}
        </Select>
      </Field>

      {speaker && speaker.voices.length > 0 && (
        <Field label={t.t('voice.tts.voice')} htmlFor={`${ids}-voice`}>
          <Select
            id={`${ids}-voice`}
            value={voice.ttsVoice || speaker.voices[0]!.id}
            onChange={(e) => void save({ ttsVoice: e.target.value })}
          >
            {speaker.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {speaker?.expressive && (
        <Field
          label={t.t('voice.tts.style')}
          help={t.t('voice.tts.styleHelp')}
          htmlFor={`${ids}-style`}
        >
          <Textarea
            id={`${ids}-style`}
            rows={2}
            maxLength={300}
            value={style}
            placeholder={t.t('voice.tts.stylePlaceholder')}
            onChange={(e) => setStyle(e.target.value)}
            onBlur={() => style !== voice.ttsStyle && void save({ ttsStyle: style })}
          />
        </Field>
      )}

      <div>
        <Button onClick={preview}>
          {playing ? t.t('voice.previewStop') : t.t('voice.preview')}
        </Button>
      </div>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          checked={voice.speakReplies}
          onChange={(e) => void save({ speakReplies: e.target.checked })}
          className="mt-1 size-4 accent-[var(--accent)]"
        />
        <span>
          <span className="block text-sm font-medium">{t.t('voice.speakReplies')}</span>
          <span className="block text-sm text-muted">{t.t('voice.speakRepliesHelp')}</span>
        </span>
      </label>

      <p role="status" aria-live="polite" className="h-5 text-sm text-success">
        {saved ? t.t('voice.saved') : ''}
      </p>
    </section>
  );
}
