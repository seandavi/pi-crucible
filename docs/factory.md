# The factory: spec → implement → review → revise → PR

An experiment in running issues through a fixed loop of
[pi-subagents](https://github.com/nicobailon/pi-subagents), with the strong model where judgment
matters and the fast model where volume does. The script is
[`workflows/factory.js`](../workflows/factory.js).

| Stage | Model | Agent | Writes | Output |
|---|---|---|---|---|
| Spec | Opus | `worker` | `docs/specs/<issue>-<slug>.md`, one commit | `{status, spec_path, blocking_questions}` |
| Implement | Sonnet | `worker` | code + tests, small commits | `{status, summary, changed_files, checks}` |
| Review | Opus | `reviewer` (read-only), one per lens, in parallel | nothing | `{verdict, findings[]}` |
| Revise | Sonnet | `worker` | fixes for blocker/major findings, spec updates | `{status, responses[], checks}` |
| PR | Sonnet | `worker` | push, follow-up issue, `gh pr create` (or edit) | `{pr_url, draft, followup_issue}` |
| Flag | Haiku | `worker` | `needs:human` label + comment on the issue | — |

**Review lenses** (chosen per issue from labels):

- `code` (always): correctness against the spec, tests that would catch a regression, the
  one-capability-two-transports rule, Ousterhout-style deep modules with clear seams, no
  network in tests. The spec and the code must agree; a stale spec is `major`, because later
  issues copy it.
- `ux` (label `review:ux`): the agent and developer experience. Tool names, descriptions that
  say when *not* to use the tool, input/output schemas, error messages an agent can act on,
  result size, provenance; REST paths and OpenAPI; README and connection instructions.
- `security` (label `review:security`): SSRF (no tool fetches a caller-supplied URL), input
  validation, secret handling, fork-PR CI safety, rate limiting, nothing non-public returned.

**Skills:** the built-in `worker` and `reviewer` agents do not inherit skills, so the script names
them per stage. Implement, revise and the `code`/`security` lenses get the project skill
`workers-best-practices` (`.agents/skills/`, pinned in `skills-lock.json`). It is a trial: keep it
if reviews cite it for real findings.

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
implementation reporting `blocked` stops before review. Both label the issue `needs:human` and
comment why. Every PR the factory opens is labelled `needs:human` too; remove the label when you
have acted. Your queue is `gh issue list -l needs:human` plus `gh pr list -l needs:human`.

**Resuming:** `startAt: "implement"` skips the spec stage (the spec must already be on the branch);
`startAt: "review"` re-reviews an existing branch, e.g. after hand edits, and replaces the body of
its PR if one exists. Use it instead of fixing review findings by hand outside the factory, so the
record stays in the PR.

**Never automated:** merging. A human merges, from the main session.

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

Prepare an isolated worktree for the issue (the workflow sandbox has no shell), then launch:

```sh
git -C ~/Documents/git/bioc-mcp fetch origin
git -C ~/Documents/git/bioc-mcp worktree add -b issue-2-scaffold \
  ~/Documents/git/bioc-mcp-worktrees/issue-2 origin/main
```

```js
subagent({
  workflow: "pi-factory",
  async: true,              // required for claude-bridge children on the Mac
  cwd: "~/Documents/git/bioc-mcp",
  args: {
    repo: "seandavi/bioc-mcp", issue: 2, slug: "scaffold",
    worktree: "/Users/<you>/Documents/git/bioc-mcp-worktrees/issue-2",
    branch: "issue-2-scaffold", lenses: ["code", "ux", "security"], seam: true,
    parent: 1               // optional: tracking issue for the follow-up issue
    // startAt: "review"    // optional: re-review an existing branch
  }
})
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
