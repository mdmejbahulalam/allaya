import { AllayaError } from '@allaya/shared';
import { PROVIDER_IDS, type ProviderId } from '@allaya/types';
import type { FetchLike } from './http';
import type { AIProvider, ProviderContext } from './provider';
import { AnthropicProvider } from './providers/anthropic';
import { GoogleProvider } from './providers/google';
import { OpenAIProvider } from './providers/openai';
import { OpenRouterProvider } from './providers/openrouter';
import { OpenAICompatibleVendor, VENDORS } from './providers/vendors';

export interface ProviderFactoryOptions {
  /** Resolves the decrypted key for a provider at call time. Throws PROVIDER_NOT_CONFIGURED when absent. */
  getApiKey: (providerId: ProviderId) => Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  baseUrls?: Partial<Record<ProviderId, string>>;
  /** For providers whose address the person sets. Read at request time; `undefined` means the default. */
  getBaseUrl?: (providerId: ProviderId) => string | undefined;
}

/** Holds provider adapters. Adding a provider means registering another `AIProvider` — nothing else changes. */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  register(provider: AIProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: ProviderId): AIProvider {
    const provider = this.providers.get(id);
    if (!provider)
      throw new AllayaError(`Unknown AI provider: ${id}`, { code: 'PROVIDER_NOT_CONFIGURED' });
    return provider;
  }

  list(): AIProvider[] {
    return PROVIDER_IDS.map((id) => this.providers.get(id)).filter(
      (p): p is AIProvider => p !== undefined,
    );
  }
}

export function createProviderRegistry(options: ProviderFactoryOptions): ProviderRegistry {
  const context = (id: ProviderId): ProviderContext => ({
    getApiKey: () => options.getApiKey(id),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}),
    ...(options.baseUrls?.[id] ? { baseUrl: options.baseUrls[id] } : {}),
    ...(options.getBaseUrl ? { getBaseUrl: () => options.getBaseUrl!(id) } : {}),
  });
  const registry = new ProviderRegistry()
    .register(new AnthropicProvider(context('anthropic')))
    .register(new OpenAIProvider(context('openai')))
    .register(new GoogleProvider(context('google')))
    .register(new OpenRouterProvider(context('openrouter')));
  for (const spec of VENDORS) registry.register(new OpenAICompatibleVendor(spec, context(spec.id)));
  return registry;
}
