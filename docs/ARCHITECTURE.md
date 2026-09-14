# Architecture

## The shape of the thing

```
                 ┌──────────────────────────────┐
                 │        src/core/*.mjs        │   zero dependencies
                 │  config · skills · mcp ·     │   no I/O policy of its own
                 │  patch · ccswitch · server   │
                 └───────────────┬──────────────┘
                                 │  createPanelServer(config, opts)
                 ┌───────────────┴───────────────┐
                 │                               │
        src/cli.mjs                     src/desktop/main.mjs
   browser mode, fixed port 8791    Electron, OS-assigned port
                 │                               │
                 └──────────────┬────────────────┘
                                │
                       public/index.html
                    (one file: inline CSS + JS)
```

There is exactly **one** implementation of the logic. The two front-ends differ
only in how the server gets started and where the window comes from. Adding a
feature to the core adds it to both.

The core is a factory, not a script: `createPanelServer(config, options)` takes
an explicit config object and returns an unstarted `http.Server`. That is what
makes the integration tests possible — they point a config at a temp directory
and `listen(server, { port: 0 })`.

## Why the two mechanisms differ (and the evidence)

This is the fact the whole UI is organised around, so it is worth stating how it
was established rather than assuming it.

**Skills are hot.** The `dsh-skill-filesystem` provider watches the skill root
and rebuilds the catalog when it changes. The experiment:

1. Create `.dsh/skills/gh` as a junction into the skill pool.
2. On the **next** model request, `gh` is present in the available-skills list.
3. Remove the junction.
4. On the next request, it is gone.

No restart at any point.

**MCP is not hot.** MCP servers are assembled at boot. The composition is read
once; there is no watcher. A change to `cordis.patch.yml` is inert until
`dsh web` restarts.

Rather than nagging the user about a restart that may not be needed, the panel
compares two timestamps: the patch file's `mtime` against the creation time of
the running `dsh web` process. The banner appears only when the former is later.
If that probe fails — a locked-down machine, an unusual process list — the
banner simply does not appear; the rest of the app is unaffected.

## Safety is structural, not procedural

The dangerous operations are not "handled carefully". They are written so that
the dangerous outcome is unreachable:

**Deleting a real directory.** `disableSkill` calls `linkStat`, which uses
`lstat` — it does *not* follow the link, so a junction is distinguishable from a
real directory. If the entry is not a link, the function throws a `409` before
any mutation. `removeDirLink` then removes the link with `unlink`, falling back
to `rmdir` on the Windows error codes, and never falls back to a recursive
delete — that is the one call that could follow a link and destroy its target.

**Writing to cc-switch.** `ccswitch.mjs` opens the DB with `{ readOnly: true }`
and contains no `INSERT`, `UPDATE`, `DELETE`, `DROP` or DDL of any kind. An
audit of the module is a short read.

**Producing an unbootable patch file.** `ensureValidArray` is applied to every
write. It guarantees the file ends as a top-level YAML array, inserting an
explicit `[]` when the last block is removed. A comments-only file parses to
`null`, and the boot loader throws on "exists but is not an array".

**Clobbering hand-tuned MCP config.** `setMcpEnabled` restores a parked block
**verbatim** from `disabled.yml` first, and only consults cc-switch to generate
a block that has never existed in DSH. The integration test asserts the restored
block is byte-for-byte identical, comment line included.

**Path traversal.** Every name arriving over HTTP passes `ensureSafeName`, which
rejects separators, `..` and anything outside `[A-Za-z0-9._-]` before it reaches
a `path.join`. Static file serving resolves the target and verifies it is still
inside `public/`. `/api/open` accepts a fixed key, never a path.

**Using the local server as a launch primitive.** The panel binds loopback only,
but a loopback server is still reachable by any page in the user's browser. That
is why `/api/open` is an allow-list and why callers cannot pass arbitrary paths.

## Deliberate design choices

**Junctions on Windows, symlinks elsewhere.** A Windows junction needs no
elevation and no Developer Mode, unlike a true symlink — which matters a lot for
a tool aimed at people who just want to flip a switch.

**`cmd /c` wrapping is Windows-only.** On Windows, `npx`, `uvx` and friends are
`.cmd` shims that libuv cannot spawn (ENOENT). On POSIX they are real
executables and must be left alone. The converter takes the platform as a
parameter precisely so this is testable from any platform.

**`node:sqlite` is imported dynamically.** It is a recent builtin, and the
Electron/Node pairing in a desktop build is not something this project controls.
A failed import degrades the panel to "everything DSH itself knows about"
instead of taking it down. The `ExperimentalWarning` it emits on every launch is
suppressed around the import, because it fires on the happy path and would
otherwise land in the user-facing log file.

**cc-switch's agent columns are discovered, not hardcoded.** `detectAgents` reads
`PRAGMA table_info(skills)` and picks up whatever `enabled_<agent>` columns exist.
Upstream adding an agent does not require a change here.

**The UI is one file with no build step.** It has no framework, no bundler and no
runtime dependencies. It is served straight off disk by the same process that
serves the API, which keeps the desktop build to "wrap the server in a window".

**Icons come from the design tool, and the script verifies rather than redraws.**
`assets/*.svg` is the artwork (app tile, 16-32 px variant, monochrome tray
glyph); `assets/*.png` and `assets/icon.ico` are that tool's exports, and
`scripts/make-icons.mjs` installs them into `build/`. An earlier version rasterized
the SVGs in-process with a hand-written PNG encoder; that was a *second*
implementation of the artwork, free to disagree with the designer's own export,
and it was replaced. What survives is the checking: the script refuses to
install an export that is not a real PNG/ICO container, is not 1024x1024, or
does not carry every ICO size the packaging config promises.

**The tray icon is theme-aware.** The monochrome glyph is white, which vanishes
on a light taskbar, so the tray picks the glyph on a dark theme and the full
colour icon otherwise, and re-picks on `nativeTheme` changes.

## Testing

70 tests, no framework — `node --test` and `node:assert`.

The unit tests cover the parsers where the bugs actually live: YAML frontmatter
(including the block scalars and the kebab-case rule), the delimited-block
editor, and the cc-switch → DSH converter.

The integration tests create a throwaway profile in the OS temp directory with
real skills, real junctions and a real patch file, then drive the HTTP API over
a real socket. They assert the safety properties directly: that the pool file
survives a disable, that a real directory is refused, that traversal-shaped keys
are rejected, and that a hand-written MCP block round-trips byte for byte.

`npm run screenshot` is the third kind: it boots the real Electron window
against a synthetic profile and captures the documentation images. It doubles as
an end-to-end check that the UI actually renders.
