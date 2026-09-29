import { join } from 'node:path';
import { app } from 'electron';

export interface AppPaths {
  userData: string;
  database: string;
  logs: string;
  migrations: string;
  rendererRoot: string;
  preload: string;
}

/**
 * All filesystem locations Allaya owns. `ALLAYA_USER_DATA_DIR` lets automated tests
 * use an isolated profile; it is honoured only for unpackaged builds or when
 * `ALLAYA_E2E=1` is set, so a production install can't be redirected by environment.
 */
export function resolveAppPaths(): AppPaths {
  const override = process.env['ALLAYA_USER_DATA_DIR'];
  if (override && (!app.isPackaged || process.env['ALLAYA_E2E'] === '1')) {
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
