/**
 * Stable machine-readable error codes. The UI maps these to localized,
 * human-friendly messages — raw technical errors are never the only thing a user sees.
 */
export const ERROR_CODES = [
  'UNKNOWN',
  'INVALID_INPUT',
  'INVALID_IPC_PAYLOAD',
  'UNKNOWN_CHANNEL',
  'UNAUTHORIZED_SENDER',
  'NOT_FOUND',
  'CONFLICT',
  'PERMISSION_DENIED',
  'PERMISSION_REQUIRED',
  'CONFIRMATION_REQUIRED',
  'CONFIRMATION_REJECTED',
  'CANCELLED',
  'TIMEOUT',
  'PATH_NOT_ALLOWED',
  'UNSAFE_PATH',
  'TOOL_NOT_FOUND',
  'TOOL_EXECUTION_FAILED',
  'VERIFICATION_FAILED',
  'UNSUPPORTED_PLATFORM',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'CREDENTIAL_STORAGE_UNAVAILABLE',
  'LOW_CONFIDENCE',
  'DATABASE_ERROR',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AllayaErrorOptions {
  code?: ErrorCode;
  /** Whether repeating the same operation could plausibly succeed. */
  retryable?: boolean;
  /** Safe-to-display structured context (never secrets). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AllayaError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: AllayaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AllayaError';
    this.code = options.code ?? 'UNKNOWN';
    this.retryable = options.retryable ?? false;
    if (options.details) this.details = options.details;
  }
}

export function isAllayaError(value: unknown): value is AllayaError {
  return value instanceof AllayaError;
}

/** Serializable shape that crosses process boundaries (IPC, database, logs). */
export interface SerializedError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function toSerializedError(error: unknown): SerializedError {
  if (isAllayaError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { code: 'CANCELLED', message: 'Operation cancelled', retryable: false };
    }
    return { code: 'UNKNOWN', message: error.message, retryable: false };
  }
  return { code: 'UNKNOWN', message: String(error), retryable: false };
}
