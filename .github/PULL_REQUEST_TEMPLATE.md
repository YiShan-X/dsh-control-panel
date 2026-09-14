## What this changes

<!-- One or two sentences. Describe the symptom or the gap, not just the diff. -->

## Why

<!-- The reasoning a reviewer cannot recover from reading the code. -->

## How it was tested

- [ ] `npm test` passes
- [ ] `npm run smoke` passes (if the desktop shell or the UI changed)
- [ ] `npm run screenshot` was re-run (if the UI changed) and the images are in this PR
- [ ] Verified on: <!-- Windows / macOS / Linux — say which, the code paths differ -->

## Safety checklist

The README lists six guarantees. Confirm none of them is weakened here:

- [ ] No new code path can delete a real directory, or anything that is not a
      link this tool created
- [ ] Nothing new writes to the cc-switch database
- [ ] Every write to `cordis.patch.yml` still goes through `ensureValidArray`
- [ ] Parked MCP blocks are still restored verbatim, never regenerated
- [ ] Any new name arriving over HTTP is validated before it reaches a path join
- [ ] No new absolute path, personal skill name, or captured profile data is
      committed

## Related issues

<!-- Closes #... -->
