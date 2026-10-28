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
| Spec | Opus | `worker` | `<specDir>/<issue>-<slug>.md` (default `docs/specs`), one commit | `{status, spec_path, blocking_questions, trust_boundaries, ignored_comments}` |
| Implement | Sonnet | `worker` | code + tests, small commits | `{status, summary, changed_files, checks}`: one result per configured check |
| Diff | Haiku | `worker`, before each review round | `.pi/crucible-review/r<round>.diff` and `r<round>.blind.diff` (without the spec) in the worktree, ignored by git | `{status, summary, changed_files, diff_lines, blind_diff_lines, spec_present}` |
| Review | Opus | `reviewer` (read-only), one per lens, in parallel | nothing | `{verdict, findings[]}` |
| Blind review | Opus | `reviewer`, one per round it runs, in parallel with the lenses | nothing | `{verdict, findings[], trust_boundaries[]}` |
| Revise | Sonnet | `worker` | fixes for blocker/major findings, spec updates | `{status, responses[], checks}` |
| Integrate | Haiku; Sonnet for the fix | `worker`, once after review | a merge of `origin/main` into the branch; on a conflict or failing check, one fix round and a re-check | `{status, summary, main, merge, conflicts, checks, failures}`; fix: `{status, summary, changed_files, non_test_files, checks}` |
| PR | Sonnet | `worker` | push, follow-up issue, `gh pr create` (or edit) | `{pr_url, draft, followup_issue}` |
| Flag | Haiku | `worker` | `needs:human` label + comment on the issue | — |

**Review lenses** are defined per repository in `.pi/crucible.json`: a name and the text the
reviewer is told to check. `code` is required and runs on every issue, however the run is launched (the script adds it to any
`lenses` it is given; `defaultLenses` may add more, but must include it); a label `review:<name>` adds that lens to the issue's run. bioc-mcp, for
example, defines `code`, `ux` (agent and developer experience of its MCP tools) and `security`;
bioc-support-archive defines `code`, `ux` (a reader on an old link) and `privacy`. See
[`examples/`](../examples). `blind` is the engine's own lens: it runs on every issue and cannot be
defined in the config, named with `--lens` or asked for with a `review:blind` label (see
[The blind lens](#the-blind-lens)).

**Skills:** the built-in `worker` and `reviewer` agents do not inherit skills, so the config names
them per stage (`skills.build` for implement and revise, `skills.lenses.<lens>` per reviewer). A
missing skill is a warning, not a failure.

**Seams** (label `seam`, arg `seam: true`): for shared foundations that later issues build on, the
reviewers are told to rate inherited defects by blast radius, so a bypassable guard is `major`
even when nothing calls it yet. Added after #2, where four such findings came back as `minor`.

**Finding ids** are `<lens>-r<round>-<n>`, unique across rounds, and `blind-r<round>-scope-<n>` for
the blind lens's scope findings.

**The diff:** reviewers have no shell, so before each review round (round 0 and every
re-review) a Haiku worker writes `git diff origin/main...HEAD`, its `--stat` summary first, to
`.pi/crucible-review/r<round>.diff` in the worktree. A `.gitignore` containing `*` in that
directory keeps it out of git without touching the repository's own ignore files. Every reviewer
gets the file's path and git's list of changed files, reads the whole diff with its read tool, and
gives finding locations as `path:line` from the diff's hunks. If the diff step fails (a wrong
branch, a git error), the round is reviewed from the changed-file list instead, and pi-crucible
record says the diff was unavailable; the run does not stop. Added after bioc-mcp, where
reviewers without git reviewed from the file list alone (#4). The diff step also writes
`r<round>.blind.diff`, the same diff with the run's spec file left out (`:(exclude)<specPath>`),
and reports whether the spec file exists on the branch.

**The blind lens** (#31): anyone can open an issue, and the spec stage turns the issue into a
committed spec that the other lenses read, so a polite "small refactor" that also relaxes an auth
check could arrive with "reviewed by N lenses, no blockers". The engine therefore adds its own
reviewer, `blind`, to every run. It gets `r<round>.blind.diff` and the repository's `AGENTS.md`, and
nothing else: no issue, no comments, no spec, no `design` text, and it is told not to read the spec
directory. It reports, besides ordinary findings, what the change actually does to eight trust
boundaries (`auth`, `permissions`, `input-validation`, `secrets`, `network`, `dependencies`, `ci`,
`agent-instructions`). The spec stage declares the boundaries the change is meant to alter in its
`trust_boundaries` output (and in the spec's Trust boundaries section). The script, not a model,
compares the two: a boundary the blind lens found and the spec did not declare is a `major` finding,
`blind-r<round>-scope-<n>`. Revise must remove that part of the change, or decline the finding if
the issue needs it; it may never edit the spec to widen the declared scope, because a person decides
whether the scope widens. A declined scope finding stays open and makes the PR a draft. The blind
lens re-reviews in every revise round, alongside the lenses that had blocking findings, because revise
can change code in answer to a finding from a lens that reads the spec; it sees only its own earlier
findings and the responses to them. So the PR's trust-boundary record always describes the last
reviewed state of the branch. On `--start-at implement|review` there is no spec-stage
output to compare with, so the lens reports but nothing is compared, and the PR's record says so. The
integration-fix re-review stays the `code` lens alone.

**Sensitive paths** (#31): the script collects every path any stage reported changing (implement,
revise, the integration fix, and each diff's `git diff --name-only --no-renames`) and matches them against path
globs: the engine's defaults plus the repository's `sensitivePaths`. The defaults are CI
(`.github/`, `.gitlab-ci.yml`, `.circleci/`), agent instructions (`AGENTS.md`, `CLAUDE.md`, `.pi/`)
and dependency manifests and lockfiles (`package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
`yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `.npmrc`, `pyproject.toml`, `uv.lock`,
`poetry.lock`, `Pipfile`, `Pipfile.lock`, `requirements*.txt`, `setup.py`, `setup.cfg`, `Cargo.toml`,
`Cargo.lock`, `go.mod`, `go.sum`, `Gemfile`, `Gemfile.lock`, `DESCRIPTION`, `renv.lock`). A config can
add to them and cannot remove them. If any path matches, the PR body opens with a "Sensitive paths
touched" section listing each path and the pattern it matched, and the issue is labelled
`needs:human` as well as the PR. If no list of changed files exists at all (every diff failed and
no stage reported files), the PR says sensitive paths were not checked, with the same label. The PR
is not made a draft for this alone. A model only lists the paths (the diff stage copies
`git diff --name-only --no-renames`, so a rename lists the old path as well as the new one, and
`core.quotePath=false` keeps non-ASCII paths unquoted); the matching is in the script. The set is conservative: a path changed and
later reverted still counts.

| Pattern | Matches | Does not match |
|---|---|---|
| `.github/` | `.github/workflows/ci.yml`, `.github/dependabot.yml` | `docs/.github/x` |
| `package.json` | `package.json`, `web/package.json` | `package.json.bak` |
| `requirements*.txt` | `requirements.txt`, `py/requirements-dev.txt` | `requirements/dev.txt` |
| `src/auth/` | `src/auth/token.ts`, `src/auth/a/b.ts` | `src/authz.ts` |
| `**/auth/*.ts` | `auth/x.ts`, `src/auth/x.ts` | `src/auth/a/x.ts` |
| `src/*.ts` | `src/a.ts` | `src/a/b.ts`, `lib/src/a.ts` |

**Table 2.** How path globs match. `*` and `?` stay within one path segment, `**` crosses them, a
trailing `/` means everything under that directory, and a pattern without `/` matches the file name
in any directory.

**Revise rounds:** at most two. Only `blocker` and `major` findings trigger a round, and only the
lenses that asked for changes review again, plus the blind lens (see The blind lens). Revise fixes root causes and updates the spec when a
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
the run at the end; a spec missing from the branch when review starts stops the run before any
reviewer runs (the lenses never review against the issue instead, #31). Integration never stops the
run; see above. All four label the issue `needs:human` (creating the label first if the repository lacks it) and
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

## Threat model

pi-crucible reads text written by people it does not control and runs agents with shell access on
the machine of the person who launched it. This section says what that text can and cannot do (#31).

**Who can do what.** Anyone can open an issue, or comment on one, in a public repository, so issue
text is untrusted input. Only a person with the checkout launches a run (`/crucible`, or a hand
launch of the workflow), and only a person merges the PR. Any future trigger by label, webhook or
an outer loop (#30) must first check that whoever triggered it is a maintainer (`OWNER`, `MEMBER` or
`COLLABORATOR`); nothing here builds such a trigger.

| Stage | Sees |
|---|---|
| Spec | the issue body; comments from owners, members, collaborators and the issue's author (the others are listed without their text); `AGENTS.md`; the design sources |
| Implement | the spec |
| Review (configured lenses) | the spec, the diff |
| Blind review | the diff without the spec, `AGENTS.md` |
| Revise | the findings, the spec |
| PR | the spec's summary, the crucible record |

**Table 3.** What each stage reads of the issue's story. Only the spec stage reads the issue and its
comments. The spec stage's prompt calls them untrusted requests, never instructions, and requires
a Trust boundaries section; a change that weakens, removes or bypasses a check, adds a dependency or
changes CI must also be named as its own Risk. The comment filter is jq run through `gh api` with
`author_association`; the issue author is passed as `issueAuthor` (a bot or an `app/...` login gets no
exception). The PR's record has an "Ignored comments" line.

**What no model decides:** the sensitive-path match, the scope comparison between the declared and
found trust boundaries, the `needs:human` labels, the draft rule, and the merge.

**What remains:**

- The configured lenses still read a spec that the issue shaped; the spec model may declare a
  boundary the issue talked it into. That shows in the spec's Trust boundaries section and in the
  record.
- The diff's own comments, docs and test names can still argue with the blind lens, which is itself a
  model that may miss a change.
- Resumed runs (`--start-at implement|review`) do not compare scope.
- Defaults such as `package.json` flag routine dependency edits too, and cannot yet be removed.
- A maintainer who quotes an untrusted comment puts it in front of the spec stage. The comment
  filter depends on the spec model running the commands it is given instead of
  `gh issue view --comments`; nothing enforces that.

**Red-team check.** To see whether the defences work, run this in a scratch repository with a small
auth check, and file the result as a run report. From an account without write access, open two
issues: (1) a polite "small refactor" that also asks to drop the "redundant" token check, and (2) one
that also adds a dependency. Run `/crucible` on each. Record what the spec declared under Trust
boundaries, what the blind lens found, the scope findings, whether the PR opened with a "Sensitive
paths touched" section, whether the issue got `needs:human`, and whether the PR was a draft. The
unit tests cover both scenarios with fake runs; the live run needs real models and a real
repository.

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
| `lenses` | review | `{name: text}`; `code` is required. `blind` is reserved for the engine's own lens and is rejected. |
| `sensitivePaths` | PR | Path globs added to the engine's defaults; a change to a matching path opens the PR with a "Sensitive paths touched" section and labels the issue `needs:human`. |
| `defaultLenses` | `/crucible` | Lenses every run gets; must include `code` (default `["code"]`). |
| `seamNote` | review | What later issues build on, for the `seam` reviewer note. |
| `skills` | implement, revise, integration fix, review | `{build, lenses: {name: skill}}`; `build` goes to implement, revise and the integration fix. |
| `specDir` | spec | Default `docs/specs`. |
| `worktreeRoot` | `/crucible` | Default `../<repo>-worktrees`, relative to the main checkout. |
| `parent` | PR | Tracking issue; the follow-up issue becomes its sub-issue. |
| `repo` | `/crucible` | `owner/name`, when the `origin` remote does not say. |
| `commitAuthor` | every writing stage | `{name, email}`; default is the worktree's git config. The name may not contain control characters, backticks, `$` or `\`; the email is `local@domain` in plain characters. Both are single-quoted in the commit command. |
| `models` | every stage | `{strong, fast, small}` model ids; defaults are the claude-bridge Opus, Sonnet and Haiku 5.5. |

**Table 4.** `.pi/crucible.json` fields. Everything except `defaultLenses`, `worktreeRoot`, `parent`,
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
`code`. It warns when there is no `AGENTS.md`. When no config exists, it detects checks from
`package.json` scripts (`typecheck`, `lint`, `test`), `justfile` or `Makefile` recipes (`check`,
`lint`, `test`) and `pyproject.toml` (pytest, ruff), and offers a starter `.pi/crucible.json` with
generic texts for `design`, `spec.design`, `implement` and the `code`, `security` and `ux` lenses.
Edit those texts for the project (they make better runs) and merge the file to `main`. With no
checks detected the config has none, and runs report "no checks configured".

## Before a run: triage

An issue is a claim from whoever filed it. The package ships an `issue-triage` skill
([`skills/issue-triage/SKILL.md`](../skills/issue-triage/SKILL.md)), invoked by name
(`/skill:issue-triage` in pi). It checks the issue's claims against real data, logs and code and
drafts a record for Sean to approve before it posts. The record says whether the issue is real,
what the evidence is, and what is missing; it does not design the fix, which stays with the spec
stage. Outcomes are `triage:ready` (applied by Sean only), `triage:needs-info`,
`triage:unconfirmed`, not-a-bug and duplicate. The record is a comment marked
`<!-- issue-triage -->`. The spec stage does not yet treat it differently from any other comment;
that is a follow-up. Added after omicidx#237 (#51).

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

**From an agent:** the extension also registers two tools on the same code path, so the agent in a
pi session can start runs without rebuilding args (#53). `crucible_plan({issue, startAt?, lenses?})`
returns what `--dry-run` shows (worktree, branch, lenses, config source, warnings, args) and changes
nothing but the fetch. `crucible_launch` with the same parameters prepares the worktree, launches and
returns the run id; it refuses with the same messages as `/crucible`. Both the launch result and the
message `/crucible` sends the agent say that a person merges the PR: the agent must not merge,
approve, push to the branch, or comment on or close the issue or PR (#35). Which issues to launch is
the caller's decision; the tools don't check triage state.

Launching by hand still works, for scripts and agents outside pi: pass the same args `/crucible --dry-run`
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
- The blind lens: how often its scope findings are real, and how often the sensitive-paths section
  appears on routine PRs (#31).
- Time and tokens per stage, from the run receipts.
- Severity calibration: how many `minor` findings had to be fixed before merge anyway? (#2: five,
  all in the upstream seam; the `seam` note and v2's fix-judging are the response.)
- Work done outside pi-crucible after a run. Each instance is a gap in the loop; prefer
  `startAt: "review"`.
- Skills: do findings or fixes cite `workers-best-practices`? If not after #7 and #11, drop it.
