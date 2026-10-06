<!-- condensed from AGENTS.md @ 2026-10-06 · kept 33/48 items · evidence: git @ 011604a (22 commits / 22 days, semi-empirical) -->

# AGENTS.md — working notes for agents

Operational knowledge for changing this repo (`CONTRIBUTING.md` covers what a good change looks like). Read it
before your first edit, and update it when you learn something that would have saved you time.

## 1. Layout and commands

Zero-dependency core, two front-ends. **Nothing in `src/core/` may import from `node_modules`**: CI's fast path runs
`npm ci --ignore-scripts` and `npm test`, so a stray dependency breaks the job meant to need only Node.

```bash
npm test          # node --test, ~7 s, no dependencies needed — the gate that matters
npm run smoke     # real Electron window, then exit
npm run icons     # install build/ icons from assets/ exports
npm run pack      # electron-builder --dir (slow; needs network the first time)
node src/cli.mjs  # browser mode on 127.0.0.1:8791
```

`npm test` catches almost everything — see §5 before you trust it.

## 2. Invariants that are not negotiable

Break one of these and the change is wrong, however good the intent:

- **A real directory in the skill root is never deleted.** `disableSkill` refuses anything that is not a link (HTTP 409); there is a test for it.
- **cc-switch's database is opened `readOnly: true`** and is never written.
- **A parked MCP block is restored verbatim**, byte for byte, including hand-written comments (`test/server.test.mjs` asserts this).
- **The patch file always stays a valid YAML array** (`ensureValidArray`), never comments-only, because the loader throws on a null parse.
- **Never claim success on a non-event.** A mutating function reports what it *observed* after acting — `removePlugin` re-reads the profile manifest before it says "uninstalled" — not what it intended.
- **The panel must not carry credentials.** It reads them out of the user's DSH and cc-switch config; it never stores its own.

## 3. Windows and CI specifics that will bite you

Developed on Windows, CI runs Ubuntu/macOS/Windows; most bugs so far lived in that gap.

**`.cmd` shims cannot be spawned.** `spawn('dsh')` fails with `ENOENT` (libuv cannot start a `.cmd` batch shim), and
`where dsh` lists an **extensionless POSIX script first** (`C:\nvm4w\nodejs\dsh`) that Windows cannot run either —
while `execFileSync('dsh')` succeeds anyway, because it goes through a shell. So:

- Resolve to a real launchable file with `resolveExecutable()` (prefers `.exe` > `.com` > `.cmd` > `.bat`) before spawning anything.
- Never wrap in `cmd /c` if you can avoid it: `cmd` stays hidden, but the console app it launches gets a **visible console window** for the process's whole life. `unwrapNpmShim()` runs `node bin.js` from npm's own shim instead.
- Measure, don't assume: `Get-Process -Id <pid> | Select MainWindowHandle` (`0` = hidden, non-zero = a window the user will see).

**A global CLI is a symlink on POSIX and a `.cmd` on Windows** (`resolveDshLauncher()`, `src/core/plugins.mjs`).
Windows writes a readable `.cmd` shim naming the script, which `unwrapNpmShim()` turns into `node <script>`; POSIX
writes a **symlink** (`.../bin/dsh -> ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`) that only `fs.realpathSync`
resolves. Code handling only the `.cmd` shape silently finds nothing on Linux and macOS — and a test that builds a
*standalone shell script* hides that, because the platform installs a symlink. Build a symlink.

**Packaged vs. run-from-source.** `build/` is **not** inside the asar; `files` decides what goes in, so anything else
needed at package time must be listed in `extraResources`, or `nativeImage.createFromPath(.../build/icon.png)`
silently returns an *empty* image (that is how the tray icon shipped invisible until 1.2.0) — a packaged-only path
failure looks exactly like "no icon configured".

**Tests must be host-independent.** CI runners have **no `dsh` installed**, so a test that asserts a real command
resolves, or that calls a Windows-only parser unguarded, passes locally and fails on every runner. Either put a
stand-in on `PATH` (`withFakeDshOnPath()` in `test/dsh.test.mjs`) + `clearExecutableCache()`, or
`{ skip: process.platform !== 'win32' }`. Strongest form: a real per-platform executable named by `DSH_WEB_CMD` that
writes a marker file — proof the program *executed*, which a mocked `spawn` never gives (`test/plugins.test.mjs`, for
`dsh plugin remove`).

**Screenshots need `--disable-gpu` in an agent session**: `npm run screenshot` (any `DSH_PANEL_SMOKE_CAPTURE` run) fails
with `capture: UnknownVizError` and writes **no file**, while
`node_modules/electron/dist/electron.exe --disable-gpu .` works. It surfaces as `SMOKE fail: 1 renderer error(s)`; the
`capture:` line is the one naming the cause.

**`ELECTRON_RUN_AS_NODE=1` must be cleared before running Electron.** A DSH agent session exports it, and with it set
the binary runs as plain Node: no window, and a CLI error naming a Chromium switch
(`electron.exe: bad option: --disable-gpu`). `npm run smoke` / `npm run screenshot` inherit it; clear it for the child
(`Remove-Item env:ELECTRON_RUN_AS_NODE`). It is a property of the session, not of the app.

**The panel's own update reads `latest*.yml`, not the GitHub API** (`src/core/panelUpdate.mjs`): the API
(`api.github.com/repos/.../releases/latest`) is rate-limited per IP — this repo's IP got `403 API rate limit exceeded` —
and lacks the per-artifact `sha512`/`size` that make a verified download of an OS-executed file possible. The feeds
`latest.yml`, `latest-mac.yml`, `latest-linux.yml` (from `.github/workflows/release.yml`) come through
`https://github.com/<repo>/releases/latest/download/<name>`, which redirects to `release-assets.githubusercontent.com`,
so an allow-list must include `*.githubusercontent.com`, not just `github.com`.

- **The architecture token is not `process.arch`**: an x64 AppImage is `x86_64`, an x64 deb `amd64`; only Windows and macOS use `x64`. This shipped broken in 1.3.0 (the Linux updater offered nothing); `archTokens` owns the mapping, and `test/panelUpdate.test.mjs` feeds it the verbatim `latest-linux.yml` of 1.3.0.
- `pickAsset` encodes what a person would pick: `-setup.exe` over the portable build (running the portable opens a *second* copy), `.dmg` over the electron-updater `.zip`, `.AppImage` over `.deb`. The Windows portable carries **no** arch token, so it is matched without one and ordered below the installer.

**Node's `fetch` ignores `HTTP_PROXY`/`HTTPS_PROXY`** — why `src/core/httpGet.mjs` exists. **HTTPS → HTTP is refused inside
the client**, always: whoever answers for the original host could otherwise strip TLS from a download. Redirect policy
beyond that ("stay on GitHub") belongs to the caller — `onRedirect` + `assertFollowable`, never baked into the client;
`test/httpGet.test.mjs` asserts both rules on real `127.0.0.1` servers and needs `openssl` for its TLS case.

## 4. Conventions

- **One decision per commit.** The message says what was observed and why the alternative was rejected, not just what changed.
- **i18n: every `t('key')` must exist in BOTH `en` and `zh-CN`.** `t()` falls back to the key name, so a missing key renders as `puNeverChecked` and nothing fails. `test/ui.test.mjs` enforces it — run it after touching `public/index.html`.
- **Delete dead code with the feature.** There is no Models tab; routes, UI or changelog entries for one are leftovers and are wrong.
- **Comments explain why, especially the rejected alternative.** Several non-obvious blocks in `src/core/dsh.mjs` exist only because a simpler version was tried and failed; the comment is what stops the next agent from undoing it.
- **`public/index.html` is one file with no build step** (inline CSS/JS, both languages). Keep it that way.

## 5. The pre-release checklist

Run this in order. Skipping a step is how a release fails twice.

```bash
npm test                     # must be 100% green
npm run smoke                # window must load with no renderer errors
npm run icons                # if assets/ changed
node node_modules/electron-builder/out/cli/cli.js --dir   # optional, slow
```

Then, before tagging:

1. **Bump `package.json` version AND promote the CHANGELOG `Unreleased` section to that version with today's date.** The release body is generated from the CHANGELOG, so stale entries become public false claims — grep for the routes and files the entries name; a leftover section from an unlanded workstream is not hypothetical.
2. **`git status` must be clean apart from intended files.** `.codegraph/` and `release/` are ignored; never commit either.
3. **Push `main`, then push the tag** (the tag triggers the Release workflow).
4. **Watch both workflows** (`gh run list`): CI on `main` and Release on the tag run in parallel, and the Release job's `npm test` step is the same gate — a red CI means a red Release and no published artifacts.
5. **Confirm the release exists** (`gh release list`) — a green tag push is not enough. If the tag triggered a failed run, check `gh release view <tag>` before recovering: no release means `git push origin :refs/tags/<tag>` and re-tagging is safe.

## 6. Network-dependent steps

`electron-builder --dir` downloads an Electron build the first time and writes a ~250 MB executable: run it as a
background job. It never publishes by itself — the tag does that.

**`npm install` can leave Electron with no binary and report success anyway.** The `electron` package ships no executable:
its postinstall fetches `electron-v<version>-<platform>-<arch>.zip` from **GitHub releases** into
`node_modules/electron/dist`, writing the relative path into `path.txt`. When that fetch fails, `npm install` still exits
0 — it installed the *package* — and the damage shows up later as `npm run smoke` / `npm run screenshot` failing with an
unusable binary, while `require('electron/package.json').version` reports the new version happily. Check
`Test-Path node_modules/electron/dist/electron.exe` (and a non-empty `path.txt`), not the version number.

Two dead ends, both measured here: the npmmirror **binary** mirror
(`ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`) answers `200` to a HEAD request while the zip
transfer stalled at 0 bytes; and `HTTP_PROXY`/`HTTPS_PROXY` **do not reach the installer**
(`node node_modules/electron/install.js` opened a direct GitHub connection — `Get-NetTCPConnection -OwningProcess <pid>`
— and hung, because `@electron/get` gets its proxy from `global-agent`, which never sees them).

```bash
curl.exe -x <proxy-url> -L -o "$TEMP/electron-v<ver>-win32-x64.zip" \
  https://github.com/electron/electron/releases/download/v<ver>/electron-v<ver>-win32-x64.zip
# then: Expand-Archive into node_modules/electron/dist  (replacing it wholesale)
# and:  Set-Content node_modules/electron/path.txt -Value "electron.exe" -NoNewline
```

`path.txt` is a plain relative path *inside* `dist` (`electron.exe` on Windows, `electron` on Linux,
`Electron.app/Contents/MacOS/Electron` on macOS) — exactly what `scripts/electron-binary.mjs` hands to `spawn`, so a
hand-extracted `dist` is enough for `npm run smoke`.

**Do not pipe a long-lived Electron child through `Select-Object -Last N`**: a
`npm run smoke 2>&1 | Select-Object -Last 12` sat for 3 minutes with no output and no exit, while the same run
redirected to a file finished in 2 s with a verdict. Read `smoke.out` for `SMOKE ok: window loaded`; the exit code
alone is not the evidence:

```powershell
Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList '--disable-gpu',"--user-data-dir=$env:TEMP\smoke" -Wait -PassThru -RedirectStandardOutput "$env:TEMP\smoke.out" -RedirectStandardError "$env:TEMP\smoke.err"
```

If `git push` or that download fails with a connection or TLS error while the network is otherwise fine, a proxy may be
required — set it per repository (`git config --local http.proxy` / `https.proxy <proxy-url>`, never `--global`; these
are machine details and do not belong in a public file) plus `HTTP_PROXY`/`HTTPS_PROXY` for the builder. `curl -x
<proxy-url> -sS -o NUL -w "%{http_code}" https://github.com` then tells a dead tunnel (000 / TLS handshake error) from a
wrong remote.

## 7. The panel no longer manages a process

`dsh web` process control — start, stop, restart, the `dshControl` bundle, the `/api/dsh/*` routes and the DSH tab — was
**removed** when the official DSH desktop app became the way people run DSH, and the global `dsh` install went with it
(`src/core/dshVersion.mjs` is gone). The panel still *probes* for a running `dsh web` (`src/core/dsh.mjs`) because the MCP
and plugin banners compare its boot time against the patch/manifest mtime, but it never kills or spawns anything.

- The probe is the only OS call left and is cached for 15 s; `DSH_PANEL_PROBE_WEB=0` turns it off, every restart comparison then reads "no boot time" and the banners stay quiet. A banner can only fire when `isDshWeb` recognises the process (a command line containing both `dsh` and `web`), so the panel cannot yet tell "restarted" from "not found".
- If process control is ever wanted back, do not resurrect it half-way: `dsh web` is usually the thing hosting the agent session, so stopping it kills the turn that asked for the stop. Any revival needs a detached restorer and a stand-in process, verified against the OS process table rather than the panel's own report.

## 8. Known open items

- `POST /api/panel/update`: the **download path is verified end-to-end against the real release** — 111,413,415 bytes of `dsh-control-panel-1.2.0-x64-setup.exe`, byte count matching the feed's `size` and the sha512 matching its digest. Everything *after* the file lands is unverified: `openPath` has never launched an installer, and the "download and install" button only appears in a **packaged** app, so that branch has only unit-test coverage.
- Plugin uninstall (`src/core/plugins.mjs`) runs the *documented* `dsh plugin --profile <n> remove <pkg>` — a pnpm forwarder that also reconciles `dsh.profile.bundles` — and re-reads the manifest before claiming success. Editing `package.json` directly was rejected: it desyncs `pnpm-lock.yaml`, and the next `dsh plugin add` then fails on the mismatch. No test drives a real pnpm run, so real-CLI behaviour is unverified in CI.
- `DSH_WEB_CMD` can only be set through the environment (no in-app field), and now only names the launcher for `dsh plugin` commands.
- `DSH_SETTINGS_FILE` still exists in `config.mjs` with no consumer left; the `llm-deepseek` / model-catalog code paths went with the Models tab, so references to them are stale.
