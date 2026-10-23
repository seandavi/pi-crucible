# pi-factory

A spec → implement → review → revise → PR loop for GitHub issues, run as a
[pi-subagents](https://github.com/nicobailon/pi-subagents) workflow: the strong model (Opus) where
judgment matters, the fast model (Sonnet) where volume does, Haiku for bookkeeping. A human merges.

> **Status: seed, packaged.** `workflows/factory.js` and `docs/factory.md` were copied from
> [seandavi/bioc-mcp](https://github.com/seandavi/bioc-mcp) at commit
> `e51c13fa8b957dbc65c28fd2c74262a4b43300ed` (2026-10-22), where the loop ran about 25 issues,
> and are now installable as a pi package (#2).
> They still contain bioc-mcp's project block (design URL, skills, review lenses). The open issues
> turn this into a shared engine; until then bioc-mcp and
> [bioc-support-archive](https://github.com/seandavi/bioc-support-archive) keep their own copies.

## Install

```sh
pi install git:github.com/seandavi/pi-factory
```

Then launch with `subagent({ workflow: "pi-factory", async: true, args: { ... } })`. See
[docs/factory.md](docs/factory.md#installing) for the args and how the named resource works.

## Where it is going

- **Engine here, project config in each repo.** This repo holds the stage logic, prompts and lens
  machinery, installed on each machine as a pi package from git main. Each repo keeps `AGENTS.md`
  and a `.pi/factory.json` (design sources, lenses, skills, check commands).
- **A `/factory <issue>` launcher** reads that config, creates the worktree and branch, picks review
  lenses from the issue's labels and launches the workflow (the workflow sandbox cannot read
  files, so configuration arrives as args).
- **Provenance:** every factory PR records the engine commit that produced it.

## Lessons carried over from bioc-mcp

What worked: parallel review lenses that find real problems; fix-judging (re-reviewers judge the
fix, not just the symptom); seam-aware severity; specs kept in step with code; follow-up issues;
`needs:human` on every stop; `startAt` to resume. What it lacked, and the issues here address:
an integration step (semantic merge breaks between parallel PRs surfaced only when merged by hand),
reviewers that always see the diff, and one shared copy instead of drifting ports.

## License

Apache 2.0, as the bioc-mcp original.
