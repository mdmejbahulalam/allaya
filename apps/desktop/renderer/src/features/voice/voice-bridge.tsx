import { useEffect } from 'react';
import { resolveUiLocale } from '@allaya/localization';
import { textLang } from '@renderer/lib/text-lang';
import { useAppInfoStore } from '@renderer/stores/app-info';
import { useChatStore } from '@renderer/stores/chat';
import { useProvidersStore } from '@renderer/stores/providers';
import { useSettingsStore } from '@renderer/stores/settings';
import { useVoiceStore } from '@renderer/stores/voice';
import { VoiceSetupModal } from './voice-setup-modal';

/**
 * Mounted once in the app shell. Keeps voice capabilities fresh, reads finished replies aloud when the user
 * asked for that, and hosts the consent dialog.
 */
export function VoiceBridge() {
  const voiceEnabled = useSettingsStore((s) => s.values['voice.enabled']);
  const speakReplies = useSettingsStore((s) => s.values['voice.speakReplies']);
  const uiPreference = useSettingsStore((s) => s.values['language.ui']);
  const osLocale = useAppInfoStore((s) => s.osLocale);
  const providers = useProvidersStore((s) => s.providers);
  const lastCompleted = useChatStore((s) => s.lastCompleted);
  const refresh = useVoiceStore((s) => s.refreshCapabilities);

  // Capabilities depend on consent and on whether an OpenAI key exists.
  useEffect(() => {
    void refresh();
  }, [refresh, voiceEnabled, providers]);

  // Turning voice off ends a hands-free conversation: the microphone must not stay open without consent.
  useEffect(() => {
    if (!voiceEnabled) useVoiceStore.getState().endConversation();
  }, [voiceEnabled]);

  useEffect(() => {
    // In a hands-free conversation every reply is spoken, whatever the "read replies aloud" setting says: the
    // person is talking, not reading.
    const wantsSpeech = speakReplies || useVoiceStore.getState().conversation;
    if (!lastCompleted || !voiceEnabled || !wantsSpeech) return;
    const uiLanguage = resolveUiLocale(uiPreference, osLocale) === 'bn' ? 'bn' : 'en';
    const language = textLang(lastCompleted.content) ?? uiLanguage;
    void useVoiceStore.getState().speak(lastCompleted.content, language);
    // Only a *new* finished reply is read aloud; toggling the setting must not replay the last one.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the message id on purpose
  }, [lastCompleted?.id]);

  return <VoiceSetupModal />;
}
