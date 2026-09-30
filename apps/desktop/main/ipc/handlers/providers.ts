import type { HandlerRegistry } from '../registry';
import type { ProviderService } from '../../services/provider-service';

export function registerProviderHandlers(
  registry: HandlerRegistry,
  providers: ProviderService,
): void {
  registry
    .register('providers:list', () => providers.list())
    .register('providers:setKey', ({ providerId, apiKey }) => providers.setKey(providerId, apiKey))
    .register('providers:setEndpoint', ({ providerId, baseUrl, apiKey }) =>
      providers.setEndpoint(providerId, baseUrl, apiKey),
    )
    .register('providers:removeKey', ({ providerId }) => providers.removeKey(providerId))
    .register('providers:test', ({ providerId }) => providers.test(providerId))
    .register('providers:refreshModels', ({ providerId }) => providers.refreshModels(providerId))
    .register('models:list', () => providers.availableModels().map((m) => ({ ...m })))
    .register('models:getRouting', () => providers.getRouting())
    .register('models:setRouting', (patch) => providers.setRouting(patch));
}
