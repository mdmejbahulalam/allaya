/**
 * Secret redaction. Applied to everything that is logged or written to the audit
 * log/diagnostics export: API keys, tokens, passwords, and authorization headers
 * must never be persisted or displayed.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /^(?:.*(?:api[_-]?key|apikey|secret|password|passwd|passphrase|token|authorization|cookie|credential|private[_-]?key|session[_-]?id).*)$/i;

/** Values that look like credentials regardless of the key they are stored under. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bsk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\bgsk_[A-Za-z0-9]{16,}/g, // Groq
  /\bxai-[A-Za-z0-9]{16,}/g, // xAI
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s]+/gi,
];

export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match, prefix: unknown) =>
      typeof prefix === 'string' && match.startsWith(prefix) && prefix.length < match.length
        ? `${prefix}${REDACTED}`
        : REDACTED,
    );
  }
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Deep-redacts objects/arrays/strings. Never mutates the input; cycle-safe. */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]' as T;
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    } as T;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, seen)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(inner, seen);
  }
  return out as T;
}

/** Shows only a masked hint of a secret, e.g. `sk-a…9f2c`. Never returns the full value. */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}
