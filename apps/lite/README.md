# Allaya (আলেয়া) — the simple one

A small desktop app: chat with any AI model, and (as it is built) talk to it, browse the web with it, give it tasks on a
schedule, and connect it to the software you use. The earlier, larger app is in `apps/desktop`; this one starts fresh and
reuses only the tested AI provider layer (`@allaya/ai`).

## What works now (steps 1–2)

- Connect any AI service: Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks,
  Perplexity, Cerebras, SambaNova, NVIDIA NIM, Hyperbolic, Moonshot, Ollama, LM Studio, or any OpenAI-compatible address.
  Models are read from the service itself; a service with no list can have model names typed in.
- Keys are encrypted by the operating system (Windows: DPAPI). If it cannot encrypt, saving is refused.
- A chat per conversation, each with its own model; streaming replies that can be stopped; everything saved locally (SQLite).
- The agent loop is already in place (`main/core/agent.ts`): tools the model may call, read tools run freely, tools that
  change something outside the app always ask first. No tools are registered yet — the browser, tasks and connections come
  next and plug in through `ToolRegistry`.
- **Voice** (step 2): one click on the microphone starts a spoken conversation — listen, understand, answer with the
  chat's own model, read the answer aloud, listen again — until you end it (or it has been quiet for two minutes). Listening
  and speaking use whichever connected service can do it (OpenAI, Google Gemini, Groq listens) or this computer's own
  voices; so _any_ model can be spoken with, because the voice is separate from the model. Not realtime audio-to-audio
  models (OpenAI Realtime, Gemini Live): those are not built.
- English and Bengali (the name is আলেয়া), light and dark.

## Layout

```
apps/lite
  shared/     the contract between screen and engine (zod), presets, defaults
  main/core/  db, secrets, settings, connections, chat, agent loop, tools
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
