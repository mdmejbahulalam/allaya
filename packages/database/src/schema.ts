import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Allaya local database schema (SQLite).
 *
 * Conventions
 *  - ids are text (prefixed uuid); timestamps are epoch milliseconds
 *  - `deleted_at` marks soft deletion for user-facing records that support undo/history
 *  - JSON payloads are stored as text columns (`*_json`) and validated with zod at the repository boundary
 *  - secrets are never stored in plaintext: `api_credentials.encrypted_key` holds OS-keychain-encrypted ciphertext
 */

const createdAt = () =>
  integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const updatedAt = () =>
  integer('updated_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const deletedAt = () => integer('deleted_at', { mode: 'number' });

// ── Identity & settings ─────────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  onboardingCompletedAt: integer('onboarding_completed_at', { mode: 'number' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const settings = sqliteTable('settings', {
  /** Dotted key, e.g. `appearance.theme`. */
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: updatedAt(),
});

export const languageSettings = sqliteTable('language_settings', {
  id: text('id').primaryKey().default('default'),
  /** `auto` | `bn` | `en` */
  uiLanguage: text('ui_language').notNull().default('auto'),
  /** `auto` | `bn` | `en` | `mixed` — language of Allaya's replies. */
  responseLanguage: text('response_language').notNull().default('auto'),
  /** BCP-47 locale for number/date formatting, e.g. `bn-BD`. */
  locale: text('locale').notNull().default('en-US'),
  /** `auto` | `bengali` | `latin` */
  numeralStyle: text('numeral_style').notNull().default('auto'),
  updatedAt: updatedAt(),
});

export const voiceSettings = sqliteTable('voice_settings', {
  id: text('id').primaryKey().default('default'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  sttProviderId: text('stt_provider_id'),
  ttsProviderId: text('tts_provider_id'),
  voiceId: text('voice_id'),
  speechRate: real('speech_rate').notNull().default(1),
  speechPitch: real('speech_pitch').notNull().default(1),
  vadSensitivity: real('vad_sensitivity').notNull().default(0.5),
  /** Below this STT confidence, destructive actions are refused and the user is asked to repeat. */
  minConfidence: real('min_confidence').notNull().default(0.6),
  speakResponses: integer('speak_responses', { mode: 'boolean' }).notNull().default(true),
  updatedAt: updatedAt(),
});

// ── Conversations ───────────────────────────────────────────────────────────
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    language: text('language'),
    modelId: text('model_id'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** Rolling summary used for conversation compaction. */
    summary: text('summary'),
    summarizedThroughMessageId: text('summarized_through_message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index('conversations_updated_idx').on(t.updatedAt)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** `user` | `assistant` | `task_action` | `system_status` | `confirmation` */
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    language: text('language'),
    /** Optional link to the task this message reports on. */
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    metadataJson: text('metadata_json'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

// ── Tasks ───────────────────────────────────────────────────────────────────
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    /** The user's original request text. */
    request: text('request').notNull(),
    language: text('language'),
    state: text('state').notNull().default('CREATED'),
    source: text('source').notNull().default('chat'),
    complexity: text('complexity'),
    modelId: text('model_id'),
    /** Highest risk level among the task's tool calls. */
    riskLevel: text('risk_level').notNull().default('LOW'),
    planJson: text('plan_json'),
    resultSummary: text('result_summary'),
    errorJson: text('error_json'),
    automationRunId: text('automation_run_id'),
    /** Engine bookkeeping that is not queried on: usage counters, what the task is waiting for, where it resumes. */
    runtimeJson: text('runtime_json'),
    filesChanged: integer('files_changed').notNull().default(0),
    actionCount: integer('action_count').notNull().default(0),
    startedAt: integer('started_at', { mode: 'number' }),
    completedAt: integer('completed_at', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('tasks_state_idx').on(t.state),
    index('tasks_created_idx').on(t.createdAt),
    index('tasks_conversation_idx').on(t.conversationId),
  ],
);

export const taskSteps = sqliteTable(
  'task_steps',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    toolName: text('tool_name'),
    argumentsJson: text('arguments_json'),
    state: text('state').notNull().default('pending'),
    error: text('error'),
    /** What the plan said about the step, and what came of it (summary, evidence, attempts, …). */
    dataJson: text('data_json'),
    startedAt: integer('started_at', { mode: 'number' }),
    completedAt: integer('completed_at', { mode: 'number' }),
  },
  (t) => [uniqueIndex('task_steps_task_position_uq').on(t.taskId, t.position)],
);

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Monotonic per task — lets the UI resume a stream without gaps. */
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payloadJson: text('payload_json'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('task_events_task_seq_uq').on(t.taskId, t.seq)],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    toolName: text('tool_name').notNull(),
    /** Redacted arguments. */
    argumentsJson: text('arguments_json').notNull(),
    risk: text('risk').notNull(),
    permissionDecision: text('permission_decision').notNull(),
    status: text('status').notNull().default('pending'),
    startedAt: integer('started_at', { mode: 'number' }),
    completedAt: integer('completed_at', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [index('tool_calls_task_idx').on(t.taskId), index('tool_calls_tool_idx').on(t.toolName)],
);

export const toolResults = sqliteTable(
  'tool_results',
  {
    id: text('id').primaryKey(),
    toolCallId: text('tool_call_id')
      .notNull()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    outputJson: text('output_json'),
    observationJson: text('observation_json'),
    verificationJson: text('verification_json'),
    errorJson: text('error_json'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tool_results_call_uq').on(t.toolCallId)],
);

// ── Memory ──────────────────────────────────────────────────────────────────
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    category: text('category').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    /** `user` | `inferred` | `system` */
    source: text('source').notNull().default('user'),
    confidence: real('confidence').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('memories_category_key_uq').on(t.category, t.key),
    index('memories_category_idx').on(t.category),
  ],
);

// ── AI providers ────────────────────────────────────────────────────────────
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** `not_configured` | `connected` | `error` | `unknown` */
  status: text('status').notNull().default('not_configured'),
  lastCheckedAt: integer('last_checked_at', { mode: 'number' }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    /** The provider's own model identifier. */
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    capabilitiesJson: text('capabilities_json').notNull(),
    costJson: text('cost_json'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    discoveredAt: integer('discovered_at', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('models_provider_model_uq').on(t.providerId, t.modelId)],
);

export const apiCredentials = sqliteTable(
  'api_credentials',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    /** base64 ciphertext produced by the OS-backed vault. Never plaintext. */
    encryptedKey: text('encrypted_key').notNull(),
    /** Safe display hint such as `sk-…a1b2`. */
    maskedHint: text('masked_hint').notNull(),
    lastTestedAt: integer('last_tested_at', { mode: 'number' }),
    lastTestOk: integer('last_test_ok', { mode: 'boolean' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('api_credentials_provider_uq').on(t.providerId)],
);

export const modelRouting = sqliteTable('model_routing', {
  purpose: text('purpose').primaryKey(),
  providerId: text('provider_id'),
  modelId: text('model_id'),
  updatedAt: updatedAt(),
});

// ── Permissions ─────────────────────────────────────────────────────────────
export const permissions = sqliteTable(
  'permissions',
  {
    id: text('id').primaryKey(),
    /** A `PermissionSubject`. */
    subject: text('subject').notNull(),
    /** `always_allow` | `ask` | `never` */
    mode: text('mode').notNull(),
    /** `global` or a narrower scope such as `app:chrome`. */
    scope: text('scope').notNull().default('global'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('permissions_subject_scope_uq').on(t.subject, t.scope)],
);

// ── Automations ─────────────────────────────────────────────────────────────
export const automations = sqliteTable(
  'automations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    /** `manual` | `schedule` | `event` */
    triggerType: text('trigger_type').notNull().default('manual'),
    triggerJson: text('trigger_json').notNull().default('{}'),
    nextRunAt: integer('next_run_at', { mode: 'number' }),
    lastRunAt: integer('last_run_at', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [index('automations_next_run_idx').on(t.enabled, t.nextRunAt)],
);

export const automationSteps = sqliteTable(
  'automation_steps',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    /** Stable node id within the workflow graph. */
    nodeId: text('node_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    configJson: text('config_json').notNull().default('{}'),
    /** Outgoing edges: `[{ "to": "node2", "label": "true" }]`. */
    nextJson: text('next_json').notNull().default('[]'),
    positionX: real('position_x').notNull().default(0),
    positionY: real('position_y').notNull().default(0),
  },
  (t) => [uniqueIndex('automation_steps_node_uq').on(t.automationId, t.nodeId)],
);

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    /** `running` | `waiting_for_approval` | `completed` | `failed` | `cancelled` */
    status: text('status').notNull().default('running'),
    /** `schedule` | `manual` | `event` */
    triggeredBy: text('triggered_by').notNull(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    logJson: text('log_json').notNull().default('[]'),
    error: text('error'),
    startedAt: integer('started_at', { mode: 'number' }).notNull(),
    completedAt: integer('completed_at', { mode: 'number' }),
  },
  (t) => [index('automation_runs_automation_idx').on(t.automationId, t.startedAt)],
);

// ── Audit & notifications ───────────────────────────────────────────────────
export const activityLogs = sqliteTable(
  'activity_logs',
  {
    id: text('id').primaryKey(),
    timestamp: integer('timestamp', { mode: 'number' }).notNull(),
    /** `allaya` | `user` | `system` */
    actor: text('actor').notNull(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    tool: text('tool'),
    action: text('action').notNull(),
    /** `success` | `failure` | `denied` | `cancelled` | `pending` | `info` */
    result: text('result').notNull(),
    risk: text('risk'),
    permission: text('permission'),
    error: text('error'),
    /** Redacted structured context. */
    detailsJson: text('details_json'),
  },
  (t) => [
    index('activity_logs_timestamp_idx').on(t.timestamp),
    index('activity_logs_task_idx').on(t.taskId),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    /** `success` | `info` | `working` | `warning` | `error` */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    dataJson: text('data_json'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt)],
);

// ── Computer / files ────────────────────────────────────────────────────────
export const installedApps = sqliteTable(
  'installed_apps',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** `exe` | `uwp` | `builtin` */
    kind: text('kind').notNull().default('exe'),
    executablePath: text('executable_path'),
    launchTarget: text('launch_target'),
    /** `uia` | `app_api` | `none` */
    automationSupport: text('automation_support').notNull().default('none'),
    lastLaunchedAt: integer('last_launched_at', { mode: 'number' }),
    discoveredAt: integer('discovered_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('installed_apps_name_uq').on(t.name)],
);

export const fileBookmarks = sqliteTable(
  'file_bookmarks',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    path: text('path').notNull(),
    /** `quick_location` | `recent` | `user` */
    kind: text('kind').notNull().default('user'),
    lastAccessedAt: integer('last_accessed_at', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('file_bookmarks_path_uq').on(t.path)],
);

/** What the file tools changed, with what is needed to reverse it (see `@allaya/filesystem`'s undo journal). */
export const fileOperations = sqliteTable(
  'file_operations',
  {
    id: text('id').primaryKey(),
    /** `create_file` | `create_folder` | `overwrite` | `copy` | `move` | `trash` */
    kind: text('kind').notNull(),
    /** The path as shown to the user (`Documents/report.txt`). */
    label: text('label').notNull(),
    target: text('target'),
    undoable: integer('undoable', { mode: 'boolean' }).notNull(),
    note: text('note'),
    /** The absolute paths needed to undo; re-validated against the allowed folders before use. */
    dataJson: text('data_json'),
    createdAt: createdAt(),
    undoneAt: integer('undone_at', { mode: 'number' }),
  },
  (t) => [index('file_operations_created_idx').on(t.createdAt)],
);

// Composite-key helper table used for schema-version bookkeeping of seed data.
export const seedState = sqliteTable(
  'seed_state',
  {
    name: text('name').notNull(),
    version: integer('version').notNull(),
    appliedAt: integer('applied_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.name] })],
);
