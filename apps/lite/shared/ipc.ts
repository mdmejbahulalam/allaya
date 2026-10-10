import { z } from 'zod';
import { MCP_AUTH_KINDS } from './mcp-presets';
import { CONNECTION_KINDS } from './presets';
import { scheduleSchema } from './schedule';

/** Every call between the screen and the app's engine. One list: the preload, the dispatcher and the client derive from it. */

export const ERROR_CODES = [
  'UNKNOWN',
  'INTERNAL',
  'INVALID_INPUT',
  'INVALID_IPC_PAYLOAD',
  'UNKNOWN_CHANNEL',
  'UNAUTHORIZED_SENDER',
  'NOT_FOUND',
  'CANCELLED',
  'TIMEOUT',
  'LIMIT_EXCEEDED',
  'PERMISSION_DENIED',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'CREDENTIAL_STORAGE_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const serializedErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type SerializedError = z.infer<typeof serializedErrorSchema>;

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

export const envelopeSchema = z.object({
  channel: z.string().min(1).max(64),
  payload: z.unknown().optional(),
});

export interface ChannelSpec<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  request: Req;
  response: Res;
}
export const spec = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
): ChannelSpec<Req, Res> => ({ request, response });

const none = z.undefined();
const id = z.string().min(1).max(128);
const ok = z.object({ ok: z.literal(true) });

// ── Settings ────────────────────────────────────────────────────────────────
export const modelRefSchema = z.object({ connectionId: id, modelId: z.string().min(1).max(200) });
export type ModelRef = z.infer<typeof modelRefSchema>;

export const voiceSettingsSchema = z.object({
  /** The service that turns speech into text; null picks the first one that can. */
  sttConnectionId: z.string().max(128).nullable(),
  /** `system` speaks with this computer's own voices; `service` uses a connected AI service's voice. */
  ttsEngine: z.enum(['system', 'service']),
  ttsConnectionId: z.string().max(128).nullable(),
  /** A voice of that service; empty is its default. */
  ttsVoice: z.string().max(60),
  /** How it should sound, in plain words (only some voices follow it). */
  ttsStyle: z.string().max(300),
  /** Read every reply aloud, not only in a spoken conversation. */
  speakReplies: z.boolean(),
  /** The language to expect when listening; `auto` lets the service decide. */
  inputLanguage: z.enum(['auto', 'en', 'bn']),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const settingsSchema = z.object({
  /** Tell the person (a desktop notice) when a task finishes or needs a yes while the window is not in front. */
  notifyTasks: z.boolean(),
  /** Keep running in the tray when the window is closed, so scheduled tasks still run. */
  background: z.boolean(),
  /** Start with Windows (in the tray), so scheduled tasks run without opening the app. */
  startWithWindows: z.boolean(),
  /** Let Allaya use the browser (open pages and read them) when you ask it something. */
  browserTools: z.boolean(),
  language: z.enum(['auto', 'en', 'bn']),
  theme: z.enum(['system', 'dark', 'light']),
  /** What to call the person. */
  userName: z.string().trim().max(60),
  /** The person's standing instructions to the model, added to every chat. */
  instructions: z.string().max(4000),
  /** The model used for a new chat. */
  defaultModel: modelRefSchema.nullable(),
  voice: voiceSettingsSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export { settingsDefaults } from './defaults';

// ── Connections and models ──────────────────────────────────────────────────
export const connectionViewSchema = z.object({
  id,
  presetId: z.string().optional(),
  kind: z.enum(CONNECTION_KINDS),
  name: z.string(),
  baseUrl: z.string().optional(),
  hasKey: z.boolean(),
  keyHint: z.string().optional(),
  keyOptional: z.boolean(),
  manualModels: z.array(z.string()),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;

const modelIdList = z
  .array(
    z
      .string()
      .trim()
      .regex(/^[\w./:@+-]{1,200}$/),
  )
  .max(50);

export const addConnectionSchema = z.object({
  presetId: z.string().max(40),
  /** Only for "any other": the display name. */
  name: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  apiKey: z.string().max(600).optional(),
  manualModels: modelIdList.optional(),
});
export const updateConnectionSchema = z.object({
  id,
  name: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  /** An empty string removes the key. */
  apiKey: z.string().max(600).optional(),
  manualModels: modelIdList.optional(),
});

export const testResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  modelCount: z.number().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
});

export type TestResult = z.infer<typeof testResultSchema>;

export const modelViewSchema = z.object({
  connectionId: id,
  connectionName: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  tier: z.enum(['fast', 'balanced', 'frontier']),
  vision: z.boolean(),
  reasoning: z.boolean(),
  contextWindow: z.number(),
  /** The service said so, or Allaya guessed from the name. */
  inferred: z.boolean(),
});
export type ModelView = z.infer<typeof modelViewSchema>;

export const modelListSchema = z.object({
  models: z.array(modelViewSchema),
  /** Connections whose model list could not be read, and why. */
  problems: z.array(
    z.object({
      connectionId: id,
      connectionName: z.string(),
      code: z.string(),
      message: z.string(),
    }),
  ),
});
export type ModelList = z.infer<typeof modelListSchema>;

// ── Chats ───────────────────────────────────────────────────────────────────
export const stepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  /** One line a person can read: "Read page: example.com". */
  summary: z.string(),
  status: z.enum(['running', 'done', 'error', 'denied']),
  output: z.string().max(4000).optional(),
});
export type Step = z.infer<typeof stepSchema>;

export const messageViewSchema = z.object({
  id,
  chatId: id,
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: z.enum(['complete', 'streaming', 'error', 'cancelled']),
  /** The model's display name, on a reply. */
  model: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  steps: z.array(stepSchema).optional(),
  createdAt: z.number(),
});
export type MessageView = z.infer<typeof messageViewSchema>;

export const chatViewSchema = z.object({
  id,
  title: z.string(),
  model: modelRefSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ChatView = z.infer<typeof chatViewSchema>;

export const MAX_MESSAGE_CHARS = 30_000;

// ── Tasks ───────────────────────────────────────────────────────────────────
export const runViewSchema = z.object({
  id,
  taskId: id,
  taskTitle: z.string(),
  trigger: z.enum(['manual', 'schedule']),
  status: z.enum(['running', 'done', 'error', 'cancelled']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** The model's name. */
  model: z.string(),
  /** The report: what Allaya found or did. */
  result: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  steps: z.array(stepSchema),
});
export type RunView = z.infer<typeof runViewSchema>;

export const TASK_TOOL_GROUPS = ['browser'] as const;

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  /** What to do, in the person's words. */
  instructions: z.string().trim().min(1).max(8000),
  /** The model to use; null uses the default for new chats. */
  model: modelRefSchema.nullable(),
  schedule: scheduleSchema,
  /** Which kinds of tools the task may use. */
  groups: z.array(z.string().max(60)).max(30),
  enabled: z.boolean().optional(),
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export const taskViewSchema = z.object({
  id,
  title: z.string(),
  instructions: z.string(),
  model: modelRefSchema.nullable(),
  schedule: scheduleSchema,
  groups: z.array(z.string()),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  running: z.boolean(),
  /** Made by the person, or proposed by Allaya in a chat and allowed. */
  createdBy: z.enum(['person', 'allaya']),
  createdAt: z.number(),
  lastRun: runViewSchema.nullable(),
});
export type TaskView = z.infer<typeof taskViewSchema>;

export const approvalViewSchema = z.object({
  id,
  /** One line for what Allaya wants to do. */
  summary: z.string(),
  tool: z.string(),
  details: z.string(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), chatId: id }),
    z.object({ kind: z.literal('task'), taskId: id, taskTitle: z.string() }),
  ]),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type ApprovalView = z.infer<typeof approvalViewSchema>;

// ── Connected apps (MCP servers) ─────────────────────────────────────────────
export const MCP_STATUSES = [
  'off',
  'connecting',
  'connected',
  'needs_sign_in',
  'signing_in',
  'error',
] as const;

export const mcpToolSchema = z.object({
  /** As the service names it. */
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  /** Whether Allaya may use it at all. */
  enabled: z.boolean(),
  /** Whether Allaya asks the person before using it. */
  ask: z.boolean(),
  /** What it would do without the person's choice: ask, unless the service is trusted and says the tool only reads. */
  askByDefault: z.boolean(),
});
export type McpToolView = z.infer<typeof mcpToolSchema>;

export const mcpServerViewSchema = z.object({
  id,
  name: z.string(),
  presetId: z.string().nullable(),
  transport: z.enum(['http', 'stdio']),
  url: z.string().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  /** Names of the environment variables given to a program (never the values). */
  envKeys: z.array(z.string()),
  auth: z.enum(MCP_AUTH_KINDS),
  enabled: z.boolean(),
  /** Whether a tool's claim to only read is believed. */
  trusted: z.boolean(),
  status: z.enum(MCP_STATUSES),
  /** Why it is not connected, in words from the program (never a secret). */
  error: z.string().nullable(),
  tools: z.array(mcpToolSchema),
  hasToken: z.boolean(),
  tokenHint: z.string().nullable(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  signedIn: z.boolean(),
  /** The tool group a task is given to use this connection. */
  group: z.string(),
});
export type McpServerView = z.infer<typeof mcpServerViewSchema>;

export const MAX_MCP_ENV = 30;
export const mcpServerInputSchema = z.object({
  presetId: z.string().max(40).nullable().optional(),
  name: z.string().trim().min(1).max(60),
  transport: z.enum(['http', 'stdio']),
  url: z.string().max(300).optional(),
  command: z.string().trim().max(300).optional(),
  args: z.array(z.string().max(500)).max(40).optional(),
  env: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(80),
      z.string().max(4000),
    )
    .refine((env) => Object.keys(env).length <= MAX_MCP_ENV)
    .optional(),
  auth: z.enum(MCP_AUTH_KINDS),
  token: z.string().max(4000).optional(),
  clientId: z.string().max(500).optional(),
  clientSecret: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

// ── Browser ─────────────────────────────────────────────────────────────────
export const tabSchema = z.object({
  id,
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});
export const browserStateSchema = z.object({
  tabs: z.array(tabSchema),
  activeId: z.string().nullable(),
});
export type BrowserState = z.infer<typeof browserStateSchema>;
export type BrowserTab = z.infer<typeof tabSchema>;

// ── Voice ───────────────────────────────────────────────────────────────────
export const MAX_AUDIO_BASE64_CHARS = 28_000_000;
export const MAX_SPEECH_CHARS = 4_000;

export const speechEngineSchema = z.object({
  connectionId: id,
  name: z.string(),
  stt: z.boolean(),
  tts: z.boolean(),
  /** The voices of this service, when it has voices to choose from. */
  voices: z.array(z.object({ id: z.string(), label: z.string() })),
  /** This service reads a plain audio file, not what the microphone records: convert it first. */
  needsWav: z.boolean(),
  /** The voice follows a style note and [tone tags] in the text. */
  expressive: z.boolean(),
});
export type SpeechEngine = z.infer<typeof speechEngineSchema>;

export const voiceOptionsSchema = z.object({
  engines: z.array(speechEngineSchema),
  /** What listening will use right now (the choice, or the first able service), or null if nothing can. */
  stt: z.object({ connectionId: id, needsWav: z.boolean() }).nullable(),
  /** What speaking will use right now: a service, or null for this computer's own voices. */
  tts: z.object({ connectionId: id, voice: z.string(), expressive: z.boolean() }).nullable(),
});
export type VoiceOptions = z.infer<typeof voiceOptionsSchema>;

export const invokeContract = {
  'app:info': spec(
    none,
    z.object({ version: z.string(), platform: z.string(), locale: z.string(), e2e: z.boolean() }),
  ),
  'settings:get': spec(none, settingsSchema),
  'settings:set': spec(settingsSchema.partial(), settingsSchema),

  'connections:list': spec(none, z.array(connectionViewSchema)),
  'connections:add': spec(addConnectionSchema, connectionViewSchema),
  'connections:update': spec(updateConnectionSchema, connectionViewSchema),
  'connections:remove': spec(z.object({ id }), ok),
  'connections:test': spec(z.object({ id }), testResultSchema),
  'models:list': spec(z.object({ refresh: z.boolean().optional() }), modelListSchema),

  'chats:list': spec(none, z.array(chatViewSchema)),
  'chats:get': spec(
    z.object({ id }),
    z.object({ chat: chatViewSchema, messages: z.array(messageViewSchema) }),
  ),
  'chats:create': spec(z.object({ model: modelRefSchema.nullable().optional() }), chatViewSchema),
  'chats:rename': spec(z.object({ id, title: z.string().trim().min(1).max(120) }), chatViewSchema),
  'chats:setModel': spec(z.object({ id, model: modelRefSchema }), chatViewSchema),
  'chats:remove': spec(z.object({ id }), ok),

  'chat:send': spec(
    z.object({
      chatId: id.optional(),
      text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
      model: modelRefSchema.optional(),
    }),
    z.object({ chat: chatViewSchema, userMessage: messageViewSchema, reply: messageViewSchema }),
  ),
  'chat:cancel': spec(z.object({ chatId: id }), ok),

  'tasks:list': spec(none, z.array(taskViewSchema)),
  'tasks:get': spec(
    z.object({ id }),
    z.object({ task: taskViewSchema, runs: z.array(runViewSchema) }),
  ),
  'tasks:create': spec(taskInputSchema, taskViewSchema),
  'tasks:update': spec(z.object({ id, changes: taskInputSchema.partial() }), taskViewSchema),
  'tasks:remove': spec(z.object({ id }), ok),
  /** Run it now, by hand. Returns the run that was started; it goes on in the background. */
  'tasks:run': spec(z.object({ id }), runViewSchema),
  'tasks:cancel': spec(z.object({ runId: id }), ok),
  'approvals:list': spec(none, z.array(approvalViewSchema)),
  'approvals:decide': spec(z.object({ id, allow: z.boolean() }), ok),

  'mcp:list': spec(none, z.array(mcpServerViewSchema)),
  'mcp:add': spec(mcpServerInputSchema, mcpServerViewSchema),
  'mcp:update': spec(
    z.object({ id, changes: mcpServerInputSchema.partial() }),
    mcpServerViewSchema,
  ),
  'mcp:remove': spec(z.object({ id }), ok),
  /** Connect again (after an error, or to test). Resolves when the attempt is over. */
  'mcp:reconnect': spec(z.object({ id }), mcpServerViewSchema),
  /** Sign in on the service's own page, in the person's browser. Resolves when they have finished (or not). */
  'mcp:signIn': spec(z.object({ id }), mcpServerViewSchema),
  'mcp:cancelSignIn': spec(z.object({ id }), ok),
  'mcp:signOut': spec(z.object({ id }), mcpServerViewSchema),
  /** Change how one tool of a connection is used: whether it may be used at all, and whether it asks first. */
  'mcp:setTool': spec(
    z.object({
      id,
      tool: z.string().min(1).max(200),
      ask: z.boolean().optional(),
      enabled: z.boolean().optional(),
    }),
    mcpServerViewSchema,
  ),

  'browser:state': spec(none, browserStateSchema),
  /** Go to an address, or search for words, in the current tab (a first tab if none is open). */
  'browser:go': spec(z.object({ input: z.string().max(2000) }), ok),
  'browser:newTab': spec(z.object({ input: z.string().max(2000).optional() }), ok),
  'browser:close': spec(z.object({ id }), ok),
  'browser:activate': spec(z.object({ id }), ok),
  'browser:back': spec(z.object({ id: id.optional() }), ok),
  'browser:forward': spec(z.object({ id: id.optional() }), ok),
  'browser:reload': spec(z.object({ id: id.optional() }), ok),
  'browser:stop': spec(z.object({ id: id.optional() }), ok),
  /** Where the page is drawn, in window coordinates, and whether the pane is showing. */
  'browser:bounds': spec(
    z.object({
      x: z.number().min(0).max(20_000),
      y: z.number().min(0).max(20_000),
      width: z.number().min(0).max(20_000),
      height: z.number().min(0).max(20_000),
      visible: z.boolean(),
    }),
    ok,
  ),

  'voice:options': spec(none, voiceOptionsSchema),
  'voice:transcribe': spec(
    z.object({
      audio: z.string().min(1).max(MAX_AUDIO_BASE64_CHARS),
      mimeType: z
        .string()
        .regex(/^audio\/[\w.+-]+(;.*)?$/)
        .max(80),
    }),
    z.object({
      text: z.string(),
      language: z.enum(['en', 'bn']).nullable(),
      noSpeech: z.boolean(),
    }),
  ),
  'voice:synthesize': spec(
    z.object({
      text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
      language: z.enum(['en', 'bn']),
      /** Try another service, voice or style without saving it (the settings preview). */
      connectionId: id.optional(),
      voice: z.string().max(60).optional(),
      style: z.string().max(300).optional(),
    }),
    z.object({ audio: z.string(), mimeType: z.enum(['audio/mpeg', 'audio/wav']) }),
  ),
} as const;

export const eventContract = {
  /** A piece of a reply as it is written. */
  'chat:delta': z.object({ chatId: id, messageId: id, text: z.string() }),
  /** A message changed (finished, failed, a step started or ended). */
  'chat:message': messageViewSchema,
  /** The list of chats or their titles changed. */
  'chats:changed': z.object({}),
  'tasks:changed': z.object({}),
  /** A run started, made progress, or ended. */
  'tasks:run': runViewSchema,
  'approvals:changed': z.array(approvalViewSchema),
  'mcp:changed': z.array(mcpServerViewSchema),
  'browser:changed': browserStateSchema,
  /** The browser refused to save a file a page offered. */
  'browser:download-refused': z.object({ filename: z.string().max(300) }),
  'connections:changed': z.object({}),
} as const;

export type InvokeChannel = keyof typeof invokeContract;
export type EventChannel = keyof typeof eventContract;
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.output<
  (typeof invokeContract)[C]['response']
>;
export type EventPayload<E extends EventChannel> = z.output<(typeof eventContract)[E]>;

export const INVOKE_CHANNELS = Object.keys(invokeContract) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(eventContract) as EventChannel[];
export const isInvokeChannel = (c: string): c is InvokeChannel =>
  Object.prototype.hasOwnProperty.call(invokeContract, c);
export const isEventChannel = (c: string): c is EventChannel =>
  Object.prototype.hasOwnProperty.call(eventContract, c);

/** What the preload exposes to the screen as `window.allaya`. */
export interface Bridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...payload: InvokeRequest<C> extends undefined
      ? [payload?: undefined]
      : [payload: InvokeRequest<C>]
  ): Promise<IpcResult<InvokeResponse<C>>>;
  subscribe<E extends EventChannel>(
    channel: E,
    listener: (payload: EventPayload<E>) => void,
  ): () => void;
}
