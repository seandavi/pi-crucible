# The factory: spec → implement → review → revise → PR

An experiment in running issues through a fixed loop of
[pi-subagents](https://github.com/nicobailon/pi-subagents), with the strong model where judgment
matters and the fast model where volume does. The script is
[`workflows/factory.js`](../workflows/factory.js).

![The factory workflow](figures/factory-flow-light.svg)

**Figure 1.** One run; see the [README](../README.md) for the legend.

| Stage | Model | Agent | Writes | Output |
|---|---|---|---|---|
| Spec | Opus | `worker` | `<specDir>/<issue>-<slug>.md` (default `docs/specs`), one commit | `{status, spec_path, blocking_questions}` |
| Implement | Sonnet | `worker` | code + tests, small commits | `{status, summary, changed_files, checks}`: one result per configured check |
| Review | Opus | `reviewer` (read-only), one per lens, in parallel | nothing | `{verdict, findings[]}` |
| Revise | Sonnet | `worker` | fixes for blocker/major findings, spec updates | `{status, responses[], checks}` |
| PR | Sonnet | `worker` | push, follow-up issue, `gh pr create` (or edit) | `{pr_url, draft, followup_issue}` |
| Flag | Haiku | `worker` | `needs:human` label + comment on the issue | — |

**Review lenses** are defined per repository in `.pi/factory.json`: a name and the text the
reviewer is told to check. `code` is required and runs on every issue, however the run is launched (the script adds it to any
`lenses` it is given; `defaultLenses` may add more, but must include it); a label `review:<name>` adds that lens to the issue's run. bioc-mcp, for
example, defines `code`, `ux` (agent and developer experience of its MCP tools) and `security`;
bioc-support-archive defines `code`, `ux` (a reader on an old link) and `privacy`. See
[`examples/`](../examples).

**Skills:** the built-in `worker` and `reviewer` agents do not inherit skills, so the config names
them per stage (`skills.build` for implement and revise, `skills.lenses.<lens>` per reviewer). A
missing skill is a warning, not a failure.

**Seams** (label `seam`, arg `seam: true`): for shared foundations that later issues build on, the
reviewers are told to rate inherited defects by blast radius, so a bypassable guard is `major`
even when nothing calls it yet. Added after #2, where four such findings came back as `minor`.

**Finding ids** are `<lens>-r<round>-<n>`, unique across rounds.

**Revise rounds:** at most two. Only `blocker` and `major` findings trigger a round, and only the
lenses that asked for changes review again. Revise fixes root causes and updates the spec when a
fix changes an interface, rule or example. Re-reviewers see the earlier findings and the responses
and judge the fix itself: a symptom patch that leaves the root cause is a new `major`. Added after
#2, where a post-hoc redirect check was accepted in round 1 and later replaced by hand. If
findings remain after round two, the PR opens as a **draft** listing them.

**Follow-ups:** `minor` and `nit` findings are filed as one issue, "Follow-ups from the #n review"
(a sub-issue of `parent` when given), and the PR links it.

**Stops:** a spec with blocking questions stops the run before any code is written; an
implementation reporting `blocked` stops before review; a PR stage that fails or opens no PR stops
the run at the end. All three label the issue `needs:human` (creating the label first if the repository lacks it) and
comment why; the run's result says whether the flag succeeded (`flagged`). Every PR the factory opens is labelled `needs:human` too; remove the label when you
have acted. Your queue is `gh issue list -l needs:human` plus `gh pr list -l needs:human`.

**Resuming:** `--start-at implement` skips the spec stage (the spec must already be on the branch);
`--start-at review` re-reviews an existing branch, e.g. after hand edits, and replaces the body of
its PR if one exists. Use it instead of fixing review findings by hand outside the factory, so the
record stays in the PR.

**Provenance:** `/factory` passes the engine's commit (and whether its checkout had local changes),
and the PR's factory record ends with `Engine: seandavi/pi-factory@<sha>`.

**Never automated:** merging. A human merges, from the main session.

## Configuring a repository

Each repository that uses the engine keeps two things: `AGENTS.md`, which every stage reads first,
and `.pi/factory.json`. The engine holds no project text; everything below reaches the workflow as
`args.config`. The schema is [`schema/factory.schema.json`](../schema/factory.schema.json)
(generated from [`src/config.ts`](../src/config.ts)); point `$schema` at it for editor help.

| Field | Used by | Meaning |
|---|---|---|
| `design` | every stage | Where the design lives and how to treat it. |
| `spec.design` | spec | What the spec's Design section must pin down for this project. |
| `implement` | implement | Project rules: fixtures, data tests must never read, setup steps. |
| `checks` | implement, revise, PR | `[{name, command}]`, run from the worktree root and reported by name. A `fail` makes the PR a draft. |
| `lenses` | review | `{name: text}`; `code` is required. |
| `defaultLenses` | `/factory` | Lenses every run gets; must include `code` (default `["code"]`). |
| `seamNote` | review | What later issues build on, for the `seam` reviewer note. |
| `skills` | implement, revise, review | `{build, lenses: {name: skill}}`. |
| `specDir` | spec | Default `docs/specs`. |
| `worktreeRoot` | `/factory` | Default `../<repo>-worktrees`, relative to the main checkout. |
| `parent` | PR | Tracking issue; the follow-up issue becomes its sub-issue. |
| `repo` | `/factory` | `owner/name`, when the `origin` remote does not say. |
| `commitAuthor` | every writing stage | `{name, email}`; default is the worktree's git config. The name may not contain control characters, backticks, `$` or `\`; the email is `local@domain` in plain characters. Both are single-quoted in the commit command. |
| `models` | every stage | `{strong, fast, small}` model ids; defaults are the claude-bridge Opus, Sonnet and Haiku 5.5. |

**Table 2.** `.pi/factory.json` fields. Everything except `defaultLenses`, `worktreeRoot`, `parent`,
`repo` and `$schema` is sent to the workflow, and pi-subagents caps workflow args at 16 KiB, so
`/factory` refuses a config whose lens texts push the args past that.

## Installing

The engine is a pi package. Install it on each machine from git main (no tags; `pi update`
pulls the latest main):

```sh
pi install git:github.com/seandavi/pi-factory
```

The package's extension (`extensions/factory.ts`) registers the workflow as the named
pi-subagents resource **`pi-factory`** in every session. To work on the engine itself, load the
checkout instead: `pi -e ~/Documents/git/pi-factory/extensions/factory.ts` (after `npm install`
there); the script is re-read on each session start, so `/reload` picks up edits.

**Named resource, not a path** (verified 2026-10-23 against pi-subagents 0.80.0). pi-subagents
exports `registerWorkflowResource` from `pi-subagents/workflow-resources` for trusted extensions.
Its registry lives on `globalThis` under `Symbol.for("pi-subagents.workflow-resources.v1")`, so the
copy this package depends on registers into the registry of the copy pi loaded, even though pi
gives each package its own module root. What that means in practice:

- Registration is per session: `session_start` registers, `session_shutdown` disposes.
- `resolve` must be synchronous with no I/O. The extension reads `workflows/factory.js` on
  `session_start` and `resolve` validates the args (`src/resource.ts`) and returns that text.
  Bad args fail before any child starts, with every problem listed.
- The script still sees the caller's `args`; receipts record the resource name and version as
  provenance; `options.reuseFrom` resumes a named run.
- If a future pi-subagents changes the registry version, launches fail with "Unknown workflow
  resource 'pi-factory'". Fallback: pass the installed script's path as `workflow` (raw-script
  provenance, otherwise identical), then bump the `pi-subagents` dependency here.

Checks: `npm test` (args validation and a registration round trip through pi-subagents' resolver),
`npm run check` (the script parses as a sandbox body), and
`subagent({ action: "validate", workflow: "<path to workflows/factory.js>" })`.

## Running it

From pi, anywhere inside the repository (its main checkout or any worktree):

```text
/factory 12                       # spec → implement → review → revise → PR
/factory 12 --dry-run             # show the worktree, branch and args; change nothing
/factory 12 --start-at review     # re-review the existing branch, update its PR
/factory 12 --lens security       # add a lens the issue's labels do not ask for
```

`/factory` reads `.pi/factory.json` from the main checkout and validates it; reads the issue (it
must be open) for its title and labels; picks lenses from `defaultLenses`, `review:<lens>` labels
and `--lens`, and `seam` from the label. It then creates the worktree
`<worktreeRoot>/issue-<n>` on branch `issue-<n>-<slug>` from `origin/main` (or reuses it, or checks
out an existing branch, which `--start-at` requires) and launches the `pi-factory` workflow
asynchronously through pi-subagents. Follow the run with `/subagents-fleet`.

The slug comes from the issue's title only for a new branch. If the issue already has a branch
(the worktree's current one, else the one `issue-<n>-*` branch locally or on origin), that branch and its
slug are used, so retitling an issue or making the branch by hand does not break `--start-at`; several
such branches are an error that lists them. The repository should have the `needs:human` label (`/factory` stops early with the `gh label create`
command if it is missing; the stages also create it when they flag a stop, so hand launches are covered) and should have `seam` and
`review:<lens>` for the lenses it defines (a warning if not).

Launching by hand still works, for scripts or other agents: pass the same args `/factory --dry-run`
prints. The validator holds hand launches to the names `/factory` derives: `branch` must be
`issue-<issue>-<slug>`, and `worktree` a normalized absolute path ending in `/issue-<issue>` with no control characters or shell
metacharacters. The validator cannot read the disk, so every stage that writes (spec, implement,
revise, PR) first runs `git -C '<worktree>' rev-parse --abbrev-ref HEAD`; unless it prints the issue
branch, the stage changes nothing and reports blocked (the PR stage, an empty `pr_url`). Reviewers are
read-only and have no shell, so they skip the check.

```js
subagent({ workflow: "pi-factory", async: true, cwd: "<repo>", args: { repo, issue, slug, worktree, branch, config, lenses, seam } })
```

## What to watch while it is an experiment

- Do the reviews find real problems, or restate the spec? (Count findings that led to a change.)
- Does round two ever happen, and does it converge?
- Time and tokens per stage, from the run receipts.
- Severity calibration: how many `minor` findings had to be fixed before merge anyway? (#2: five,
  all in the upstream seam; the `seam` note and v2's fix-judging are the response.)
- Work done outside the factory after a run. Each instance is a gap in the loop; prefer
  `startAt: "review"`.
- Skills: do findings or fixes cite `workers-best-practices`? If not after #7 and #11, drop it.
