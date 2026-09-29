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

## 6. Not yet covered (honest status)

See `docs/STATUS.md` for the per-requirement state. Security items that are designed but not yet built or not yet
verifiable in this environment are tracked there, notably: the tool permission/risk engine and confirmation flow,
the global (system-wide) emergency-stop shortcut, and Windows-specific hardening (UI Automation scope, installer signing,
auto-update signature verification). Those require the corresponding phases and, for the Windows-specific items,
a real Windows machine.
