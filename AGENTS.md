# AGENTS.md

This repo is the pi-crucible engine itself. Read [docs/crucible.md](docs/crucible.md) first.

- The workflow script runs in the pi-subagents sandbox: no filesystem, no shell, no nested async
  functions. Validate every change with `subagent({ action: "validate", workflow: "<path>" })`
  and run `npm test` and `npm run check` (the latter parses the script as an async function body).
- When the script's args change, update the validator in `src/resource.ts` in the same commit;
  when config fields change, `src/config.ts` and `npm run schema` (the tests check the schema file).
- This repo runs its own issues through pi-crucible: `.pi/crucible.json` is its config.
- When stages, models, lenses or stop rules change, update `docs/crucible.md` and regenerate the
  README figure: `python3 docs/figures/make_figures.py`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- Claude-bridge children must be launched `async: true` on the Mac.
- `/reload` during a crucible run is recoverable: pi-subagents (≥0.82) resumes the run once, reusing
  finished stages. Except after editing `workflows/crucible.js`: the resource must resolve to the
  same script, so the auto-resume is refused (pi-subagents docs/workflows.md, "Failed lane recovery").
  Don't edit the script during a run; if you did, relaunch by hand with `options.reuseFrom`, with
  the issue's worktree as `cwd` (the host commands run there). A resume also needs the check grant
  `/crucible` recorded in the session that launched it; from another session it is refused, so
  relaunch with `/crucible <n> --start-at implement` (or `review`).
- Changes here affect every repo that uses the engine: keep the project-specific parts in each
  repo's config, not in the engine.
- Small, well-described commits with a `Co-Authored-By` trailer when an agent wrote them. Never
  `git stash`; never force-push `main`.
