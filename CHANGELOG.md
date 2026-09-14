# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-14

### Added

- **Light and dark themes.** Every surface colour is now a token defined once per
  palette, so the whole UI switches rather than leaving dark islands behind. The
  theme follows the OS until you pick one with the new header toggle, and the
  choice persists. The theme is applied by a tiny inline script before first
  paint, so a light-theme user never sees a dark flash on launch.
- `?theme=` alongside `?lang=` for deterministic screenshots, plus a light-theme
  capture in the documentation.

### Changed

- **The desktop window no longer shows the native menu bar.** It is developer
  chrome; every entry already has a keyboard accelerator or a button in the page,
  and `Alt` still reveals it, so DevTools and zoom stay reachable.

### Fixed

- **The smoke test could pass while the app was visibly broken.** Two causes,
  both fixed:
  - A renderer error now fails the run. Previously a page script could throw,
    render nothing, and still exit 0 with a blank screenshot -- CI green, product
    broken. `console-message` and `render-process-gone` are collected and any
    error-level entry fails the run and prints what went wrong.
  - Smoke and screenshot runs take their own `--user-data-dir`. The
    single-instance lock is keyed on it, so a run started while the app was
    already open silently became a "focus the other window" no-op, exiting 0
    without producing anything. That case now fails loudly, with the fix in the
    message.
- A page-script `ReferenceError` that blanked the entire UI: the theme toggle was
  painted by a module-level call made before `const $` was initialised.
- `/favicon.ico` answers `204` instead of `404`, so the browser's automatic probe
  no longer logs a console error.

## [1.0.1] - 2026-09-14

Documentation and positioning only -- no behaviour change in the app.

### Added

- A README section stating precisely how this tool differs from the other DSH
  managers, and from the cc-switch <-> DSH cluster in particular: most of those
  move *provider* data (base URLs, model routes, API keys) or perform a one-time
  *import*, while this tool soft-routes the *same* pool directory by link and
  never touches providers or keys.
- A top-of-README note that the cc-switch integration is the headline feature
  for people already running cc-switch, and an equally explicit note that
  cc-switch is optional, so people without it do not self-select out.

### Changed

- The repository description and topics now name cc-switch, so the project is
  findable from the hub it routes rather than only from "DSH panel".

## [1.0.0] - 2026-09-14

The first public release. The panel grew out of a local-only script; this
release is the desktop app plus the packaging, tests and docs that make it
publishable.

### Added

- **Desktop app.** Electron shell that runs the panel server on an OS-assigned
  loopback port inside its own process and opens a real window. Single-instance
  lock, window-state persistence, menu with shortcuts to every managed path, and
  a log file under `userData` for support.
- **Prebuilt installers** for Windows (NSIS + portable), macOS (dmg + zip) and
  Linux (AppImage + deb), built by GitHub Actions on tag.
- **Bilingual UI** (English and Simplified Chinese), selected from the browser
  language and switchable in the header.
- **About tab** showing the resolved paths and skill pools, each with a button
  that opens it in the file manager.
- **Test suite:** 70 unit and integration tests using `node --test`, covering
  frontmatter parsing, the patch-block editor, the cc-switch converter, the skill
  model, and the HTTP API end to end against a throwaway profile.
- **Zero-dependency icon generator** (`scripts/make-icons.mjs`): a hand-written
  PNG encoder and ICO writer, so the artwork is code rather than an opaque
  binary.
- **Reproducible screenshots** (`scripts/screenshot.mjs`) rendered from the real
  app against synthetic demo data, so the docs can never leak a real profile or
  drift from the UI.
- `--help`, `--version`, `--port`, `--host`, `--no-open` and `--print-config`
  for the CLI.

### Changed

- **The logic is now a reusable core.** `server.mjs` was split into
  `src/core/*.mjs` modules behind a `createPanelServer(config, options)` factory,
  shared by the CLI and the desktop shell. `server.mjs` remains as a
  compatibility shim.
- **Cross-platform.** Directory symlinks on POSIX (junctions on Windows), the
  `cmd /c` shim wrapping is Windows-only, and the `dsh web` start-time probe
  falls back to `ps` on macOS and Linux.
- **cc-switch is optional.** Its absence is reported as an informational banner
  and the panel continues to manage everything DSH itself knows about, instead of
  showing an empty or broken page.
- **Multiple skill pools**, configurable through `DSH_SKILL_POOL`, replacing the
  single hardcoded cc-switch pool. Duplicate folder names across pools are
  reported rather than silently resolving to one of them.
- **Safer API surface.** Request-supplied names are validated before reaching any
  path join, `/api/open` is an explicit allow-list, and the bulk endpoint is
  capped at 500 items.
- `start.cmd` prefers the desktop app and falls back to browser mode.

### Fixed

- `ensureValidArray` no longer emits a stray leading newline for an empty patch
  file.
- A broken skill link (target deleted underneath it) is reported as
  `broken link` instead of appearing to be an installed, working skill.
- The `node:sqlite` experimental warning no longer pollutes the log file on
  every launch.
