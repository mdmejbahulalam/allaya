import { spawn } from 'node:child_process';
import { AllayaError, redactString } from '@allaya/shared';

export interface ScriptRunner {
  /** Runs a constant PowerShell program with JSON arguments and returns its stdout. */
  run(
    script: string,
    args: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal | undefined },
  ): Promise<string>;
}

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STDERR = 4096;
/** Windows caps a command line at 32,767 characters; `-EncodedCommand` is base64 of UTF-16, so leave headroom. */
export const MAX_ENCODED_LENGTH = 30_000;

/** The exact command-line arguments used to run `script`. Exposed so tests can prove the script is constant. */
export function powershellArguments(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length > MAX_ENCODED_LENGTH) {
    throw new AllayaError('Internal error: the PowerShell program is too large to run', {
      code: 'INTERNAL',
    });
  }
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded,
  ];
}

/** Runs scripts with Windows PowerShell 5.1 (present on every supported Windows). */
export class PowerShellRunner implements ScriptRunner {
  constructor(private readonly executable = 'powershell.exe') {}

  run(
    script: string,
    args: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    return new Promise<string>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new AllayaError('cancelled', { code: 'CANCELLED' }));
        return;
      }
      const child = spawn(this.executable, powershellArguments(script), {
        // The data channel: JSON in an environment variable, parsed by ConvertFrom-Json. Never part of the code.
        env: { ...process.env, ALLAYA_ARGS: JSON.stringify(args ?? null) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        child.kill();
        finish(() => reject(new AllayaError('cancelled', { code: 'CANCELLED' })));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() =>
          reject(
            new AllayaError('The Windows helper took too long to respond', {
              code: 'TIMEOUT',
              retryable: true,
            }),
          ),
        );
      }, timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR) stderr += chunk;
      });
      child.on('error', (error) =>
        finish(() =>
          reject(
            new AllayaError(`Could not start Windows PowerShell (${redactString(error.message)})`, {
              code: 'UNSUPPORTED_PLATFORM',
            }),
          ),
        ),
      );
      child.on('close', (code) =>
        finish(() =>
          code === 0
            ? resolve(stdout)
            : reject(
                new AllayaError(
                  `The Windows helper failed: ${redactString(stderr.trim().slice(0, 400)) || `exit code ${String(code)}`}`,
                  {
                    code: 'TOOL_EXECUTION_FAILED',
                  },
                ),
              ),
        ),
      );
    });
  }
}
