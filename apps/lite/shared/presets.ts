/**
 * The services a person can connect for the model. A "kind" is how Allaya talks to it; most services speak the
 * OpenAI format, so `compatible` covers them all, and any other address can be added by hand.
 */
export const CONNECTION_KINDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'compatible',
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export interface Preset {
  id: string;
  name: string;
  kind: ConnectionKind;
  /** For `compatible`: where the service lives. The person can change it. */
  baseUrl?: string;
  /** A model on this computer needs no key. */
  keyOptional?: boolean;
  /** Where to get a key (shown as text, never opened by the app). */
  keysAt?: string;
  /** Services that do not list their models: the person types the model names. */
  manualModels?: boolean;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    kind: 'anthropic',
    keysAt: 'console.anthropic.com',
  },
  { id: 'openai', name: 'OpenAI (GPT)', kind: 'openai', keysAt: 'platform.openai.com' },
  { id: 'google', name: 'Google (Gemini)', kind: 'google', keysAt: 'aistudio.google.com' },
  {
    id: 'openrouter',
    name: 'OpenRouter (hundreds of models, one key)',
    kind: 'openrouter',
    keysAt: 'openrouter.ai',
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    keysAt: 'console.groq.com',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    keysAt: 'console.mistral.ai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    keysAt: 'platform.deepseek.com',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    kind: 'compatible',
    baseUrl: 'https://api.x.ai/v1',
    keysAt: 'console.x.ai',
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'compatible',
    baseUrl: 'https://api.together.xyz/v1',
    keysAt: 'api.together.xyz',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keysAt: 'fireworks.ai',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    kind: 'compatible',
    baseUrl: 'https://api.perplexity.ai',
    keysAt: 'perplexity.ai/settings/api',
    manualModels: true,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    keysAt: 'cloud.cerebras.ai',
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    kind: 'compatible',
    baseUrl: 'https://api.sambanova.ai/v1',
    keysAt: 'cloud.sambanova.ai',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    kind: 'compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keysAt: 'build.nvidia.com',
  },
  {
    id: 'hyperbolic',
    name: 'Hyperbolic',
    kind: 'compatible',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    keysAt: 'app.hyperbolic.xyz',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    kind: 'compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    keysAt: 'platform.moonshot.ai',
  },
  {
    id: 'ollama',
    name: 'Ollama (on this computer)',
    kind: 'compatible',
    baseUrl: 'http://localhost:11434/v1',
    keyOptional: true,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (on this computer)',
    kind: 'compatible',
    baseUrl: 'http://localhost:1234/v1',
    keyOptional: true,
  },
  { id: 'custom', name: 'Any other (OpenAI-compatible address)', kind: 'compatible', baseUrl: '' },
] as const;

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);
