# Allaya (আলেয়া) — user guide

Allaya is a desktop assistant. You talk or type to any AI model you connect, it can read web pages for you, do jobs on a
schedule, and use the software you connect (email, code, reports). It asks you before it changes anything.

## 1. Install

Run `Allaya-Lite-Setup-….exe`. It installs for your user only (no administrator needed) and keeps your data in
`%APPDATA%\Allaya Lite`; uninstalling never deletes that. Windows will say "unknown publisher" because the installer is not
signed yet. The earlier, larger Allaya (if you have it) is a different program and is not touched.

## 2. Connect an AI service

**Settings → AI services → Add a service.** Pick Anthropic (Claude), OpenAI, Google (Gemini), OpenRouter, Groq, Mistral,
DeepSeek, xAI, Together, Fireworks, Perplexity, Cerebras, SambaNova, NVIDIA, Hyperbolic, Moonshot, Ollama, LM Studio, or "custom"
for any OpenAI-compatible address. Paste the key (the page tells you where to get one). The key is encrypted by Windows and
never shown again. Allaya reads the list of models from the service, so you can pick any of them — a different one in every
chat.

## 3. Chat and talk

- Type in the box and press Enter. The model name under the box is for this chat only; click it to change it (search works —
  OpenRouter lists hundreds).
- **Microphone:** one click starts a spoken conversation: it listens, answers with the chat's model, reads the answer
  aloud, and listens again, until you press the button again (or it has been quiet for two minutes). Choose what listens and
  speaks in **Settings → Voice**: OpenAI, Google Gemini, Groq (listening only) or your computer's own voices. Any model can
  be spoken with, because the voice is separate from the model. (Models that take audio straight in — OpenAI Realtime,
  Gemini Live — are not supported.)
- Turn on "read every reply aloud" in Settings → Voice if you want replies spoken without the microphone.

## 4. The browser

Click **Browser** to open a real browser beside the chat (tabs, address box; your logins are kept). Allaya can open pages and
read them for you — you will see each step ("Open example.com", "Read page"). It only **reads**: it does not click, type or
submit anything on a page, and it will not go to your own computer or private network by itself. Click **Ask about this page**
to ask about what you are looking at. Switch it off for Allaya in Settings → General if you like.

## 5. Tasks

**Tasks → New task.** Write what Allaya should do as if telling a helper who knows nothing else, and what the report should
contain. Then:

- **Model:** pick any model of any connected service, or choose by what the job needs (fast and cheap, balanced, hard thinking,
  sees images, long documents) and Allaya picks a fitting one.
- **When:** only when you run it, once at a time, every N minutes/hours, or at a time of day on the days you choose.
- **What it may use:** the web, and each connected app, separately.

A task's report and the steps it took are kept. You can also just ask in a chat: _"Every weekday at 8 check example.com and
tell me the headline"_ — Allaya proposes the task and nothing is made until you allow it.

**Tasks only run while Allaya is running.** By default closing the window keeps it in the tray (the icon near the clock);
quit it from there. In Settings → General you can also start it with Windows (quietly, in the tray) and choose whether to get
a desktop notice when a task finishes or needs your OK. A task that was missed while the computer was off runs once when
Allaya starts (if it is less than a day late).

## 6. Connected apps

**Settings → Apps → Add an app.** Allaya connects to software through MCP servers.

- **GitHub:** make a personal access token (GitHub → Settings → Developer settings → Personal access tokens) with only the
  access you want Allaya to have, and paste it.
- **Ahrefs:** in Ahrefs go to Account settings → API keys → **Generate MCP key** (needs a paid plan) and paste it. (Or choose
  "Sign in on the website".)
- **Gmail:** Google offers this as a developer preview, so your Google account may need to join its preview program. In Google
  Cloud: enable the Gmail API and the Gmail MCP API, set up the consent screen (add yourself as a test user and the scopes
  `gmail.readonly` and `gmail.compose`), and create an OAuth client of type **Web application** with the redirect address shown
  in Allaya (`http://127.0.0.1:38943/callback`). Paste its client ID and secret into Allaya and sign in. It can search and read
  email and write drafts; it cannot send.
- **Notion, Linear, Sentry, Supabase, Canva, Vercel, Figma, Jira/Confluence:** add them, then sign in on the service's page.
- **Another app / a program on this computer:** any MCP address, or a program Allaya starts (advanced; only add programs you
  trust).

**What asks first.** Allaya runs a tool without asking only if the service is one it knows (the named ones, at their own
address) _and_ the tool says it only reads. Everything else — including every tool of an address Allaya does not know — asks
you first, in the window and as a desktop notice, and a task waits up to 30 minutes for your answer (no answer means no). Open
an app's **Tools** to switch a tool off, or turn asking off or on for that one tool.

## 7. Privacy and safety

- Keys and sign-ins are encrypted by Windows. They are only sent to the service you connected them to.
- What a web page, an email or a tool returns is treated as information, never as an instruction from you.
- Everything (chats, tasks, reports) is stored on your computer.
- The AI services you connect do receive what you send them (your messages and what the tools return) — that is how they work.

## 8. What it cannot do (yet)

- Click or type on web pages, download files, or look at screenshots.
- Realtime audio models; sending email through Gmail.
- Run tasks while the computer is off or Allaya is closed.
- Update itself: install a newer installer over the old one.

## 9. If something goes wrong

- **"Could not connect" on an app:** the message says why (wrong key, address, program not found). Fix it with **Change**, then
  **Connect again**.
- **Sign-in says another program is using the port:** close the other program, or any earlier sign-in window, and try again.
- **A service says the key is wrong:** copy it again without spaces; check it has the access you need.
- **Nothing is spoken:** check **Settings → Voice** has a service (or system voices) chosen, and your computer's sound.
