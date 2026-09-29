import type { VoiceState } from '@allaya/types';
import { useT } from '@renderer/lib/i18n';
import { cn } from '@renderer/lib/cn';

/**
 * Animated waveform for the voice states. When live microphone `levels` (0..1) are supplied
 * the bars follow real audio; otherwise they animate by state. Motion is disabled globally
 * when the user prefers reduced motion (bars then render at a static height).
 */
export function VoiceVisualizer({
  state,
  levels,
  bars = 24,
  className,
}: {
  state: VoiceState;
  levels?: readonly number[];
  bars?: number;
  className?: string;
}) {
  const t = useT();
  const animated =
    !levels && (state === 'LISTENING' || state === 'SPEAKING' || state === 'PROCESSING');
  const tone =
    state === 'ERROR'
      ? 'bg-danger'
      : state === 'IDLE'
        ? 'bg-line-strong'
        : 'bg-[linear-gradient(to_top,var(--accent),var(--accent-2))]';

  return (
    <div
      role="img"
      aria-label={t.t(`voice.${state}`)}
      className={cn('flex h-12 items-center justify-center gap-[3px]', className)}
    >
      {Array.from({ length: bars }, (_, i) => {
        const shaped = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7)); // deterministic pseudo-random envelope
        const level = levels ? (levels[i % levels.length] ?? 0) : state === 'IDLE' ? 0.12 : shaped;
        return (
          <span
            key={i}
            className={cn(
              'h-full w-1 origin-center rounded-full',
              tone,
              animated && 'animate-wave',
            )}
            style={{
              transform: animated ? undefined : `scaleY(${Math.max(0.12, level)})`,
              animationDelay: animated ? `${(i % 8) * 90}ms` : undefined,
              animationDuration: animated
                ? `${state === 'PROCESSING' ? 1.6 : 0.9 + (i % 5) * 0.08}s`
                : undefined,
              opacity: state === 'IDLE' ? 0.5 : 1,
            }}
          />
        );
      })}
    </div>
  );
}
