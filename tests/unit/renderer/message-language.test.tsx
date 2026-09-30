import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MessageView } from '@allaya/validation';
import {
  AssistantBubble,
  UserBubble,
} from '../../../apps/desktop/renderer/src/features/chat/message-bubble';
import { textLang } from '@renderer/lib/text-lang';
import { renderUi } from '../../helpers/render';

const user = (content: string): MessageView => ({
  id: 'm1',
  conversationId: 'c1',
  kind: 'user',
  content,
  createdAt: 0,
});
const assistant = (content: string): MessageView => ({
  id: 'm2',
  conversationId: 'c1',
  kind: 'assistant',
  content,
  createdAt: 0,
  status: 'complete',
});

describe('message language tagging', () => {
  it('tags text with the language it is written in', () => {
    expect(textLang('আমার Downloads folder টা খুলে দাও')).toBe('bn');
    expect(textLang('amar Downloads folder ta open koro')).toBe('bn');
    expect(textLang('Please open my Downloads folder')).toBe('en');
  });

  it('leaves very short or empty text untagged rather than guessing', () => {
    expect(textLang('')).toBeUndefined();
    expect(textLang('   ')).toBeUndefined();
    expect(textLang('ok')).toBeUndefined();
  });

  it('sets lang on user and assistant bubbles (fonts, shaping and the screen-reader voice depend on it)', () => {
    renderUi(
      <>
        <UserBubble message={user('Chrome খুলে দাও')} />
        <AssistantBubble message={assistant('হয়ে গেছে — Chrome খুলে দিয়েছি।')} />
        <UserBubble message={user('Open Chrome for me please')} />
      </>,
    );
    expect(screen.getByText('Chrome খুলে দাও')).toHaveAttribute('lang', 'bn');
    expect(screen.getByText(/হয়ে গেছে/).closest('[lang]')).toHaveAttribute('lang', 'bn');
    expect(screen.getByText('Open Chrome for me please')).toHaveAttribute('lang', 'en');
  });
});

describe('tone tags in written replies', () => {
  const reply = '[warm] Hello there! [whispers] Use `items[index]` here.';
  it('are hidden when the expressive voice is on — but never inside code', () => {
    renderUi(<AssistantBubble message={assistant(reply)} />, {
      settings: { 'voice.speechEngine': 'gemini', 'voice.expressive': true },
    });
    expect(screen.getByText(/Hello there!/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\[warm\]|\[whispers\]/);
    expect(screen.getByText('items[index]')).toBeInTheDocument();
  });

  it('are left as written when it is off, so a person’s own brackets are never lost', () => {
    renderUi(<AssistantBubble message={assistant(reply)} />, {
      settings: { 'voice.speechEngine': 'system' },
    });
    expect(document.body.textContent).toMatch(/\[warm\] Hello there!/);
    renderUi(<AssistantBubble message={assistant(reply)} />, {
      settings: { 'voice.speechEngine': 'gemini', 'voice.expressive': false },
    });
    expect(document.body.textContent?.match(/\[warm\]/g)).toHaveLength(2);
  });
});
