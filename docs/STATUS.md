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

## Phase 3 — Bengali / multilingual language engine ✅ (with caveats below)

`packages/language` — pure TypeScript, no I/O, no Electron. Bengali is a first-class input language, not a translation layer.

| Item                                                                                                                                                                                       | State                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Unicode handling: NFC, ZWJ/ZWNJ stripping, Bengali/Latin script counting, Bengali digits ↔ ASCII, punctuation (danda)                                                                      | ✅ (unit)                                 |
| Number words (Bengali + Banglish, 1–100 table) and digits                                                                                                                                  | ✅ (unit)                                 |
| Language detection: Bengali / English / Banglish (romanised) / mixed; `bn-BD` / `en-US` / `en-GB`; confidence so that one-word replies fall back to history                                | ✅ (unit)                                 |
| Conversation language memory: explicit "বাংলায় কথা বলো" / "Speak English" sticks (beats the app-wide policy), history for short replies, UI fallback                                      | ✅ (unit + integration + E2E)             |
| Date/time parsing: কাল/পরশু (genuinely ambiguous → reported as such, never guessed), weekdays, ranges, "৩টা" count vs clock, period-of-day rules, Saturday-start weeks                     | ✅ (unit)                                 |
| Normaliser: protected literals (quotes, URLs, paths, file names) lifted out first; longest-phrase matching; Bengali suffix splitting; Bengali (verb-final) vs English argument order       | ✅ (unit)                                 |
| Intent parser: open/close/find/search/show/create/copy/move/rename/delete/screenshot/lock/stop/cancel/switch-language → language-independent intents with params, `missing`, `destructive` | ✅ (unit, ~100 phrasings)                 |
| Same request in Bengali, Banglish, English or mixed produces **identical params**; output never contains Bengali (the execution core is language-independent)                              | ✅ (unit)                                 |
| Uncertainty → `needsPlanner`; unknown words are reported as `leftovers`, never silently dropped                                                                                            | ✅ (unit)                                 |
| Safety: delete never takes its target from context or from a bare noun / known folder; "stop" only counts when it is the whole message                                                     | ✅ (unit + integration; mutation-checked) |
| Context: "এই folder এর মধ্যে…", "close it"; corrections ("না, Edge খুলে দাও"); strict yes/no parsing for confirmations (ambiguous never confirms)                                          | ✅ (unit)                                 |
| Chat integration: language detected + persisted per message, reply language decided per turn and given to the model, typed stop/cancel/switch handled **without** a model call             | ✅ (integration + E2E)                    |
| UI: reply-language selector (Auto / বাংলা / English) per conversation, `lang` attribute on bubbles (font + screen-reader voice)                                                            | ✅ (unit + E2E)                           |

**Caveats — read these**

- **The lexicon is hand-written and finite.** It covers the verbs, apps, folders, file types and phrasings in the tests; real
  users will say things it does not know. That is by design: anything not fully understood goes to the AI planner
  (`needsPlanner`) instead of being guessed. Coverage will need to grow from real usage.
- **Detection of short Banglish is heuristic** (a romanised-word lexicon). Very short or ambiguous input scores low and
  inherits the conversation's language.
- The parsed intents are **not yet executed** — there are no tools until Phase 5. Only `stop`, `cancel` and
  language switching have an effect today (they are handled locally in chat).
- Bengali quality of _model_ replies depends on the provider; only the instruction to the model is verified here.

## Phase 4 — Voice ✅ (with important caveats below)

`@allaya/speech` (pure, renderer-safe) and `@allaya/voice` (main-process providers).

| Item                                                                                                                                                                                             | State                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Voice state machine IDLE/LISTENING/PROCESSING/SPEAKING/ERROR: no talking over the user, barge-in, interrupt always → IDLE, **epoch-guarded so late results from cancelled requests are dropped** | ✅ (unit; mutation-checked)              |
| Voice-activity detection: hysteresis, adaptive noise floor (learned from quiet frames only), click rejection, end-of-utterance, no-speech timeout, max length                                    | ✅ (unit, synthetic signals)             |
| Transcript hygiene: confidence from Whisper log-probs (unknown ⇒ `null`, never "high"), silence-hallucination filter                                                                             | ✅ (unit + integration)                  |
| **Low-confidence safety gate**: destructive ⇒ always review (whatever the policy/confidence); unknown/low confidence ⇒ review; "stop" ⇒ send immediately                                         | ✅ (unit + integration + E2E)            |
| Speech-to-text adapter (OpenAI-compatible `/audio/transcriptions`, multipart, retry/cancel/redaction)                                                                                            | 🧩 verified against wire-format fixtures |
| Text-to-speech: cleaned/chunked spoken text (Markdown/URLs/code/emoji removed, Bengali danda), cloud voice adapter, system-voice picker (never a wrong-language voice)                           | ✅ prep logic · 🧩 adapters              |
| Microphone permission policy: audio only, own origin, only after consent, revoked when voice is turned off; camera never                                                                         | ✅ (unit + **real Electron E2E**)        |
| Consent dialog, mic button, live level meter, review card (editable, confidence badge, reasons), notices, Settings → Voice, in-app shortcut (Ctrl+Shift+V outside text fields)                   | ✅ (unit + E2E)                          |
| Emergency STOP silences the microphone, speech and tasks; STOP visible whenever voice is active                                                                                                  | ✅ (E2E)                                 |
| Audio never persisted or logged; transcripts not logged                                                                                                                                          | ✅ (integration)                         |

**Caveats — read these**

- **No real speech has ever been through this pipeline.** E2E uses Chromium's _synthetic_ microphone (a periodic beep) and a
  fake speech server that returns a scripted transcript. Actual microphone capture quality, VAD thresholds in real rooms,
  and — most importantly — **Bengali recognition accuracy** are unverified and must be tested with real voices.
- **The OpenAI transcription/speech endpoints have never been called live.** Whisper's per-segment log-probabilities are what
  drive the confidence gate; other models (e.g. `gpt-4o-transcribe`) return no confidence, so every transcript from them is
  held for review under the default policy.
- **Bengali text-to-speech** through `speechSynthesis` depends on a Bengali voice being installed in Windows (unverified here — this
  environment has no voices; the "no voice installed" path is what E2E exercises). The cloud voice's Bengali quality is unverified.
- Only **one** speech provider (OpenAI) exists. Google/Gemini STT and local/offline recognition are not implemented.
- **Not implemented:** wake word ("Hey Allaya"), hold-to-talk key, system-wide voice hotkey (Windows integration phase),
  microphone level calibration UI, voice activity while the window is hidden.
- VAD defaults (threshold, 1.1 s end-of-speech silence) were chosen by reasoning about Bengali speech pauses, not measured.

## Not started

Phases 5–15 (tool engine, computer control, files, browser, task engine, automation,
memory, security hardening, Windows polish, release). Anything that needs Windows UI Automation, the tray,
global hotkeys, the installer, or auto-update **cannot be verified in this Linux environment** and will be marked 🪟
until run on Windows.
