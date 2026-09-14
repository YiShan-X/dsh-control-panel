# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
