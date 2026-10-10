import { AllayaError } from '@allaya/shared';
import type { BrowserHost, BrowserState, Bounds } from './host';
import { addressFromInput, SEARCH_URL } from './url';

/**
 * What the screen can ask of the browser. It is the person acting: they may go to any web address (including one on
 * their own network), and what they type that is not an address becomes a search.
 */
export class BrowserService {
  constructor(private readonly host: BrowserHost) {}

  state(): BrowserState {
    return this.host.state();
  }

  /** Go to what was typed: in the current tab, or a first one when none is open. Returns without waiting for the page. */
  go(input: string): void {
    const url = addressFromInput(input);
    if (!url) {
      throw new AllayaError('That is not an address or something to search for', {
        code: 'INVALID_INPUT',
        details: { reason: 'not_an_address' },
      });
    }
    const { activeId } = this.host.state();
    const started = activeId
      ? this.host.navigate(url, { tabId: activeId, by: 'person' })
      : this.host.open(url, { by: 'person' });
    started.catch(() => undefined);
  }

  newTab(input?: string): void {
    const url = (input && addressFromInput(input)) || SEARCH_URL.replace('/?q=', '/');
    this.host.open(url, { by: 'person' }).catch(() => undefined);
  }

  close(id: string): void {
    this.host.close(id);
  }
  activate(id: string): void {
    this.host.activate(id);
  }
  back(id?: string): void {
    this.host.back(id);
  }
  forward(id?: string): void {
    this.host.forward(id);
  }
  reload(id?: string): void {
    this.host.reload(id);
  }
  stop(id?: string): void {
    this.host.stop(id);
  }
  setBounds(bounds: Bounds, visible: boolean): void {
    this.host.setBounds(bounds, visible);
  }
}
