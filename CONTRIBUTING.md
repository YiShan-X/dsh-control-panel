# Contributing

Thanks for taking the time. This is a small project with a narrow purpose, and
the most useful contributions are usually bug reports with a concrete
reproduction.

## Getting set up

```bash
git clone https://github.com/YiShan-X/dsh-control-panel.git
cd dsh-control-panel
npm install
npm test          # should be green before and after your change
npm run smoke     # boots the real desktop window and exits
```

`npm test` needs nothing but Node 22.5+. `npm install` (and Electron) is only
needed for the desktop shell, the smoke test and the screenshot generator.

## What "good" looks like here

**Keep the core dependency-free.** `src/core/` must run on a bare Node install
with no `node_modules`. Everything it uses comes from `node:` — `node:http`,
`node:fs`, `node:path`, `node:sqlite`. The desktop packaging may pull in
dependencies; the panel may not.

**Do not weaken a safety guarantee.** The six guarantees in the README are the
product. If a change makes one of them conditional, that is a design discussion
first, not a pull request.

**Test the bug, not just the fix.** The suite is deliberately built around
throwaway sandboxes (`test/helpers.mjs`) rather than mocks, so a regression test
can create real skills, real links and a real patch file. If you found a bug by
hand, there is almost always a way to reproduce it in there.

**Never commit a real profile.** No absolute paths from your machine, no captured
skill names, no screenshots of your own configuration. `npm run screenshot`
exists so the documentation images come from synthetic data.

**Prefer deleting a line to adding a comment.** Where a decision is non-obvious
(a guard, a platform branch, a workaround for someone else's bug), a short
comment explaining *why* is worth more than a paragraph in the README.

## Commits and pull requests

- One logical change per pull request.
- Conventional-commit-style subjects are welcome but not enforced:
  `fix:`, `feat:`, `docs:`, `test:`, `chore:`.
- Describe the *symptom* you saw, not just the code you changed.
- Say which platform you tested on. Windows, macOS and Linux take genuinely
  different code paths through the skill-link and MCP-shim logic.

## Reporting a bug

Include:

- your OS and Node version (`node -v`), and whether it was the desktop build or
  browser mode;
- the resolved paths (About tab, or `node src/cli.mjs --print-config`);
- what you did, what you expected, what happened;
- the log if the desktop app was involved (`Help → Reveal log file`).

**Redact your own profile before pasting.** Skill names, repository URLs and
`cordis.patch.yml` contents are personal.

## Reporting a security issue

Please do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
