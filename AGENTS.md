# AGENTS.md

This repo is the factory engine itself. Read [docs/factory.md](docs/factory.md) first.

- The workflow script runs in the pi-subagents sandbox: no filesystem, no shell, no nested async
  functions. Validate every change with `subagent({ action: "validate", workflow: "<path>" })`
  (and `node --check` on a copy wrapped in an async function).
- Claude-bridge children must be launched `async: true` on the Mac.
- Never `/reload` pi while a factory run is active; resume with `options.reuseFrom`.
- Changes here affect every repo that uses the engine: keep the project-specific parts in each
  repo's config, not in the engine.
- Small, well-described commits with a `Co-Authored-By` trailer when an agent wrote them. Never
  `git stash`; never force-push `main`.
