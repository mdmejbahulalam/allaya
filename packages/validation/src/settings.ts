import { z } from 'zod';
import { LANGUAGE_PREFERENCES } from '@allaya/types';

/**
 * Registry of every persisted user setting. The renderer can only read/write keys
 * declared here, and each value is validated against its own schema — there is no
 * generic "write anything" channel.
 */
export const settingsSchemas = {
  // General
  'general.startWithWindows': z.boolean(),
  'general.minimizeToTray': z.boolean(),
  'general.showFloatingAssistant': z.boolean(),
  'general.quickActions': z
    .array(
      z.enum(['open_folder', 'open_browser', 'open_app', 'screenshot', 'find_file', 'run_task']),
    )
    .max(12),
  // Appearance
  'appearance.theme': z.enum(['dark', 'light', 'system']),
  'appearance.accent': z.string().regex(/^#[0-9a-fA-F]{6}$/),
  'appearance.density': z.enum(['comfortable', 'compact']),
  'appearance.animations': z.enum(['full', 'reduced', 'system']),
  'appearance.glass': z.boolean(),
  'appearance.sidebar': z.enum(['expanded', 'collapsed']),
  'appearance.sidebarPinned': z.boolean(),
  'appearance.uiScale': z.number().min(0.8).max(1.5),
  // Language
  'language.ui': z.enum(LANGUAGE_PREFERENCES),
  'language.response': z.enum(['auto', 'bn', 'en', 'mixed']),
  'language.numerals': z.enum(['auto', 'bengali', 'latin']),
  // AI / privacy
  'ai.autoRouting': z.boolean(),
  'privacy.screenshotsToProvider': z.enum(['ask', 'never', 'always']),
  'privacy.fileContentsToProvider': z.enum(['ask', 'never', 'always']),
  // Shortcuts
  'shortcuts.commandPalette': z.string().max(64),
  'shortcuts.newTask': z.string().max(64),
  'shortcuts.voice': z.string().max(64),
  'shortcuts.emergencyStop': z.string().max(64),
  'shortcuts.search': z.string().max(64),
  // Onboarding
  'onboarding.completed': z.boolean(),
  'profile.displayName': z.string().trim().max(60),
} as const;

export type SettingKey = keyof typeof settingsSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsSchemas)[K]>;
export type SettingsSnapshot = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(settingsSchemas) as SettingKey[];

export const settingsDefaults: SettingsSnapshot = {
  'general.startWithWindows': false,
  'general.minimizeToTray': true,
  'general.showFloatingAssistant': false,
  'general.quickActions': [
    'open_folder',
    'open_browser',
    'open_app',
    'screenshot',
    'find_file',
    'run_task',
  ],
  'appearance.theme': 'dark',
  'appearance.accent': '#7C5CFF',
  'appearance.density': 'comfortable',
  'appearance.animations': 'system',
  'appearance.glass': true,
  'appearance.sidebar': 'expanded',
  'appearance.sidebarPinned': true,
  'appearance.uiScale': 1,
  'language.ui': 'auto',
  'language.response': 'auto',
  'language.numerals': 'auto',
  'ai.autoRouting': true,
  'privacy.screenshotsToProvider': 'ask',
  'privacy.fileContentsToProvider': 'ask',
  'shortcuts.commandPalette': 'Ctrl+K',
  'shortcuts.newTask': 'Ctrl+N',
  'shortcuts.voice': 'Ctrl+Shift+V',
  'shortcuts.emergencyStop': 'Ctrl+Shift+Escape',
  'shortcuts.search': 'Ctrl+/',
  'onboarding.completed': false,
  'profile.displayName': '',
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(settingsSchemas, key);
}

const settingEntries = SETTING_KEYS.map((key) =>
  z.object({ key: z.literal(key), value: settingsSchemas[key] }),
) as unknown as [
  z.ZodObject<{ key: z.ZodLiteral<SettingKey>; value: z.ZodTypeAny }>,
  ...z.ZodObject[],
];

/** `{ key, value }` where `value` must satisfy that specific key's schema. */
export const settingUpdateSchema = z.union(settingEntries) as unknown as z.ZodType<SettingUpdate>;
export type SettingUpdate = { [K in SettingKey]: { key: K; value: SettingValue<K> } }[SettingKey];
