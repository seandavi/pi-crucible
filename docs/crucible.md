# pi-crucible: spec → implement → review → revise → integrate → PR

Formerly **pi-factory** (renamed in #23). `/factory`, the `pi-factory` resource name and
`.pi/factory.json` still work and warn; rename the config file when convenient.

An experiment in running issues through a fixed loop of
[pi-subagents](https://github.com/nicobailon/pi-subagents), with the strong model where judgment
matters and the fast model where volume does. The script is
[`workflows/crucible.js`](../workflows/crucible.js).

![The pi-crucible workflow](figures/crucible-flow-light.svg)

**Figure 1.** One run; see the [README](../README.md) for the legend.

| Stage | Model | Agent | Writes | Output |
|---|---|---|---|---|
| Spec | Opus | `worker` | `<specDir>/<issue>-<slug>.md` (default `docs/specs`), one commit | `{status, spec_path, blocking_questions}` |
| Implement | Sonnet | `worker` | code + tests, small commits | `{status, summary, changed_files, checks}`: one result per configured check |
| Diff | Haiku | `worker`, before each review round | `.pi/crucible-review/r<round>.diff` in the worktree, ignored by git | `{status, summary, changed_files, diff_lines}` |
| Review | Opus | `reviewer` (read-only), one per lens, in parallel | nothing | `{verdict, findings[]}` |
| Revise | Sonnet | `worker` | fixes for blocker/major findings, spec updates | `{status, responses[], checks}` |
| Integrate | Haiku; Sonnet for the fix | `worker`, once after review | a merge of `origin/main` into the branch; on a conflict or failing check, one fix round and a re-check | `{status, summary, main, merge, conflicts, checks, failures}`; fix: `{status, summary, changed_files, non_test_files, checks}` |
| PR | Sonnet | `worker` | push, follow-up issue, `gh pr create` (or edit) | `{pr_url, draft, followup_issue}` |
| Flag | Haiku | `worker` | `needs:human` label + comment on the issue | — |

**Review lenses** are defined per repository in `.pi/crucible.json`: a name and the text the
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

**The diff:** reviewers have no shell, so before each review round (round 0 and every
re-review) a Haiku worker writes `git diff origin/main...HEAD`, its `--stat` summary first, to
`.pi/crucible-review/r<round>.diff` in the worktree. A `.gitignore` containing `*` in that
directory keeps it out of git without touching the repository's own ignore files. Every reviewer
gets the file's path and git's list of changed files, reads the whole diff with its read tool, and
gives finding locations as `path:line` from the diff's hunks. If the diff step fails (a wrong
branch, a git error), the round is reviewed from the changed-file list instead, and pi-crucible
record says the diff was unavailable; the run does not stop. Added after bioc-mcp, where
reviewers without git reviewed from the file list alone (#4).

**Revise rounds:** at most two. Only `blocker` and `major` findings trigger a round, and only the
lenses that asked for changes review again. Revise fixes root causes and updates the spec when a
fix changes an interface, rule or example. Re-reviewers see the earlier findings and the responses
and judge the fix itself: a symptom patch that leaves the root cause is a new `major`. Added after
#2, where a post-hoc redirect check was accepted in round 1 and later replaced by hand. If
findings remain after round two, the PR opens as a **draft** listing them.

**Follow-ups:** `minor` and `nit` findings are filed as one issue, "Follow-ups from the #n review"
(a sub-issue of `parent` when given), and the PR links it.

**Integration:** each run's checks pass against the main it started from, and parallel runs can
still break each other once merged (in bioc-mcp: a changed function signature, twice, and a test
fixture's record ids). So after review a Haiku worker fetches `origin`, merges `origin/main` into
the branch (a merge commit, never a rebase) and runs every configured check in full. On a
conflict or a failing check, one Sonnet fix round gets the conflicting paths or the checks'
output, fixes the branch without reverting main's changes, and a Haiku re-check merges and runs
the checks again. If the fix touched files other than tests, fixtures and test data, the `code`
lens re-reviews in one more round, with its own diff; its blocker/major findings are added to the
still-open ones (it judges the fix, so it never clears an earlier finding) rather than starting
another revise round. The checks the PR reports are the post-merge ones, and
its crucible record gets an Integration line. A branch that still conflicts or fails, or whose
integration could not run, opens as a draft PR saying why; the run does not stop (#5).

**Stops:** a spec with blocking questions stops the run before any code is written; an
implementation reporting `blocked` stops before review; a PR stage that fails or opens no PR stops
the run at the end. Integration never stops the run; see above. All three label the issue `needs:human` (creating the label first if the repository lacks it) and
comment why; the run's result says whether the flag succeeded (`flagged`). Every PR pi-crucible opens is labelled `needs:human` too; remove the label when you
have acted. Your queue is `gh issue list -l needs:human` plus `gh pr list -l needs:human`.

**Resuming:** `--start-at implement` skips the spec stage (the spec must already be on the branch);
`--start-at review` re-reviews an existing branch and integrates it again, e.g. after hand edits
or when main has moved, and replaces the body of its PR if one exists. Use it instead of fixing review findings by hand outside pi-crucible, so the
record stays in the PR.

**Provenance:** `/crucible` passes the engine's commit (and whether its checkout had local changes),
and the PR's crucible record ends with `Engine: seandavi/pi-crucible@<sha>`. The config is read from
`origin/main`, so the run's config is the one at that commit (`--dry-run` shows it), unless
`/crucible` warned that it fell back to the working tree.

**Never automated:** merging the PR. A human merges, from the main session. (The integration stage merges main into the branch, never the branch into main.)

## Configuring a repository

Each repository that uses the engine keeps two things: `AGENTS.md`, which every stage reads first,
and `.pi/crucible.json`. Merge the config to `main`: `/crucible` reads it from `origin/main` (see
[Running it](#running-it)). The engine holds no project text; everything below reaches the workflow as
`args.config`. The schema is [`schema/crucible.schema.json`](../schema/crucible.schema.json)
(generated from [`src/config.ts`](../src/config.ts)); point `$schema` at it for editor help.

| Field | Used by | Meaning |
|---|---|---|
| `design` | every stage | Where the design lives and how to treat it. |
| `spec.design` | spec | What the spec's Design section must pin down for this project. |
| `implement` | implement, integration fix | Project rules: fixtures, data tests must never read, setup steps. |
| `checks` | implement, revise, integration, PR | `[{name, command}]`, run from the worktree root and reported by name. A `fail` makes the PR a draft. Integration runs all of them after merging main. |
| `lenses` | review | `{name: text}`; `code` is required. |
| `defaultLenses` | `/crucible` | Lenses every run gets; must include `code` (default `["code"]`). |
| `seamNote` | review | What later issues build on, for the `seam` reviewer note. |
| `skills` | implement, revise, integration fix, review | `{build, lenses: {name: skill}}`; `build` goes to implement, revise and the integration fix. |
| `specDir` | spec | Default `docs/specs`. |
| `worktreeRoot` | `/crucible` | Default `../<repo>-worktrees`, relative to the main checkout. |
| `parent` | PR | Tracking issue; the follow-up issue becomes its sub-issue. |
| `repo` | `/crucible` | `owner/name`, when the `origin` remote does not say. |
| `commitAuthor` | every writing stage | `{name, email}`; default is the worktree's git config. The name may not contain control characters, backticks, `$` or `\`; the email is `local@domain` in plain characters. Both are single-quoted in the commit command. |
| `models` | every stage | `{strong, fast, small}` model ids; defaults are the claude-bridge Opus, Sonnet and Haiku 5.5. |

**Table 2.** `.pi/crucible.json` fields. Everything except `defaultLenses`, `worktreeRoot`, `parent`,
`repo` and `$schema` is sent to the workflow, and pi-subagents caps workflow args at 16 KiB, so
`/crucible` refuses a config whose lens texts push the args past that.

## Installing

The engine is a pi package. Install it on each machine from git main (no tags; `pi update --extensions`
pulls the latest main):

```sh
pi install git:github.com/seandavi/pi-crucible
```

The package's extension (`extensions/crucible.ts`) registers the workflow as the named
pi-subagents resource **`pi-crucible`** in every session. To work on the engine itself, load the
checkout instead: `pi -e ~/Documents/git/pi-crucible/extensions/crucible.ts` (after `npm install`
there); the script is re-read on each session start, so `/reload` picks up edits.

**Named resource, not a path** (verified 2026-10-23 against pi-subagents 0.80.0). pi-subagents
exports `registerWorkflowResource` from `pi-subagents/workflow-resources` for trusted extensions.
Its registry lives on `globalThis` under `Symbol.for("pi-subagents.workflow-resources.v1")`, so the
copy this package depends on registers into the registry of the copy pi loaded, even though pi
gives each package its own module root. What that means in practice:

- Registration is per session: `session_start` registers, `session_shutdown` disposes.
- `resolve` must be synchronous with no I/O. The extension reads `workflows/crucible.js` on
  `session_start` and `resolve` validates the args (`src/resource.ts`) and returns that text.
  Bad args fail before any child starts, with every problem listed.
- pi-subagents hands a named resource's `args` only to `resolve`; the sandbox starts with empty
  `args` (`subagent-executor.js`: `const { workflow, args, ...rest } = publicParams`). So `resolve`
  prepends the validated args to the script as `const CRUCIBLE_ARGS = {...};`, and the script uses
  them, falling back to `args` when launched by path. (Corrected 2026-10-24: the first note here
  said the script sees `args`; the first real `/crucible` run failed on exactly that.) Receipts record
  the resource name and version as provenance.
- If a future pi-subagents changes the registry version, launches fail with "Unknown workflow
  resource 'pi-crucible'". Fallback: pass the installed script's path as `workflow` (raw-script
  provenance, otherwise identical), then bump the `pi-subagents` dependency here.

Checks: `npm test` (args validation and a registration round trip through pi-subagents' resolver),
`npm run check` (the script parses as a sandbox body), and
`subagent({ action: "validate", workflow: "<path to workflows/crucible.js>" })`.

## First run in a new repository

```text
/crucible init               # labels, AGENTS.md check, detected checks, starter config (printed)
/crucible init --write       # also write .pi/crucible.json (never overwrites an existing one)
/crucible init --dry-run     # report only: create nothing
```

`init` creates the labels a run uses that the repository lacks: `needs:human` (every stop and every
PR carries it; `/crucible` refuses to start without it), `seam`, and `review:<lens>` for each lens but
`code`. It warns when there is no `AGENTS.md`. When no config exists, it detects checks from CI first: the `run:` steps of the workflows in
`.github/workflows` that run on `pull_request`, in file, job and step order. It drops `uses:`
steps and setup (`npm ci`, `pip install`, `uv sync`, …), joins a multi-line script's lines
with `&&`, prefixes `cd <dir> &&` for a `working-directory`, and leaves out steps that only work
inside Actions: `${{ }}` expressions, writes to `$GITHUB_ENV` and friends, a non-bash shell, or
shell control flow across lines. It lists what it left out and why. Reusable workflows are not
followed. Check names come from the step's `name`, else from the command (`npm run lint` →
`lint`). Only when CI yields no check does it fall back to `package.json` scripts
(`typecheck`, `lint`, `test`), `justfile` or `Makefile` recipes (`check`, `lint`, `test`) and
`pyproject.toml` (pytest, ruff). It then offers a starter `.pi/crucible.json` with
generic texts for `design`, `spec.design`, `implement` and the `code`, `security` and `ux` lenses.
Edit those texts for the project (they make better runs) and merge the file to `main`. With no
checks detected the config has none, and runs report "no checks configured".

## Running it

From pi, anywhere inside the repository (its main checkout or any worktree):

```text
/crucible 12                       # spec → implement → review → revise → integrate → PR
/crucible 12 --dry-run             # show the worktree, branch and args; change nothing
/crucible 12 --start-at review     # re-review and re-integrate the existing branch, update its PR
/crucible 12 --lens security       # add a lens the issue's labels do not ask for
```

`/crucible` fetches `origin` and reads `.pi/crucible.json` as `origin/main` has it, so the config
that drives a run is the one reviewed on main, whatever branch the main checkout is on or has
uncommitted. Only when `origin/main` has no config yet (while a repository's first config PR is
open) does it read the main checkout's working tree instead, with a warning. It also warns when
the working tree's copy differs from main's, and `--dry-run` says which copy it used. It
validates the config; reads the issue (it
must be open) for its title and labels; picks lenses from `defaultLenses`, `review:<lens>` labels
and `--lens`, and `seam` from the label. It then creates the worktree
`<worktreeRoot>/issue-<n>` on branch `issue-<n>-<slug>` from `origin/main` (or reuses it, or checks
out an existing branch, which `--start-at` requires) and launches the `pi-crucible` workflow
asynchronously through pi-subagents. Follow the run with `/subagents-fleet`.

The slug comes from the issue's title only for a new branch. If the issue already has a branch
(the worktree's current one, else the one `issue-<n>-*` branch locally or on origin), that branch and its
slug are used, so retitling an issue or making the branch by hand does not break `--start-at`; several
such branches are an error that lists them. The repository should have the `needs:human` label (`/crucible` stops early with the `gh label create`
command if it is missing; the stages also create it when they flag a stop, so hand launches are covered) and should have `seam` and
`review:<lens>` for the lenses it defines (a warning if not).

Launching by hand still works, for scripts or other agents: pass the same args `/crucible --dry-run`
prints. The validator holds hand launches to the names `/crucible` derives: `branch` must be
`issue-<issue>-<slug>`, and `worktree` a normalized absolute path ending in `/issue-<issue>` with no control characters or shell
metacharacters. The validator cannot read the disk, so every stage that writes (spec, implement,
diff, revise, integrate, PR) first runs `git -C '<worktree>' rev-parse --abbrev-ref HEAD`; unless it prints the issue
branch, the stage changes nothing and reports blocked (the PR stage, an empty `pr_url`). Reviewers are
read-only and have no shell, so they skip the check and read the diff the diff stage wrote.

```js
subagent({ workflow: "pi-crucible", async: true, cwd: "<repo>", args: { repo, issue, slug, worktree, branch, config, lenses, seam } })
```

## What to watch while it is an experiment

- Do the reviews find real problems, or restate the spec? (Count findings that led to a change.)
- Does round two ever happen, and does it converge?
- Do findings cite the diff (`path:line` locations in changed hunks)? How often is a round's
  diff unavailable?
- Integration: how often main had moved, how often the merge conflicted or a check failed after
  it, whether the fix round converged, and whether the code re-review found anything. Did a merge
  break still reach a human?
- Time and tokens per stage, from the run receipts.
- Severity calibration: how many `minor` findings had to be fixed before merge anyway? (#2: five,
  all in the upstream seam; the `seam` note and v2's fix-judging are the response.)
- Work done outside pi-crucible after a run. Each instance is a gap in the loop; prefer
  `startAt: "review"`.
- Skills: do findings or fixes cite `workers-best-practices`? If not after #7 and #11, drop it.
