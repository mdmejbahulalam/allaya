# Packaging and installing Allaya

What is here, what was actually run, and what has not been.

## Commands

| Command                                                                 | What it does                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                                            | Builds the app (main, preload, renderer) into `apps/desktop/out`.                                               |
| `pnpm --filter @allaya/desktop pack`                                    | Builds and packages an **unpacked** app for the current system into `apps/desktop/release/<platform>-unpacked`. |
| `pnpm --filter @allaya/desktop dist`                                    | Builds the **Windows installer** (NSIS, x64) into `apps/desktop/release`. Needs Windows (or Wine elsewhere).    |
| `ALLAYA_PACKAGED_EXE=<path to the packaged program> pnpm test:packaged` | Launches the packaged program and checks the package (see below).                                               |
| `python3 scripts/make-icons.py`                                         | Redraws the icons in `apps/desktop/build` (needs Pillow).                                                       |

Configuration: `apps/desktop/electron-builder.yml`. App id `com.allaya.desktop`. Per-user install (no administrator rights),
the person may choose the folder, Start-menu and desktop shortcuts, and **uninstalling never deletes their data** (memories,
activity, settings, files are theirs).

## What ships

- `app.asar` (about 17 MB): the built app plus the three modules that stay outside the bundle — `better-sqlite3`,
  `playwright-core`, `electron-updater` — and their dependencies. Everything used only by the window (React, icons, UI
  libraries) is bundled into the page by the build, so it is not shipped twice.
- `app.asar.unpacked`: the database driver's native files (a `.node` file cannot load from inside an archive).
- `resources/migrations`: the database migrations. `resources/icons`: the window, notification and tray images.
- `resources/app-update.yml`: where updates come from (GitHub releases of `mdmejbahulalam/allaya`).

## What was verified (Linux, this machine)

- `pack` produces a working unpacked app; the archive is 17 MB, holds only production dependencies, and the driver's native
  files are outside it.
- `tests/packaged/smoke.spec.ts` launches that **packaged** program and checks: it is packaged and not a test build; the
  migrations, icons and `app-update.yml` are present; the page renders from the archive through the app protocol; a write goes
  into the database and comes back (so the native driver and migrations work); the renderer has no Node access; the bridge
  has two functions; an unknown channel is refused; the update service is wired to the real feed. It passes.
- On this Linux machine the Windows build stops before the installer is assembled: that needs Wine (to make the uninstaller),
  which is not installed here. The Windows runner above does it natively.

## What was verified on Windows (GitHub Actions, `windows-2022`)

`.github/workflows/windows-installer.yml` runs the steps above on a real Windows runner, on each push to the working
branch. Run 3 (commit `428bd18`) passed every step: install, `pnpm --filter @allaya/desktop dist`, uploading the
installer as the `allaya-windows-installer` artifact (the step fails if no file was produced), and the packaged smoke test
(`tests/packaged/smoke.spec.ts`) against `win-unpacked\allaya.exe`. `windows-latest` (Visual Studio 2026) failed first:
node-gyp could not build the native database driver there, so the workflow pins `windows-2022`.

## What was NOT verified

- **The installer has not been run by a person.** The build and the packaged program's smoke test passed in CI, but nothing
  about installing, the Start-menu entry, uninstalling, upgrading over an older install, or how Windows treats the app
  (SmartScreen, Defender) has been tried. Download the artifact from the run and try it on a real PC.
- **The installer is unsigned.** Windows will show "unknown publisher" and SmartScreen will warn. Signing needs a
  certificate this repository does not have: set `CSC_LINK` and `CSC_KEY_PASSWORD` for the release build and add
  `publisherName` to `win:` in `electron-builder.yml`. Signing is also what lets the updater check who built an update.
- **The update feed does not exist yet**: no release has been published, so the real updater has never fetched anything. It
  reads `latest.yml` (with each file's checksum) from GitHub releases; a private repository would need a token, and the
  updater would then need one at run time. Publishing is a release step (Phase 15).
- The icon was drawn by a script, not by a designer.
- 32-bit and ARM Windows, macOS and Linux installers are not configured or tried.
