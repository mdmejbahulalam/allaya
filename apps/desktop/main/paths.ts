import { join } from 'node:path';
import { app } from 'electron';
import { E2E } from './security/e2e-hooks';

export interface AppPaths {
  userData: string;
  database: string;
  logs: string;
  migrations: string;
  rendererRoot: string;
  preload: string;
}

/**
 * All filesystem locations Allaya owns. `ALLAYA_USER_DATA_DIR` lets automated tests use an isolated
 * profile; it is honoured only by the dedicated `e2e` build (a compile-time flag), so neither a packaged
 * install nor a normal production build can be redirected through the environment.
 */
export function resolveAppPaths(): AppPaths {
  const override = process.env['ALLAYA_USER_DATA_DIR'];
  if (E2E && override) {
    app.setPath('userData', override);
  }
  const userData = app.getPath('userData');
  const outDir = __dirname; // <app>/out/main
  return {
    userData,
    database: join(userData, 'allaya.sqlite'),
    logs: join(userData, 'logs'),
    migrations: app.isPackaged
      ? join(process.resourcesPath, 'migrations')
      : join(outDir, '../../../../packages/database/migrations'),
    rendererRoot: join(outDir, '../renderer'),
    preload: join(outDir, '../preload/index.js'),
  };
}
