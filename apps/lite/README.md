# Allaya (আলেয়া) — the simple one

A small desktop app: chat with any AI model, and (as it is built) talk to it, browse the web with it, give it tasks on a
schedule, and connect it to the software you use. The earlier, larger app is in `apps/desktop`; this one starts fresh and
reuses only the tested AI provider layer (`@allaya/ai`).

## What works now (steps 1–4)

- Connect any AI service: Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks,
  Perplexity, Cerebras, SambaNova, NVIDIA NIM, Hyperbolic, Moonshot, Ollama, LM Studio, or any OpenAI-compatible address.
  Models are read from the service itself; a service with no list can have model names typed in.
- Keys are encrypted by the operating system (Windows: DPAPI). If it cannot encrypt, saving is refused.
- A chat per conversation, each with its own model; streaming replies that can be stopped; everything saved locally (SQLite).
- The agent loop is already in place (`main/core/agent.ts`): tools the model may call, read tools run freely, tools that
  change something outside the app always ask first (a question on screen: Allow / Don't allow; no answer is a no). The
  browser and tasks plug in through `ToolRegistry`; connections will too.
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
  something outside (when connections arrive) asks the person first, in the app and as a desktop notice.
  Tasks run **only while Allaya is running**: closing the window can keep it in the tray (a setting, on by default) and it
  can start with Windows, quietly in the tray.
- English and Bengali (the name is আলেয়া), light and dark.

## Layout

```
apps/lite
  shared/     the contract between screen and engine (zod), presets, defaults
  main/core/  db, secrets, settings, connections, chat, agent loop, tools, tasks, approvals
  main/browser/  the built-in browser and its tools
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
```

The data lives in its own folder (`%APPDATA%/Allaya Lite`), so it never touches the earlier app's data.
