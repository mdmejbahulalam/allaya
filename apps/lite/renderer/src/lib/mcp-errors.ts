import { IpcError } from './api';
import type { Translator } from '../i18n';

/** Why adding, changing or signing in to an app failed, in the person's words. */
export function mcpErrorText(t: Translator, error: unknown): string {
  if (error instanceof IpcError) {
    const reason = error.details?.['reason'];
    if (typeof reason === 'string') {
      const key = `apps.err.${reason}`;
      if (t.has(key)) return t.t(key);
    }
    const byCode = `error.${error.code}`;
    if (t.has(byCode)) return t.t(byCode);
  }
  return t.t('apps.err.unknown');
}
