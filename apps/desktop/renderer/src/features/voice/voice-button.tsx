import { Loader2, Mic, Square, Volume2 } from 'lucide-react';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';
import { useVoiceStore } from '@renderer/stores/voice';
import { IconButton } from '@renderer/components/ui/icon-button';

/**
 * The microphone button. One control, four meanings: start listening, finish listening, stop speaking, and
 * (while transcribing) cancel. Its accessible name always says what pressing it will do.
 */
export function VoiceButton({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const t = useT();
  const state = useVoiceStore((s) => s.state);
  const conversation = useVoiceStore((s) => s.conversation);
  const toggle = useVoiceStore((s) => s.toggle);

  const config = {
    IDLE: { label: t.t('voice.start'), icon: <Mic size={18} /> },
    ERROR: { label: t.t('voice.start'), icon: <Mic size={18} /> },
    LISTENING: {
      label: t.t('voice.stopListening'),
      icon: <Square size={16} fill="currentColor" />,
    },
    PROCESSING: {
      label: t.t('voice.processingLabel'),
      icon: <Loader2 size={18} className="animate-spin" />,
    },
    SPEAKING: { label: t.t('voice.stopSpeaking'), icon: <Volume2 size={18} /> },
  }[state];
  // In a hands-free conversation the button always means "end it".
  const label = conversation ? t.t('voice.endConversation') : config.label;
  const icon = conversation ? <Square size={16} fill="currentColor" /> : config.icon;

  return (
    <IconButton
      label={label}
      icon={icon}
      size={size}
      active={state === 'LISTENING' || conversation}
      onClick={() => void toggle()}
      className={cn(
        (state === 'LISTENING' || conversation) &&
          'bg-danger/15 text-danger-text ring-1 ring-danger/40',
      )}
    />
  );
}
