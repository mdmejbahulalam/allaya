# Allaya

A personal AI computer agent / "digital employee" for Windows. Allaya understands Bengali, English,
Banglish and mixed commands (text or voice), plans multi-step work, safely controls the computer
through validated tools, verifies what it did, and remembers your preferences.

> **The AI decides _what_ needs to happen. The trusted local runtime decides _how_ it is safely executed.**
> Model output is never executed directly — it becomes a structured, schema-validated, permission-checked tool call.

**Status:** under active development, built phase by phase. See [docs/STATUS.md](docs/STATUS.md) for an honest,
per-requirement account of what is implemented, what is verified, and what still needs a real Windows machine.

## Quick start

```bash
pnpm install
pnpm dev              # run the app with hot reload
pnpm check            # typecheck + lint + unit/integration tests
pnpm test:e2e         # build, then drive the real Electron app with Playwright
```

Requirements: Node ≥ 22.12, pnpm 10. On headless Linux, wrap E2E in `xvfb-run -a`.

## Repository layout

```
apps/desktop/         Electron app: main (trusted), preload (bridge), renderer (React UI)
packages/             Domain logic — independent of UI and Electron
tests/                unit · integration · e2e · security · fixtures
docs/                 Architecture, security, privacy, user guide
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.
