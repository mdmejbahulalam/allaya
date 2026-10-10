# Allaya (আলেয়া) — the simple one

A small desktop app: chat with any AI model, and (as it is built) talk to it, browse the web with it, give it tasks on a
schedule, and connect it to the software you use. The earlier, larger app is in `apps/desktop`; this one starts fresh and
reuses only the tested AI provider layer (`@allaya/ai`).

## What works now (steps 1–5)

- Connect any AI service: Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks,
  Perplexity, Cerebras, SambaNova, NVIDIA NIM, Hyperbolic, Moonshot, Ollama, LM Studio, or any OpenAI-compatible address.
  Models are read from the service itself; a service with no list can have model names typed in.
- Keys are encrypted by the operating system (Windows: DPAPI). If it cannot encrypt, saving is refused.
- A chat per conversation, each with its own model; streaming replies that can be stopped; everything saved locally (SQLite).
- The agent loop is already in place (`main/core/agent.ts`): tools the model may call, read tools run freely, tools that
  change something outside the app always ask first (a question on screen: Allow / Don't allow; no answer is a no). The
  browser, tasks and connected apps all plug in through `ToolRegistry`.
- **Voice** (step 2): one click on the microphone starts a spoken conversation — listen, understand, answer with the
  chat's own model, read the answer aloud, listen again — until you end it (or it has been quiet for two minutes). Listening
  and speaking use whichever connected service can do it (OpenAI, Google Gemini, Groq listens) or this computer's own
  voices; so _any_ model can be spoken with, because the voice is separate from the model. Not realtime audio-to-audio
  models (OpenAI Realtime, Gemini Live): those are not built.
- **Browser** (step 3): a real browser beside the chat — tabs, address box, logins kept between runs. Allaya can open
  pages and read them (`open_url`, `read_page`, `list_links`, `list_tabs`, `search_web`) and shows each step. It only
  reads: it never clicks, types or submits. Pages run in a sandbox (no preload, no Node, every permission refused,
  downloads refused); what a page says reaches the model marked as a page's words, never as the person's; and Allaya
  itself will not go to this computer or a private network (the person still can). Not built: clicking and typing on
  pages, downloads, screenshots for vision models.
- **Tasks** (step 4): things Allaya does on its own — now, once at a set time, every N minutes/hours, or at a time of
  day on chosen weekdays. Each task has its own model: pick any model of any connected service, or choose by need (fast
  and cheap, balanced, hard thinking, sees images, long documents) and Allaya picks the one that fits from what is
  connected. A run is a conversation with that model and only the tools the task was given (the web by default; never the
  power to make more tasks); its report and steps are kept. Allaya can propose a task in a chat ("every morning check…");
  nothing is made until the person allows it, and bad requests (a time already past, unclear schedule) are refused
  before the person is asked. At most two tasks run at once; one that was missed while the app was closed runs once when
  it opens (if less than a day late); a run cut off by closing the app is shown as stopped. A task that needs to change
  something outside (a connected app) asks the person first, in the app and as a desktop notice.
  Tasks run **only while Allaya is running**: closing the window can keep it in the tray (a setting, on by default) and it
  can start with Windows, quietly in the tray.
- **Connected apps** (step 5, Settings → Apps): any software that offers an MCP server — GitHub, Gmail, Ahrefs, Notion,
  Linear, Sentry, Supabase, Canva, Vercel, Figma, Jira/Confluence, or any address (or a program on this computer, for
  advanced use). Each one's tools join Allaya's own as `mcp__<app>__<tool>`, in chats and in tasks (a task is given the
  apps it may use, and no others). Signing in: paste a key (GitHub token, Ahrefs MCP key), or sign in on the service's
  own page in the person's browser (OAuth with PKCE; the sign-in comes back to `http://127.0.0.1:38943/callback`), or —
  as Google's Gmail server requires — sign in with an app the person made in their own Google Cloud console (client ID
  and secret). Keys, tokens and program settings are encrypted by the operating system, never shown again, and removed
  from any error text. **What asks first:** a tool runs without asking only if the service is one Allaya trusts (the named
  ones, at their own address) _and_ the tool says it only reads; every other tool — and every tool of an address Allaya
  does not know — asks the person first. Per tool, the person can switch a tool off, or switch asking off or on (a very
  long list starts with only the first 64 tools on). What a service sends back reaches the model marked as information
  from that service, never as an instruction. A program on this computer is started with only the few environment
  variables a program needs plus the ones the person gave it, and is stopped when the app is removed or Allaya quits.
  Verified against the services' own documentation: GitHub (`https://api.githubcopilot.com/mcp/`, personal access
  token), Gmail (`https://gmailmcp.googleapis.com/mcp/v1`, a developer preview that can read and draft but not send),
  Ahrefs (`https://api.ahrefs.com/mcp/mcp`, MCP key). The other addresses are from memory and have not been tried
  against the real services; "Another app" takes any address.
- English and Bengali (the name is আলেয়া), light and dark.

## Using it

See [GUIDE.md](GUIDE.md) (English) and [GUIDE.bn.md](GUIDE.bn.md) (বাংলা).

## Layout

```
apps/lite
  shared/     the contract between screen and engine (zod), presets, defaults
  main/core/  db, secrets, settings, connections, chat, agent loop, tools, tasks, approvals
  main/browser/  the built-in browser and its tools
  main/mcp/      connected apps: the connection, sign-in (OAuth), the one-visit listener, the service that keeps them
  main/shell.ts  tray, desktop notices, start with Windows
  main/ipc/   the one door from the screen into the engine
  main/security/  window/session hardening, app protocol, CSP, cipher
  preload/    exposes `window.allaya` (two functions) to the screen
  renderer/   React screen (zustand, Tailwind)
```

## Commands

```
pnpm lite                 # run in development
pnpm lite:build           # build
pnpm test                 # unit + integration + renderer tests (tests/lite/**)
pnpm test:lite:e2e        # build and drive the real app with Playwright
pnpm --filter @allaya/lite pack         # an unpacked package for this system
pnpm --filter @allaya/lite dist         # the Windows installer (needs Windows)
ALLAYA_LITE_PACKAGED_EXE=<program> pnpm test:lite:packaged   # starts the packaged program and checks it
```

The data lives in its own folder (`%APPDATA%/Allaya Lite`), so it never touches the earlier app's data.
