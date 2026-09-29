import type { HandlerRegistry } from '../registry';
import type { BrowserService } from '../../services/browser-service';

export function registerBrowserHandlers(registry: HandlerRegistry, browser: BrowserService): void {
  registry
    .register('browser:getStatus', () => browser.status())
    .register('browser:setDomain', ({ list, domain, present }) =>
      browser.setDomain(list, domain, present),
    )
    .register('browser:openWindow', ({ url }) => browser.openWindow(url))
    .register('browser:close', () => browser.close());
}
