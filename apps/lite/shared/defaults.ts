import type { Settings } from './ipc';

/** The settings before the person changes anything. Plain data, so the screen can use it without loading the schemas. */
export const settingsDefaults: Settings = {
  language: 'auto',
  theme: 'system',
  userName: '',
  instructions: '',
  defaultModel: null,
};
