import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionView } from '@lite/shared/ipc';
import { GeneralPanel } from '@lite/renderer/src/settings/general-panel';
import { ProvidersPanel } from '@lite/renderer/src/settings/providers-panel';
import { SettingsView } from '@lite/renderer/src/settings/settings-view';
import { useAppStore } from '@lite/renderer/src/stores/app';
import { useConnectionsStore } from '@lite/renderer/src/stores/connections';
import { bridge, fail, model, renderLite, resetStores } from './helpers';

const connection = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: 'c1',
  presetId: 'anthropic',
  kind: 'anthropic',
  name: 'Anthropic (Claude)',
  hasKey: true,
  keyHint: 'sk-…ABCD',
  keyOptional: false,
  manualModels: [],
  ...over,
});

beforeEach(() => {
  resetStores();
  bridge();
});

describe('adding an AI service', () => {
  const open = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Add a service' }));
  };

  it('finds a service by name among all the choices', async () => {
    renderLite(<ProvidersPanel />);
    await open();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(15);
    await userEvent.type(screen.getByRole('textbox', { name: 'Find a service' }), 'groq');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await userEvent.clear(screen.getByRole('textbox', { name: 'Find a service' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Find a service' }), 'zzzz');
    expect(screen.getByText('No service matches “zzzz”.')).toBeVisible();
  });

  it('sends the key and the choice, then shows the service and tells the screen to look again', async () => {
    const invoke = bridge({
      'connections:add': () => connection({ name: 'Groq', kind: 'compatible', presetId: 'groq' }),
      'connections:list': () => [
        connection({ name: 'Groq', kind: 'compatible', presetId: 'groq' }),
      ],
      'models:list': () => ({ models: [model()], problems: [] }),
    });
    useConnectionsStore.setState({ connections: [] });
    renderLite(<ProvidersPanel />);
    expect(screen.getByText('Nothing connected yet.')).toBeVisible();
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Groq' }));
    // A known service needs only its key; the address is already known and shown to be changed if needed.
    expect(screen.getByLabelText('Address', { exact: true })).toHaveValue(
      'https://api.groq.com/openai/v1',
    );
    await userEvent.type(screen.getByLabelText('API key'), 'gsk_my_secret_key');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('“Groq” connected.')).toBeVisible());
    expect(invoke).toHaveBeenCalledWith('connections:add', {
      presetId: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_my_secret_key',
    });
    expect(screen.getByTestId('connection')).toHaveTextContent('Groq');
    expect(document.body.textContent).not.toContain('gsk_my_secret_key');
  });

  it('a model on this computer needs no key, and says so', async () => {
    const invoke = bridge({ 'connections:add': () => connection({ name: 'Ollama' }) });
    renderLite(<ProvidersPanel />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Ollama (on this computer)' }));
    expect(screen.getByText('Not needed for a model on this computer.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('connections:add', {
        presetId: 'ollama',
        name: 'Ollama (on this computer)',
        baseUrl: 'http://localhost:11434/v1',
      }),
    );
  });

  it('any other address needs a name, and may list model names by hand', async () => {
    const invoke = bridge({ 'connections:add': () => connection({ name: 'Mine' }) });
    renderLite(<ProvidersPanel />);
    await open();
    await userEvent.click(
      screen.getByRole('button', { name: 'Any other (OpenAI-compatible address)' }),
    );
    await userEvent.type(screen.getByLabelText('Name', { exact: true }), 'Mine');
    await userEvent.type(
      screen.getByLabelText('Address', { exact: true }),
      'https://llm.example.com/v1',
    );
    await userEvent.type(screen.getByLabelText('API key'), 'abcdefgh12345');
    await userEvent.type(
      screen.getByLabelText('Model names (optional)'),
      'a-model, b-model,, a-model',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('connections:add', {
        presetId: 'custom',
        name: 'Mine',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'abcdefgh12345',
        manualModels: ['a-model', 'b-model'],
      }),
    );
  });

  it.each([
    ['key_required', 'This service needs an API key.'],
    ['bad_key', 'That does not look like a valid key. Copy it again, without spaces.'],
    ['insecure_remote', 'Use https:// — a key must not travel over an unencrypted address.'],
    ['empty', 'Enter the address of the service.'],
  ])('explains "%s" in plain words and stays open', async (reason, words) => {
    bridge({
      'connections:add': () => {
        throw fail('INVALID_INPUT', 'no', { reason });
      },
    });
    renderLite(<ProvidersPanel />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Anthropic (Claude)' }));
    await userEvent.type(screen.getByLabelText('API key'), 'whatever-key-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(screen.getByLabelText('API key')).toBeVisible();
  });

  it('explains when the computer cannot store keys safely', async () => {
    bridge({
      'connections:add': () => {
        throw fail('CREDENTIAL_STORAGE_UNAVAILABLE');
      },
    });
    renderLite(<ProvidersPanel />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Anthropic (Claude)' }));
    await userEvent.type(screen.getByLabelText('API key'), 'whatever-key-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Secure storage is not available');
  });

  it('can go back from the form to the choices, and from the choices to the list', async () => {
    renderLite(<ProvidersPanel />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Anthropic (Claude)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(screen.getByRole('textbox', { name: 'Find a service' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(screen.getByRole('button', { name: 'Add a service' })).toBeVisible();
  });
});

describe('the services already connected', () => {
  it('shows each with only a hint of its key, tests it, and says how it went', async () => {
    bridge({
      'connections:test': () => ({ ok: true, latencyMs: 5, modelCount: 12 }),
      'models:list': () => ({ models: [], problems: [] }),
    });
    useConnectionsStore.setState({ connections: [connection()] });
    renderLite(<ProvidersPanel />);
    const card = screen.getByTestId('connection');
    expect(card).toHaveTextContent('Key sk-…ABCD');
    await userEvent.click(within(card).getByRole('button', { name: 'Test' }));
    expect(await within(card).findByText('Connected · 12 models')).toBeVisible();
  });

  it('says why a test failed', async () => {
    bridge({
      'connections:test': () => ({
        ok: false,
        latencyMs: 5,
        errorCode: 'PROVIDER_AUTH_FAILED',
        errorMessage: 'Invalid key',
      }),
    });
    useConnectionsStore.setState({ connections: [connection()] });
    renderLite(<ProvidersPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not connect: Invalid key');
  });

  it('removes one only after asking, and says a local model runs here', async () => {
    const invoke = bridge({
      'connections:list': () => [],
      'models:list': () => ({ models: [], problems: [] }),
    });
    useConnectionsStore.setState({
      connections: [
        connection(),
        connection({
          id: 'c2',
          name: 'Ollama',
          hasKey: false,
          keyHint: undefined,
          keyOptional: true,
          kind: 'compatible',
          baseUrl: 'http://localhost:11434/v1',
        }),
      ],
    });
    renderLite(<ProvidersPanel />);
    const cards = screen.getAllByTestId('connection');
    expect(cards[1]).toHaveTextContent('Runs on this computer');
    await userEvent.click(within(cards[0]!).getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove “Anthropic (Claude)” and its key?')).toBeVisible();
    expect(invoke).not.toHaveBeenCalledWith('connections:remove', expect.anything());
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('connections:remove', { id: 'c1' }));
  });

  it('changes a key without showing the old one, and keeps the old one when left empty', async () => {
    const invoke = bridge({
      'connections:update': () => connection(),
      'connections:list': () => [connection()],
      'models:list': () => ({ models: [], problems: [] }),
    });
    useConnectionsStore.setState({ connections: [connection()] });
    renderLite(<ProvidersPanel />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('New API key (leave empty to keep the current one)')).toHaveValue(
      '',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('connections:update', {
        id: 'c1',
        name: 'Anthropic (Claude)',
        manualModels: [],
      }),
    );
    expect(await screen.findByText('Saved.')).toBeVisible();
  });
});

describe('the general settings', () => {
  it('saves the language and the look as soon as they are chosen', async () => {
    const invoke = bridge({
      'settings:set': (p) => ({ ...useAppStore.getState().settings, ...(p as object) }),
    });
    renderLite(<GeneralPanel />);
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'bn');
    expect(invoke).toHaveBeenCalledWith('settings:set', { language: 'bn' });
    await userEvent.selectOptions(screen.getByLabelText('Appearance'), 'light');
    expect(invoke).toHaveBeenCalledWith('settings:set', { theme: 'light' });
    expect(useAppStore.getState().settings).toMatchObject({ language: 'bn', theme: 'light' });
  });

  it('saves the name and the instructions when the person leaves the box, and only if changed', async () => {
    const invoke = bridge({
      'settings:set': (p) => ({ ...useAppStore.getState().settings, ...(p as object) }),
    });
    renderLite(<GeneralPanel />);
    await userEvent.click(screen.getByLabelText('Your name'));
    await userEvent.tab();
    expect(invoke).not.toHaveBeenCalledWith('settings:set', expect.anything());
    await userEvent.type(screen.getByLabelText('Your name'), '  Babul ');
    await userEvent.type(screen.getByLabelText('Your instructions'), 'Short answers');
    await userEvent.tab();
    expect(invoke).toHaveBeenCalledWith('settings:set', { userName: 'Babul' });
    expect(invoke).toHaveBeenCalledWith('settings:set', { instructions: 'Short answers' });
  });

  it('puts a failed save back as it was', async () => {
    bridge({
      'settings:set': () => {
        throw fail('INVALID_INPUT');
      },
    });
    renderLite(<GeneralPanel />);
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'bn');
    expect(await screen.findByRole('status')).toHaveTextContent('Could not save that.');
    expect(useAppStore.getState().settings.language).toBe('auto');
  });
});

describe('the settings screen', () => {
  it('has the two tabs, switches between them and goes back to the chat', async () => {
    renderLite(<SettingsView />);
    expect(screen.getByRole('tab', { name: 'AI services', selected: true })).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(useAppStore.getState().settingsTab).toBe('general');
    await userEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(useAppStore.getState().route).toBe('chat');
  });
});
