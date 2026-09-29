# Allaya security model

> The AI decides **what** needs to happen. The trusted local runtime decides **how** it is safely executed.

Allaya is an agent that can operate a computer, so security is a product feature, not an add-on. This
document states the guarantees the code is designed to provide, where each one is enforced, and how it is
tested. It also lists what is _not_ yet covered.

## 1. Process isolation

| Layer                     | Trust                                                       |
| ------------------------- | ----------------------------------------------------------- |
| Renderer (React UI)       | **Untrusted.** Sandboxed, no Node, no Electron, no `fs`     |
| Preload (`contextBridge`) | Exposes exactly two functions: `invoke`, `subscribe`        |
| Main process              | **Trusted.** All I/O, credentials, files, browser, database |

Enforced by:

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webviewTag: false`,
  `webSecurity: true`, `allowRunningInsecureContent: false` (`main/windows/main-window.ts`).
- Navigation is locked to our own origin; `window.open` is denied; external `http(s)`/`mailto` links open
  in the system browser only after URL validation; `<webview>` attachment is blocked
  (`main/security/window-security.ts`).
- Every web-platform permission request is denied by default. The microphone — audio only, never the camera — is
  granted to our own origin, and only after the user has turned voice on (see §5).
- ESLint `no-restricted-imports` **fails the build** if renderer code imports Node built-ins, Electron, or any
  system-level `@allaya/*` package, or if a domain package imports Electron/React/apps.

Tests: `tests/e2e/launch.spec.ts` (real Electron: no `require`/`process`/`Buffer` in the page; bridge exposes only
`invoke`/`subscribe`), lint boundary rules run in CI.

## 2. IPC hardening

All renderer → main traffic goes through one channel handled by `IpcDispatcher`
(`main/ipc/dispatcher.ts`):

1. **Sender verified**: must be the main frame of a window loaded from our origin (`allaya-app://app`, or the
   dev server in development).
2. **Envelope validated** (`zod`), channel name length-bounded.
3. **Channel allow-listed** by an `hasOwnProperty` lookup on the contract (no prototype-chain tricks:
   `__proto__`, `constructor`, `toString` are unknown channels).
4. **Payload validated** against that channel's schema. Error responses never echo the offending value.
5. **Handler output validated** against the response schema (strict outside production).
6. **Errors normalised**: handlers never throw across the boundary; unknown failures are logged in full but reported as a
   generic `INTERNAL` — no stack traces, file paths, or secrets reach the UI.

The contract (`packages/validation/src/ipc`) is the single source of truth: the preload allow-list, dispatcher
validation, handler table types and the renderer client are all derived from it, and startup fails if a declared
channel has no handler. Settings can only be written through a typed registry — there is no "write any key" channel.

Tests: `tests/integration/ipc.test.ts` (untrusted origin, sub-frame, malformed envelopes, prototype-pollution
channel names, payload/secret echo, crashing handler, contract-violating response, duplicate registration).

## 3. Content Security Policy and the app protocol

The renderer is **not** loaded from `file://`. It is served by a privileged custom scheme,
`allaya-app://app/`, handled in the main process (`main/security/app-protocol.ts`). This gives it a stable
origin and lets the main process attach a real CSP **header** with a fresh **per-response nonce**.

Production policy (`main/security/csp.ts`):

```
default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-<random>';
img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'
```

- No `unsafe-inline` or `unsafe-eval` anywhere in production. The two libraries that inject `<style>` elements
  (Radix scroll-lock, Radix Select) receive the nonce (`renderer/src/lib/nonce.ts`).
- `connect-src 'self'`: **the renderer cannot make network requests.** AI calls, downloads and browsing all happen
  in the main process, which is what makes the "never silently upload" privacy rule enforceable.
- The protocol handler is a path-traversal-safe static server: encoded dots/slashes, backslashes, drive
  letters, NUL bytes and foreign hosts are refused, and the resolved path must stay inside the renderer root.

Tests: `tests/security/app-protocol.test.ts` (traversal corpus + confinement invariant, nonce uniqueness, policy
shape, origin trust) and `tests/e2e/launch.spec.ts` (header present in the real app; a `<style>` with the page's
nonce is honoured, without it is blocked; inline `<script>` never runs; traversal returns 403; every load has a
different nonce). `tests/e2e/shell.spec.ts` fails if **any** CSP violation occurs while using dialogs, dropdowns,
the command palette, and toasts.

## 4. Secrets

- API keys are only ever handled in the main process. They are stored encrypted with the OS keychain
  (Electron `safeStorage`, DPAPI on Windows); only a masked hint (`sk-…a1b2`) is ever sent to the UI.
- Logging, audit records and diagnostics export pass through `redact()` (`packages/shared/src/redaction.ts`), which
  masks sensitive keys and credential-shaped values (Anthropic/OpenAI/OpenRouter/Google keys, GitHub tokens, JWTs,
  `Bearer …`, `?key=` query parameters) at any depth, without mutating the input and safe against cycles.

Tests: `tests/unit/shared/redaction.test.ts`.

## 5. Microphone and voice

| Guarantee                                                                                                   | Enforced by                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The microphone is unavailable until the user turns voice on; turning it off revokes it immediately          | `isPermissionAllowed` (`window-security.ts`), synced from `voice.enabled` |
| The camera (video) is never granted — alone or combined with audio                                          | same policy function                                                      |
| Consent dialog explains that speech goes to the user's own OpenAI account and that recordings are not saved | `voice-setup-modal.tsx`                                                   |
| Audio exists only in memory: never written to disk, never logged, never sent over events                    | `VoiceService` (integration test greps logs/events)                       |
| Transcripts are not logged (they may contain anything the user said)                                        | `VoiceService`                                                            |
| Speech-to-text keys stay in the main process; the renderer only ever sends audio and receives text          | vault + `AudioEndpoint`                                                   |
| A low-confidence, uncertain or **destructive** transcript is never acted on: it is shown for review first   | `decideSubmission` (`@allaya/speech`), evaluated in main                  |
| Silence hallucinations ("Thanks for watching!") are discarded, not sent                                     | `isLikelyHallucination`                                                   |
| "Stop" spoken or typed as the whole message is handled immediately; a stop word inside a sentence never is  | intent parser `standalone` rule + chat integration                        |
| One STOP silences microphone, speech and running tasks; late results from cancelled requests are ignored    | `VoiceStateMachine` epochs + header STOP                                  |
| Allaya never talks over the user                                                                            | state machine refuses `start_speaking` while listening/processing         |

Tests: `tests/security/permissions.test.ts`, `tests/integration/voice.test.ts`, `tests/unit/speech/*`,
`tests/unit/renderer/voice-store.test.ts`, and `tests/e2e/voice.spec.ts` (real Electron: mic and camera denied before
consent, mic granted after, revoked when voice is switched off).

## 6. Tools: what the AI may cause, and how it is stopped

The model can only _request_ an action. Everything after that is decided by trusted code in `@allaya/tools`:

1. **Validate** the arguments against the tool's zod schema. Risk and required permissions are computed from the
   _validated_ arguments (a hostile `recursive: true` cannot hide behind a benign-looking call).
2. **Policy** (`evaluatePolicy`, one pure, exhaustively tested function): a subject set to _never_ denies the action;
   CRITICAL always needs a fresh confirmation **on screen** (a spoken or typed "yes" is refused); sensitive actions (delete
   files, send email, install software, admin commands, external communication) can never be "always allow"; MEDIUM/HIGH ask
   unless every subject is always-allowed; LOW observation never interrupts.
3. **Confirm**: the approval belongs to one request and to the exact arguments that were validated; silence expires as "no";
   STOP cancels it; only the first answer counts.
4. **Run** with a timeout and cancellation that work even if the tool ignores its abort signal.
5. **Verify** with an independent check. A failed check turns "ran" into "failed"; a missing check is reported to the model as
   _unverified_ with an instruction not to claim success (§131).
6. **Audit** every attempt — including refused, unknown-tool and invalid calls — with redacted, size-bounded arguments.
   **If the record cannot be written, the action does not run.**

Also enforced: the registry refuses a state-changing tool that declares itself LOW risk; unknown tool names from a model are a
normal, audited error; one reply is limited to 8 tool rounds and 8 calls per round; a reply cut off by the length limit never
executes a half-received tool call.

Tests: `tests/unit/tools/*` (policy invariants, broker, executor with mutation-checked properties), `tests/integration/agent-tools.test.ts`
(the loop, confirmations by button/typed/spoken answer, permissions, audit, cancellation), `tests/e2e/tools.spec.ts` (real UI).

## 7. Computer control

- **Launching** is catalog-only. The model supplies a _name_; a fixed table decides what runs. Paths, command lines and shell
  text are rejected (`resolveApp`, `WindowsAdapter.launch`).
- **Input** (typing, shortcuts, clicks, UI Automation) is refused for shells, system tools (Task Manager, Registry Editor, MMC,
  UAC prompt…), elevated windows and Allaya itself — enforced in the engine, so neither the model nor an approved confirmation can
  override it. Shortcuts that leave the window (Win+…, Alt+F4, Ctrl+Alt+Del, Ctrl+Shift+Esc) are refused. Text is bounded, click
  coordinates must be on a display and not inside an off-limits window, and input is rate limited.
- **Windows helpers never receive code from data**: each PowerShell program is a constant; arguments are JSON in `ALLAYA_ARGS`.
  Window ids must be decimal handles and executables plain names before they reach a script. (`tests/unit/computer/windows-adapter.test.ts`
  proves the script text is identical whatever the input, and executes the launch program with hostile arguments under a real
  PowerShell where available.)
- **Privacy**: typed text and clipboard contents are kept out of the audit log; clipboard reads always ask; screenshots are saved
  locally and never sent to a provider.
- **Honesty**: input tools report their effect as _unverified_ rather than claiming success.

## 8. File access

- **One guard for everything.** The model's file tools and the Files screen both call `FileManager`, which resolves every path
  through `PathPolicy` first. There is no second, looser path.
- **Scope.** Only the known folders and folders the user added with the system picker. A path must begin with such a folder's
  name or lie inside one. `..` is refused (not normalised). After resolving links on disk the result must _still_ be inside
  the folder, so a shortcut placed in Documents cannot lead to `C:\Windows` or to Allaya's own data. Network, device,
  alternate-data-stream, reserved-name, 8.3 short-name and text-direction-spoofing names are refused.
- **Secrets and system files.** Names that usually hold credentials (`.ssh`, `.env*`, keys, password databases, browser
  profiles) can't be read, listed, searched, copied or changed; system-managed names can't be changed. Allaya's own data
  folder can't be reached from either side. Folders that would expose these (a drive, the user profile, `AppData`, the app
  data folder) can't be added.
- **No programs.** Allaya never creates, renames to, or opens `.exe/.bat/.ps1/.js/.lnk/…`, so it cannot be talked into
  planting something the user might double-click.
- **Non-destructive by construction.** Create/copy/move/rename refuse an existing name. Replacing a file needs an explicit flag,
  is HIGH risk (always asks), and keeps the old version. Delete only moves to the trash: a file is HIGH, a folder is CRITICAL
  (on-screen click only). Roots can't be moved, renamed or deleted. Every change is verified afterwards and journaled.
- **Undo never destroys the user's work.** It re-validates paths against the current folders and refuses if the file changed
  since Allaya's change (size or timestamp).
- **Privacy.** Reading a file asks first and says the text goes to the AI provider; the audit log records that a file was read
  or written and how large it was, never its content. The prompt tells the model that file contents are data, not orders.
- **Bounded.** Reads, searches and copies have fixed limits; long operations honour STOP.
- **Same pipeline from the screen.** Changes made in the Files screen run through the tool executor (permission, confirmation,
  verification, audit) and are cancelled by the emergency stop. Switching `file_access` off blocks both the tools and the screen.

Tests: `tests/unit/filesystem/*` (real temp directories, `EXDEV` simulated, ten mutation-checked properties),
`tests/security/filesystem.test.ts` (hostile-input battery and a generated-path property test),
`tests/integration/files.test.ts` (model and screen paths, audit contents, restart), `tests/e2e/files.spec.ts` (real Electron).
**Unverified:** NTFS junction/short-name/case behaviour, the Recycle Bin, and the race between checking a path and using it.

## 9. Browser

- **One choke point for the network.** The browser is started so that it can only reach the internet through Allaya's local
  filtering proxy (`--proxy-server`, loopback included, no local name resolution, no QUIC, restricted WebRTC). The proxy judges
  **every** connection — the page, redirects, images, scripts, `fetch`, XHR, WebSockets — _before_ connecting, and connects
  to the addresses it vetted, so a name that answers differently a second time (DNS rebinding) leads nowhere. (Request
  interception in Playwright was tried first and rejected: it does not see redirect hops, so a redirect to `127.0.0.1`
  went through. The test that found it keeps guarding it.)
- **What is never opened.** Anything on the local network or this computer (loopback, private, link-local, cloud-metadata,
  CGNAT ranges — in decimal, hex, octal, IPv6 and IPv4-mapped forms), local names, non-http(s) schemes, addresses with
  credentials in them, blocked sites (including via redirect). Look-alike (internationalised) site names are shown with their
  real punycode name when asking.
- **Asking.** A site not visited before asks once (per session, or never if trusted). Clicking what looks like _paying_ is
  CRITICAL (on-screen click only); _sending, deleting, signing in_ are HIGH and cannot be silenced by "always allow"; the
  question names the control and its destination.
- **Never types secrets.** Password, card, one-time-code and identity fields are refused by the engine (not merely
  confirmed). The person signs in themselves in Allaya's browser window; cookies live in Allaya's own profile, separate from
  their everyday browser.
- **A web page is untrusted input.** Its text is handed to the model as data with a standing warning; text that looks like
  instructions to an AI is flagged; an address a page plants is refused without troubling the user; refs to controls expire
  when the page changes.
- **No dangerous surfaces.** Downloads are cancelled, file pickers are never answered, permission prompts are denied,
  service workers are blocked, page dialogs are dismissed and reported, there is no JavaScript-evaluation, cookie or upload tool.
- **Privacy.** The audit log keeps where the browser went (no query strings or fragments), never typed text or page content.
  Screenshots are saved locally and not sent to any provider.
- **Bounded.** 8 tabs, 90 actions a minute, capped reads and controls; STOP aborts loads.

Tests: `tests/unit/browser/*` (URL/IP policy, page model, engine on a scripted web, tools), `tests/integration/safe-proxy.test.ts`
(the proxy against real sockets), `tests/integration/browser-playwright.test.ts` (a **real Chromium** against a local server whose
`/secret` path stands for the local network — it must stay at zero hits), `tests/integration/browser.test.ts` (agent loop, audit,
settings), `tests/e2e/browser.spec.ts` (real Electron + Chromium). Eight safety properties are mutation-checked.
**Unverified:** Edge/Chrome on Windows, the Chromium sandbox and the visible window, proxy-requiring networks (unsupported), and
that `playwright-core` ships correctly in an installer.

## 10. Tasks (the task engine)

- **A task has no more power than a chat message.** Its model calls tools through the one `ToolService.execute` road:
  same argument validation, risk and permission policy, confirmation, timeouts, verification and audit. There is no second
  path to the computer, so a compromised plan or a hostile file/page cannot do what a chat message could not (a task that
  reads a file telling it to delete things, or a compromised planner that plans a deletion, meets the same refusals).
- **A plan is a proposal, never a permission.** Approving a plan lets the task _try_; each risky action still asks on its own,
  CRITICAL ones need an on-screen click (a typed or spoken "yes" is refused by the confirmation broker), and "always allow"
  cannot weaken sensitive actions. The plan preview is an estimate that only knows the tools the plan names.
- **The model cannot certify its own work.** A step is done only if something ran and the last change worked; unconfirmed
  changes are marked and mentioned in the answer; the final verdict can only be made stricter than the model's by the record.
- **"No" stays no.** When the person declines (or does not answer in time) the step stops immediately; the model is not given a
  chance to retry or route around it. Refusals that will not change (protected locations, secrets, a permission switched off)
  are never retried.
- **Reserved names.** `submit_plan`, `finish_step`, `ask_user`, `finish_task` and `start_task` belong to the agent; a real tool
  may not use them (startup fails), and the tool that starts a task is never offered inside a task (no tasks starting tasks).
- **Bounded.** Steps, rounds, attempts, actions, running time and questions are all capped by the orchestrator, not the model.
  One task runs at a time.
- **Stoppable.** The emergency stop and a typed "stop" cancel running and queued tasks and any open question; STOP on a task
  aborts its model call and its running action. Closing the app pauses tasks as _interrupted_; nothing resumes without the person.
- **Privacy.** The timeline and audit trail keep tool names, verified/unverified, risk and privacy-safe summaries — not typed
  text, file contents or clipboard text. The task text and the model's step summaries and answers are stored as written.
  Removing a task removes its history but keeps its audit rows (detached from the task).
- **Chat answers are careful.** A message typed while a task waits is taken as the answer only if it is not a clear command of
  its own; "yes"/"no" approve a plan or continue after a decline; a spoken "yes" cannot approve a CRITICAL action.

Tests: `tests/unit/agent/tasks/*` (state machine, plan validation, complexity, and 65 orchestrator scenarios — fourteen safety
rules mutation-checked; eight more in the integration/security tests), `tests/integration/tasks.test.ts` and `task-store.test.ts` (real pipeline and files, chat, restart and
crash recovery), `tests/security/tasks.test.ts` (reserved names, hostile payloads, untrusted senders, the CRITICAL-by-voice
case, the emergency stop with a question open, what is recorded), `tests/unit/renderer/tasks-screen.test.tsx`,
`tests/e2e/tasks.spec.ts` (real Electron, including quitting and relaunching mid-task).
**Unverified:** behaviour with real AI providers (a real model may plan badly or resist the step/finish protocol), and everything
Windows-specific the tools depend on.

## 11. Automations (things that run by themselves)

An automation is the most persistent thing Allaya can be asked to do, because it acts again and again while nobody is watching.
The rules below exist so that "nobody is watching" never means "more allowed".

- **An automation run is an ordinary task.** The scheduler only starts a task from a saved instruction; every action still goes
  through the one `ToolService.execute` road (validation, risk, the person's permission settings, confirmation, audit). An
  unattended run whose plan deletes something, or that needs a permission that is set to "ask", **waits for the person**
  (shown as "Needs you") and does nothing by itself; an unanswered question expires as a "no".
- **Creating one needs an on-screen click.** `create_automation` is CRITICAL: the confirmation broker refuses a typed or spoken
  "yes" and shows the name, the schedule and the whole instruction (the model's instruction is capped at 600 characters so it
  can be read in full). Creating one on the Automations screen is the person's own action.
- **Nothing that runs by itself can create more things that run by themselves.** `create_automation` is denied _at execution
  time_ (`ExecuteOptions.deniedTools`) to tasks and unattended runs, not merely left out of the tool list — so a hallucinated or
  injected call is refused too. It is audited as a refused call.
- **The emergency stop is sticky.** STOP (or a typed "stop") cancels the running task and pauses every schedule, and the pause
  is saved: a restart does not lift it, only the person's "Turn automations back on" does. Closing the app is deliberately not a
  stop. "Run now" still works while paused, because it is the person asking, on the screen.
- **No surprise late runs.** If Allaya was closed at the scheduled time the run is skipped (and recorded as missed) unless the
  person chose "run once when Allaya opens". A moment that arrives while the last run is still going, waiting, or paused is
  skipped, never queued. Three failed runs in a row switch the automation off.
- **File names are data.** A watched-folder run hands the model the names of the new files, cleaned (control characters and line
  breaks become spaces, angle brackets removed, 200-character cap), at most 20, and labelled as data not instructions. The first
  look at a folder never triggers anything, and a burst of files is one run, not one per file. Reading the folder goes through the
  file service, so the same scope and permission rules as any file read apply; a folder Allaya may not read is reported, not
  bypassed. A hostile name cannot grant anything, but a model can still be steered by text — the pipeline, not the wording, is
  the defence.
- **The screen's commands are validated like every IPC call** (strict schemas, sender checks, bounded sizes, 20 automations, an
  interval of at least 5 minutes, no times in the past); the hostile-request tests show nothing is created, run or paused by a
  refused request.
- **Privacy.** The instruction and the run history are stored locally as written, like chat messages. Deleting an automation removes
  its history and keeps the tasks it ran (whose audit rows are kept, as for any task).

Tests: `tests/security/automations.test.ts` (hostile requests to the channels, from a foreign page and with bad payloads; an
unattended run cannot exceed a chat message — a deletion waits, a CRITICAL action needs a click, a compromised model cannot
reach outside, read secrets or schedule more work; a flood of files is one bounded run; the pause survives a restart),
`tests/integration/automations.test.ts` and `automation-store.test.ts`, `tests/unit/automation/*`, `tests/unit/tools/executor.test.ts`
(`deniedTools`), `tests/e2e/automations.spec.ts`. Thirteen rules are mutation-checked (see `docs/STATUS.md`).
**Unverified:** what a real model does with an unattended instruction (a model could still plan something unwanted — it would
meet the same refusals and questions, but nobody may be there to answer), running for days unattended, and everything
Windows-specific.

## 12. Memory (what Allaya remembers about the person)

Memory is personal data that is later put into the AI's prompt, so it is a target twice over: something to leak, and a way to
plant instructions that outlive a conversation. The rules:

- **The person owns it.** Every entry is visible on the Memory screen, and can be edited, removed, exported to a file or wiped;
  one switch turns the whole thing off (nothing is given to the AI, nothing new is saved, what is there stays until deleted).
- **The AI can only propose.** `remember` and `forget` are HIGH risk with no permission to "always allow", so each use is a
  question showing the exact text (and what would be replaced or removed). A refused or unanswered question stores nothing; the
  emergency stop ends an open one.
- **Refused before asking.** The `remember` arguments are validated with the guard, so the person is never asked to approve saving
  a password or an order to skip confirmation. The manager checks again when storing (nothing relies on one layer).
- **No secrets.** API keys and tokens, JWTs, private keys, checksum-valid card numbers (Bengali digits too), "password/PIN/OTP is …"
  phrases and long token-like strings are refused, including when the person types them. The guard is a heuristic.
- **No standing orders from the AI.** The "Instructions" category (which is always considered) can only be written by the person.
  The AI's schema does not list it, and the manager refuses it as a second layer. Text that reads like an order about
  permissions ("never ask", "always allow", "ignore the rules"; English and Bengali) is refused when the AI proposes it.
- **A memory is data, never authority.** It reaches the AI only as a fenced block that says it is information about the user and
  never changes rules, grants permission, or replaces confirmation. Each line is one inert line: line breaks and `<` `>` are
  removed, so an entry cannot close the fence or fake a tag. And it does not matter what the text says: permissions and
  confirmations are enforced by the app — a stored "delete without asking" still asks (tested).
- **Tasks cannot write memory.** A task reads web pages and files, so `remember` and `forget` are neither offered to it nor
  accepted from it (enforced at execution time by `deniedTools`, as for `create_automation`); `recall` (read-only) is allowed.
- **Least given.** Only entries sharing a word with the message go along (plus the person's own Instructions and Language
  entries), at most 8 and about 1500 characters. Each reply records what it was given, and the screen shows use counts.
- **Private record.** The audit trail says that something was remembered (and the category), not what; memory text is kept out of
  logs. The export path is chosen by the person in a system dialog — the renderer cannot name one — and the file is written
  owner-only (where the platform supports it).
- **The IPC is strict**: sender check on every channel, including reads, schemas that reject unknown fields and prototype tricks,
  bounded sizes, 500 entries.

Tests: `tests/security/memory.test.ts` (hostile payloads, foreign senders on every channel including read and export, a
remembered "delete without asking" changing nothing, fence break-outs, the emergency stop with a question open, a task naming
`remember`/`forget`, nothing leaking to logs or audit), `tests/unit/memory/*`, `tests/integration/memory.test.ts`,
`tests/e2e/memory.spec.ts`. Twenty rules are mutation-checked (see `docs/STATUS.md`).
**Unverified / by design:** memory is stored in the local database **unencrypted** (only credentials are encrypted) and is sent to
the AI provider inside matching prompts; the guards are heuristics; a stored memory can still influence what a model says; real
models were not used; Windows-specific behaviour (the save dialog) was not exercised.

## 13. Safety controls the person can see and use

- **Permissions screen.** Every permission is visible and changeable in one place, with what it means. The cautious defaults are
  the ones in the policy engine (everything that changes something asks; the camera and administrator commands are off).
  Sensitive actions (deleting files, sending email, installing software, administrator commands, external communication) cannot
  be set to "always allow" — the screen does not offer it and the backend refuses it. CRITICAL actions ignore these settings and
  always need an on-screen click. "Reset to defaults" puts everything back at once.
- **Emergency stop.** One action stops everything: model streams, running and queued tasks, the running action, an open
  confirmation, the microphone, and (by pausing them) every schedule. It can be triggered by the STOP button, by typing "stop", by
  the in-window key (works from text fields), and by a **system-wide key** registered with the operating system so it works when
  Allaya is hidden. The key is re-registered when the setting changes and released on quit. If the system refuses it, the
  Permissions screen says why; nothing else depends on it.
- **Activity record.** Each tool call — allowed, refused, failed or stopped — is recorded with its risk and how permission was
  settled, and shown on the Activity screen without the stored structured details. Typed text, file contents, clipboard text and
  memory text are kept out of it; arguments go through secret redaction. Entries older than 90 days are removed at start-up; the
  person can clear the record (after a question). No tool can clear it, and clearing keeps rows for calls still in flight.
- **The renderer → main surface is a fixed, reviewed list.** A test walks every channel automatically: each refuses any page
  that is not the app's own protocol and any sub-frame; each refuses payloads of the wrong kind and prototype tricks; unknown
  fields are refused or stripped; and no channel may take a path, address, command or script unless it is on a reviewed list (the
  file channels, which go through the file policy, and the browser window, which goes through the URL policy). A new channel that
  does is caught until someone reviews it.
- **The window is not a browser.** No popups, navigation away is blocked, outside connections are blocked by the CSP (observed
  in real Electron), webviews are disabled, one window.
- **Dependencies.** `pnpm audit --prod` reports nothing; the one advisory in the full tree is dev-only (a build tool used to make
  migrations) and is not shipped.

Tests: `tests/security/ipc-surface.test.ts`, `tests/integration/activity.test.ts` and `safety.test.ts`,
`tests/unit/emergency-shortcut.test.ts`, `tests/unit/renderer/safety-screens.test.tsx`, `tests/e2e/safety.spec.ts`.
**Unverified / by design:** the system-wide key on Windows (Ctrl+Shift+Esc is also Task Manager's shortcut there — it may be
refused; the screen would say so), key delivery was checked once by hand on X11; the Activity record is a convenience log, not
tamper-proof; no third-party review or penetration test has been done.

## 14. The desktop shell (tray, notifications, updates, the floating bar)

- **Running out of sight is visible and stoppable.** With "keep running in the tray", closing the window does not quit; the
  first time, a notification says so. The tray icon's tooltip says whether Allaya is ready, working or paused, and its menu has
  STOP, pause/resume automations and Quit. The person can turn the behaviour off. A real quit is never held back.
- **Nothing about a question leaks to the desktop.** A notification that a question is waiting says only that, never what is
  being asked (a notification can be read on a locked screen); the details are in the window, and CRITICAL actions still need a
  click there. A task's notification does show its title (the person's own words, or an automation's name): turn notifications
  off in Settings if that is a concern.
- **Updates are never silent about restarting.** Allaya looks for updates and may download them (both can be turned off), but
  restarting into one happens only when the person presses the button, and never while something is running. Downgrades are
  refused. Trust in an update rests on the feed: the updater checks the file's checksum against the feed's list, and — only for a
  **signed** build (`publisherName`) — the publisher's signature. **The build is not signed yet**, so today an attacker who
  could publish to the release feed could ship a malicious update; protect the publishing account (two-factor, restricted
  access) and sign the build before release. This is the largest supply-chain risk in the project.
- **The sign-in start is the installed app only.** A development or test run never registers itself; the sign-in launch uses
  `--hidden` so it stays in the tray. It is off by default.
- **The floating bar has no extra power.** It is another page of the same app: same sandbox, same origin check, same channels
  (its only extras are "show the app" and "stop everything", both harmless). It shows no confirmations and no content, only
  status; STOP from it is the same emergency stop.
- **The system-wide keys** (stop, show Allaya) can only stop everything or bring the window forward; neither reads anything.
  If the system refuses one, the person is told.
- **The installer is per-user** (no administrator rights) and its uninstaller keeps the person's data.

Tests: `tests/unit/shell/*`, `tests/integration/desktop.test.ts`, `tests/e2e/desktop.spec.ts`,
`tests/packaged/smoke.spec.ts`. **Unverified:** everything on Windows itself (see `docs/STATUS.md` Phase 13 and
`docs/PACKAGING.md`), the real updater against a real feed, code signing (not done), and how Windows treats an unsigned
installer.

## 15. Not yet covered (honest status)

See `docs/STATUS.md` for the per-requirement state. Security items that are designed but not yet built or not yet
verifiable in this environment are tracked there, notably: NTFS-specific file behaviour, Edge/Chrome on Windows, the Windows input adapter's behaviour on a real desktop, the system-wide emergency-stop key on Windows, and Windows-specific hardening (UI Automation scope, installer signing,
auto-update signature verification). Those require the corresponding phases and, for the Windows-specific items,
a real Windows machine.
