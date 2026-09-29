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
- The system prompt states whether tools exist. Without tools the model is told it cannot act and must never claim to have;
  with tools (Phase 5) it may act only through them and report success only when a tool result confirms it.

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
- The parsed intents are **not yet executed** — the tool engine exists (Phase 5) but there are no computer/file/browser tools
  until Phases 6–8. Only `stop`, `cancel`, language switching and answering a pending confirmation have an effect today
  (they are handled locally in chat).
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

## Phase 5 — Tool engine ✅ (engine verified; the tools themselves arrive in Phases 6–8)

`@allaya/tools` (Electron-free) plus the main-process wiring and confirmation UI.

| Item                                                                                                                                                                                        | State                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Registry: strict names, no duplicates, state-changing tools cannot be statically LOW risk, prototype-safe lookup, JSON Schema for the model (zod, `io: input`), per-platform filtering      | ✅ (unit)                          |
| Argument validation with zod; **risk and permissions computed from the validated arguments**; errors name the problem without echoing values                                                | ✅ (unit; mutation-checked)        |
| Permission/risk policy as one pure function, exhaustively tested over risk × mode × subject: `never` denies; CRITICAL always confirms on screen; sensitive actions can't be always-allowed  | ✅ (unit, exhaustive)              |
| Confirmation broker: approval bound to one request, expiry = "no", STOP cancels, first answer wins, channel rules (voice/text never approve CRITICAL)                                       | ✅ (unit + integration + E2E)      |
| Execution pipeline: never runs before approval; timeout + cancellation even for tools that ignore the abort signal; secrets masked in errors                                                | ✅ (unit; mutation-checked)        |
| Verification: verified / failed / unverified / not-applicable; a failed check turns success into failure; the model is told plainly when an effect is unverified                            | ✅ (unit + integration + E2E)      |
| Audit: every attempt (including refused, unknown and invalid ones) → `tool_calls`, `tool_results`, `activity_logs`; args redacted and size-bounded; **no record ⇒ no action** (fail closed) | ✅ (unit + integration)            |
| Agent loop: model → tools → results → answer, bounded rounds, only completed tool-use turns act, usage summed, cancellation at every step                                                   | ✅ (integration + E2E, fake model) |
| Permissions backend (`permissions:list/set`) with cautious defaults (camera, admin commands off)                                                                                            | ✅ (integration)                   |
| UI: confirmation dialog (focus on "Don't allow", Esc declines, **Stop everything** inside it), per-reply action timeline with outcome + "Checked/Not checked", Bengali/English              | ✅ (unit + E2E)                    |
| Answering a question by voice/typed "yes"/"no" (strict parser; CRITICAL refuses it); unclear replies re-ask                                                                                 | ✅ (integration + E2E)             |
| Built-in tools: `get_datetime` (real). `e2e_probe` (test builds only, compiled out of production)                                                                                           | ✅                                 |

**Caveats — read these**

- **There are no computer-control, file or browser tools yet** (Phases 6–8), so the engine is proven with `get_datetime` and a
  harmless test probe, not with real actions. The risk classification of real tools will be reviewed as each is written.
- The model side is verified against a **fake Anthropic-shaped server**. Tool-call streaming for the other providers is covered by
  the Phase 2 wire-format fixtures only.
- The confirmation dialog makes the rest of the window inert (standard modal behaviour), which is why it carries its own
  "Stop everything" button and why a spoken answer is the way to reply while it is open. A **system-wide emergency-stop shortcut**
  needs the Windows integration phase.
- The Permissions **screen** is not built yet (Phase 12); the backend and defaults are.
- The typed/spoken answer channel is enforced in the trusted process, but the renderer reports which channel it used; that is
  acceptable because the renderer is the user's own UI (the restriction protects against _mis-heard_ speech, not a hostile renderer).
- Tool _plans_ spanning several user turns (a persistent task, pause/resume) belong to the task engine (Phase 9).

## Phase 6 — Computer control 🪟 (engine and safety verified; Windows behaviour NOT verified)

`@allaya/computer` (Electron-free) + `ElectronHost` (screenshots, clipboard, displays) + the Computer screen.

| Item                                                                                                                                                                                                                          | State                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Adapter interface; capabilities are reported honestly and tools that cannot work are **never offered** to the model                                                                                                           | ✅ (unit + integration + E2E)                     |
| App launcher only from a **catalog** (no paths, commands or shell text; catalog covers every app the language engine recognises); shells are MEDIUM risk                                                                      | ✅ (unit)                                         |
| Input safety: no synthetic keyboard/mouse into shells, system tools, elevated windows or Allaya itself; blocked shortcuts (Win+…, Alt+F4, Ctrl+Alt+Del, Ctrl+Shift+Esc); bounded text; on-screen coordinates only; rate limit | ✅ (unit against an in-memory desktop)            |
| Launch/close are **verified** by looking for the window (a window that never appears, or refuses to close, is a failure — not a success)                                                                                      | ✅ (unit + integration)                           |
| Typed text and clipboard contents never enter the audit log (only their length)                                                                                                                                               | ✅ (unit + integration)                           |
| Tools: `open_app`, `close_app`, `list_windows`, `focus_window`, `take_screenshot`, `read_clipboard`, `write_clipboard`, `type_text`, `press_keys`, `click_element`, `click_at` (HIGH), `scroll`                               | ✅ engine · 🪟 real desktop                       |
| **Real screenshots** (Electron `desktopCapturer`) saved as verified PNGs; **real clipboard** read/write with read-back verification                                                                                           | ✅ (E2E under Xvfb)                               |
| Windows adapter (PowerShell + Win32 `SendInput`/`EnumWindows`/UI Automation): arguments travel as JSON in an env var and can never become code                                                                                | ✅ injection-tested · 🪟 behaviour unverified     |
| The C# interop **compiles** (Mono `mcs`), all ten PowerShell programs **parse** (real PowerShell 7 parser), the `launch` program was **executed for real** and treated shell metacharacters as data                           | ✅ where those tools exist (tests skip otherwise) |
| Computer screen: capabilities, tools with risk, safe self-check (read-only), Windows-only notice                                                                                                                              | ✅ (unit + E2E)                                   |

**Caveats — read these**

- **Nothing in the Windows adapter has run on Windows.** Window enumeration, focusing, launching, mouse, `SendInput` typing
  (including Bengali as Unicode), keyboard chords and UI Automation are written carefully and syntax-checked, but their behaviour
  on a real desktop is unproven. Use **Computer → "Run a safe check"** on a Windows machine first; it lists windows and
  captures the screen without typing or clicking anything.
- Known Windows unknowns: DPI scaling and multi-monitor coordinate mapping (the input adapter assumes physical pixels, the same
  space as screenshots; mixed-DPI setups are unverified); Windows may refuse to bring a window to the front despite the Alt-key
  workaround; some apps ignore `WM_CLOSE`; PowerShell start-up adds a fraction of a second to every action.
- The model **cannot see the screen**: screenshots are saved to disk and _not_ sent to any provider. Screen understanding
  (vision) is not implemented, so `click_at` is a last resort and is HIGH risk. `click_element` (by visible name) is preferred.
- `type_text`/`press_keys`/`click_*` cannot confirm what the target program did, so their results are reported as
  **unverified** — the model is told not to claim more than "typed"/"pressed".
- Only the applications in the catalog can be opened; apps discovered from the Start menu are not supported yet.
- macOS/Linux: only screenshots and the clipboard exist (by design; no other adapter is implemented).

## Not started

Phases 7–15 (files, browser, task engine, automation,
memory, security hardening, Windows polish, release). Anything that needs Windows UI Automation, the tray,
global hotkeys, the installer, or auto-update **cannot be verified in this Linux environment** and will be marked 🪟
until run on Windows.
