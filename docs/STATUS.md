# Implementation status

Legend: ✅ implemented **and verified** here · 🧩 implemented, verified only against fakes/Linux ·
🪟 needs a real Windows machine to verify · 🚧 written but not yet tested · ⬜ not started

All checks below run in CI-equivalent form in this environment: `pnpm typecheck`, `pnpm lint`, `pnpm test`
(Vitest), and `pnpm test:e2e` (Playwright driving the **real built Electron app** under Xvfb).

## Phase 0 — Architecture ✅

| Item                                                                          | State                  |
| ----------------------------------------------------------------------------- | ---------------------- |
| pnpm monorepo, strict TS, type-aware ESLint + import-boundary rules, Prettier | ✅                     |
| Electron shell: sandbox, contextIsolation, navigation/permission hardening    | ✅ (E2E)               |
| Typed IPC contract, hardened dispatcher, handler registry                     | ✅ (integration + E2E) |
| SQLite + Drizzle: 25 tables, migrations, FK/cascade/transaction tests         | ✅                     |
| Typed settings registry (validated, defaults, no arbitrary keys)              | ✅                     |
| Launches under Xvfb, isolated test profiles                                   | ✅                     |

## Phase 1 — Design system & shell ✅

| Item                                                                                                    | State                                      |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Tokens (spec palette), dark/light/system, accent picker, density, motion, glass                         | ✅                                         |
| WCAG AA contrast **computed from the real CSS** for both themes; derived custom-accent tokens AA-safe   | ✅ (unit)                                  |
| Inter + Noto Sans Bengali bundled locally (CSP-safe, offline); Bengali optical scale + line-height      | ✅ (E2E font check)                        |
| All §70 components (Button…ConfirmationDialog, Timeline, VoiceVisualizer, AutomationNode…) + gallery    | ✅                                         |
| Shell: sidebar (pin/collapse/hover-expand), header, live-activity panel, command palette (Ctrl+K)       | ✅ (E2E)                                   |
| Responsive tiers 1920/1440/1280/small — drawer + forced-collapsed rail; critical controls never hidden  | ✅ (E2E)                                   |
| Keyboard: skip link, focus order, Esc closes one layer, configurable shortcuts (recorder)               | ✅                                         |
| Confirmation dialog safe defaults (Cancel focused, Esc cancels)                                         | ✅ (unit; mutation-checked)                |
| Strict CSP with per-response nonce, custom `allaya-app://` protocol, traversal-safe server              | ✅ (unit + E2E)                            |
| i18n: `en`/`bn` catalogs, typed keys, plural + Bengali numerals/dates, key/placeholder parity test      | ✅                                         |
| Screens: Home, Settings (General/Appearance/Language/Privacy/Shortcuts), Help, gallery are functional   | ✅                                         |
| Screens Chat, Tasks, Automations, Computer, Apps, Browser, Files, Memory, Models, Activity, Permissions | empty states only — built in their phases  |
| Native window-caption overlay colours follow the theme                                                  | 🪟 (code written; only visible on Windows) |

## Phase 2 — Core chat ✅ (with caveats below)

| Item                                                                                                                                                       | State                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Provider-neutral request/response/stream types; one SSE parser correct at every byte boundary (incl. split Bengali UTF-8)                                  | ✅ (unit)                                         |
| Anthropic / OpenAI / Google / OpenRouter adapters: streaming, tool calls, images, model discovery, retry/backoff, cancellation                             | 🧩 verified against **wire-format fixtures** only |
| Model router: hard constraints → pin → per-purpose assignment → scored auto; deterministic; explains its choice                                            | ✅ (unit)                                         |
| Credential vault: encrypted at rest, masked hint only, **refuses to store if OS encryption is unavailable** (no plaintext fallback)                        | ✅ (unit + integration + E2E)                     |
| Key never appears in DB, IPC results, events, logs, renderer DOM/storage, error messages                                                                   | ✅ (integration + E2E)                            |
| Provider service: verify-then-keep, rejected keys discarded, offline keeps key with `error` status, routing persistence                                    | ✅ (integration + E2E)                            |
| Chat: persisted conversations/messages, streaming (coalesced deltas), history windowing (Bengali-aware token estimate), auto-title on code points          | ✅ (integration + E2E)                            |
| Cancellation: run registry, per-conversation cancel, global **emergency stop** (`agent:stop`), header STOP always visible while working, partial text kept | ✅ (integration + E2E)                            |
| Crash recovery: messages left mid-stream are marked interrupted on next start                                                                              | ✅ (integration)                                  |
| Safe Markdown renderer (no HTML injection; only http(s) links)                                                                                             | ✅                                                |
| Models screen (providers, add/test/remove key, routing) and Chat screen (list, streaming, model picker, retry, copy, a11y announcements)                   | ✅ (E2E)                                          |
| No-API-key mode: app fully usable, actionable errors, provider notice                                                                                      | ✅ (E2E)                                          |

**Caveats — read these**

- **No adapter has been run against a real provider API.** They are verified against fixtures shaped like each vendor's
  documented protocol, and against a local fake server end-to-end. Real-world differences (new fields, rate-limit
  shapes, model ids) can only be found by running with real keys.
- **Windows credential encryption (DPAPI via Electron `safeStorage`) is not exercised here.** The vault is tested with a
  fake cipher and E2E uses a build-time-gated insecure test cipher that is compiled out of production bundles.
- The system prompt tells the model it has **no tools yet**, so it cannot claim to have controlled the computer. This
  changes when the tool engine lands (Phase 5).

## Not started

Phases 3–15 (Bengali engine, voice, tool engine, computer control, files, browser, task engine, automation,
memory, security hardening, Windows polish, release). Anything that needs Windows UI Automation, the tray,
global hotkeys, the installer, or auto-update **cannot be verified in this Linux environment** and will be marked 🪟
until run on Windows.
