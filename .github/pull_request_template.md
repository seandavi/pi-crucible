Closes #

## What and why

## Checks

- [ ] `npm test`
- [ ] `npm run check`
- [ ] `subagent({ action: "validate", workflow: "workflows/crucible.js" })` (if the script changed)
- [ ] Args in `workflows/crucible.js` and `src/resource.ts` still agree (if args changed)
- [ ] `python3 docs/figures/make_figures.py` re-run and `docs/crucible.md` updated (if stages, models or labels changed)

## Not verified

<!-- Anything you could not check, e.g. "no full crucible run". -->
