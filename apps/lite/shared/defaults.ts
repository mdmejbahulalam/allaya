import type { Settings } from './ipc';

/** The settings before the person changes anything. Plain data, so the screen can use it without loading the schemas. */
export const settingsDefaults: Settings = {
  notifyTasks: true,
  background: true,
  startWithWindows: false,
  browserTools: true,
  language: 'auto',
  theme: 'system',
  userName: '',
  instructions: '',
  defaultModel: null,
  voice: {
    sttConnectionId: null,
    ttsEngine: 'system',
    ttsConnectionId: null,
    ttsVoice: '',
    ttsStyle: '',
    speakReplies: false,
    inputLanguage: 'auto',
  },
};
