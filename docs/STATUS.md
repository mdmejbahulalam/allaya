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

## Phase 2 — Core chat 🚧

| Item                                                                         | State                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Provider-neutral request/response/stream types                               | 🚧                                                                        |
| SSE parser (chunk-boundary, CRLF, split UTF-8 safe)                          | 🚧                                                                        |
| Anthropic / OpenAI / Google / OpenRouter adapters (streaming, tools, images) | 🚧 not yet tested against wire fixtures; **never run against a live API** |
| Model router (hard constraints → pin → assignment → scored auto)             | 🚧                                                                        |
| Credential vault, provider service, model routing UI, chat persistence + UI  | ⬜                                                                        |

## Not started

Phases 3–15 (Bengali engine, voice, tool engine, computer control, files, browser, task engine, automation,
memory, security hardening, Windows polish, release). Anything that needs Windows UI Automation, the tray,
global hotkeys, the installer, or auto-update **cannot be verified in this Linux environment** and will be marked 🪟
until run on Windows.
