import { z } from 'zod';
import { noPayload, spec } from './common';
import { settingUpdateSchema, settingsSchemas, SETTING_KEYS, type SettingKey } from '../settings';

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  electronVersion: z.string(),
  chromeVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  osVersion: z.string(),
  arch: z.string(),
  osLocale: z.string(),
  isPackaged: z.boolean(),
  environment: z.enum(['development', 'staging', 'production']),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

const settingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);

export const settingsSnapshotSchema = z.object(
  Object.fromEntries(SETTING_KEYS.map((k) => [k, settingsSchemas[k]])) as {
    [K in SettingKey]: (typeof settingsSchemas)[K];
  },
);

export const appContract = {
  invoke: {
    'app:getInfo': spec(noPayload, appInfoSchema),
    'settings:getAll': spec(noPayload, settingsSnapshotSchema),
    'settings:set': spec(settingUpdateSchema, settingsSnapshotSchema),
    'settings:reset': spec(z.object({ key: settingKeySchema }), settingsSnapshotSchema),
  },
  events: {
    'settings:changed': settingsSnapshotSchema,
    'app:notice': z.object({
      level: z.enum(['info', 'success', 'warning', 'error']),
      message: z.string().max(500),
    }),
  },
} as const;
