# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-09-19

### Added

- **Panel self-update.** The About tab reports the running version, whether a
  newer release exists, and can install it. The version feed is
  electron-builder's own `latest*.yml` published as a release asset, chosen over
  the GitHub API for a concrete reason: the API is rate-limited per IP (60/hour
  unauthenticated, and this very session was answered 403 by it), while the asset
  is served like any other file *and* carries the **sha512 and size** of every
  artifact. That digest is what lets the download be verified before a ~110 MB
  installer is handed to the OS to execute; a mismatch deletes the file rather
  than leaving it where a user could run it, and a feed with no digest still
  downloads but reports `verified: null` instead of implying a check it did not
  make. Artifact choice follows what a person would actually run: the NSIS
  `-setup.exe` on Windows (not the portable build, which would open a second
  copy), the `.dmg` on macOS (not the `.zip` that ships beside it for
  electron-updater), and the `.AppImage`/`.deb` on Linux, each matched to the
  architecture in the filename. Only a packaged app can replace itself, so a
  source checkout says so and the route answers 501 rather than downloading an
  installer for a program it is not running. New `src/core/panelUpdate.mjs`, new
  `$DSH_PANEL_REPO` and `$DSH_PANEL_DOWNLOAD_DIR`, and a new
  `src/core/httpGet.mjs` — a dependency-free HTTP GET that honours
  `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (Node's global `fetch` ignores them),
  using `CONNECT` and an inner TLS handshake for HTTPS targets. The client always
  refuses to follow an HTTPS-to-HTTP redirect downgrade; the stricter "stay on
  GitHub" rule is passed in by the update path as an `onRedirect` hook, so a
  caller fetching anything else is not bound by another caller's policy.
- **DSH version management.** The DSH tab now answers "what am I running, and is
  there an update?" and can install one. The installed version is read with
  `dsh --version` — through the same command the Start button runs, so
  `DSH_WEB_CMD` cannot make the panel report a *different* installation than the
  one it manages; a broken shim falls back to the installed `package.json`, and
  the card says which of the two answered. Published versions come from
  `npm view <package> --json` executed with the user's own npm rather than a
  hand-rolled HTTP client, because that is what makes `.npmrc`, a registry mirror
  and `HTTP_PROXY`/`HTTPS_PROXY` apply for free — and it is the same tool that
  performs the install, so the version offered is by construction the version an
  install would fetch. Every dist-tag is listed with its publish date, and a
  channel behind the installed version is labelled older rather than recommended
  as an update. `GET /api/dsh/release` is deliberately off the `/api/state` poll
  path: the registry is contacted once per page load and on the check button, so
  an unreachable registry cannot stall the panel — the failure is reported in the
  card. `POST /api/dsh/update` accepts a channel name or an exact version and
  re-validates it against the registry's own version list before a command line
  exists, so this localhost route cannot be turned into an arbitrary
  `npm install`. Success is reported from a *re-read* of `dsh --version`, never
  from npm's exit code: an installation earlier on `PATH` that swallows the
  update is reported as a failure with the reason, and a running `dsh web` is
  offered a restart only when the install landed after it booted. New
  `src/core/dshVersion.mjs`, new `$DSH_PANEL_DSH_PACKAGE`, and 28 tests.


- **Plugins tab — uninstall only.** A DSH plugin is an npm dependency of a
  *profile*, so the tab reads `$DSH_HOME/profiles/<name>/package.json` and
  classifies every row from those two lists: a package that is both a dependency
  and an entry in `dsh.profile.bundles` is a third-party plugin, an entry with no
  dependency behind it is an in-box layer (`dsh-base`, `dsh-web-app`) and is shown
  as not removable rather than silently omitted. Uninstalling runs
  `dsh plugin --profile <name> remove <pkg>` — the documented command, which
  forwards to pnpm inside the profile directory and reconciles the bundle list —
  instead of editing the manifest here, which was rejected because it leaves
  `pnpm-lock.yaml` describing a dependency the manifest no longer has and the
  next `dsh plugin add` then fails on the mismatch. "Uninstalled" is reported
  only after re-reading the profile and finding the dependency actually gone, so
  a pnpm run that exits 0 without changing anything is reported as a failure.
  Installing is deliberately not offered. New `POST /api/plugins/remove` route,
  new `$DSH_PROFILES_DIR`, new `profile:<name>` open target, and a restart-pending
  banner driven by the profile manifest's mtime against the running service's
  boot time.

## [1.2.0] - 2026-09-14

### Added

- **DSH service control.** Every `/api/dsh/*` route was gated on the desktop-only
  `restartHook`, so the DSH tab's three buttons were permanently dead, and in
  browser mode the panel could not manage the service it exists to manage at all.
  Control is now its own injected `dshControl` bundle wired by both hosts, and
  `DSH_PANEL_NO_CONTROL=1` degrades a host to a read-only reporter that says so
  instead of offering a button that fails.
- **"Restart dsh web now" button** (`#8`). The MCP restart banner used to say
  "kill it yourself and relaunch"; the panel now does it. The respawn tokenises
  the captured cmdline itself and calls `spawn` directly, so no `cmd.exe` window
  flashes up on Windows; stderr is captured so a failed relaunch leaves a
  breadcrumb in the panel log instead of vanishing.
- **System tray icon** (`#7`). The desktop window no longer kills the app when
  closed -- a tray icon keeps it alive, left-click brings the window back,
  right-click opens a menu with the same DSH paths the menu bar shows plus a real
  Quit. Smoke runs skip the tray so a CI host never picks up a leftover icon.
  The tray image follows the OS theme: the monochrome glyph on a dark taskbar,
  the full colour icon on a light one, re-picked on `nativeTheme` changes.
- **`$DSH_SETTINGS_FILE`** environment variable (default `$DSH_HOME/settings.yaml`),
  so a config can be repointed without symlinking the file.

### Changed

- **The icon set was refreshed from the design sources.** `assets/*.svg` (app
  tile, 16-32 px variant, monochrome tray glyph) plus the tool's own PNG/ICO
  exports now live in the repository, and `scripts/make-icons.mjs` installs them
  into `build/`, verifying each export is a real 1024x1024 PNG / complete ICO
  container rather than redrawing the artwork a second time. The tray uses the
  new glyph instead of a rescaled app icon.
- **Default window size shrunk from 1240x860 to 920x700** (`#9`). The first
  launch no longer fills half the screen with empty space. Existing
  `window-state.json` files keep whatever the user last resized to.
- `window-all-closed` no longer quits the app on non-darwin: the tray owns
  the lifecycle now. Real shutdowns come from the tray menu.

### Fixed

- **Starting `dsh web` from the panel opened a console window that stayed for
  the service's whole life.** Wrapping the `.cmd` shim through `cmd /c` fixed the
  ENOENT below but not the noise: `cmd` itself stayed hidden while the console
  application it launched got a *visible* console allocated for it. Measured
  rather than assumed — the launched `node` reported a non-zero
  `MainWindowHandle`. The npm shim is now unwrapped to the command it actually
  stands for (`node .../dsh/lib/bin.js web`, following the shim's own `%_prog%`
  branch) and spawned directly, which libuv creates with `CREATE_NO_WINDOW`; the
  same measurement now reports `MainWindowHandle=0`. A shim the parser does not
  understand still falls back to `cmd /c`, just noisily.
- **"Start dsh web" failed with `spawn dsh ENOENT` on Windows.** `dsh` is a
  `dsh.cmd` shim there, and libuv cannot start a `.cmd` file directly — the same
  trap `mcp.mjs` had always handled for `npx`, which the DSH start path never
  got. The command is now resolved to a file Windows can actually launch (a real
  `.exe` wins over a wrapper) and routed through `cmd /c` when it is a shim.
  Resolution also stops being a bare existence check: `where dsh` lists the
  extensionless POSIX shim first, and resolving to *that* reproduced the very
  ENOENT being fixed. A command that genuinely is not on PATH now fails with a
  sentence naming it — plus the `DSH_WEB_CMD` hint — instead of a bare libuv
  code, and the spawn result is awaited rather than inferred from a timer.
- **The DSH tab rendered raw translation keys instead of labels.** Its
  renderer asked for 21 keys — `dshPageTitle`, `dshRunning`,
  `dshControlUnavailable` and friends — that existed in neither dictionary, and
  `t()` falls back to the key name, so the page title, the three stat labels,
  every button hint and every action toast displayed as `dshControlUnavailable`.
  All 21 keys now exist in `en` and `zh-CN`, along with the three control button
  labels, which had been hardcoded in Chinese and stayed Chinese in the English
  UI. `test/ui.test.mjs` now fails if any `t('…')` key is missing from either
  dictionary, or if the two dictionaries define different key sets.
- **The DSH tab was three permanently dead buttons in browser mode.** Every
  `/api/dsh/*` route was gated on the desktop-only `restartHook`, so
  `node src/cli.mjs` could not start, stop or restart the service it exists to
  manage. Control is now its own injected `dshControl` bundle wired by both
  hosts, and a host that genuinely cannot manage a process renders the buttons
  disabled with the reason instead of failing on click. `DSH_PANEL_NO_CONTROL=1`
  opts out.
- **A restart replayed a command line that could be stale.** The captured
  command line is a snapshot of an earlier session: a machine that switched Node
  version managers still reports the old absolute `node.exe`, and replaying it
  failed with ENOENT. The executable is now resolved before it is replayed, and
  the panel falls back to `DSH_WEB_CMD` with a visible warning.
- The MCP restart banner could show stale content for up to 20 s after a
  programmatic restart; the new route invalidates the web-start cache so the
  banner refreshes immediately.

### Changed

- **The DSH tab is a real service panel.** It now shows uptime, CPU time and
  resident memory alongside status, PID and start time; it distinguishes "not
  running" from "not probed"; it names the command the Start button would run and
  where that command came from; it warns, before you act, that restarting
  `dsh web` disconnects the page and interrupts the running AI session; and it
  reports what was *observed* after an action rather than what was attempted
  (a start whose process never appeared is an error, not a success with a
  caveat).
- **Process probing is one call and one cache, not two.** `mcp.mjs` had its own
  copy of the `dsh web` filter and boot-time probe; both now live in
  `src/core/dsh.mjs`, so the MCP restart banner and the DSH tab cannot disagree
  about whether the service is up. A single `/api/state` request probes once.
  The probe is measured once per 15 s of polling, re-probes immediately after a
  mutating action, and is floored to one OS call per 250 ms so a client hammering
  `?fresh=1` cannot fork PowerShell per request. Both hosts warm the cache at
  startup, so the first paint is not blocked behind a PowerShell round trip.
- Stopping `dsh web` no longer always waits out the full 2 s grace period: the
  pid is polled and the force-kill step is skipped as soon as the process is
  gone, and a forced kill is reported as such.

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
