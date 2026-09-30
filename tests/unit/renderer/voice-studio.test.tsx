import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceStudio } from '../../../apps/desktop/renderer/src/features/settings/voice-studio';
import { useToastStore } from '@renderer/stores/toasts';
import { renderUi } from '../../helpers/render';

const speakers: Array<{
  options: Record<string, unknown>;
  speak: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];
let speakImpl: (text: string, lang: string) => Promise<void> = async () => undefined;
vi.mock('@renderer/lib/voice/speaker', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class FakeCloudSpeaker {
    speak = vi.fn((text: string, lang: string) => speakImpl(text, lang));
    stop = vi.fn();
    constructor(readonly options: Record<string, unknown>) {
      speakers.push(this);
    }
  }
  return { ...original, CloudSpeaker: FakeCloudSpeaker };
});

let invoke: ReturnType<typeof vi.fn>;
function bridge(
  models = {
    models: ['gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts'],
    fetched: true,
  },
) {
  invoke = vi.fn(async (channel: string) =>
    channel === 'voice:listSpeechModels' ? { ok: true, data: models } : { ok: true, data: {} },
  );
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}

const change = vi.fn();
const show = (settings: Record<string, unknown> = {}, available = true) =>
  renderUi(<VoiceStudio available={available} onChange={change} />, {
    settings,
  });

beforeEach(() => {
  speakers.length = 0;
  speakImpl = async () => undefined;
  change.mockClear();
  useToastStore.setState({ toasts: [] });
  bridge();
});

describe('the voice studio', () => {
  it('offers thirty voices and marks the chosen one', async () => {
    show({ 'voice.geminiVoice': 'Kore' });
    const group = screen.getByRole('radiogroup', { name: 'Voice' });
    expect(within(group).getAllByRole('radio')).toHaveLength(30);
    expect(within(group).getByRole('radio', { name: /Kore/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /Puck/ })).not.toBeChecked();
    await userEvent.click(within(group).getByRole('radio', { name: /Puck/ }));
    expect(change).toHaveBeenCalledWith('voice.geminiVoice', 'Puck');
  });

  it('lists the models the account can use and saves the choice', async () => {
    show();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('voice:listSpeechModels'));
    expect(await screen.findByText('The models your Google key can use.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Speech model' }));
    await userEvent.click(
      await screen.findByRole('option', { name: 'gemini-2.5-pro-preview-tts' }),
    );
    expect(change).toHaveBeenCalledWith('voice.geminiModel', 'gemini-2.5-pro-preview-tts');
  });

  it('says so when the list is only the default, and does not ask without a key', async () => {
    show({}, false);
    expect(screen.getByRole('status')).toHaveTextContent('Add a Google (Gemini) key');
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByText(/The default model/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('a style preset fills the box and is saved; typing is saved when leaving the box', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Calm' }));
    expect(change).toHaveBeenCalledWith(
      'voice.style',
      expect.stringContaining('Calm and reassuring'),
    );
    const box = screen.getByRole('textbox', { name: 'How should it sound?' });
    expect((box as HTMLTextAreaElement).value).toContain('Calm and reassuring');
    change.mockClear();
    await userEvent.clear(box);
    await userEvent.type(box, '  slow and deep ');
    expect(change).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(change).toHaveBeenCalledWith('voice.style', 'slow and deep');
  });

  it('a tag from the palette goes into the text at the cursor', async () => {
    show();
    const text = screen.getByRole('textbox', { name: 'Text to speak' });
    await userEvent.clear(text);
    await userEvent.type(text, 'Hello');
    await userEvent.click(screen.getByRole('button', { name: '[whispers]' }));
    expect(text).toHaveValue('Hello [whispers] ');
  });

  it('plays a preview with the voice and the style on screen, before anything is saved', async () => {
    show({ 'voice.geminiVoice': 'Kore' });
    await userEvent.type(screen.getByRole('textbox', { name: 'How should it sound?' }), 'brisk');
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(speakers).toHaveLength(1));
    expect(speakers[0]!.options).toMatchObject({ engine: 'gemini', voice: 'Kore', style: 'brisk' });
    expect(speakers[0]!.speak).toHaveBeenCalledWith(expect.stringContaining('[warm]'), 'en');
    // Leaving the style box saved it; playing itself changed no other setting.
    expect(change.mock.calls.map(([key]) => key)).toEqual(['voice.style']);
  });

  it('speaks Bengali text as Bengali', async () => {
    show();
    const text = screen.getByRole('textbox', { name: 'Text to speak' });
    await userEvent.clear(text);
    await userEvent.type(text, 'নমস্কার, আমি আল্লায়া। আপনি কেমন আছেন?');
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(speakers[0]!.speak).toHaveBeenCalledWith(expect.any(String), 'bn'));
  });

  it('can be stopped while it plays, and the button comes back', async () => {
    let finish!: () => void;
    speakImpl = () => new Promise<void>((r) => (finish = r));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    const stop = await screen.findByRole('button', { name: 'Stop' });
    await userEvent.click(stop);
    expect(speakers[0]!.stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    finish();
  });

  it('says so when the preview fails', async () => {
    speakImpl = async () => {
      throw new Error('boom');
    };
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        'Could not play the preview.',
      ),
    );
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('the tone-tag switch is saved', async () => {
    show({ 'voice.expressive': true });
    await userEvent.click(
      screen.getByRole('switch', { name: 'Let Allaya add tone to spoken replies' }),
    );
    expect(change).toHaveBeenCalledWith('voice.expressive', false);
  });
});
