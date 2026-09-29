/**
 * Domain vocabulary shared by every package. Each list is declared once as a
 * `const` tuple so runtime validators (zod) and static types stay in sync.
 */

// ── Security ────────────────────────────────────────────────────────────────
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const PERMISSION_MODES = ['always_allow', 'ask', 'never'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Coarse capability areas the user can grant or deny. */
export const PERMISSION_CATEGORIES = [
  'computer_control',
  'file_access',
  'browser_automation',
  'application_launch',
  'clipboard',
  'microphone',
  'camera',
  'network',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/** Sensitive actions with their own explicit setting, independent of category. */
export const SENSITIVE_ACTIONS = [
  'delete_files',
  'send_email',
  'install_software',
  'administrator_commands',
  'external_communication',
] as const;
export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export const PERMISSION_SUBJECTS = [...PERMISSION_CATEGORIES, ...SENSITIVE_ACTIONS] as const;
export type PermissionSubject = (typeof PERMISSION_SUBJECTS)[number];

export const PERMISSION_DECISIONS = [
  'allowed',
  'allowed_by_user',
  'denied',
  'denied_by_user',
  'not_required',
] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

// ── Tasks / agent ───────────────────────────────────────────────────────────
/** Task lifecycle (§10). */
export const TASK_STATES = [
  'CREATED',
  'ANALYZING',
  'PLANNING',
  'PERMISSION_CHECK',
  'READY',
  'EXECUTING',
  'VERIFYING',
  'COMPLETED',
  'ERROR',
  'RECOVERY',
  'RETRY',
  'WAITING_FOR_USER',
  'PAUSED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Orchestrator-level phase (§9). */
export const AGENT_PHASES = [
  'IDLE',
  'UNDERSTANDING',
  'PLANNING',
  'WAITING_FOR_PERMISSION',
  'EXECUTING',
  'OBSERVING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'PAUSED',
] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export const STEP_STATES = [
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type StepState = (typeof STEP_STATES)[number];

export const TASK_EVENT_TYPES = [
  'TASK_CREATED',
  'TASK_STARTED',
  'PLAN_CREATED',
  'PERMISSION_REQUESTED',
  'PERMISSION_GRANTED',
  'PERMISSION_DENIED',
  'TOOL_STARTED',
  'TOOL_COMPLETED',
  'TOOL_FAILED',
  'OBSERVATION_CREATED',
  'VERIFICATION_STARTED',
  'VERIFICATION_COMPLETED',
  'TASK_PAUSED',
  'TASK_RESUMED',
  'TASK_CANCELLED',
  'TASK_COMPLETED',
  'TASK_FAILED',
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const TASK_SOURCES = ['chat', 'voice', 'palette', 'automation', 'quick_action'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const TASK_COMPLEXITIES = ['trivial', 'simple', 'multi_step', 'complex'] as const;
export type TaskComplexity = (typeof TASK_COMPLEXITIES)[number];

// ── Tools ───────────────────────────────────────────────────────────────────
export const TOOL_CATEGORIES = [
  'computer',
  'files',
  'browser',
  'applications',
  'system',
  'meta',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

// ── Language ────────────────────────────────────────────────────────────────
export const DETECTED_LANGUAGES = [
  'bn',
  'en',
  'bn-BD',
  'en-US',
  'en-GB',
  'mixed-bn-en',
  'romanized-bn',
] as const;
export type DetectedLanguage = (typeof DETECTED_LANGUAGES)[number];

/** What the user picks in settings. */
export const LANGUAGE_PREFERENCES = ['auto', 'bn', 'en'] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

/** Languages the UI and Allaya's replies can actually be rendered in. */
export const RESPONSE_LANGUAGES = ['bn', 'en'] as const;
export type ResponseLanguage = (typeof RESPONSE_LANGUAGES)[number];

// ── AI ──────────────────────────────────────────────────────────────────────
export const PROVIDER_IDS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ROUTING_PURPOSES = [
  'general',
  'coding',
  'reasoning',
  'vision',
  'fast',
  'long_context',
  'agent_planning',
] as const;
export type RoutingPurpose = (typeof ROUTING_PURPOSES)[number];

export const CHAT_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

/** Message kinds the chat UI renders differently (§38). */
export const MESSAGE_KINDS = [
  'user',
  'assistant',
  'task_action',
  'system_status',
  'confirmation',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

// ── Memory ──────────────────────────────────────────────────────────────────
export const MEMORY_CATEGORIES = [
  'personal',
  'preferences',
  'language',
  'applications',
  'tasks',
  'projects',
  'instructions',
  'facts',
  'automation',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_SOURCES = ['user', 'inferred', 'system'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

// ── Voice ───────────────────────────────────────────────────────────────────
export const VOICE_STATES = ['IDLE', 'LISTENING', 'PROCESSING', 'SPEAKING', 'ERROR'] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

// ── Audit ───────────────────────────────────────────────────────────────────
export const ACTORS = ['allaya', 'user', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

export const ACTIVITY_RESULTS = [
  'success',
  'failure',
  'denied',
  'cancelled',
  'pending',
  'info',
] as const;
export type ActivityResult = (typeof ACTIVITY_RESULTS)[number];

export const NOTIFICATION_KINDS = ['success', 'info', 'working', 'warning', 'error'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// ── Intents (language-independent; §132) ───────────────────────────────────
export const INTENT_TYPES = [
  'OPEN_FOLDER',
  'OPEN_FILE',
  'OPEN_APP',
  'CLOSE_APP',
  'FOCUS_APP',
  'FIND_FILES',
  'LIST_DIRECTORY',
  'CREATE_FOLDER',
  'CREATE_FILE',
  'COPY_FILE',
  'MOVE_FILE',
  'RENAME_FILE',
  'DELETE_FILE',
  'TAKE_SCREENSHOT',
  'WEB_SEARCH',
  'OPEN_URL',
  'DOWNLOAD_FILE',
  'UPLOAD_FILE',
  'OPEN_SETTINGS',
  'LOCK_COMPUTER',
  'STOP',
  'CANCEL',
  'SWITCH_LANGUAGE',
  'CORRECTION',
  'UNKNOWN',
] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

// ── Automation ──────────────────────────────────────────────────────────────
export const AUTOMATION_NODE_KINDS = [
  'trigger',
  'ai',
  'computer',
  'browser',
  'files',
  'applications',
  'condition',
  'loop',
  'wait',
  'notification',
  'human_approval',
  'end',
] as const;
export type AutomationNodeKind = (typeof AUTOMATION_NODE_KINDS)[number];

export const AUTOMATION_RUN_STATUSES = [
  'running',
  'waiting_for_approval',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

// ── Agent status shown by the AI status card / header (§37) ─────────────────
export const AGENT_STATUSES = [
  'ready',
  'listening',
  'thinking',
  'working',
  'verifying',
  'completed',
  'failed',
  'paused',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const TIMELINE_STEP_STATES = ['done', 'running', 'pending', 'failed', 'skipped'] as const;
export type TimelineStepState = (typeof TIMELINE_STEP_STATES)[number];
