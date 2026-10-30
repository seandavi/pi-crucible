# Spec for #4: reviewers always get the diff

Issue: [seandavi/pi-factory#4](https://github.com/seandavi/pi-factory/issues/4), part of the
tracking issue #1 (package → launcher → **reviewers get the diff** → integration step → migrations).

## Goal

In bioc-mcp, several reviewers said they could not run git and reviewed from the changed-file list
alone. The built-in `reviewer` agent (pi-subagents 0.80.0, `agents/reviewer.md`) has the tools
`read, grep, find, ls, watchdog_diff, contact_supervisor`: no `bash`. Its own instructions say
`watchdog_diff` "does not inspect committed ranges" and that a task asking for one must "require a
supplied artifact". The factory's review prompt still tells reviewers to run
`git diff --name-only origin/main...HEAD` when it has no file list (`--start-at review`), which they
cannot do.

After this change:

1. Before **every** review batch (round 0 and each re-review round), a cheap Haiku child writes
   `git diff origin/main...HEAD`, its `--stat` summary first, to a file in the worktree that git
   ignores. It also reports git's list of changed files.
2. Every reviewer in that batch gets the file's absolute path and git's list of changed files. The
   prompt tells them to read the whole file with their read tool, and to give finding locations as
   `path:line` taken from the diff hunks.
3. If the diff cannot be prepared, the review still runs without it, and the PR's factory record
   says so for that round.

## Non-goals

- Giving reviewers a shell or a custom agent with `bash`. Reviewers stay read-only.
- Changing which lenses run, severities, revise rules, stop rules or the PR stage beyond its
  factory-record table.
- Filtering the diff (lockfiles, generated files). The engine stays project-neutral. Reviewers may
  skip hunks of generated files themselves; see the prompt.
- Diffing uncommitted work. Every writing stage commits before it reports, so the diff covers
  commits only (`origin/main...HEAD`), as the issue says.
- Fetching `origin` in the diff step. `/factory` fetches at launch. A three-dot diff runs from the
  merge base, so a stale `origin/main` adds no unrelated changes.
- Changing args, `/factory`, the launcher or `src/resource.ts`'s validation.
- The integration step (#5) and the Clef review gate.

## Design

### Where the diff lives and why git ignores it

- Directory: `<worktree>/.pi/factory-review/`. The file for round `n` is
  `<worktree>/.pi/factory-review/r<n>.diff`.
- The diff step writes `<worktree>/.pi/factory-review/.gitignore` with the single line `*`. That
  file ignores everything in its directory, itself included. So:
  - nothing in the directory shows in `git status`;
  - nothing in it can be committed by `git add -A` in a later revise stage;
  - no repository's `.gitignore` is edited;
  - the shared `$GIT_COMMON_DIR/info/exclude` is not touched, and that file lies outside the
    worktree, which every stage is told to stay inside.

  Verified 2026-10-24 with git 2.55.0 in a scratch repo with a linked worktree: after
  `printf '*\n' > .pi/factory-review/.gitignore`, both `git status --short --untracked-files=all`
  and `git add -A; git status --short` print nothing. `git check-ignore -v` names that
  `.gitignore:1:*` as the rule.
- `.pi/` is where a repo already keeps `factory.json`. Under a project's `.pi/`, pi reads only
  named entries: `settings.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`,
  `APPEND_SYSTEM.md`, `git` and `npm` (checked by grepping `CONFIG_DIR_NAME` joins in
  `@earendil-works/pi-coding-agent`'s `dist/`). pi-subagents 0.80.0 also reads `agents` and
  `mcp.json` there. A `factory-review` subdirectory is inert.
- Each run overwrites the file for its round (`>`). Files from an earlier run's higher rounds may
  remain; they are ignored and harmless.
- The diff content never enters args, prompts or receipts. Only its path does, so the 16 KiB args
  cap is unaffected.

Reading limits (verified against `@earendil-works/pi-coding-agent`'s
`dist/core/tools/read.js` and `truncate.js`): the read tool returns at most 2000 lines or 50 KB per
call and takes a 1-indexed `offset` and a `limit`, so large diffs are read in chunks.

### `workflows/factory.js`

#### Header comments

- Line 1–2 becomes:
  ```js
  // Factory: spec (Opus) → implement (Sonnet) → [diff (Haiku) → review lenses (Opus, parallel)]
  // → revise ≤ maxRounds (Sonnet) → PR (Sonnet). See docs/factory.md.
  ```
- In the comment above `COMMON`, the list of writing stages becomes "(spec, implement, diff,
  revise, PR; all on the worker agent, which has bash)".

#### New constants (after `specPath`)

```js
// Where the diff step writes the diff each review round reads; its .gitignore ("*") keeps the
// directory out of git without touching the repository's own ignore files.
const REVIEW_DIR = ".pi/factory-review";
const diffFile = (round) => `${REVIEW_DIR}/r${round}.diff`;
```

#### New stage: diff, before each review batch

The key is `diff-r<round>` and the label `Diff for issue #<issue> r<round>`. It runs as agent
`worker` on model `HAIKU` (`config.models.small`), with `cwd` set to the worktree. It is a writing
stage (it writes the ignored file), so its prompt starts with `COMMON`, which includes the
branch check. It is a top-level plain function that returns the `runs.run` promise, like
`flagHuman`. There are no nested async functions.

```js
// ---- 3a. Diff (before each review batch) ---------------------------------------------
// Reviewers have no shell, so a Haiku worker writes the branch's diff where they can read it.
function diffRun(round) {
  const dir = `${cwd}/${REVIEW_DIR}`;
  const file = `${cwd}/${diffFile(round)}`;
  const range = "origin/main...HEAD";
  return runs.run(`diff-r${round}`, {
    label: `Diff for issue #${issue} r${round}`,
    agent: "worker",
    model: HAIKU,
    cwd,
    outputSchema: statusSchema({
      summary: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } },
      diff_lines: { type: "integer" },
    }),
    task: `${COMMON}

You are the DIFF stage for review round ${round}. Do not edit, stage or commit any file in the
repository; you only write the review diff, which git ignores. Run these commands from ${cwdQ},
in order, exactly as written:
  mkdir -p ${shellQuote(dir)}
  printf '*\\n' > ${shellQuote(`${dir}/.gitignore`)}
  git -C ${cwdQ} diff --no-color --no-ext-diff --stat=200 ${range} > ${shellQuote(file)}
  git -C ${cwdQ} diff --no-color --no-ext-diff ${range} >> ${shellQuote(file)}
  wc -l < ${shellQuote(file)}
  git -C ${cwdQ} diff --name-only ${range}
Report status "done", diff_lines (the number wc printed) and changed_files (the paths the last
command printed, one per line; an empty list if it printed nothing). If a command fails, stop,
report status "blocked" and put the command and its error in summary.`,
  });
}

// What a round's reviewers get: the diff file and git's list of changed files, or why there is
// none. `record` is the round's entry in the PR's factory record.
function diffFor(result, round) {
  const out = result.structuredOutput || {};
  if (result.ok && out.status === "done") {
    const files = out.changed_files || [];
    return {
      path: `${cwd}/${diffFile(round)}`,
      lines: out.diff_lines,
      files,
      record: `${diffFile(round)} (${out.diff_lines} lines, ${files.length} files)`,
    };
  }
  const why = String(out.summary || result.error || "no structured output").slice(0, 200);
  return { path: null, lines: 0, files: [], record: `unavailable: ${why}` };
}
```

With the worktree `/tmp/repo-worktrees/issue-2` and round 0, the prompt's command block reads:

```text
  mkdir -p '/tmp/repo-worktrees/issue-2/.pi/factory-review'
  printf '*\n' > '/tmp/repo-worktrees/issue-2/.pi/factory-review/.gitignore'
  git -C '/tmp/repo-worktrees/issue-2' diff --no-color --no-ext-diff --stat=200 origin/main...HEAD > '/tmp/repo-worktrees/issue-2/.pi/factory-review/r0.diff'
  git -C '/tmp/repo-worktrees/issue-2' diff --no-color --no-ext-diff origin/main...HEAD >> '/tmp/repo-worktrees/issue-2/.pi/factory-review/r0.diff'
  wc -l < '/tmp/repo-worktrees/issue-2/.pi/factory-review/r0.diff'
  git -C '/tmp/repo-worktrees/issue-2' diff --name-only origin/main...HEAD
```

Why these flags: `--no-color` and `--no-ext-diff` keep a user's git config (`color.ui=always`, an
external diff driver) out of the file. `--stat=200` stops the stat from truncating long paths to 80
columns. Every path is single-quoted with the existing `shellQuote`. The worktree is already pinned
by `src/resource.ts` to have no quotes or shell metacharacters, `round` is an integer, and nothing
from the issue text reaches the command.

**A failed diff step never stops the run and never flags a human.** That covers `ok: false`, a
status other than `"done"`, a missing structured output, the wrong-branch stop and (#56) a `"done"`
report without `changed_files` or `diff_lines`, recorded as
`unavailable: diff reported "done" without: <fields>`. The round's
reviewers fall back to the file list (below), and the factory record shows
`unavailable: <reason>` for that round.

#### Review prompt (`reviewTask`) and `reviewBatch`

The signatures become `reviewTask(lens, diff, files, round, prior)` and
`reviewBatch(lensList, diff, files, round, prior)`, where `diff` is a `diffFor` result. `reviewBatch`
passes `diff` through to `reviewTask` and is otherwise unchanged. The new `reviewTask`:

```js
function reviewTask(lens, diff, files, round, prior) {
  const source = diff.path
    ? `The branch's changes are in ${diff.path}: the output of git diff origin/main...HEAD, a --stat
summary followed by the full diff (${diff.lines} lines). You cannot run git, so this file is how you
see the change: read all of it with your read tool, continuing with offset until the end (each read
returns at most 2000 lines). You may skip the hunks of generated files (lockfiles, build output) the
--stat names. The watchdog_diff tool does not see commits; do not use it.
${diff.files.length ? `Changed files: ${diff.files.join(", ")}.` : "The diff is empty: nothing on this branch differs from main."}`
    : `The diff for this round could not be prepared (${diff.record}) and you cannot run git. Review ${files.length ? `the changed files: ${files.join(", ")}` : "the files the spec says change"}.`;
  return `${CONTEXT}

You are a READ-ONLY reviewer (round ${round}). Lens: ${LENS[lens]}${SEAM_NOTE}
${source}
Read ${specPath} (if it does not exist, review against the issue), AGENTS.md and any other file you
need, including a changed file in full when its hunks are not enough. Do not edit anything.${priorRound(prior)}
Report findings with severity: blocker (wrong or unsafe; must fix), major (should fix before merge),
minor, nit. Give each an id of the form "${lens}-r${round}-<n>" (e.g. "${lens}-r${round}-1");
when a finding repeats one from an earlier round, say so in problem. Set location to "path:line",
where line is the line's number in the branch's version of the file (in the diff, count from the
+start in the hunk's @@ header), or "-" when the finding is not about one place. verdict is
"changes" only if there is at least one blocker or major finding. Do not pad: zero findings is a
valid review.`;
}
```

The old instruction `every file changed on this branch (git diff --name-only origin/main...HEAD)`
is removed. No review prompt tells a reviewer to run git.

`reviewSchema` is unchanged. `location` stays a free string, and the prompt sets its form.

#### Main review loop

```js
let files = implOut.changed_files || [];
let checks = implOut.checks || {};
let activeLenses = lenses.slice();
let diff = diffFor(await diffRun(0), 0);
let results = await reviewBatch(activeLenses, diff, files, 0);
let open = blocking(results, activeLenses);
let followUps = minors(results, activeLenses);
const history = [{ round: 0, lenses: activeLenses, diff: diff.record, blocking: open.length }];
```

and inside the `while` loop, after `activeLenses` is recomputed:

```js
  diff = diffFor(await diffRun(round), round);
  results = await reviewBatch(activeLenses, diff, files, round, prior);
  open = blocking(results, activeLenses);
  followUps = followUps.concat(minors(results, activeLenses));
  history.push({ round, lenses: activeLenses, diff: diff.record, blocking: open.length, responses: revOut.responses || [] });
```

The `files` bookkeeping (implement's `changed_files`, merged with each revise's) stays as it is. It
is now only the fallback for a round whose diff step failed. When the diff step succeeds, the list
the reviewers see is git's (`diff.files`), which also fixes the empty list on `--start-at review`.
The "revise stopped" history entry (`{ round, stopped, error }`) is unchanged and has no `diff`.

Call order for a run with lenses `code, ux` and no blocking findings:
`spec, implement, diff-r0, review-code-r0, review-ux-r0, pr`. With one revise round on `code`:
`spec, implement, diff-r0, review-code-r0, review-ux-r0, revise-r1, diff-r1, review-code-r1, pr`.

#### PR stage

Only the "Factory record" bullet of step 3 changes. Its exact new text:

```js
   - "Factory record": a table with one row per review round (round, lenses, the diff the
     reviewers read, blocking findings, what was fixed or declined, one line each) from
     ${JSON.stringify(history)}; then the checks
     ${JSON.stringify(checks)}; then the line "Engine: ${engineNote}".${startAt !== "spec" ? ` Note that this run started at the ${startAt} stage.` : ""}
```

The PR's factory record then shows, per round, either
`.pi/factory-review/r<n>.diff (<lines> lines, <files> files)` or `unavailable: <reason>`. The
script's return value (`rounds: history`, on both the success and the PR-stop paths) carries the
same `diff` strings.

No other stage, prompt or output schema changes. `flagHuman`, spec, implement and revise prompts
are unchanged.

### `src/resource.ts`

No change. The args are unchanged and `RESOURCE_VERSION` stays `1`.

### `src/config.ts` and `schema/factory.schema.json`

There is no new field. Only the description of `models.small` changes, because Haiku now does more
than flag a human:

```ts
small: Type.Optional(Type.String({ minLength: 1, description: "Flagging a human and writing the review diff (default claude-bridge/claude-haiku-5-5)." })),
```

Then run `npm run schema`, which rewrites `schema/factory.schema.json`'s `models.small.description`
to match. The existing schema test checks that the two agree. `examples/*.factory.json` and
`.pi/factory.json` need no change.

### Extension command (`/factory`)

No change. `/factory 12 --dry-run` prints the same args. The launcher (`src/launcher.ts`) and
`extensions/factory.ts` are untouched.

### Docs

**`docs/factory.md`**

- Stage table: insert this row between Implement and Review:

  ```markdown
  | Diff | Haiku | `worker`, before each review round | `.pi/factory-review/r<round>.diff` in the worktree, ignored by git | `{status, summary, changed_files, diff_lines}` |
  ```

- After the "**Finding ids**" paragraph, add:

  ```markdown
  **The diff:** reviewers have no shell, so before each review round (round 0 and every
  re-review) a Haiku worker writes `git diff origin/main...HEAD`, its `--stat` summary first, to
  `.pi/factory-review/r<round>.diff` in the worktree. A `.gitignore` containing `*` in that
  directory keeps it out of git without touching the repository's own ignore files. Every reviewer
  gets the file's path and git's list of changed files, reads the whole diff with its read tool, and
  gives finding locations as `path:line` from the diff's hunks. If the diff step fails (a wrong
  branch, a git error), the round is reviewed from the changed-file list instead, and the factory
  record says the diff was unavailable; the run does not stop. Added after bioc-mcp, where
  reviewers without git reviewed from the file list alone (#4).
  ```

- In "Running it", "every stage that writes (spec, implement, revise, PR)" becomes "every stage
  that writes (spec, implement, diff, revise, PR)". The sentence "Reviewers are read-only and have
  no shell, so they skip the check." becomes "Reviewers are read-only and have no shell, so they
  skip the check and read the diff the diff stage wrote."
- "What to watch while it is an experiment": add the bullet
  `- Do findings cite the diff (\`path:line\` locations in changed hunks)? How often is a round's
  diff unavailable?`
- Table 2's `models` row is unchanged.

**`README.md`**

- Table 1: insert between Implement and Review:
  `| Diff | Haiku, before each review round | \`.pi/factory-review/r<round>.diff\`, ignored by git (never committed) |`
- The figure's `alt` text becomes: "The factory workflow: launch, spec (Opus), implement (Sonnet),
  a diff (Haiku) before each round of parallel review lenses (Opus), up to two revise rounds
  (Sonnet), then a PR (Sonnet) that a human merges. Spec or implement can stop and flag a human."
- The Figure 1 caption: after "Review lenses run in parallel: … `review:<lens>` label." insert
  "Before each review round a Haiku step writes the branch's diff for the reviewers, who have no
  shell."
- Status checklist: `- [x] Reviewers always get the diff ([#4](…))`.
- "Lessons carried over": the sentence "What was missing, and the open issues address: an
  integration step (…), reviewers that always see the diff, and one shared copy instead of drifting
  ports." becomes "What was missing: an integration step (semantic merge breaks between parallel PRs
  surfaced only when merged by hand), reviewers that always see the diff (done in #4), and one
  shared copy instead of drifting ports."

**`docs/figures/make_figures.py`** (then run it and commit both SVGs)

- Inside the "review · parallel" group, add a one-line box above the lenses:
  `f.tag_box(950, 100, 240, 46, "diff · Haiku", "r<n>.diff", "CORAL")`. Move the three lens boxes
  down to `y = 160 + i * 66`, height 54. Make the group `f.group(930, 80, 280, 286, …)`, so its
  bottom is at y 366.
- Move the Revise box and the Flag box down to y 470, the two revise arrows to
  `[(1010, 369), (1010, 465)]` (label at `(1010, 417)`) and `[(1130, 468), (1130, 372)]` (label at
  `(1130, 420)`), and the two stop arrows to end at y 465 (labels at y 377). Move the legend down:
  `ly = 680`, so its rule is at y 650. Set the SVG size to `1820 × 720`.
- Box colour stays "the model a stage runs on", so Haiku stays CORAL. The legend entry
  `("CORAL", "Haiku: stop for a human")` becomes `("CORAL", "Haiku: diff, stop for a human")`.
  Stops are still the dashed red arrows.
- The SVG title becomes the README `alt` text above.
- The `--start-at review` pill still points at the group's top (y 76). Nothing may overlap; check
  both rendered SVGs by eye.

`CONTRIBUTING.md`, `AGENTS.md`, `examples/` and `.pi/factory.json` do not change.

## Acceptance criteria

- [ ] Before each review batch the script runs `diff-r<round>` (agent `worker`, model
      `config.models.small`, default `claude-bridge/claude-haiku-5-5`), and every review call
      of that round comes after it.
- [ ] The diff prompt starts with the branch check, and contains the six commands above with every
      path single-quoted, including `printf '*\n' > '<worktree>/.pi/factory-review/.gitignore'`
      and both `git -C '<worktree>' diff --no-color --no-ext-diff … origin/main...HEAD` lines
      writing `r<round>.diff`.
- [ ] Every review prompt of round `n` names `<worktree>/.pi/factory-review/r<n>.diff`, its line
      count and git's changed-file list (`changed_files` from the diff step), tells the reviewer to
      read the whole file with offset, and asks for `path:line` locations from the hunks.
- [ ] A re-review round gets a fresh diff: `diff-r1` writes `r1.diff` and `review-<lens>-r1` names
      `r1.diff`, not `r0.diff`.
- [ ] No review prompt tells a reviewer to run git (`--name-only` no longer appears in any review
      prompt).
- [ ] If the diff step fails (`ok: false`, `status: "blocked"`, no structured output, or a `"done"`
      report without `changed_files` or `diff_lines`), the review
      still runs, no `flag-*` child starts, the review prompt says the diff could not be prepared
      and lists the implement/revise changed files, and that round's `history` entry has
      `diff: "unavailable: <reason>"`.
- [ ] Each `history` entry for a review round has `diff`: either
      `".pi/factory-review/r<n>.diff (<lines> lines, <files> files)"` or `"unavailable: …"`. The PR
      prompt asks for a "the diff the reviewers read" column in the factory record.
- [ ] `src/config.ts`'s `models.small` description and `schema/factory.schema.json` agree
      (`npm run schema` leaves no diff).
- [ ] `docs/factory.md`, `README.md` and the figure (both SVGs regenerated) describe the diff
      stage as above.
- [ ] `npm test` and `npm run check` pass. `subagent({ action: "validate", workflow:
      "<worktree>/workflows/factory.js" })` passes when run from a pi session; if the implementer
      cannot run it, they say so in the PR.
- [ ] Manual, after merge: on the next factory run with the installed engine (e.g. #5), the PR's
      factory record shows a diff file per round, and review findings give `path:line` locations
      in changed hunks. Record it in a factory run report. This is the issue's "a run shows
      reviewers citing diff hunks".

## Test plan

All of this goes in `test/workflow.test.ts`, using the existing `simulate` harness (a fake `runs`,
no git, gh or models).

Update existing tests:

- `happy()` answers `diff-*` keys with
  `{ structuredOutput: { status: "done", summary: "", changed_files: ["a.ts", "b.ts"], diff_lines: 120 } }`.
- "every stage's prompt comes from the config": the expected keys become
  `["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "pr"]`. The loop that checks
  every task contains the design text still holds, because the diff prompt starts with `COMMON`.
- "blocker findings trigger revise …": the expected keys become
  `["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "revise-r1", "diff-r1", "review-code-r1", "pr"]`.
- "code review runs whatever lenses a hand launch names": the expected keys gain `diff-r0` after
  `implement`.
- "every writing stage checks the worktree's HEAD …": the guarded keys become
  `["spec", "implement", "diff-r0", "pr"]`.
- "only the writing stages run the worktree check": unchanged, and it now also asserts that
  `diff-r0` has the check.

New tests:

1. **"before each review round a Haiku worker writes an ignored diff file"**: with the default
   config, `diff-r0` has agent `worker` and model `claude-bridge/claude-haiku-5-5`. Its task
   contains the exact lines
   `printf '*\n' > '/tmp/repo-worktrees/issue-2/.pi/factory-review/.gitignore'` and
   `git -C '/tmp/repo-worktrees/issue-2' diff --no-color --no-ext-diff --stat=200 origin/main...HEAD > '/tmp/repo-worktrees/issue-2/.pi/factory-review/r0.diff'`.
   The index of `diff-r0` in `calls` is lower than the indexes of every `review-*-r0` call.
2. **"every reviewer reads the round's diff and cites hunks"**: `review-code-r0` and `review-ux-r0`
   contain `/tmp/repo-worktrees/issue-2/.pi/factory-review/r0.diff`, `(120 lines)`,
   `Changed files: a.ts, b.ts.` (git's list, not implement's `a.ts` alone), `continuing with offset`
   and `"path:line"`. Neither matches `/--name-only/`.
3. **"each re-review round gets a fresh diff"**: in the revise scenario, `diff-r1`'s task contains
   `r1.diff`. `review-code-r1` contains `/.pi/factory-review/r1.diff` and does not contain
   `r0.diff`.
4. **"a failed diff step degrades the review and does not stop the run"**: for each of
   `{ ok: false, error: "boom" }` and
   `{ structuredOutput: { status: "blocked", summary: "wrong branch" } }` as the `diff-r0` answer,
   the call keys are still `spec, implement, diff-r0, review-code-r0, review-ux-r0, pr` (no
   `flag-*`). `review-code-r0` contains `could not be prepared` and `the changed files: a.ts`, and
   does not contain `.pi/factory-review`. `result.rounds[0].diff` is `"unavailable: boom"` or
   `"unavailable: wrong branch"`, and the PR task contains that string.
5. **"the factory record shows the diff each round read"**: in the happy run,
   `result.rounds[0].diff === ".pi/factory-review/r0.diff (120 lines, 2 files)"`, and the PR task
   contains `the diff the` and `"diff":".pi/factory-review/r0.diff (120 lines, 2 files)"`.
6. **"models.small runs the diff step"**: extend "models, skills, commit identity and spec dir follow
   the config" with `models.small: "p/small"` and assert `by("diff-r0").model === "p/small"`.
7. **"on --start-at review the reviewers get git's file list"**: with `startAt: "review"`, the keys
   are `diff-r0, review-code-r0, review-ux-r0, pr`, and `review-code-r0` contains
   `Changed files: a.ts, b.ts.`

Also: `npm run check` (the script parses as a sandbox body), `npm run schema` followed by
`git diff --exit-code schema/`, `python3 docs/figures/make_figures.py` followed by checking both
SVGs by eye, and `subagent({ action: "validate", … })` from a pi session.

## Risks

- **Haiku does not follow the commands exactly** (it paraphrases or skips the `.gitignore`). The
  `status`/`diff_lines` schema catches most of these, and a failure degrades to the old behaviour.
  A diff file written without its `.gitignore` would show as untracked, and a revise stage running
  `git add -A` could commit it. The prompt orders `mkdir` and the `.gitignore` before the diff, and
  the implement and revise prompts already ask for small, deliberate commits. Watch the first runs'
  `git status`.
- **Large diffs cost reviewer tokens.** Every lens reads the whole diff, and lockfile churn can run
  to thousands of lines. The prompt lets reviewers skip generated-file hunks. If cost bites, a later
  issue can add a per-repo exclude list in `.pi/factory.json` (project-specific, so not the engine's
  call now).
- **The diff is untrusted input.** Branch content written by earlier agents from issue text now
  reaches reviewers as one file. The exposure is the same as reading the changed files before.
  Reviewers stay read-only with no shell, and only the path, never the content, enters prompts or
  args.
- **A stale `origin/main`** (a long run, main moving underneath) still gives a correct three-dot
  diff of the branch's own changes. It can hide conflicts with new main commits, which is #5's
  integration step's job.
- **pi-subagents changes the reviewer agent** (e.g. gives it `bash`, or `watchdog_diff` learns
  committed ranges). The diff file stays correct, just redundant. Revisit then.
- **Extra time per round**: one short Haiku child (seconds) before each review batch, run
  sequentially, at most `maxRounds + 1` times.
