# Allaya architecture

## Trust boundaries

```
Renderer (React, sandboxed, no Node)
   │  window.allaya.invoke / subscribe        ← only two functions cross the bridge
Preload (contextIsolation, sandbox)
   │  one IPC channel, allow-listed channel names
IpcDispatcher (main)                          ← verify sender → validate envelope → validate payload → handler
   │
Trusted services (settings, agent, tools, files, browser, computer, voice, memory, automation)
   │
Operating system
```

- The renderer has **no** filesystem, shell, process, crypto-secret or database access. Boundaries are
  enforced three ways: Electron flags (`contextIsolation`, `sandbox`, `nodeIntegration:false`), a strict
  CSP, and ESLint `no-restricted-imports` rules that fail the build if renderer code imports Node,
  Electron, or any system-level `@allaya/*` package.
- `packages/validation/src/ipc` is the **single source of truth** for the IPC surface. The preload's
  allow-list, the dispatcher's validation, the handler table's types, and the renderer's typed client are
  all derived from it. `HandlerRegistry.assertComplete()` fails startup if a declared channel has no handler.
- Handlers never throw across the boundary; failures become `{ ok:false, error:{code,message} }` with stable
  error codes. Unknown failures are logged in full and reported generically (no stack traces or paths).

## Packages

| Package              | Responsibility                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `@allaya/shared`     | Result/errors, ids, clock, typed event bus, cancellation, redaction, logging                         |
| `@allaya/types`      | Domain vocabulary (risk levels, task states, intents, …) as const tuples                             |
| `@allaya/validation` | Zod schemas: IPC contract, settings registry, tool argument schemas                                  |
| `@allaya/database`   | Drizzle schema, migrations, SQLite connection, repositories                                          |
| `@allaya/ai`         | Provider adapters, SSE, retry/cancel, model router, token estimates                                  |
| `@allaya/security`   | Credential vault (OS-encrypted, no plaintext fallback)                                               |
| `@allaya/agent`      | Prompt policy, and the task engine: state machine, planner, orchestrator (Electron-free)             |
| `@allaya/language`   | Bengali/Banglish/English detection, normaliser, intent parser, dates, replies                        |
| `@allaya/speech`     | Pure voice logic: state machine, VAD, transcript safety gate, speech-text prep                       |
| `@allaya/voice`      | Main-process STT/TTS providers (OpenAI-compatible)                                                   |
| `@allaya/tools`      | Tool registry, risk/permission policy, confirmation broker, execution pipeline                       |
| `@allaya/computer`   | Computer control engine: adapters (Windows/host/memory), app catalog, input-safety rules, tools      |
| `@allaya/filesystem` | Scoped file operations: path policy, guarded ops, trash, undo journal, file tools                    |
| `@allaya/browser`    | Browser automation: URL policy, filtering proxy, page model, engine, Playwright session, tools       |
| `@allaya/automation` | Schedule maths (local time, DST), the scheduler (Electron-free), `create_automation` tools           |
| `@allaya/memory`     | Memory store port, secret/rule guard, retrieval, prompt block, manager, `remember`/`recall`/`forget` |

More packages arrive with their phases (see STATUS.md).

## Language engine (Bengali-first)

`@allaya/language` is pure and side-effect free. Pipeline: canonicalise (NFC, ZWJ) → lift out **protected literals**
(quotes, URLs, paths, file names) → lift out date/time expressions → tokenise with Bengali suffix splitting →
longest-phrase lexical matching (Bengali, Banglish and English map to the same canonical tokens) → role assignment
(Bengali postpositions attach backwards, English prepositions forwards) → intent parser.

The parser output is **language-independent**: the same request in any language yields identical params, and nothing
downstream ever sees Bengali. It is a _fast path_ that is deliberately conservative — a clause that is not fully
understood, or that is missing a parameter, is reported (`resolved:false`, `missing`, `leftovers`) and goes to the AI
planner rather than being guessed. Destructive intents are flagged and never take their target from context.

## Task engine

`@allaya/agent/tasks` runs a request from start to answer. It never touches the computer itself: it depends on three ports —
`AgentModel` (one whole model turn), `ToolPort` (the tool pipeline) and `TaskStore` (persistence) — so it runs in plain Node
with a scripted model and an in-memory store, and in the app with the user's providers, `ToolService` and SQLite.

```
CREATED → ANALYZING → (PLANNING → PERMISSION_CHECK →) READY → EXECUTING → VERIFYING → COMPLETED
                         ↘ WAITING_FOR_USER (approval / a question / a declined action)
EXECUTING → ERROR → RECOVERY → RETRY → EXECUTING          any working state ⇄ PAUSED     → CANCELLED / FAILED
```

- **Understand** — `classifyComplexity` (local, no model call). Simple requests run as one step; the rest are planned.
- **Plan** — a forced `submit_plan` call; `validatePlan` rejects unknown tools, forward/unknown dependencies and oversize
  plans (one repair round); `assessPlan` decides whether the person must approve first.
- **Do** — per step, a fresh model conversation (brief = request + plan + notes from earlier steps, never a growing
  transcript) with the real tools plus `finish_step` and `ask_user`. `judgeStep` decides whether "done" is believed.
- **Verify** — the record (not the model) sets the ceiling on the verdict; a `finish_task` call writes the answer.
- **Control** — pause is cooperative (safe points), cancel and the emergency stop abort model calls and actions, budgets are
  checked before every model call. One run at a time; others queue. `recover()` and `shutdown()` turn interrupted runs into
  PAUSED so nothing repeats on its own.

The main process adds `TaskService` (IPC, events, conversation posts, status pill), `DbTaskStore` (tasks, steps and a
timeline in SQLite; engine bookkeeping in `runtime_json` / `data_json`, validated on read), `ProviderModel` (routes planning
to the strongest tool-capable model, steps by task size) and `ToolServicePort`. Chat gets the `start_task` tool.

## Automations

`@allaya/automation` decides _when_; the task engine still decides _how_. An automation is an instruction plus a trigger
(`manual`, `once`, `interval`, `daily`, `monthly`, `new_file`). The `AutomationScheduler` depends on three ports —
`AutomationStore`, `RunLauncher` (start a task, read a task's state) and `FolderLister` — and a clock, so it runs in plain Node
with a fake clock and an in-memory store, and in the app with `DbAutomationStore` (SQLite, migration `0003`), the `TaskService`
and the `FileService`.

- **Tick** (every 30 s while the app runs): reconcile runs with their tasks → stop if automations are paused → fire what is
  due (skip what was missed while closed, skip what overlaps a run still going or waiting) → look at watched folders.
- **A run** is a row in `automation_runs` linked to an ordinary task (`source: 'automation'`). `taskChanged` keeps the run true to
  the task: completed / failed / cancelled / waiting for the person / paused (which still counts as going).
- **Stop** — the `RunRegistry`'s `stopped` event (emergency stop or typed "stop", not shutdown) sets the persisted setting
  `automations.paused`; the scheduler does nothing while it is set, except a manual "Run now".
- **The model's tools** — `create_automation` (CRITICAL) and `list_automations` are chat-only: `ToolServicePort` passes
  `deniedTools` so a task cannot call the first even if asked to.
- **Not built:** a node-graph workflow editor (the `automation_steps` table is unused), triggers from Windows events, running
  while Allaya is closed (tray/background arrives with Windows polish).

## Memory

`@allaya/memory` is what Allaya remembers about the person. A `MemoryManager` sits on a `MemoryStore` port (SQLite in the app via
`DbMemoryStore`, in-memory in tests) and a master switch (`memory.enabled`). Three doors lead in, each with its own rules:

- **The person** (Memory screen, IPC `memory:*`) — full control; the guard still refuses secrets.
- **The model** (`remember` / `recall` / `forget` tools) — proposals only: arguments are checked before the person is asked,
  saving and forgetting are HIGH risk (always a question), the "Instructions" category and rule-changing text are refused, and
  tasks are denied the writing tools.
- **The prompt** — `forPrompt(query)` ranks entries by word overlap (title 3, text 1, category 1; the person's "Instructions"
  and "Language" entries always), keeps 8 / ~1500 characters, marks them used, and formats a fenced, inert block. Chat records
  the used ids on the reply; the task service asks once per task and hands the block to the planner and step prompts.

Nothing in `@allaya/memory` can widen a permission: it only produces text for prompts and rows for the screen.

## Data

SQLite (better-sqlite3, WAL, foreign keys on) with Drizzle migrations. JSON payload columns are validated
with zod at the repository boundary. Secrets are never stored in plaintext.

## Testing strategy

- `tests/unit`, `tests/integration` — Vitest, in plain Node. The whole trusted backend (`createContainer`)
  has no Electron imports, so integration tests exercise the real dispatcher + real SQLite in memory.
- `tests/e2e` — Playwright driving the real built Electron app (isolated profile per test via
  `ALLAYA_USER_DATA_DIR`, honoured only for unpackaged or `ALLAYA_E2E=1` runs).
- `tests/security` — trust-boundary and hardening tests.
