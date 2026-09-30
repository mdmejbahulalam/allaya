import { AllayaError, redactString, type ErrorCode } from '@allaya/shared';
import type { ProviderId } from '@allaya/types';

/** Extracts a human-readable message from the many error-body shapes providers use. */
export function extractProviderMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.slice(0, 500);
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const nested = record['error'];
    if (typeof nested === 'string') return nested.slice(0, 500);
    if (nested && typeof nested === 'object') {
      const message = (nested as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message.slice(0, 500);
    }
    if (typeof record['message'] === 'string') return record['message'].slice(0, 500);
  }
  return undefined;
}

/** Parses a `Retry-After` header (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Maps a failed HTTP response to a typed error. Messages are passed through secret redaction so a
 * provider echoing back part of a key can never reach logs or the UI.
 */
/**
 * Removes the exact secrets a request carried from a piece of text. Pattern redaction cannot know a key whose
 * format it has never seen (many services use plain random strings); a service that echoes the key back in an
 * error message must still not put it on screen or in a log.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  return out;
}

/** The credentials in a request's headers (`Authorization: Bearer …`, `x-api-key`, `x-goog-api-key`). */
export function secretsIn(headers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^(authorization|x-api-key|x-goog-api-key)$/i.test(name)) continue;
    out.push(value.replace(/^Bearer\s+/i, '').trim());
  }
  return out.filter((v) => v.length >= 8);
}

export function httpError(
  provider: ProviderId,
  status: number,
  body: unknown,
  retryAfterMs?: number,
  secrets: readonly string[] = [],
): AllayaError {
  const detail = scrubSecrets(
    redactString(extractProviderMessage(body) ?? `HTTP ${status}`),
    secrets,
  );
  let code: ErrorCode;
  let retryable = false;
  if (status === 401 || status === 403) code = 'PROVIDER_AUTH_FAILED';
  else if (status === 429) {
    code = 'PROVIDER_RATE_LIMITED';
    retryable = true;
  } else if (status === 408 || status === 409 || status >= 500) {
    // 529 is Anthropic's "overloaded".
    code = 'PROVIDER_UNAVAILABLE';
    retryable = true;
  } else code = 'PROVIDER_ERROR';

  return new AllayaError(`${provider}: ${detail}`, {
    code,
    retryable,
    details: { provider, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  });
}

export function networkError(
  provider: ProviderId,
  cause: unknown,
  secrets: readonly string[] = [],
): AllayaError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AllayaError(
    `${provider}: could not reach the service (${scrubSecrets(redactString(message), secrets)})`,
    {
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      details: { provider },
      cause,
    },
  );
}
