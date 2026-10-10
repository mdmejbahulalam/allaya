import { IpcError } from '../lib/api';
import type { Translator } from '../i18n';
import { errorText } from './message';

/** Why a task call failed, in words: its own reasons first (already running, too many, a time in the past). */
export function taskErrorText(t: Translator, error: unknown): string {
  if (!(error instanceof IpcError)) return t.t('error.generic');
  const reason = error.details?.['reason'];
  if (typeof reason === 'string') {
    const key = `tasks.err.${reason}`;
    if (t.has(key)) return t.t(key);
  }
  return errorText(t, error);
}

/** Why a run did not finish, in words. */
export function runErrorText(t: Translator, error: { code: string; message: string }): string {
  if (error.code === 'LIMIT_EXCEEDED') return t.t('tasks.err.steps');
  if (error.code === 'CANCELLED') return t.t('tasks.err.interrupted');
  return errorText(t, error);
}
