import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceButton } from '../../../apps/desktop/renderer/src/features/voice/voice-button';
import { VoicePanel } from '../../../apps/desktop/renderer/src/features/voice/voice-panel';
import { resetVoiceForTests, useVoiceStore } from '@renderer/stores/voice';
import { renderUi } from '../../helpers/render';

beforeEach(() => resetVoiceForTests());
afterEach(() => resetVoiceForTests());

describe('microphone button', () => {
  it.each([
    ['IDLE', 'Start voice mode'],
    ['ERROR', 'Start voice mode'],
    ['LISTENING', 'Stop listening'],
    ['PROCESSING', 'Transcribing…'],
    ['SPEAKING', 'Stop speaking'],
  ] as const)('is named for what pressing it does while %s', (state, name) => {
    renderUi(<VoiceButton />);
    act(() => useVoiceStore.setState({ state }));
    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('shows a pressed state only while listening', () => {
    renderUi(<VoiceButton />);
    act(() => useVoiceStore.setState({ state: 'LISTENING' }));
    expect(screen.getByRole('button', { name: 'Stop listening' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('voice panel', () => {
  it('renders nothing when voice is idle and there is nothing to show', () => {
    renderUi(<VoicePanel />);
    expect(screen.queryByRole('region', { name: 'Voice' })).toBeNull();
  });

  it('announces listening and lets the user cancel', async () => {
    const interrupt = vi.fn();
    renderUi(<VoicePanel />);
    act(() => useVoiceStore.setState({ state: 'LISTENING', interrupt }));
    expect(screen.getByRole('status')).toHaveTextContent('Listening — speak now, then pause.');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(interrupt).toHaveBeenCalled();
  });

  it('the review card highlights a destructive request and never auto-sends', async () => {
    const confirmReview = vi.fn();
    renderUi(<VoicePanel />);
    act(() =>
      useVoiceStore.setState({
        confirmReview,
        review: { text: 'report.docx ডিলিট করো', confidence: 0.93, reasons: ['destructive'] },
      }),
    );
    expect(
      screen.getByText('This sounds like a delete request, so please confirm it.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Confidence: 93%')).toBeInTheDocument();
    expect(confirmReview).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(confirmReview).toHaveBeenCalledWith('report.docx ডিলিট করো');
  });

  it('shows "confidence unknown" rather than a number when the provider gave none', () => {
    renderUi(<VoicePanel />);
    act(() =>
      useVoiceStore.setState({
        review: { text: 'open chrome', confidence: null, reasons: ['unknown_confidence'] },
      }),
    );
    expect(screen.getByText('Confidence unknown')).toBeInTheDocument();
  });

  it('the review can be edited before sending, and Enter sends (but not mid-IME composition)', async () => {
    const confirmReview = vi.fn();
    renderUi(<VoicePanel />);
    act(() =>
      useVoiceStore.setState({
        confirmReview,
        review: { text: 'open crome', confidence: 0.5, reasons: ['low_confidence'] },
      }),
    );
    const box = screen.getByRole('textbox', { name: 'What I heard' });
    await userEvent.clear(box);
    await userEvent.type(box, 'open chrome{Enter}');
    expect(confirmReview).toHaveBeenCalledWith('open chrome');
  });

  it('localises everything in Bengali, with Bengali digits', () => {
    renderUi(<VoicePanel />, { settings: { 'language.ui': 'bn' } });
    act(() =>
      useVoiceStore.setState({
        review: { text: 'Chrome খুলে দাও', confidence: 0.82, reasons: ['low_confidence'] },
      }),
    );
    expect(screen.getByText('ঠিক শুনেছি তো?')).toBeInTheDocument();
    expect(screen.getByText('নিশ্চয়তা: ৮২%')).toBeInTheDocument();
    expect(screen.getByText('ঠিকমতো শুনেছি কি না নিশ্চিত নই।')).toBeInTheDocument();
  });

  it('shows and dismisses a notice', async () => {
    renderUi(<VoicePanel />);
    act(() => useVoiceStore.setState({ notice: { kind: 'error', code: 'mic_permission_denied' } }));
    expect(screen.getByText(/Microphone access was denied/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Microphone access was denied/)).toBeNull();
  });

  it('falls back to a generic message for an unknown error code', () => {
    renderUi(<VoicePanel />);
    act(() => useVoiceStore.setState({ notice: { kind: 'error', code: 'SOMETHING_ELSE' } }));
    expect(screen.getByText("Voice isn't working right now.")).toBeInTheDocument();
  });
});

describe('a hands-free conversation on screen', () => {
  it('turns the microphone button into "End conversation", whatever the voice is doing', async () => {
    const endConversation = vi.fn();
    renderUi(<VoiceButton />);
    for (const state of ['IDLE', 'LISTENING', 'PROCESSING', 'SPEAKING'] as const) {
      act(() => useVoiceStore.setState({ state, conversation: true, endConversation }));
      expect(screen.getByRole('button', { name: 'End conversation' })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    expect(endConversation).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel up between turns, says what it is waiting for, and always offers the way out', async () => {
    const endConversation = vi.fn();
    renderUi(<VoicePanel />);
    act(() =>
      useVoiceStore.setState({
        state: 'IDLE',
        conversation: true,
        awaitingReply: true,
        endConversation,
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Thinking about your reply…');
    expect(screen.getByText(/hands-free conversation/)).toBeInTheDocument();
    act(() => useVoiceStore.setState({ awaitingReply: false }));
    expect(screen.getByRole('status')).toHaveTextContent('Getting ready to listen…');
    act(() => useVoiceStore.setState({ state: 'LISTENING' }));
    expect(screen.getByRole('status')).toHaveTextContent('Listening — go ahead');
    await userEvent.click(screen.getByRole('button', { name: 'End conversation' }));
    expect(endConversation).toHaveBeenCalledTimes(1);
    // The single-question "Cancel" is not shown: ending is one clear action.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('offers "Skip" only while a reply is being read', async () => {
    const skip = vi.fn();
    renderUi(<VoicePanel />);
    act(() => useVoiceStore.setState({ state: 'LISTENING', conversation: true, skip }));
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    act(() => useVoiceStore.setState({ state: 'SPEAKING' }));
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('says why a conversation ended by itself', () => {
    renderUi(<VoicePanel />);
    act(() =>
      useVoiceStore.setState({
        state: 'IDLE',
        conversation: false,
        notice: { kind: 'conversation_idle' },
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'I stopped listening because it was quiet for a while',
    );
  });

  it('is in Bengali when the interface is', () => {
    renderUi(<VoicePanel />, { settings: { 'language.ui': 'bn' } });
    act(() => useVoiceStore.setState({ state: 'LISTENING', conversation: true }));
    expect(screen.getByRole('button', { name: 'কথোপকথন শেষ করুন' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('শুনছি');
  });
});
