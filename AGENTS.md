# AGENTS.md — working notes for agents

Operational knowledge for an agent (or a human in a hurry) changing this repo.
`CONTRIBUTING.md` covers what a good change looks like; this file covers the
things that have already cost a full session to learn once.

Read this before your first edit, and update it when you learn something that
would have saved you time.

---

## 1. Layout and commands

Zero-dependency core, two front-ends. Nothing in `src/core/` may import from
`node_modules`: CI's fast path runs `npm ci --ignore-scripts` and `npm test`, so
a stray dependency there would break the job that is supposed to need nothing
but Node.

```bash
npm test          # node --test, ~7 s, no dependencies needed
npm run smoke     # real Electron window, then exit
npm run icons     # install build/ icons from assets/ exports
npm run pack      # electron-builder --dir (slow; needs network the first time)
node src/cli.mjs  # browser mode on 127.0.0.1:8791
```

`npm test` is the gate that matters. It runs in ~7 s and catches almost
everything — see §5 before you trust it.

---

## 2. Invariants that are not negotiable

Break one of these and the change is wrong, however good the intent:

- **A real directory in the skill root is never deleted.** `disableSkill` refuses
  anything that is not a link (HTTP 409). There is a test for it.
- **cc-switch's database is opened `readOnly: true`** and is never written.
- **A parked MCP block is restored verbatim**, byte for byte, including
  hand-written comments. `test/server.test.mjs` asserts this.
- **The patch file always stays a valid YAML array** (`ensureValidArray`), never
  comments-only, because the loader throws on a null parse.
- **Never claim success on a non-event.** A lifecycle function reports what it
  *observed* after acting (`alive`, `livePid`), not what it intended.
- **The panel must not carry credentials.** It reads them out of the user's DSH
  and cc-switch config; it never stores its own.

---

## 3. Windows specifics that will bite you

This project is developed on Windows and CI runs Ubuntu/macOS/Windows. Most of
the bugs so far have been in the gap between the three.

### `.cmd` shims cannot be spawned

`spawn('dsh')` fails with `ENOENT` because `dsh` is a `dsh.cmd` batch shim and
libuv cannot start one. Worse, `where dsh` lists an **extensionless POSIX
script first** (`C:\nvm4w\nodejs\dsh`) that Windows cannot run either, and
`execFileSync('dsh')` succeeds anyway because it goes through a shell.

Rules:

- Resolve to a real launchable file with `resolveExecutable()` (prefers
  `.exe` > `.com` > `.cmd` > `.bat`) before spawning anything.
- Never wrap in `cmd /c` if you can avoid it: `cmd` stays hidden, but the console
  app it launches gets a **visible console window** that persists for the
  process's whole life. `unwrapNpmShim()` reads npm's own shim and runs
  `node bin.js` directly instead.
- Measure, don't assume: `Get-Process -Id <pid> | Select MainWindowHandle`.
  `0` = hidden, non-zero = a window the user will see.

### Packaged vs. run-from-source

`build/` is **not** inside the asar. electron-builder's `files` decides what
goes in; anything else at package time must be listed in `extraResources`, or
`nativeImage.createFromPath(.../build/icon.png)` silently returns an *empty*
image (that is how the tray icon shipped invisible in every release until
1.2.0). A packaged-only path failure looks exactly like "no icon configured".

### Testing conventions must be host-independent

CI runners have **no `dsh` installed**. Tests that assert a real command
resolves, or that call a Windows-only parser unguarded, pass locally and fail on
every runner. Either:

- put a stand-in on `PATH` (`withFakeDshOnPath()` in `test/dsh.test.mjs`) and
  `clearExecutableCache()`, or
- `{ skip: process.platform !== 'win32' }` and keep the Windows-only case there.

The strongest form used here: build a real per-platform executable, point
`DSH_WEB_CMD` at it, launch it for real, and have it write a marker file — that
proves the program *executed*, which a mocked `spawn` never can.

---

## 4. Conventions

- **One decision per commit.** The message says what was observed and why the
  alternative was rejected, not just what changed.
- **i18n: every `t('key')` must exist in BOTH `en` and `zh-CN`.** `t()` falls
  back to the key name, so a missing key renders as `dshControlUnavailable` and
  nothing fails. `test/ui.test.mjs` now enforces this — run it after touching
  `public/index.html`.
- **Delete dead code with the feature.** There is no Models tab; if you find
  routes, UI or changelog entries for one, they are leftovers and are wrong.
- **Comments explain why, especially the rejected alternative.** Several
  non-obvious blocks in `src/core/dsh.mjs` exist only because a simpler version
  was tried and failed; the comment is what stops the next agent from undoing it.
- **`public/index.html` is one file with no build step** (inline CSS/JS, both
  languages). Keep it that way.

---

## 5. The pre-release checklist

Run this in order. Skipping a step is how a release fails twice.

```bash
npm test                     # must be 100% green
npm run smoke                # window must load with no renderer errors
npm run icons                # if assets/ changed
node node_modules/electron-builder/out/cli/cli.js --dir   # optional, slow
```

Then, before tagging:

1. **Bump `package.json` version AND promote the CHANGELOG `Unreleased` section
   to that version with today's date.** The release body is generated from the
   CHANGELOG, so stale entries become public false claims.
2. **Check the CHANGELOG entries are real.** Grep for the routes and files they
   name; a leftover section from an unlanded workstream is not hypothetical.
3. **`git status` must be clean apart from intended files.** `.codegraph/` and
   `release/` are ignored; never commit either.
4. **Push `main`, then push the tag** (the tag triggers the Release workflow).
5. **Watch both workflows** — `gh run list`. CI on `main` and Release on the tag
   run in parallel; the Release job's `npm test` step is the same gate, so a red
   CI means a red Release and no published artifacts.
6. **Confirm the release actually exists** — a green tag push is not enough:
   `gh release list`. A failed build job leaves you with a tag and no release,
   in which case deleting and re-pushing the tag is clean (nothing was published).

If the tag already triggered a failed run, check whether a release was created
*before* deciding how to recover: `gh release view <tag>`. No release means
`git push origin :refs/tags/<tag>` and re-tagging is safe.

---

## 6. Network-dependent steps

`electron-builder --dir` downloads an Electron build the first time and writes a
~250 MB executable; allow a few minutes and run it as a background job rather
than blocking on it. It never publishes by itself — the tag does that.

If `git push` or that download fails with a connection or TLS error while the
network is otherwise fine, an HTTP proxy may be required. Set it per repository
so the choice stays out of the global git config and out of this repository
(these are machine details and do not belong in a public file):

```bash
git config --local http.proxy  <proxy-url>     # local only, never --global
git config --local https.proxy <proxy-url>
$env:HTTP_PROXY='<proxy-url>'; $env:HTTPS_PROXY='<proxy-url>'   # for the builder
```

Check the failure before blaming the code: a proxy that is listening is not
necessarily working, and `curl -x <proxy-url> -sS -o NUL -w "%{http_code}"
https://github.com` distinguishes "the tunnel is down" (000 / TLS handshake
error) from "this repository's remote is wrong" (GitHub answers).

---

## 7. Verifying process control (the awkward part)

This panel manages `dsh web` — and `dsh web` is usually what is hosting the
agent session. `POST /api/dsh/stop` therefore **kills your own turn**: the HTTP
call never returns and the turn is cut off mid-flight. Do not drive stop or
restart from a foreground tool call and expect a result.

- Verify the *safe* paths live: `GET /api/state`, `/api/dsh/status`,
  `POST /api/dsh/start` (a no-op when something is already running).
- For the destructive paths, use a stand-in process whose command line contains
  both `dsh` and `web` tokens, spawned into a temp directory, and confirm with
  the OS process table — never with the panel's own report.
- To rehearse a real stop, arm a **detached** restorer first that waits, kills
  the stand-in, and relaunches the captured command line. Anything that is a
  child of the current turn dies with it, so the restorer must outlive the turn.
- Prefer reproducing the bug independently *before* the fix and re-running the
  same reproduction after: for the ENOENT bug, `spawn('dsh')` failing and
  `spawn(resolved)` succeeding was the only real evidence.

---

## 8. Known open items

- `POST /api/dsh/{stop,restart}` has never been driven end-to-end against a real
  `dsh web` (see §7). Unit and injected fake coverage only.
- `DSH_WEB_CMD` can only be set through the environment; there is no in-app
  field, so a user whose `dsh` is not on PATH can read the hint but not act on it.
- `DSH_SETTINGS_FILE` still exists in `config.mjs` with no consumer left.
- The `llm-deepseek` / model-catalog code paths were removed with the Models tab;
  if you find references to them, they are stale.
