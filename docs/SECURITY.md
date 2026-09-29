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

## 10. Not yet covered (honest status)

See `docs/STATUS.md` for the per-requirement state. Security items that are designed but not yet built or not yet
verifiable in this environment are tracked there, notably: NTFS-specific file behaviour, Edge/Chrome on Windows, the Windows input adapter's behaviour on a real desktop, the global (system-wide) emergency-stop shortcut, the Permissions screen, and Windows-specific hardening (UI Automation scope, installer signing,
auto-update signature verification). Those require the corresponding phases and, for the Windows-specific items,
a real Windows machine.
