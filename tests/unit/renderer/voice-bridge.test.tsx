import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageView } from '@allaya/validation';
import { VoiceBridge } from '../../../apps/desktop/renderer/src/features/voice/voice-bridge';
import { useChatStore } from '@renderer/stores/chat';
import { useSettingsStore } from '@renderer/stores/settings';
import { resetVoiceForTests, useVoiceStore } from '@renderer/stores/voice';
import { renderUi } from '../../helpers/render';

const reply = (id: string, content = 'ঠিক আছে।'): MessageView => ({
  id,
  conversationId: 'c1',
  kind: 'assistant',
  content,
  createdAt: 0,
  status: 'complete',
});

let speak: ReturnType<typeof vi.fn>;
let endConversation: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetVoiceForTests();
  window.allaya = {
    invoke: async () => ({
      ok: true,
      data: {
        enabled: true,
        sttAvailable: true,
        sttEngine: 'openai',
        cloudTtsAvailable: true,
        expressiveTtsAvailable: false,
      },
    }),
    subscribe: () => () => undefined,
  } as never;
  speak = vi.fn(async () => undefined);
  endConversation = vi.fn();
  useVoiceStore.setState({ speak, endConversation } as never);
  useChatStore.setState({ lastCompleted: null });
});
afterEach(() => resetVoiceForTests());

const show = (settings: Record<string, unknown>) => renderUi(<VoiceBridge />, { settings });
const finishReply = (id: string) => act(() => useChatStore.setState({ lastCompleted: reply(id) }));

describe('reading replies aloud', () => {
  it('reads a finished reply when "read replies aloud" is on', () => {
    show({ 'voice.enabled': true, 'voice.speakReplies': true });
    finishReply('m1');
    expect(speak).toHaveBeenCalledWith('ঠিক আছে।', 'bn');
  });

  it('does not read it when that is off — and it is not a conversation', () => {
    show({ 'voice.enabled': true, 'voice.speakReplies': false });
    finishReply('m1');
    expect(speak).not.toHaveBeenCalled();
  });

  it('reads every reply in a hands-free conversation, even with "read replies aloud" off', () => {
    show({ 'voice.enabled': true, 'voice.speakReplies': false });
    act(() => useVoiceStore.setState({ conversation: true }));
    finishReply('m1');
    expect(speak).toHaveBeenCalledTimes(1);
    finishReply('m2');
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('never reads out loud when voice is off', () => {
    show({ 'voice.enabled': false, 'voice.speakReplies': true });
    act(() => useVoiceStore.setState({ conversation: true }));
    finishReply('m1');
    expect(speak).not.toHaveBeenCalled();
  });

  it('turning voice off ends a conversation: the microphone must not stay open without consent', () => {
    show({ 'voice.enabled': true });
    endConversation.mockClear();
    act(() => {
      useSettingsStore.setState((s) => ({ values: { ...s.values, 'voice.enabled': false } }));
    });
    expect(endConversation).toHaveBeenCalled();
  });
});
