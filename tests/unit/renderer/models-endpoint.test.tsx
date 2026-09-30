import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@allaya/validation';
import { ModelsScreen } from '../../../apps/desktop/renderer/src/features/models/models-screen';
import { connectionState, useProvidersStore } from '@renderer/stores/providers';
import { useToastStore } from '@renderer/stores/toasts';
import { renderUi } from '../../helpers/render';

const provider = (
  over: Partial<ProviderView> & Pick<ProviderView, 'id' | 'name'>,
): ProviderView => ({
  status: 'not_configured',
  setup: 'key',
  models: [],
  ...over,
});
const model = (providerId: ProviderView['id'], modelId: string) => ({
  providerId,
  modelId,
  displayName: modelId,
  tier: 'balanced' as const,
  capabilitySource: 'inferred' as const,
  capabilities: {
    vision: false,
    tools: true,
    streaming: true,
    reasoning: false,
    contextWindow: 8000,
  },
});

let invoke: ReturnType<typeof vi.fn>;
type Handler = (payload: unknown) => unknown;
function bridge(handlers: Record<string, Handler> = {}) {
  invoke = vi.fn(async (channel: string, payload?: unknown) => {
    const handler = handlers[channel];
    if (handler) {
      const out = await handler(payload);
      return out instanceof Error
        ? {
            ok: false,
            error: {
              code: 'INVALID_INPUT',
              message: 'x',
              details: (out as never as { details: object }).details,
            },
          }
        : { ok: true, data: out };
    }
    return { ok: true, data: {} };
  });
  (window as unknown as { allaya: unknown }).allaya = { invoke, subscribe: () => () => undefined };
}
const toasts = () => useToastStore.getState().toasts.map((t) => t.message);
const cardFor = (name: string) =>
  screen.getByRole('heading', { name, level: 3 }).closest('div[class*="flex-col"]') as HTMLElement;

beforeEach(() => {
  bridge();
  useToastStore.setState({ toasts: [] });
  useProvidersStore.setState({
    providers: [
      provider({ id: 'groq', name: 'Groq' }),
      provider({ id: 'ollama', name: 'Ollama (this computer)', setup: 'endpoint' }),
      provider({ id: 'custom', name: 'Custom (OpenAI-compatible)', setup: 'endpoint' }),
    ],
    routing: { autoRouting: true, assignments: {} },
    loaded: true,
  });
});

describe('providers set up with an address', () => {
  it('a key-based provider still asks for a key; an address-based one asks for an address', async () => {
    renderUi(<ModelsScreen />);
    expect(within(cardFor('Groq')).getByRole('button', { name: /API key/ })).toBeInTheDocument();
    const ollama = cardFor('Ollama (this computer)');
    expect(within(ollama).queryByText('API key')).not.toBeInTheDocument();
    await userEvent.click(within(ollama).getByRole('button', { name: 'Set up' }));
    expect(
      await screen.findByRole('dialog', { name: 'Connect Ollama (this computer)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue(
      'http://localhost:11434/v1',
    );
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  });

  it('sends the address, and the key only if one was typed', async () => {
    bridge({
      'providers:setEndpoint': () =>
        provider({
          id: 'ollama',
          name: 'Ollama (this computer)',
          setup: 'endpoint',
          status: 'connected',
          keyless: true,
          baseUrl: 'http://localhost:11434/v1',
        }),
    });
    renderUi(<ModelsScreen />);
    await userEvent.click(
      within(cardFor('Ollama (this computer)')).getByRole('button', { name: 'Set up' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('providers:setEndpoint', {
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
      }),
    );
    await waitFor(() => expect(toasts()).toContain('Ollama (this computer) connected'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('sends a typed key, and clears it from the form', async () => {
    renderUi(<ModelsScreen />);
    await userEvent.click(
      within(cardFor('Custom (OpenAI-compatible)')).getByRole('button', { name: 'Set up' }),
    );
    await userEvent.clear(await screen.findByRole('textbox', { name: 'Address' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Address' }),
      'https://api.example.com/v1',
    );
    await userEvent.type(screen.getByLabelText('API key (optional)'), 'token-0123456789');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('providers:setEndpoint', {
        providerId: 'custom',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'token-0123456789',
      }),
    );
  });

  it.each([
    ['insecure_remote', /Only a server on this computer can use http/],
    ['credentials', /Remove the user name and password/],
    ['query', /Remove everything after a \?/],
    ['scheme', /must start with http/],
  ])('says why an address was refused (%s)', async (reason, text) => {
    bridge({
      'providers:setEndpoint': () => Object.assign(new Error('refused'), { details: { reason } }),
    });
    renderUi(<ModelsScreen />);
    await userEvent.click(
      within(cardFor('Custom (OpenAI-compatible)')).getByRole('button', { name: 'Set up' }),
    );
    await userEvent.clear(await screen.findByRole('textbox', { name: 'Address' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Address' }), 'http://example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // stays open so it can be corrected
  });

  it('a connected local server shows its address and models, and can be changed or disconnected', async () => {
    useProvidersStore.setState({
      providers: [
        provider({
          id: 'ollama',
          name: 'Ollama (this computer)',
          setup: 'endpoint',
          status: 'connected',
          keyless: true,
          baseUrl: 'http://localhost:11434/v1',
          models: [model('ollama', 'qwen2.5:7b'), model('ollama', 'llama3.2:3b')],
        }),
      ],
    });
    renderUi(<ModelsScreen />);
    const card = cardFor('Ollama (this computer)');
    expect(within(card).getByText('http://localhost:11434/v1')).toBeInTheDocument();
    expect(within(card).getByText(/qwen2.5:7b/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Change' }));
    expect(await screen.findByRole('textbox', { name: 'Address' })).toHaveValue(
      'http://localhost:11434/v1',
    );
  });

  it('its models appear in the choice of model for each kind of task', async () => {
    useProvidersStore.setState({
      providers: [
        provider({
          id: 'ollama',
          name: 'Ollama (this computer)',
          setup: 'endpoint',
          status: 'connected',
          keyless: true,
          baseUrl: 'http://localhost:11434/v1',
          models: [model('ollama', 'qwen2.5:7b')],
        }),
      ],
      routing: { autoRouting: false, assignments: {} },
    });
    renderUi(<ModelsScreen />);
    const [first] = screen.getAllByRole('combobox');
    await userEvent.click(first!);
    expect(await screen.findByRole('option', { name: /qwen2.5:7b/ })).toBeInTheDocument();
  });
});

describe('the connection indicator', () => {
  it('counts a keyless local server that is set up but not answering', () => {
    expect(
      connectionState([
        provider({ id: 'ollama', name: 'O', setup: 'endpoint', status: 'error', keyless: true }),
      ]),
    ).toBe('ai_offline');
    expect(connectionState([provider({ id: 'ollama', name: 'O', setup: 'endpoint' })])).toBe(
      'not_configured',
    );
  });
});
