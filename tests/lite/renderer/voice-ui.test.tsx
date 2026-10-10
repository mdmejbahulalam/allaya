import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechEngine, VoiceOptions } from '@lite/shared/ipc';
import { Composer } from '@lite/renderer/src/components/composer';
import { VoiceBar } from '@lite/renderer/src/components/voice-bar';
import { VoicePanel } from '@lite/renderer/src/settings/voice-panel';
import { useAppStore } from '@lite/renderer/src/stores/app';
import { useConnectionsStore } from '@lite/renderer/src/stores/connections';
import { resetVoiceForTests, useVoiceStore } from '@lite/renderer/src/stores/voice';
import { bridge, renderLite, resetStores } from './helpers';

beforeEach(() => {
  resetStores();
  resetVoiceForTests();
  bridge();
});

describe('the voice bar', () => {
  it('shows nothing when there is nothing to say', () => {
    renderLite(<VoiceBar />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says what the conversation is doing, in order, and always offers the way out', async () => {
    const end = vi.fn();
    renderLite(<VoiceBar />);
    const set = (patch: object) => useVoiceStore.setState({ active: true, end, ...patch } as never);
    set({ state: 'listening' });
    expect(await screen.findByRole('status')).toHaveTextContent('Listening… speak now');
    for (const [state, words] of [
      ['transcribing', 'Understanding what you said…'],
      ['thinking', 'Thinking…'],
      ['speaking', 'Speaking…'],
    ] as const) {
      set({ state });
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(words));
    }
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    expect(end).toHaveBeenCalled();
  });

  it('offers to skip only while a reply is being read', async () => {
    const skip = vi.fn();
    renderLite(<VoiceBar />);
    useVoiceStore.setState({ active: true, state: 'thinking', skip } as never);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull());
    useVoiceStore.setState({ state: 'speaking' });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    expect(skip).toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'mic', reason: 'permission_denied' }, 'The microphone is blocked.'],
    [{ kind: 'mic', reason: 'no_microphone' }, 'No microphone was found.'],
    [{ kind: 'speech_failed' }, 'The reply could not be read aloud. It is on the screen.'],
    [{ kind: 'idle' }, 'I stopped listening because it was quiet for a while.'],
    [{ kind: 'error', code: 'PROVIDER_AUTH_FAILED' }, 'did not accept the key'],
  ])('explains in words why voice is not going: %j', async (notice, words) => {
    renderLite(<VoiceBar />);
    useVoiceStore.setState({ active: false, state: 'idle', notice: notice as never });
    expect(await screen.findByRole('status')).toHaveTextContent(words);
  });

  it('points to the right place to fix it, and can be dismissed', async () => {
    renderLite(<VoiceBar />);
    useVoiceStore.setState({ notice: { kind: 'no_stt' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect a service' }));
    expect(useAppStore.getState()).toMatchObject({ route: 'settings', settingsTab: 'providers' });
    expect(useVoiceStore.getState().notice).toBeNull();
    useVoiceStore.setState({ notice: { kind: 'no_voice' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Voice settings' }));
    expect(useAppStore.getState().settingsTab).toBe('voice');
    useVoiceStore.setState({ notice: { kind: 'idle' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(useVoiceStore.getState().notice).toBeNull();
  });

  it('is in Bengali when the screen is', async () => {
    renderLite(<VoiceBar />, 'bn');
    useVoiceStore.setState({ active: true, state: 'listening' });
    expect(await screen.findByRole('status')).toHaveTextContent('শুনছি… বলুন');
    expect(screen.getByRole('button', { name: 'কথোপকথন শেষ করুন' })).toBeVisible();
  });
});

describe('the microphone button', () => {
  const setup = (disabled = false) =>
    renderLite(
      <Composer
        busy={false}
        disabled={disabled}
        model={null}
        onModel={() => undefined}
        onSend={() => Promise.resolve()}
        onStop={() => undefined}
        onConnect={() => undefined}
        autoFocusKey={null}
      />,
    );

  it('starts a conversation, and the same button ends it', async () => {
    const toggle = vi.fn();
    useVoiceStore.setState({ toggle } as never);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Talk' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    useVoiceStore.setState({ active: true });
    const ending = await screen.findByRole('button', { name: 'End conversation', pressed: true });
    await userEvent.click(ending);
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('is off when no service is connected', () => {
    setup(true);
    expect(screen.getByRole('button', { name: 'Talk' })).toBeDisabled();
  });
});

describe('the voice settings', () => {
  const engine = (over: Partial<SpeechEngine>): SpeechEngine => ({
    connectionId: 'c1',
    name: 'OpenAI (GPT)',
    stt: true,
    tts: true,
    voices: [
      { id: 'alloy', label: 'alloy' },
      { id: 'nova', label: 'nova' },
    ],
    needsWav: false,
    expressive: false,
    ...over,
  });
  const options = (over: Partial<VoiceOptions> = {}): VoiceOptions => ({
    engines: [engine({})],
    stt: { connectionId: 'c1', needsWav: false },
    tts: null,
    ...over,
  });
  const withOptions = (o: VoiceOptions) =>
    bridge({
      'voice:options': () => o,
      'settings:set': (p) => ({ ...useAppStore.getState().settings, ...(p as object) }),
    });

  it('says plainly when nothing can listen yet', async () => {
    withOptions({ engines: [], stt: null, tts: null });
    renderLite(<VoicePanel />);
    expect(
      await screen.findByText(
        'Nothing can listen yet. Connect OpenAI, Google or Groq in AI services.',
      ),
    ).toBeVisible();
  });

  it('lists what can listen and speak, and says which is used', async () => {
    withOptions(
      options({
        engines: [engine({}), engine({ connectionId: 'c2', name: 'Groq', tts: false, voices: [] })],
      }),
    );
    renderLite(<VoicePanel />);
    expect(await screen.findByText('Listening with OpenAI (GPT).')).toBeVisible();
    const listening = screen.getByLabelText('Listening (speech to text)');
    expect(
      within(listening)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Automatic', 'OpenAI (GPT)', 'Groq']);
    const speaking = screen.getByLabelText('Speaking (text to speech)');
    expect(
      within(speaking)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['This computer’s voice (free)', 'OpenAI (GPT)']);
  });

  it('saves the choice of a speaking service, and shows its voices', async () => {
    const invoke = withOptions(options());
    renderLite(<VoicePanel />);
    await screen.findByText('Listening with OpenAI (GPT).');
    expect(screen.queryByRole('combobox', { name: 'Voice' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Speaking (text to speech)'), 'c1');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', {
        voice: expect.objectContaining({
          ttsEngine: 'service',
          ttsConnectionId: 'c1',
          ttsVoice: '',
        }),
      }),
    );
  });

  it('saves a voice, the language heard, and reading every reply aloud', async () => {
    const invoke = withOptions(
      options({ tts: { connectionId: 'c1', voice: 'alloy', expressive: false } }),
    );
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        voice: {
          ...useAppStore.getState().settings.voice,
          ttsEngine: 'service',
          ttsConnectionId: 'c1',
        },
      },
    });
    renderLite(<VoicePanel />);
    await screen.findByText('Listening with OpenAI (GPT).');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Voice' }), 'nova');
    await userEvent.selectOptions(screen.getByLabelText('Language you speak'), 'bn');
    await userEvent.click(screen.getByRole('switch', { name: /Read every reply aloud/ }));
    const last = (key: string) =>
      invoke.mock.calls
        .filter(([c]) => c === 'settings:set')
        .map(([, p]) => (p as { voice: Record<string, unknown> }).voice[key]);
    await waitFor(() => expect(last('ttsVoice')).toContain('nova'));
    expect(last('inputLanguage')).toContain('bn');
    expect(last('speakReplies')).toContain(true);
  });

  it('a voice that follows direction offers a style box, saved when left', async () => {
    const invoke = withOptions(
      options({
        engines: [engine({ name: 'Google (Gemini)', expressive: true, needsWav: true })],
        tts: { connectionId: 'c1', voice: 'Sulafat', expressive: true },
      }),
    );
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        voice: {
          ...useAppStore.getState().settings.voice,
          ttsEngine: 'service',
          ttsConnectionId: 'c1',
        },
      },
    });
    renderLite(<VoicePanel />);
    const style = await screen.findByLabelText('How it should sound');
    await userEvent.type(style, 'warm and unhurried');
    await userEvent.tab();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('settings:set', {
        voice: expect.objectContaining({ ttsStyle: 'warm and unhurried' }),
      }),
    );
  });

  it('a service with no style support does not show the style box', async () => {
    withOptions(options());
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        voice: {
          ...useAppStore.getState().settings.voice,
          ttsEngine: 'service',
          ttsConnectionId: 'c1',
        },
      },
    });
    renderLite(<VoicePanel />);
    await screen.findByText('Listening with OpenAI (GPT).');
    expect(screen.queryByLabelText('How it should sound')).toBeNull();
  });

  it('refreshes when a service is added', async () => {
    const invoke = withOptions(options());
    renderLite(<VoicePanel />);
    await screen.findByText('Listening with OpenAI (GPT).');
    const before = invoke.mock.calls.filter(([c]) => c === 'voice:options').length;
    useConnectionsStore.setState({
      connections: [
        { id: 'c9', kind: 'google', name: 'G', hasKey: true, keyOptional: false, manualModels: [] },
      ],
    });
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === 'voice:options').length).toBeGreaterThan(
        before,
      ),
    );
  });
});
