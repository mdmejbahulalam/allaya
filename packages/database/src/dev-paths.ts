import { fileURLToPath } from 'node:url';

/**
 * Migrations folder inside the source tree. Used by tests and by `pnpm dev`.
 * Packaged builds ship the folder as an extra resource and pass their own path.
 */
export function sourceMigrationsFolder(): string {
  return fileURLToPath(new URL('../migrations', import.meta.url));
}
