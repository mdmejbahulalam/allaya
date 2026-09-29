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

| Item                                                                                                   | State                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Tokens (spec palette), dark/light/system, accent picker, density, motion, glass                        | ✅                                         |
| WCAG AA contrast **computed from the real CSS** for both themes; derived custom-accent tokens AA-safe  | ✅ (unit)                                  |
| Inter + Noto Sans Bengali bundled locally (CSP-safe, offline); Bengali optical scale + line-height     | ✅ (E2E font check)                        |
| All §70 components (Button…ConfirmationDialog, Timeline, VoiceVisualizer, AutomationNode…) + gallery   | ✅                                         |
| Shell: sidebar (pin/collapse/hover-expand), header, live-activity panel, command palette (Ctrl+K)      | ✅ (E2E)                                   |
| Responsive tiers 1920/1440/1280/small — drawer + forced-collapsed rail; critical controls never hidden | ✅ (E2E)                                   |
| Keyboard: skip link, focus order, Esc closes one layer, configurable shortcuts (recorder)              | ✅                                         |
| Confirmation dialog safe defaults (Cancel focused, Esc cancels)                                        | ✅ (unit; mutation-checked)                |
| Strict CSP with per-response nonce, custom `allaya-app://` protocol, traversal-safe server             | ✅ (unit + E2E)                            |
| i18n: `en`/`bn` catalogs, typed keys, plural + Bengali numerals/dates, key/placeholder parity test     | ✅                                         |
| Screens: Home, Settings (General/Appearance/Language/Privacy/Shortcuts), Help, gallery are functional  | ✅                                         |
| Screens Tasks, Automations, Apps, Browser, Memory, Activity, Permissions                               | empty states only — built in their phases  |
| Native window-caption overlay colours follow the theme                                                 | 🪟 (code written; only visible on Windows) |

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

- _(Historical note: when this phase was written there were no real tools; computer control arrived in Phase 6 and files in
  Phase 7, each with its risk classification reviewed. Browser tools are still to come in Phase 8.)_
- The model side is verified against a **fake Anthropic-shaped server**. Tool-call streaming for the other providers is covered by
  the Phase 2 wire-format fixtures only.
- The confirmation dialog makes the rest of the window inert (standard modal behaviour), which is why it carries its own
  "Stop everything" button and why a spoken answer is the way to reply while it is open. A **system-wide emergency-stop shortcut**
  needs the Windows integration phase.
- The Permissions **screen** is not built yet (Phase 12); the backend and defaults are.
- The typed/spoken answer channel is enforced in the trusted process, but the renderer reports which channel it used; that is
  acceptable because the renderer is the user's own UI (the restriction protects against _mis-heard_ speech, not a hostile renderer).
- Tool _plans_ spanning several user turns (a persistent task, pause/resume) are the task engine's (Phase 9, below).

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

## Phase 7 — File system 🪟 (logic verified on a real disk; Windows/NTFS behaviour NOT verified)

`@allaya/filesystem` (Electron-free) + `FileService` + the Files screen. **Every** file operation — the model's tools and the
screen's own actions — goes through one guard (`PathPolicy` → `FileManager`).

| Item                                                                                                                                                                                                                              | State                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Scope**: only the OS known folders (Desktop/Documents/Downloads/Pictures/Videos/Music) plus folders the user adds through the system picker; a path must start with a folder name (any supported language) or lie inside one    | ✅ (unit + integration + E2E)                                  |
| `..` is **rejected**, not normalised; URLs, `\\server`, `\\?\`, drive-relative paths, control characters and text-direction spoofing characters are refused (Bengali ZWJ/ZWNJ stay valid)                                         | ✅ (unit; the tests found and closed a spoofing gap)           |
| Windows name rules (alternate data streams, wildcards, reserved device names, trailing dots/spaces, 8.3 short names) checked as pure string logic under `win32` semantics                                                         | ✅ (unit) · 🪟 not run against NTFS                            |
| **Links cannot lead out**: `realpath` containment (parents and target), dangling/looping links refused, a secret name hidden behind a link is re-checked on the real location; list/search/copy never follow links                | ✅ (unit + property test + E2E; POSIX symlinks only)           |
| Secrets are never read or changed: `.ssh`, `.env*`, `*.pem/.key/.pfx/.kdbx`, `id_rsa*`, `.npmrc`, browser profiles… (also omitted from listings, searches and folder copies); system-managed names are write-protected            | ✅ (unit)                                                      |
| Allaya's own data folder is unreachable in both directions (a path inside it, or a folder that contains it); roots cannot be a drive, the user profile, system folders, or contain/sit inside app data                            | ✅ (unit + integration)                                        |
| **No program files**: `.exe/.bat/.ps1/.js/.lnk/.msi/…` can't be created, renamed to, or opened by Allaya                                                                                                                          | ✅ (unit + integration; mutation-checked)                      |
| **Nothing is overwritten silently**: create/copy/move/rename refuse an existing name (the tests caught a bug where `rename` would replace a file); replacing needs `overwrite`, is HIGH, and keeps the old version                | ✅ (unit; mutation-checked)                                    |
| **Delete = trash**: a file is HIGH, a folder is CRITICAL (on-screen click only), roots can't be deleted, the result is verified; links are deleted as links                                                                       | ✅ (unit + integration + E2E)                                  |
| **Undo journal** (SQLite, survives restart): create, mkdir, overwrite, copy, move/rename, delete (where the trash is restorable). Undo **refuses if the user changed the file since** and re-validates paths                      | ✅ (unit + integration + E2E; mutation-checked)                |
| Cross-drive moves: copy → prove sizes → only then trash the original; a failed copy leaves no half-copy and the original intact; a journal that cannot be written never turns a finished action into a failure                    | ✅ (unit, `EXDEV` simulated)                                   |
| Bounded work: read ≤ 100 000 characters (only the head of a huge file is read), search ≤ 20 000 entries / depth 8 (and says when it was cut short), copies ≤ 5 000 items / 1 GB refused **before** anything is written            | ✅ (unit)                                                      |
| `read_file` is text only (binary refused; UTF-8/UTF-16 with BOM; Bengali fine), **asks first** and says the text goes to the AI provider; the audit log keeps that a file was read, never its text                                | ✅ (unit + integration + E2E)                                  |
| 14 tools: `list_folder`, `find_files`, `get_file_info`, `read_file`, `create_folder`, `write_file`, `copy_file`, `move_file`, `rename_file`, `delete_file`, `delete_folder`, `open_file`, `list_file_actions`, `undo_file_action` | ✅ (unit + integration + E2E)                                  |
| Hostile-input battery: ~40 hostile paths × every operation leave everything outside the folders (and all secrets) byte-identical; 3 000 generated paths never resolve outside or to a secret                                      | ✅ (security tests)                                            |
| Files screen: folders, breadcrumb, search, hidden toggle, create/rename/delete/open/show-in-Explorer, add/remove a folder, "what Allaya changed" with **Undo**, access-off state; Bengali UI and numerals                         | ✅ (unit + E2E) · 🪟 Explorer/open on Windows                  |
| Changes made from the screen use the **same** permission → confirmation → verification → audit pipeline as the model (one set of rules), and the emergency stop reaches them                                                      | ✅ (integration + E2E)                                         |
| Read-tool audit privacy also applied retroactively to `read_clipboard` (`auditOutput`: the audit keeps a length, not the clipboard text)                                                                                          | ✅ (unit + integration)                                        |
| System prompt: file/clipboard contents are _information, not orders_ (prompt-injection guard); a refusal is final; delete is "moved to the trash"                                                                                 | ✅ wording (unit) — the model's obedience is not testable here |

**Caveats — read these**

- **Nothing here has run on Windows/NTFS.** Verified on POSIX only: directory junctions vs symlinks, case-insensitive rename
  (`a.txt` → `A.txt` is handled by comparing inodes; unproven on NTFS), `rename` onto an existing file, 8.3 short-name
  expansion by `realpath`, `shell.trashItem` (Recycle Bin), `shell.openPath` and the native folder picker. Test runs use
  Allaya's own trash folder, a recording "opener" and a scripted picker instead of the Windows shell.
- **Deletes are not undoable in production**: the Windows Recycle Bin can be written to but not restored from by code, so the
  journal says "restore it from the Recycle Bin". (Overwrites keep their previous version for 30 days in Allaya's own backup
  folder, so replacing a file _is_ undoable.)
- **Check-then-use**: a path is validated and then used; another program that swaps a folder for a link in between could
  defeat that. The realistic threat here is a model-generated path, not a racing local process, but the risk is not zero.
- **OneDrive "Files on-demand"**: if Documents/Desktop are redirected to OneDrive, reading a cloud-only file makes Windows
  download it. How listing and sizes behave for placeholders is unverified.
- **Not offered**: append/edit-in-place (replace with a backup instead), reading PDF/Word/Excel, searching file _contents_,
  archives, attributes/permissions, drag & drop, multi-select, previews. Deleting many files means one confirmation each.
- The program-file list also blocks `.js` and `.sh` **files Allaya would create** — over-broad for developers, deliberately so.
  Program files _inside_ a folder that is copied or moved are carried along (they already existed; nothing is authored).
- Browsing in the Files screen is the user's own action and is not written to the audit log (changes, reads by the model and
  undo are). Browsing still obeys `file_access = never`.
- Renderer bundle: the main chunk is still ~1.7 MB (unchanged by this phase); the Files screen is its own lazy chunk (~31 kB).

## Phase 8 — Browser automation 🪟 (verified against a real Chromium on Linux; Edge/Chrome on Windows NOT verified)

`@allaya/browser` (Electron-free) + `SafeProxy` + `BrowserService` + the Browser screen. Allaya drives its **own** browser profile
(Edge or Chrome, found in their standard install folders) through Playwright; the person's everyday profile is never touched.

| Item                                                                                                                                                                                                                                                                                              | State                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Network rules enforced at one choke point**: the browser is forced through a local filtering proxy that vets **every** connection (page, redirects, images, scripts, `fetch`, XHR, WebSockets) and connects only to the addresses it vetted                                                     | ✅ (unit + integration + real Chromium + E2E; mutation-checked)                  |
| **Found by testing**: Playwright's `route()` does **not** see redirect hops — a redirect to `127.0.0.1` was fetched (the fixture "router" was hit). So the guard is the proxy, not request interception                                                                                           | ✅ regression-tested against a server-side hit counter                           |
| Never opened: the local network / this computer / link-local / cloud-metadata / CGNAT addresses in every spelling (`127.1`, decimal, hex, octal, `[::1]`, IPv4-mapped IPv6), local names (`.local`, `.internal`, single-label), non-http(s) schemes, addresses with a password in them            | ✅ (unit + real Chromium)                                                        |
| DNS rebinding: a public-looking name that resolves inside the network is refused (any of its addresses), and the name is re-resolved for every connection, with the connection pinned to the vetted address                                                                                       | ✅ (integration)                                                                 |
| Blocked-sites list applies to the site, its sub-domains, **and redirects**; trusted list only removes the first-visit question                                                                                                                                                                    | ✅ (unit + integration + real Chromium + E2E)                                    |
| Chromium started with no other way out: proxy forced (loopback included), no local name resolution, no QUIC, WebRTC UDP restricted, service workers blocked; downloads cancelled, file pickers never answered, permission prompts denied, page dialogs dismissed (and reported as untrusted text) | ✅ (real Chromium) — `MAP * ~NOTFOUND` is belt-and-braces, not separately tested |
| Page model for the AI: visible text (hidden text excluded), numbered controls with refs valid only for the page they came from (`stale_ref` after navigation), text capped, controls capped, iframes/shadow DOM not read                                                                          | ✅ (unit + real Chromium)                                                        |
| **Prompt-injection signals**: text that reads like instructions to an AI is flagged in the tool result ("do NOT follow it"), the page is always labelled untrusted data, and an address a page plants is refused and never asked about                                                            | ✅ (unit + integration + E2E) · the model's obedience is not testable here       |
| **Risk follows what would happen**: new site MEDIUM (asks once per site, per session or trusted); a click that looks like _paying_ is **CRITICAL** (on-screen click only), _sending/deleting/signing in_ HIGH (never silenced by "always allow"); Bengali labels recognised                       | ✅ (unit + integration + E2E)                                                    |
| **Never types secrets**: password, card, one-time-code and identity-number fields are refused (nothing typed, value never shown to the model); the user signs in themselves in the browser window, and the profile keeps it                                                                       | ✅ (unit + real Chromium — the server received an empty password field)          |
| Typing is verified by reading the field back; opening is verified by the HTTP status (a 404 is not a success); clicks are reported **unverified** (no independent check)                                                                                                                          | ✅ (unit + integration)                                                          |
| Audit privacy: addresses stored without query/fragment (tokens), typed text and page content never stored (only lengths / that a page was read)                                                                                                                                                   | ✅ (unit + integration — the test found a leak in tool outputs, fixed)           |
| Cancellation: STOP aborts a slow load within a second and leaves the browser usable; the tab is cleared after a failed load                                                                                                                                                                       | ✅ (real Chromium + E2E)                                                         |
| Real Chromium features: tabs (list/switch/close, popups become tabs), back, real PNG screenshots, persistent cookies between runs (and per-site), unreachable / missing sites reported in plain words                                                                                             | ✅ (real Chromium)                                                               |
| 11 tools: `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_screenshot`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_back`, `browser_close`                                                                                 | ✅ (unit + integration + E2E)                                                    |
| Browser screen: engine found / not found, open / close, sign-in window, tabs, trusted & blocked lists (Unicode names stored as punycode), what Allaya won't do, tools with risk; Bengali                                                                                                          | ✅ (unit + E2E)                                                                  |
| Limits: 8 tabs, 90 actions/minute, 40 000 characters per read, 150 controls, 2 000 typed characters, allowed keys only (`Enter`, `Tab`, arrows, paging, `Escape`, `Space`…)                                                                                                                       | ✅ (unit)                                                                        |

**Caveats — read these**

- **Only Playwright's Chromium 141 was driven.** The Edge/Chrome install paths are unit-tested strings; the browser switches
  (`--proxy-server`, `--proxy-bypass-list=<-loopback>`, `--host-resolver-rules`) are proven on Chromium 141 and are expected — not
  proven — to behave the same in Edge. The Chromium **sandbox** was disabled in tests (root container); with the sandbox on
  Windows it is unverified. The **visible** window (headed mode, `--start-maximized`, Chromium's "controlled by automated
  software" bar) was never run; all tests are hidden.
- **Networks that need a proxy do not work yet.** Allaya's proxy connects directly and ignores the system proxy/PAC settings.
- The filtering proxy has **no authentication**: it listens on `127.0.0.1` on a random port, and only ever connects to public,
  non-blocked destinations — but another program on the same PC could use it as a relay to public sites.
- HTTPS is tunnelled, not inspected: rules are per **site**, never per page. Certificate errors are never bypassed.
- **Heuristics, not guarantees.** "Looks like a payment/send/delete" and "asks for a password/card/code" come from the control's
  visible name (English and Bengali). An icon-only button or an unlabelled field is treated as ordinary (MEDIUM). The
  confirmation always shows the control's name and destination so the person can judge. Injection detection is a phrase list; text
  hidden off-screen (not `display:none`) is still read.
- **Content inside iframes and shadow DOM is invisible** to the model (and cannot be clicked): embedded payment forms, captchas
  and some sign-in widgets will not work.
- **Privacy of logged-in pages**: after the person approves a site, `browser_read` on it sends what the page shows (including
  logged-in content such as an inbox) to the AI provider without asking again. Approval is per site, not per page.
- No downloads, uploads, cookie/storage access, JavaScript evaluation or arbitrary selectors are offered — by design.
- `playwright-core` is a runtime dependency of the main process; that it is included correctly in a **packaged** installer is not
  verified (Phases 13/15).
- The plain-HTTP WebSocket upgrade path of the proxy is refused; `ws://`/`wss://` normally travel through `CONNECT`.

## Phase 9 — Task engine 🧩 (verified end to end against a scripted model; no real AI provider was used)

`@allaya/agent` (`tasks/`, Electron-free) + `TaskService` / `ProviderModel` / `ToolServicePort` in the main process + the Tasks
screen. A **task** is a request that runs in the background: understand → plan (only when it pays) → show the plan when it
should be seen → do it step by step through the **same** tool pipeline chat uses → check the results → answer. The model
_proposes_ (a plan, the next tool call, "this step is done"); the orchestrator _disposes_ — every state change goes through a
state machine, every budget is enforced here, and a step counts as done only if the tool results support it.

| Item                                                                                                                                                                                                                                                                                                                                    | State                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **State machine as data**: the 15 task states, every edge listed; a final state never leaves; impossible moves throw; every recorded change of state is checked (in tests) to be a legal move that starts where the last ended                                                                                                          | ✅ (unit; 102 tests across the machine, plan, complexity and orchestrator files)               |
| Complexity is decided locally, without a model call (Bengali, English, Banglish): one command → one step, no planning call; sequenced or long requests are planned                                                                                                                                                                      | ✅ (unit)                                                                                      |
| Planner returns one structured plan; the plan is **validated** (unique ids, dependencies only on _earlier_ steps so cycles are impossible, only tools that exist, size limits) and **repaired once** with the exact problem quoted back; otherwise the task fails as `PLAN_INVALID`                                                     | ✅ (unit)                                                                                      |
| A plan is shown and **waits for a yes** when the person asked, when it is long, when it names a risky tool or a sensitive area (deleting, sending, installing). Approving a plan is **not** approving its actions: each risky action still asks on its own, CRITICAL still needs a click                                                | ✅ (unit + integration + security + E2E)                                                       |
| **A step is not "done" because the model says so.** Refused as done: nothing was run for a step that names a tool; every action failed; the last change it made failed. What was checked is recorded next to what the model reported; unconfirmed changes are marked and named in the answer                                            | ✅ (unit; each rule mutation-checked — 14 orchestrator rules and 8 integration/security rules) |
| The final verdict can only get **stricter** than the model's: a required step that was not done makes the outcome "partly done" (or failed) whatever the model claims                                                                                                                                                                   | ✅ (unit + integration)                                                                        |
| The person says **no** to an action → the step stops at once and the model is never asked to find a way around it; the task waits and the person can carry on with the rest or stop. Silence is reported as "no answer in time", not as a "no"                                                                                          | ✅ (unit + integration + security + E2E)                                                       |
| Refusals that will not change (protected path, secret, permission off) are **not retried**; other failures retry up to 3 times with a note of what went wrong, and back off for busy/unreachable providers                                                                                                                              | ✅ (unit + integration)                                                                        |
| Questions: the planner or a step may ask the person one question (max 3 per task); the answer becomes part of the request; a typed answer in the originating chat is taken as the answer unless it is a clear command of its own                                                                                                        | ✅ (unit + integration + security + E2E)                                                       |
| Budgets: 20 steps, 6 rounds per step, 3 attempts per step, 80 actions, 6 actions per turn, 30 minutes of running time (waiting for the person does not count), 3 questions                                                                                                                                                              | ✅ (unit)                                                                                      |
| Pause (at the next safe point — a running action is never cut off by a pause), resume, cancel; the emergency stop and a typed "stop" cancel running **and queued** tasks; a paused/cancelled task never repeats an action by itself                                                                                                     | ✅ (unit + integration + E2E)                                                                  |
| **One task runs at a time** (two must not fight over the mouse and keyboard); others queue                                                                                                                                                                                                                                              | ✅ (unit + integration)                                                                        |
| **Persistence and recovery**: every change is written (SQLite, migration `0002`); closing Allaya pauses a running task as _interrupted_ (written synchronously); after a crash the half-done task is found and paused; nothing resumes by itself, and the interrupted step is told it may be part-done                                  | ✅ (integration incl. a crash snapshot + real Electron restart in E2E)                         |
| Damaged rows degrade instead of crashing (an unreadable state shows as failed, never as running)                                                                                                                                                                                                                                        | ✅ (integration)                                                                               |
| Chat: the model gets `start_task` for multi-step requests (one per reply); the result, questions and plan/decline notices are posted **into the conversation**, linked to the task; yes/no in chat approves a plan or continues after a decline                                                                                         | ✅ (integration + security + E2E)                                                              |
| Tasks screen: composer (with "show me the plan first"), tabs, live list with progress, detail with plan review, question, decline and pause cards, steps with _what was reported_ vs _what was checked_, activity log, run again / remove; sidebar marker and toast when a task needs you; Home shows current and recent tasks; Bengali | ✅ (28 renderer tests + E2E)                                                                   |
| Audit: every action a task takes is recorded under the task; removing a task **detaches** (never deletes) its audit rows; typed text and file contents stay out of the timeline and audit trail                                                                                                                                         | ✅ (integration + security; the removal rule was found by a test and fixed)                    |

**Caveats — read these**

- **Only scripted models were used.** The planner, step and answer prompts have never been run against a real provider, so
  how well real models plan, stay on a step, call `finish_step`, or write a good answer in Bengali is **unverified**. The
  orchestrator is built not to trust any of it (see above), but quality is unmeasured.
- The **complexity classifier is a heuristic** (sequencing words, sentences, list items, length) in three languages; it is
  tuned on examples, not measured. A request wrongly classed as simple runs as one step under the same permission checks.
- The **plan preview is an estimate**: it knows only the tools the plan names. A tool whose risk or permission depends on its
  arguments (browser clicks, overwriting a file) counts as MEDIUM in the preview and is judged for real at each call.
- Step summaries, the final answer and the person's answers are stored **as written** in the local database (like chat
  messages); a model that echoes private text into its summary keeps it there until the task is removed.
- One task at a time also means a task waiting on a question does not block the queue — but a paused task's world may have
  changed by the time it resumes; the step is told to look before repeating anything.
- Tool calls are audited under the task but not under the individual **step** (the audit schema has a `step_id` column that is
  not filled in); the timeline carries the step id in its own events.
- Not built here: sub-tasks, plan editing by the person, vision-based steps. (Scheduled/recurring tasks arrived in Phase 10.)

## Phase 10 — Automation 🧩 (verified against a scripted model and a fake clock; Allaya was never left running for days, and Windows was not used)

`@allaya/automation` (Electron-free: schedule maths, the scheduler, the model's tools) + `AutomationService` / `DbAutomationStore`
in the main process + the Automations screen. An **automation** is a saved _instruction_ plus a _trigger_. When the trigger
fires, the scheduler starts an **ordinary task** from that instruction (source `automation`) through the same task engine, tool
pipeline, permissions and confirmations as everything else. It is not a second way to reach the computer.

| Item                                                                                                                                                                                                                                                                                                                                         | State                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Triggers: manual, once, every N minutes (5 minutes to 7 days), daily on chosen weekdays, monthly (day 1–28), and **a new file in a folder** (polling; see caveats). One strict schema shared by the scheduler, the model's tool, the database and the screen                                                                                 | ✅ (unit + integration)                                    |
| Local-time schedule maths, including **daylight-saving** changes (spring-forward, fall-back, a half-hour shift in the southern hemisphere, a zone with no daylight saving), month lengths and leap years                                                                                                                                     | ✅ (unit; zones switched with `TZ`)                        |
| A run is an ordinary task: same tools, same permission defaults, same confirmations. An unattended run that needs a click **waits for the person** (shown as "Needs you"); it never gets extra rights because nobody is watching                                                                                                             | ✅ (integration + security + E2E)                          |
| **Missed runs**: if Allaya was closed at the time, the default is to **skip** (recorded as "Allaya was closed at that time"); "run once when Allaya opens" is opt-in. A 2-minute grace stops a late timer tick from counting as missed                                                                                                       | ✅ (unit + integration)                                    |
| **No overlap**: a moment that arrives while the previous run is still going (or waiting for the person, or paused) is recorded as skipped ("the previous run was still going"), never queued up                                                                                                                                              | ✅ (unit + integration)                                    |
| **Circuit breaker**: 3 runs in a row that fail switch the automation off, and the screen says why. A run the person stopped, or that is waiting for them, is not a failure; a run that completes (even partly) resets the count                                                                                                              | ✅ (unit + integration)                                    |
| **Watched folder**: the first look only records what is already there (nothing runs for old files); later new names start **one** run for the batch (not one per file), with at most 20 names in the request, cleaned and marked as data. A folder Allaya may not read shows a warning, not a crash                                          | ✅ (unit + integration + security)                         |
| **Emergency stop** (the STOP button, or a typed "stop") cancels the running task **and pauses every schedule** until the person turns automations back on. The pause is saved, so it survives a restart. Closing the app is not a stop and pauses nothing. (Only when something is scheduled: a manual-only automation has nothing to pause) | ✅ (integration + security + E2E incl. a real relaunch)    |
| "Run now" always works, even while paused (the person is asking, on the screen)                                                                                                                                                                                                                                                              | ✅ (unit + integration)                                    |
| `create_automation` (chat only): **CRITICAL**, so it always needs an on-screen click on a question that shows the name, the schedule and the whole instruction. It is **denied at execution time** to tasks and unattended runs, so nothing that runs by itself can create more things that run by themselves                                | ✅ (unit + security + E2E; two rules mutation-checked)     |
| Persistence and recovery: automations, run history and the watched-folder memory are in SQLite (migration `0003`). On start each run is reconciled with its task: finished while closed → recorded; interrupted (task paused) → "Needs you — paused", still counted as going; task removed → stopped. A deleted automation keeps its tasks   | ✅ (integration incl. restart; E2E relaunch for the pause) |
| Limits: 20 automations, 2000-character instructions (600 when the model writes one), run history trimmed to 100 per automation                                                                                                                                                                                                               | ✅ (unit + integration)                                    |
| Automations screen: list with the schedule in words, next run, last result, on/off switch, run now, history (with the note for skipped/missed runs and a link to the task), create/edit form with inline checks, delete with a question, the paused banner; Bengali; Tasks has a "Scheduled" tab                                             | ✅ (renderer tests + E2E)                                  |

**How it was tested:** `tests/unit/automation/*` (schedule, DST, scheduler, tools), `tests/integration/automations.test.ts` and
`automation-store.test.ts` (real pipeline, real SQLite and files, a scripted model), `tests/security/automations.test.ts`,
`tests/unit/renderer/automations-screen.test.tsx`, `tests/e2e/automations.spec.ts` (4 tests, real Electron, including a
relaunch). Thirteen rules were **mutation-checked** (each was broken on purpose and a test failed): missed-run skip, overlap,
circuit breaker, pause, name cleaning, first-snapshot, folder events not lost while busy, advance-after-fire, CRITICAL risk,
creation denied inside tasks, STOP pauses, closing does not pause, no schedules in the past.

**Caveats — read these**

- **Allaya must be running for anything to happen.** Schedules are checked by a timer inside the app (every 30 seconds). There
  is no system service and no wake-from-sleep. Until the tray/background behaviour of Phase 13, closing the window ends the
  schedule; a run missed that way is skipped (or run once on opening, if chosen). A long soak test was **not** done.
- **Only scripted models were used**, as in Phase 9. What a real model does with an unattended instruction — including how it
  behaves when a step needs a click and nobody is there — is unverified beyond "the task waits".
- **Instruction-based, not a workflow builder.** An automation is one written instruction, run by the task engine. There is no
  node-graph editor, no branching, no chaining of automations; the `automation_steps` table exists in the schema and is
  **unused**. Each run's actions are audited under its task, not per step.
- **A paused or waiting run blocks the automation** until the person resumes, answers or stops that task (skipped moments are
  recorded as "still going"). That is deliberate — it prevents two copies and any unattended repeat — but it means one
  forgotten paused run stops a schedule until someone looks. The Automations and Tasks screens both show it.
- **Event triggers are only "a new file in a folder"**, found by listing the folder every 30 seconds (through the file service,
  so scoped and permission-checked like any read). It sees new _names_: a file replaced under the same name, or one that
  appears and vanishes between two looks, is missed. There is no trigger for a Windows app opening, a USB device, battery or
  a system event — those need Windows APIs (Phase 13) and are **not built**. The memory of seen names is capped at 2000.
- **Daylight-saving edge cases:** a time that does not exist that day (02:30 on a spring-forward day) runs once, an hour later; a
  time that happens twice runs once. Tested with fake clocks in New York, London, Lord Howe and Dhaka — not on a real machine
  that crossed a change, and not in every zone (a zone that skips a whole calendar day is untested).
- A folder trigger's file names are **untrusted text** that reach the model (line breaks and other control characters become
  spaces, `<` and `>` are removed, length is capped at 200, and the names are marked as data). A hostile file name cannot add
  permissions, but a model could still be _steered_ by it; the permission pipeline is the defence, not the wording.
- The global (system-wide) emergency-stop shortcut is Phase 12/13; today STOP works from the app's window and by typing "stop".
- Windows-only behaviour (sleep/resume ordering, what happens across a real logoff) is **unverified**; Phase 10 ran on Linux only.

## Phase 11 — Memory 🧩 (verified against a scripted model, a real SQLite file and real Electron; no real AI provider, no Windows)

`@allaya/memory` (Electron-free: the store port, the secret/rule guard, retrieval, the prompt block, the manager and the model's
tools) + `DbMemoryStore` / IPC handlers in the main process + the Memory screen. Memory is **the person's notebook**: they can
see, add, change, remove, save a copy of, and switch off every entry. The AI can only _suggest_ one, and nothing is stored
without a yes on the screen.

| Item                                                                                                                                                                                                                                                                                                                                      | State                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Memory screen: entries with who added them (you / suggested by Allaya and approved by you), how often and when last used; category filter and search (Bengali included); add, edit, forget one, forget everything (each asks first); master switch; "Save a copy…" (a JSON file, chosen in a system dialog); the privacy promise in words | ✅ (renderer tests + E2E)                                 |
| Storage in SQLite (migration `0004`: origin, use count, last used); 500 entries at most, 60-character titles, 500-character text; the same title in the same category is one entry (case and spacing ignored)                                                                                                                             | ✅ (unit + integration)                                   |
| **Nothing the AI proposes is stored without a yes.** `remember` and `forget` are HIGH risk with no "always allow" to fall back on, so every use asks and shows exactly what will be kept, or removed (and what a new entry would replace)                                                                                                 | ✅ (unit + integration + security + E2E)                  |
| **Secrets are never kept**: keys and tokens, JWTs, private keys, card numbers (checksum-verified, Bengali digits too), "password/PIN/OTP is …" in English and Bengali, long random strings. Refused before the person is asked, and refused for entries typed by hand too, with the reason shown                                          | ✅ (unit + integration + E2E; heuristic — see caveats)    |
| **A memory cannot change how permission works.** Text that reads like an order about Allaya's own rules ("never ask", "always allow", "ignore the rules", English and Bengali) is refused when the AI proposes it; and _nothing_ stored can grant anything — deleting still asks, confirmations still appear                              | ✅ (unit + security; heuristic guard, structural defence) |
| Standing instructions (category "Instructions") can only be written by the person, never by the AI                                                                                                                                                                                                                                        | ✅ (unit + integration; mutation-checked)                 |
| What the AI is given: only entries that share a word with the message (plus the person's own "Instructions" and "Language" entries), at most 8 and about 1500 characters, as a fenced block that says it is information about the user, not orders; an entry cannot close the fence or fake a tag                                         | ✅ (unit + integration + security)                        |
| Provenance: each reply records which memories it was given and shows "Used from memory: …" with a link to the screen; the screen shows use counts. Tasks get the same memory once per task (counted once), not shown on the task                                                                                                          | ✅ (integration + E2E)                                    |
| Master switch off: nothing is given to the AI, nothing new is saved or forgotten by it, and what is already there stays until the person deletes it                                                                                                                                                                                       | ✅ (unit + integration + E2E)                             |
| Tasks and unattended runs are **never offered** `remember` / `forget` (a task reads web pages and files) and are refused if they name them; `recall` (read-only) is available                                                                                                                                                             | ✅ (unit + integration + security; mutation-checked)      |
| Privacy of the record: the audit trail says something was remembered, not what; memory text does not reach the logs or the audit rows                                                                                                                                                                                                     | ✅ (security)                                             |
| IPC: strict schemas, sender check on every channel (including reads and the save-a-copy), the renderer cannot name a file path for the export                                                                                                                                                                                             | ✅ (security + integration)                               |

**How it was tested:** `tests/unit/memory/*` (text, guard, retrieval, prompt block, manager, tools incl. the real pipeline),
`tests/integration/memory.test.ts` (real pipeline, SQLite, chat and task engine with a scripted model, restart),
`tests/security/memory.test.ts`, `tests/unit/renderer/memory-screen.test.tsx`, `tests/e2e/memory.spec.ts` (5 tests, real
Electron, including a relaunch). Twenty rules were **mutation-checked** (each broken on purpose; a test failed): secret guard,
rule guard, standing instructions for the AI, the AI's schema, HIGH risk, fence characters, memory-off (prompt and tools), tasks
denied, standing entries always considered, no dumping of everything, once-per-task counting, audit keeps no content, ask
after refusing, duplicates, the limit, the size budget, use counting, and the reply's record. One survived at first (a task
counted a use on every model call) and led to a stronger test.

**Caveats — read these**

- **Retrieval is plain word matching**, not meaning. A memory is found only if it shares a word with the message (English
  plurals and a short list of Bengali endings are handled; synonyms, other languages — an English question about a Bengali
  entry — and paraphrases are missed). No embeddings, no model call, nothing sent anywhere to search. Only scripted messages were
  tried; how often real conversations find the right memory is **unmeasured**.
- **What is remembered is sent to your AI provider** inside the system prompt of the messages it matches (it must be, for the AI
  to use it). Memory is stored in the local SQLite file **unencrypted** (only API keys are encrypted); anyone with access to the
  user's profile folder can read it. The screen says the first; the second is documented here.
- **The secret and rule guards are heuristics.** They catch common formats and phrasings, not everything: a short password
  with no keyword, an unusual key format, or an order phrased in a way not listed will pass. They also refuse harmless text that
  looks like a secret (a 32+ character token-like word). The defences that do not depend on them: the AI cannot save without a
  yes, a memory is fenced as data, and permissions and confirmations are enforced by the app.
- A stored memory **can still influence what the AI says or chooses** (it is text in the prompt); it cannot widen what it is
  allowed to do. The person's own "Instructions" entries are trusted as the person's words.
- **Only scripted models were used.** When a real model decides to suggest a memory (or to ignore the rules in the prompt) is
  unverified; the app's checks do not rely on it behaving.
- **Not built:** silent/automatic learning (Allaya never saves on its own), import from a file, a "why was this remembered"
  history, confidence scores (the column exists and is unused), a `system` source (never produced), semantic search, syncing
  between computers, quick voice/Banglish "remember that…" commands in the local intent parser (they go through the model).
- The **Save a copy dialog** is Electron's; in tests it is replaced by a fixed path, so the real dialog is unverified, as is
  everything Windows-specific.

## Phase 12 — Security hardening 🪟 (verified on Linux against real Electron; the system-wide key was verified on X11 only, Windows not at all)

Phase 12 closes the gaps between "the app is safe" and "the person can see and steer that it is safe": the Permissions screen, the
Activity (audit) screen, a real system-wide emergency-stop key, an automatic review of the whole renderer→main surface, and
extra hardening checks in real Electron.

| Item                                                                                                                                                                                                                                                                                                                   | State                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Permissions screen**: every capability and sensitive action with what it allows, its setting (Always allow / Ask / Never), whether it is the default or changed, and "Reset to defaults" (asks first). Sensitive actions are not even offered "Always allow" (and the backend refuses it too)                        | ✅ (renderer + integration + E2E incl. a relaunch)                              |
| The screen says that the most dangerous actions (paying, creating automations) always need an on-screen click whatever is set, and points to the folder and website lists that live on the Files and Browser screens                                                                                                   | ✅ (renderer)                                                                   |
| **System-wide emergency-stop key** (default Ctrl+Shift+Esc): registered with the operating system, works when Allaya is hidden or another program is in front, follows the shortcut setting (old key released, new one taken), released on quit; stops exactly what the STOP button stops                              | ✅ (unit; registered on X11 in E2E; a real key press verified once — see below) |
| It is **never silent when it cannot work**: another program holding the key, an invalid combination, or no shortcut support each show a plain message on the Permissions screen; the STOP button and an in-window key keep working regardless (the in-window key works from text fields)                               | ✅ (unit + renderer + E2E)                                                      |
| **Activity screen**: what Allaya did, when, how risky, how permission was settled ("you allowed it", "you said no", "blocked by your settings"…), what went wrong; filter by result and risk, search (matched literally), newest first with "Show older", refreshes when something is recorded; clear all (asks first) | ✅ (renderer + integration + E2E)                                               |
| The record shows only what is safe to show: never the stored structured details; unknown values in a damaged row degrade instead of breaking the screen; audit text stays free of typed text, file contents and memory text (unchanged from earlier phases)                                                            | ✅ (integration + security)                                                     |
| Old entries are removed at start-up (90 days); clearing never breaks a call that is still running (its row is kept so its result can be written)                                                                                                                                                                       | ✅ (integration; both mutation-checked)                                         |
| **The whole IPC surface is checked automatically**, channel by channel: every channel refuses a foreign page, a sub-frame of the app, wrong-kind payloads and prototype tricks; unknown fields are refused or stripped; no channel takes a path, address, command or script unless it has been reviewed                | ✅ (security; a new channel is covered the moment it is added)                  |
| Real-Electron hardening checks: no popups, no navigating away, no outside connections (CSP violation observed), one window — on top of the existing isolation, CSP, nonce and app-protocol checks                                                                                                                      | ✅ (E2E)                                                                        |
| Dependency review: `pnpm audit --prod` finds nothing; the full audit finds one **dev-only** moderate advisory (esbuild ≤0.24.2 via `drizzle-kit`, used only to generate migrations, never shipped)                                                                                                                     | ✅ (run once, on the day; not automated)                                        |

**How it was tested:** `tests/unit/emergency-shortcut.test.ts`, `tests/integration/activity.test.ts` and `safety.test.ts`,
`tests/security/ipc-surface.test.ts` (the whole surface), `tests/unit/renderer/safety-screens.test.tsx`,
`tests/e2e/safety.spec.ts` (5 tests, real Electron). Thirteen rules were **mutation-checked** (each broken on purpose; a test failed):
wildcard-free search, clearing keeps running calls, retention, sensitive never "always allow", reset, old key released, no
silent failure to register, a failing stop is contained, unknown result values, page size limit, sub-frame refusal, the setting
is followed, and the in-window key. The global key was also pressed **at operating-system level** (a synthetic X11 key press
through the X server) in a one-off run: it stopped a reply in progress. That run is not part of the suite.

**Caveats — read these**

- **Windows was not used.** The system-wide key uses Electron's `globalShortcut`, which behaves differently per platform: on
  Windows some combinations are reserved by the system or other software, and Ctrl+Shift+Esc is Windows' own Task Manager
  shortcut — **it may well be refused there** (the screen would then say so, and the in-window key and STOP button still work).
  Consider a different default on Windows once it can be tried; nothing here proves it works there. On Wayland a global key may
  not be possible at all.
- **The synthetic key press is not the suite.** Delivery of a real global key press is verified once, manually, on X11; the
  automated tests check registration and the handler.
- The security review is **automated where it can be and otherwise by reading**: the IPC surface test proves refusals and shapes,
  not that each handler is free of logic errors. It is not a penetration test, and no third party has reviewed the app.
- **The Activity record is a convenience log, not tamper-proof evidence.** It lives in the same local database Allaya writes
  to; anything able to edit that file can change it, and the person can clear it. Entries are not signed or chained.
- The Permissions screen edits Allaya's own permission settings; it cannot revoke what the operating system has granted
  (for example the microphone at Windows level).
- Activity has no export and no per-task view yet (a task's own actions are on the task); retention (90 days) is fixed.
- `pnpm audit` was run once, on the day, with network access; it is not part of CI here.

## Not started

Phases 13–15 (Windows polish, testing pass, release). Anything that needs Windows UI Automation, the tray,
global hotkeys on Windows, the installer, or auto-update **cannot be verified in this Linux environment** and will be marked 🪟
until run on Windows.
