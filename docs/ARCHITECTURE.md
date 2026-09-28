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

* The renderer has **no** filesystem, shell, process, crypto-secret or database access. Boundaries are
  enforced three ways: Electron flags (`contextIsolation`, `sandbox`, `nodeIntegration:false`), a strict
  CSP, and ESLint `no-restricted-imports` rules that fail the build if renderer code imports Node,
  Electron, or any system-level `@allaya/*` package.
* `packages/validation/src/ipc` is the **single source of truth** for the IPC surface. The preload's
  allow-list, the dispatcher's validation, the handler table's types, and the renderer's typed client are
  all derived from it. `HandlerRegistry.assertComplete()` fails startup if a declared channel has no handler.
* Handlers never throw across the boundary; failures become `{ ok:false, error:{code,message} }` with stable
  error codes. Unknown failures are logged in full and reported generically (no stack traces or paths).

## Packages

| Package                | Responsibility                                                          |
| ---------------------- | ----------------------------------------------------------------------- |
| `@allaya/shared`       | Result/errors, ids, clock, typed event bus, cancellation, redaction, logging |
| `@allaya/types`        | Domain vocabulary (risk levels, task states, intents, …) as const tuples |
| `@allaya/validation`   | Zod schemas: IPC contract, settings registry, tool argument schemas      |
| `@allaya/database`     | Drizzle schema, migrations, SQLite connection, repositories              |

More packages arrive with their phases (see STATUS.md).

## Data

SQLite (better-sqlite3, WAL, foreign keys on) with Drizzle migrations. JSON payload columns are validated
with zod at the repository boundary. Secrets are never stored in plaintext.

## Testing strategy

* `tests/unit`, `tests/integration` — Vitest, in plain Node. The whole trusted backend (`createContainer`)
  has no Electron imports, so integration tests exercise the real dispatcher + real SQLite in memory.
* `tests/e2e` — Playwright driving the real built Electron app (isolated profile per test via
  `ALLAYA_USER_DATA_DIR`, honoured only for unpackaged or `ALLAYA_E2E=1` runs).
* `tests/security` — trust-boundary and hardening tests.
