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

| Package              | Responsibility                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `@allaya/shared`     | Result/errors, ids, clock, typed event bus, cancellation, redaction, logging                    |
| `@allaya/types`      | Domain vocabulary (risk levels, task states, intents, …) as const tuples                        |
| `@allaya/validation` | Zod schemas: IPC contract, settings registry, tool argument schemas                             |
| `@allaya/database`   | Drizzle schema, migrations, SQLite connection, repositories                                     |
| `@allaya/ai`         | Provider adapters, SSE, retry/cancel, model router, token estimates                             |
| `@allaya/security`   | Credential vault (OS-encrypted, no plaintext fallback)                                          |
| `@allaya/agent`      | System prompt policy (language rules, "no tools" honesty)                                       |
| `@allaya/language`   | Bengali/Banglish/English detection, normaliser, intent parser, dates, replies                   |
| `@allaya/speech`     | Pure voice logic: state machine, VAD, transcript safety gate, speech-text prep                  |
| `@allaya/voice`      | Main-process STT/TTS providers (OpenAI-compatible)                                              |
| `@allaya/tools`      | Tool registry, risk/permission policy, confirmation broker, execution pipeline                  |
| `@allaya/computer`   | Computer control engine: adapters (Windows/host/memory), app catalog, input-safety rules, tools |
| `@allaya/filesystem` | Scoped file operations: path policy, guarded ops, trash, undo journal, file tools               |

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

## Data

SQLite (better-sqlite3, WAL, foreign keys on) with Drizzle migrations. JSON payload columns are validated
with zod at the repository boundary. Secrets are never stored in plaintext.

## Testing strategy

- `tests/unit`, `tests/integration` — Vitest, in plain Node. The whole trusted backend (`createContainer`)
  has no Electron imports, so integration tests exercise the real dispatcher + real SQLite in memory.
- `tests/e2e` — Playwright driving the real built Electron app (isolated profile per test via
  `ALLAYA_USER_DATA_DIR`, honoured only for unpackaged or `ALLAYA_E2E=1` runs).
- `tests/security` — trust-boundary and hardening tests.
