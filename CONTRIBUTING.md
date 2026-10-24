# Contributing

pi-crucible is the shared engine behind crucible runs in several repositories. Every change here
reaches all of them on their next `pi update --extensions`, so changes go through an issue and a PR, and the
bar is "every consuming repo still works", not "my repo works".

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems
privately ([SECURITY.md](SECURITY.md)).

## Where things go

| Change | Lives in |
|---|---|
| Stages, prompts, review-lens machinery, stop rules | `workflows/crucible.js` (this repo) |
| Packaging, `/crucible`, the `pi-crucible` resource, config schema, args validation | `extensions/`, `src/`, `schema/` (this repo) |
| Design sources, lens texts, skills, check commands for one project | that project's `AGENTS.md` and `.pi/crucible.json` (examples in `examples/`) |

If a change only makes sense for one project, it belongs in that project's config. The engine
stays project-neutral.

## Issues

- **Bug**: something in the engine, package or docs is wrong. Include the run id or receipt and
  the engine commit.
- **Engine change**: a proposal. Link the runs or findings that motivate it. Settle the design
  in the issue before writing code.
- **Run report**: what a run did. These reports are the experiment's data: which
  findings led to a change, whether round two converged, and what had to be fixed by hand.

Labels the engine and its runs use:

| Label | Meaning |
|---|---|
| `needs:human` | Waiting on a person. pi-crucible adds it on every stop and to every PR it opens; remove it when you have acted. |
| `seam` | A shared foundation that later issues build on. Reviewers then rate defects by blast radius. |
| `review:ux`, `review:security` | Add that review lens to a crucible run (`code` always runs). |
| `tracking` | Has sub-issues; closes when they do. |
| `run-report` | A crucible run report. |

## Making a change

1. Branch or worktree off `origin/main` (`issue-<n>-<slug>`). Don't commit to `main`.
2. `npm install`, then make the change.
3. Run the checks, which CI also runs:

   ```sh
   npm test          # args validation; registration round trip through pi-subagents
   npm run check     # workflows/crucible.js parses as the sandbox runs it
   ```

   If you touched `workflows/crucible.js`, also validate it from a pi session:
   `subagent({ action: "validate", workflow: "<path>/workflows/crucible.js" })`.
4. To try the engine from your checkout instead of the installed copy, start pi with
   `pi -e <checkout>/extensions/crucible.ts`. The script is re-read at each session start.
   Don't `/reload` while a crucible run is active; resume with `options.reuseFrom` instead.
5. Keep things in step:
   - Args added or changed in `crucible.js` → update `src/resource.ts` in the same commit.
   - Config fields added or changed → update `src/config.ts`, run `npm run schema`, and update
     Table 2 in `docs/crucible.md` and the files in `examples/`.
   - Stages, models, lenses or stop rules changed → update `docs/crucible.md` and regenerate the
     figure with `python3 docs/figures/make_figures.py` (stdlib only; commit the SVGs).
6. Open a PR with the template. Say what you could not verify.

## Workflow script rules

The script runs in the pi-subagents sandbox: no filesystem, no shell, no host globals, no nested
async functions. Everything it knows arrives as `args` (at most 16 KiB of plain JSON). Children
on claude-bridge models must be launched `async: true` on macOS.

## Commits

Small, well-described commits. When an agent wrote the change, add a trailer:
`Co-Authored-By: Claude <noreply@anthropic.com>` (or the agent's equivalent). Never `git stash`
(other agents may share the repository's stash) and never force-push `main`. Prefer merges over
rebasing anything already pushed.

## Merging

A person merges, never pi-crucible. The bar is green CI and the PR's checklist.

## License

Contributions are licensed under [Apache 2.0](LICENSE), as the rest of the repository.
