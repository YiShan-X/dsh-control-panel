# Security Policy

## What this tool is trusted with

DSH Control Panel runs with the user's own privileges and edits files in their
profile. It creates and removes directory links in the DSH skill root and
rewrites two YAML files. That is the entire blast radius it is designed for, and
the README documents the guarantees that keep it there.

The most valuable reports are the ones that show a guarantee being broken:

- deleting or modifying anything other than a link this tool created;
- any write to the cc-switch SQLite database;
- producing a `cordis.patch.yml` that a boot loader would reject;
- overwriting a hand-written or hand-tuned MCP block;
- reading or writing a file outside the configured paths, including through a
  crafted name arriving over HTTP;
- using the local HTTP server (or the Electron renderer) to reach something it
  should not — arbitrary path opening, code execution, or escaping the app's
  origin.

## Reporting

Report privately through
[GitHub Security Advisories](https://github.com/YiShan-X/dsh-control-panel/security/advisories/new).

Please include a reproduction. A small script or an exact sequence of UI actions
is worth more than a description.

You can expect an acknowledgement within a few days. This is a volunteer project,
so there is no formal SLA, but a confirmed issue in one of the guarantees above
takes priority over everything else.

## Out of scope

- **The unsigned builds.** SmartScreen and Gatekeeper warnings are expected; see
  the install section of the README. A report that the binaries are unsigned is
  not a vulnerability report.
- **Anything requiring an attacker who already has local code execution** as the
  same user. They can edit the same files directly.
- **The cc-switch database being readable.** It is opened read-only by design, and
  it is readable by its owner either way.
- **Vulnerabilities in DSH, cc-switch, Electron or Node itself.** Report those
  upstream — though a report that this project *misuses* one of them is very much
  in scope.

## Supported versions

The latest release receives fixes. There is no back-porting to older majors.
