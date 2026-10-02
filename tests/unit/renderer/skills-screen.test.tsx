import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_SKILLS } from '@allaya/skills';
import {
  EMPTY_BRAND,
  MAX_CUSTOM_SKILLS,
  type BrandProfile,
  type CustomSkill,
} from '@allaya/validation';
import { SkillsScreen } from '../../../apps/desktop/renderer/src/features/skills/skills-screen';
import { parseKeywords } from '../../../apps/desktop/renderer/src/features/skills/skill-form';
import { useSettingsStore } from '@renderer/stores/settings';
import { useSkillsStore } from '@renderer/stores/skills';
import { useToastStore } from '@renderer/stores/toasts';
import { useUiStore } from '@renderer/stores/ui';
import { renderUi } from '../../helpers/render';

let invoke: ReturnType<typeof vi.fn>;

const catalog = () => ({
  maxCustom: MAX_CUSTOM_SKILLS,
  skills: BUILT_IN_SKILLS.map((s) => ({
    id: s.id,
    category: s.category,
    name: s.name,
    summary: s.summary,
    examples: s.examples,
    usesBrand: s.usesBrand === true,
  })),
});

/** The main process, as far as this screen can tell: the catalogue, settings and the two checked saves. */
function bridge(handlers: Record<string, (p: never) => unknown> = {}) {
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const custom = handlers[channel];
    if (custom) {
      const value = await custom(payload as never);
      if (value && typeof value === 'object' && '__error' in value) {
        return { ok: false, error: value.__error };
      }
      return { ok: true, data: value };
    }
    const values = useSettingsStore.getState().values;
    switch (channel) {
      case 'skills:catalog':
        return { ok: true, data: catalog() };
      case 'settings:set': {
        const { key, value } = payload as { key: string; value: unknown };
        return { ok: true, data: { ...values, [key]: value } };
      }
      case 'settings:getAll':
        return { ok: true, data: values };
      case 'skills:saveCustom': {
        const input = payload as Omit<CustomSkill, 'id'> & { id?: string };
        const saved: CustomSkill = { ...input, id: input.id ?? 'custom-aaaa1111' };
        const list = values['skills.custom'];
        useSettingsStore.setState({
          values: {
            ...values,
            'skills.custom': list.some((s) => s.id === saved.id)
              ? list.map((s) => (s.id === saved.id ? saved : s))
              : [...list, saved],
          },
        });
        return { ok: true, data: saved };
      }
      case 'skills:deleteCustom': {
        const { id } = payload as { id: string };
        useSettingsStore.setState({
          values: {
            ...values,
            'skills.custom': values['skills.custom'].filter((s) => s.id !== id),
          },
        });
        return { ok: true, data: { ok: true } };
      }
      case 'skills:saveBrand':
        useSettingsStore.setState({
          values: { ...values, 'skills.brand': payload as BrandProfile },
        });
        return { ok: true, data: payload };
      default:
        return { ok: true, data: { ok: true } };
    }
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel);
const rejects = (reason: string) => ({
  __error: { code: 'INVALID_INPUT', message: 'no', retryable: false, details: { reason } },
});
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);
const card = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="skill-card"][data-skill="${id}"]`)!;
const mine: CustomSkill = {
  id: 'custom-1',
  name: 'Poems',
  instructions: 'Write short rhyming poems.',
  keywords: ['poem', 'কবিতা'],
};

beforeEach(() => {
  bridge();
  useSkillsStore.setState({ skills: null });
  useUiStore.setState({ route: 'skills', composerDraft: '' });
});

describe('the Skills screen', () => {
  it('lists the built-in skills with what they do and things to try, social media marketing first', async () => {
    renderUi(<SkillsScreen />);
    await screen.findAllByTestId('skill-card');
    const cards = screen.getAllByTestId('skill-card');
    expect(cards).toHaveLength(BUILT_IN_SKILLS.length);
    expect(
      within(cards[0]!).getByRole('heading', { name: 'Social media marketing' }),
    ).toBeVisible();
    expect(within(cards[0]!).getByText(/Posts, captions, hashtags/)).toBeVisible();
    expect(
      within(cards[0]!).getByRole('button', {
        name: /Plan a week of Instagram and Facebook posts/,
      }),
    ).toBeVisible();
    // Every skill starts on.
    for (const c of cards) expect(within(c).getByRole('switch')).toBeChecked();
    expect(screen.getByText(/does not post to any of your accounts/)).toBeVisible();
  });

  it('is in Bengali when the interface is', async () => {
    renderUi(<SkillsScreen />, { settings: { 'language.ui': 'bn' } });
    await screen.findAllByTestId('skill-card');
    expect(
      within(card('social-media-marketing')).getByRole('heading', {
        name: 'সোশ্যাল মিডিয়া মার্কেটিং',
      }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'আপনার দক্ষতা' })).toBeVisible();
    expect(screen.getByText(/আলেয়া লেখে ও পরিকল্পনা করে/)).toBeVisible();
  });

  it('switches one skill off and on, remembering which in the settings', async () => {
    renderUi(<SkillsScreen />);
    await screen.findAllByTestId('skill-card');
    const toggle = within(card('content-writing')).getByRole('switch');
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(calls('settings:set').at(-1)![1]).toEqual({
        key: 'skills.disabled',
        value: ['content-writing'],
      }),
    );
    expect(toggle).not.toBeChecked();
    expect(
      within(card('content-writing')).getByRole('button', { name: /Write a 600-word/ }),
    ).toBeDisabled();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(calls('settings:set').at(-1)![1]).toEqual({ key: 'skills.disabled', value: [] }),
    );
    expect(toggle).toBeChecked();
  });

  it('the main switch turns every skill off, says so, and keeps their own choices', async () => {
    renderUi(<SkillsScreen />, {
      settings: { 'skills.enabled': false, 'skills.disabled': ['content-writing'] },
    });
    await screen.findAllByTestId('skill-card');
    expect(screen.getByRole('status')).toHaveTextContent('Skills are off');
    for (const c of screen.getAllByTestId('skill-card')) {
      expect(within(c).getByRole('switch')).toBeDisabled();
    }
    await userEvent.click(screen.getByRole('switch', { name: 'Use skills' }));
    await waitFor(() =>
      expect(calls('settings:set').at(-1)![1]).toEqual({ key: 'skills.enabled', value: true }),
    );
  });

  it('"try asking" puts the example in the message box and opens the chat — it sends nothing', async () => {
    renderUi(<SkillsScreen />);
    await screen.findAllByTestId('skill-card');
    await userEvent.click(
      within(card('social-media-marketing')).getByRole('button', { name: /three caption options/ }),
    );
    expect(useUiStore.getState().composerDraft).toMatch(/three caption options and hashtags/);
    expect(useUiStore.getState().route).toBe('chat');
    expect(calls('chat:send')).toHaveLength(0);
  });

  it('gives the example in Bengali when the interface is Bengali', async () => {
    renderUi(<SkillsScreen />, { settings: { 'language.ui': 'bn' } });
    await screen.findAllByTestId('skill-card');
    await userEvent.click(
      within(card('social-media-marketing')).getByRole('button', { name: /তিনটি ক্যাপশন/ }),
    );
    expect(useUiStore.getState().composerDraft).toMatch(/[ঀ-৿]/);
  });
});

describe('the brand profile', () => {
  it('is offered on the social media skill only, and starts unset', async () => {
    renderUi(<SkillsScreen />);
    await screen.findAllByTestId('skill-card');
    expect(within(card('social-media-marketing')).getByText(/No brand profile yet/)).toBeVisible();
    expect(within(card('content-writing')).queryByRole('button', { name: 'Set up' })).toBeNull();
  });

  it('is filled in, saved through the checked channel, and shown on the card', async () => {
    renderUi(<SkillsScreen />);
    await screen.findAllByTestId('skill-card');
    await userEvent.click(
      within(card('social-media-marketing')).getByRole('button', { name: 'Set up' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Brand profile' });
    await userEvent.type(within(dialog).getByLabelText('Business or page name'), 'Sweet Corner');
    await userEvent.type(within(dialog).getByLabelText('What it does'), 'A bakery in Dhaka');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Instagram' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Facebook' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Facebook' })); // off again
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('skills:saveBrand')).toHaveLength(1));
    expect(calls('skills:saveBrand')[0]![1]).toEqual({
      ...EMPTY_BRAND,
      businessName: 'Sweet Corner',
      about: 'A bakery in Dhaka',
      platforms: ['instagram'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toasts()).toContain('Brand profile saved.');
    expect(
      within(card('social-media-marketing')).getByText('Brand profile: Sweet Corner'),
    ).toBeVisible();
  });

  it('explains a refusal and stays open: a secret, or text about the rules', async () => {
    let reason = 'looks_secret';
    bridge({ 'skills:saveBrand': () => rejects(reason) });
    renderUi(<SkillsScreen />);
    await screen.findAllByTestId('skill-card');
    await userEvent.click(
      within(card('social-media-marketing')).getByRole('button', { name: 'Set up' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Brand profile' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/looks like a password/);
    reason = 'tries_to_change_rules';
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/cannot change how Allaya asks/),
    );
    expect(screen.getByRole('dialog', { name: 'Brand profile' })).toBeVisible();
  });

  it('can be cleared', async () => {
    renderUi(<SkillsScreen />, {
      settings: { 'skills.brand': { ...EMPTY_BRAND, businessName: 'Sweet Corner' } },
    });
    await screen.findAllByTestId('skill-card');
    await userEvent.click(
      within(card('social-media-marketing')).getByRole('button', { name: 'Edit' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Brand profile' });
    expect(within(dialog).getByLabelText('Business or page name')).toHaveValue('Sweet Corner');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(calls('skills:saveBrand')[0]![1]).toEqual(EMPTY_BRAND));
  });
});

describe('skills of your own', () => {
  const open = async () => {
    await screen.findAllByTestId('skill-card');
    await userEvent.click(screen.getAllByRole('button', { name: 'New skill' })[0]!);
    return screen.findByRole('dialog', { name: 'New skill' });
  };
  const fill = async (dialog: HTMLElement, name: string, how: string, words: string) => {
    await userEvent.type(within(dialog).getByLabelText('Name'), name);
    await userEvent.type(within(dialog).getByLabelText('How should Allaya do it?'), how);
    await userEvent.type(within(dialog).getByLabelText('Words that bring it in'), words);
  };

  it('starts with a plain empty state', async () => {
    renderUi(<SkillsScreen />);
    expect(await screen.findByText('No skills of your own yet')).toBeVisible();
    expect(screen.getByText('0 of 10 skills of your own')).toBeVisible();
  });

  it('asks for what is missing before sending anything', async () => {
    renderUi(<SkillsScreen />);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      within(dialog)
        .getAllByRole('alert')
        .map((a) => a.textContent),
    ).toEqual(['Give the skill a name.', 'Say how you want it done.', 'Add at least one word.']);
    expect(calls('skills:saveCustom')).toHaveLength(0);
  });

  it('is written, saved with its words split apart, listed, and can be switched off', async () => {
    renderUi(<SkillsScreen />);
    const dialog = await open();
    await fill(dialog, 'Poems', 'Write short rhyming poems.', 'poem, কবিতা , ,Poem');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('skills:saveCustom')).toHaveLength(1));
    expect(calls('skills:saveCustom')[0]![1]).toEqual({
      name: 'Poems',
      instructions: 'Write short rhyming poems.',
      keywords: ['poem', 'কবিতা'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = await screen.findByTestId('custom-skill');
    expect(within(row).getByRole('heading', { name: 'Poems' })).toBeVisible();
    expect(within(row).getByText('Used when you mention: poem, কবিতা')).toBeVisible();
    expect(toasts()).toContain('“Poems” saved.');
    await userEvent.click(within(row).getByRole('switch', { name: 'Use “Poems”' }));
    await waitFor(() =>
      expect(calls('settings:set').at(-1)![1]).toEqual({
        key: 'skills.disabled',
        value: ['custom-1'.replace('1', 'aaaa1111')],
      }),
    );
  });

  it('explains each refusal and stays open', async () => {
    let reason = 'looks_secret';
    bridge({ 'skills:saveCustom': () => rejects(reason) });
    renderUi(<SkillsScreen />);
    const dialog = await open();
    await fill(dialog, 'Poems', 'text', 'poem');
    const expectMessage = async (re: RegExp) => {
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(re));
    };
    await expectMessage(/looks like a password, key or card number/);
    reason = 'tries_to_change_rules';
    await expectMessage(/cannot change how Allaya asks for permission/);
    reason = 'duplicate_name';
    await expectMessage(/already have a skill with that name/);
    reason = 'too_many';
    await expectMessage(/reached the limit/);
    expect(screen.getByRole('dialog', { name: 'New skill' })).toBeVisible();
  });

  it('is edited in place, keeping its id', async () => {
    renderUi(<SkillsScreen />, { settings: { 'skills.custom': [mine] } });
    await screen.findAllByTestId('skill-card');
    await userEvent.click(screen.getByRole('button', { name: 'Edit “Poems”' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit skill' });
    expect(within(dialog).getByLabelText('Words that bring it in')).toHaveValue('poem, কবিতা');
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Poetry');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('skills:saveCustom')).toHaveLength(1));
    expect(calls('skills:saveCustom')[0]![1]).toMatchObject({ id: 'custom-1', name: 'Poetry' });
    expect(await screen.findByRole('heading', { name: 'Poetry' })).toBeVisible();
  });

  it('is deleted only after asking', async () => {
    renderUi(<SkillsScreen />, { settings: { 'skills.custom': [mine] } });
    await screen.findAllByTestId('skill-card');
    await userEvent.click(screen.getByRole('button', { name: 'Delete “Poems”' }));
    expect(
      await screen.findByText(/Delete “Poems”\? Allaya will no longer use it\./),
    ).toBeVisible();
    expect(calls('skills:deleteCustom')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Delete skill' }));
    await waitFor(() => expect(calls('skills:deleteCustom')).toHaveLength(1));
    expect(calls('skills:deleteCustom')[0]![1]).toEqual({ id: 'custom-1' });
    await waitFor(() => expect(screen.queryByTestId('custom-skill')).toBeNull());
    expect(toasts()).toContain('“Poems” deleted.');
  });

  it('cannot add past the limit', async () => {
    const many = Array.from({ length: MAX_CUSTOM_SKILLS }, (_, i) => ({
      ...mine,
      id: `custom-${i}`,
      name: `S${i}`,
    }));
    renderUi(<SkillsScreen />, { settings: { 'skills.custom': many } });
    await screen.findAllByTestId('skill-card');
    expect(screen.getByRole('button', { name: 'New skill' })).toBeDisabled();
    expect(screen.getByText('10 of 10 skills of your own')).toBeVisible();
  });
});

describe('keywords as typed', () => {
  it('are trimmed, without blanks or repeats (in any case), and within the limits', () => {
    expect(parseKeywords('poem, কবিতা , ,Poem')).toEqual(['poem', 'কবিতা']);
    expect(parseKeywords('a\nb،c')).toEqual(['a', 'b', 'c']);
    expect(parseKeywords('')).toEqual([]);
    expect(parseKeywords(Array.from({ length: 30 }, (_, i) => `w${i}`).join(','))).toHaveLength(12);
    expect(parseKeywords('x'.repeat(100))[0]).toHaveLength(40);
  });
});
