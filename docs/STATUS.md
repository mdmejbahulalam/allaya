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

## Not started

Phases 9–15 (task engine, automation,
memory, security hardening, Windows polish, release). Anything that needs Windows UI Automation, the tray,
global hotkeys, the installer, or auto-update **cannot be verified in this Linux environment** and will be marked 🪟
until run on Windows.
