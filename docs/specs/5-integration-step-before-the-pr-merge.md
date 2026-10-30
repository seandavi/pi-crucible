# Spec for #5: integration step before the PR

Issue: [seandavi/pi-factory#5](https://github.com/seandavi/pi-factory/issues/5), part of the
tracking issue #1 (package → launcher → reviewers get the diff → **integration step** →
migrations). Labelled `seam`: every consuming repository's runs go through this stage.

> **Changed by #57.** The fetch and the checks are now host commands (`runs.host`), and so is
> recording main and the branch head (`git rev-parse --short origin/main HEAD`, which adds `head`
> to the Integration record). The Haiku worker only merges `origin/main` (or reports the
> conflicts), and its report is `{status, summary, merge, conflicts}`. A check passes on exit 0. It
> fails on a nonzero exit or on running past 20 minutes. A check that cannot run is an
> integration error. The fix round gets each failing check's exit code and the first 200
> characters of its output (all pi-subagents gives the script), and is told to run the failing
> checks itself, instead of an 80-line tail. The re-check is fetch (host), merge (agent),
> rev-parse and checks (host). The integrate prompt and schema below are history. See
> [docs/crucible.md](../crucible.md#host-commands).

## Goal

In bioc-mcp, three semantic merge breaks between parallel PRs got through. Twice a function
signature changed, and once a test fixture's record ids changed. Each PR passed its own checks, and
the breaks surfaced only when the parent session merged main by hand. Each factory run tests its
branch against the `origin/main` it was cut from, not against the main it will merge into.

After this change, every run has an **integration** stage after the review/revise loop and before
the PR stage:

1. A Haiku worker fetches `origin`, merges `origin/main` into the issue branch with a merge commit,
   and runs **every** configured check. The checks run in full: "n/a" is not an answer here.
2. If the merge conflicts or any check fails, one Sonnet **fix round** gets the conflicting paths
   or the failing checks' output, fixes the branch and commits. A Haiku worker then **re-checks**:
   it merges again, which is a no-op unless main moved again, and runs every check again.
3. If the fix touched non-test files, the `code` lens **re-reviews** the branch in one more review
   round, with its own fresh diff.
4. The PR's factory record has an **Integration** line: the main commit merged, how the merge
   went, the results of the checks, the fix and the re-review. A branch that still does not
   integrate opens as a **draft** PR. The integration stage never stops the run and never flags a
   human on its own; every PR already carries `needs:human`.

Acceptance (from the issue): a deliberately conflicting pair of runs is caught by this stage, not
by a human.

## Non-goals

- Rebasing. The stage merges `origin/main` into the branch, so a branch that is already pushed
  only moves forward. This follows the "prefer merges over rebasing anything already pushed" rule
  in CONTRIBUTING.md.
- More than one fix round, or sending integration re-review findings back to revise. Blocker/major
  findings from the integration re-review stay unresolved and make the PR a draft (see Risks).
- A `--start-at integrate` resume point. `--start-at review` re-reviews, then integrates, which
  covers re-running integration after main moves.
- A per-repo setup command, or a switch to turn integration off. No config field is added. The
  fix stage gets `config.implement`, which is where setup steps such as `npm ci` already live.
- A per-repo list of test paths. The fix stage itself says which files it changed that are not
  tests (see Design).
- Changing args, `/factory`, the launcher, `src/resource.ts`'s validation or `RESOURCE_VERSION`
  (it stays `2`).
- Merging the PR. That stays manual.

## Design

### Behaviour

Call order with lenses `code, ux`, no blocking findings and a clean integration:
`spec, implement, diff-r0, review-code-r0, review-ux-r0, integrate, pr`.

With a conflict whose fix touches non-test files, and no revise rounds before it:
`spec, implement, diff-r0, review-code-r0, review-ux-r0, integrate, integrate-fix, integrate-recheck, diff-r1, review-code-r1, pr`.

The integration re-review is review round `round + 1`, where `round` is the last revise round
(0 if there was none). So after one revise round it is `diff-r2, review-code-r2`. Its finding ids
are `code-r<that round>-<n>`, unique as before.

Rules:

- `integrate` always runs once, after the review/revise loop. That includes runs where findings
  remain, where a revise stage stopped, and `--start-at review`.
- The integration **passes** when the merge did not conflict and every configured check is
  `"pass"`.
- If `integrate` fails (`ok: false`, a status other than `"done"`, no structured output, or the
  wrong-branch stop), the integration status is `"error"`. There is no fix round.
- A `"done"` report missing the fields the script reads counts as the stage failing (#56): for
  `integrate` and `integrate-recheck`, `main`, `merge`, then `conflicts` (on a conflict) or every
  configured check, plus `failures` when a check failed; for `integrate-fix`, `changed_files` and
  every check. That makes integrate or the re-check `"error"` and the fix `"fail"`. A missing
  check is never read as a failing one, so there is no fix round.
- If it does not pass, `integrate-fix` (Sonnet) runs once. If the fix fails (`ok: false`, not
  `"done"`, or no output), the status is `"fail"` and there is no re-check and no re-review.
  Otherwise `integrate-recheck` (Haiku) runs. Its result decides `"pass"` or `"fail"`, or
  `"error"` if the re-check itself fails.
- After a re-check, `main`, `merge`, `conflicts`, `failing` and `checks` are the re-check's, and
  `firstAttempt` keeps the first report's view (`{main, merge, conflicts, failing, checks}`) when
  its conflicts or failing checks differ; otherwise it is null. If the re-check fails, `main` and
  `merge` are null, `conflicts` is `[]`, `checks` and `failing` are the fix's, and
  `firstAttempt` is the first view.
- After a successful fix (`status: "done"`), the `code` lens re-reviews if the fix reported at
  least one non-test file. This happens whether the re-check passed or not. In `open`, the
  re-review's blocker/major findings are added to the earlier findings, which all stay: the
  re-review is narrow (it judges the fix, not the whole diff), so it cannot clear a finding an
  earlier round left unresolved. Minor/nit findings join `followUps`.
- The checks reported in the PR become the last integration run's results (re-check, else first
  run, else the fix's) whenever there are any. Otherwise they stay what implement/revise reported.
- The PR is a draft if blocker/major findings remain, if any check fails, **or if the integration
  status is not `"pass"`**.
- Nothing here calls `flagHuman`.

### `workflows/factory.js`

#### Header comments

Lines 1–2 become:

```js
// Factory: spec (Opus) → implement (Sonnet) → [diff (Haiku) → review lenses (Opus, parallel)]
// → revise ≤ maxRounds (Sonnet) → integrate (Haiku; one Sonnet fix round) → PR (Sonnet). See docs/factory.md.
```

The comment above `COMMON` lists the writing stages as "(spec, implement, diff, revise, integrate,
integrate-fix, PR; all on the worker agent, which has bash)". The args comment does not change.

#### The commit identity, shared by commit and merge

Replace the `commitCmd` definition with:

```js
// Single-quoted for the shell, so nothing in the configured identity is expanded.
const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const gitAs = config.commitAuthor
  ? `git -c ${shellQuote(`user.name=${config.commitAuthor.name}`)} -c ${shellQuote(`user.email=${config.commitAuthor.email}`)}`
  : "git";
const commitCmd = `${gitAs} commit`;
```

`commitCmd`'s text is unchanged.

#### `reviewTask` and `reviewBatch` take a note

The signatures become `reviewTask(lens, diff, files, round, prior, note)` and
`reviewBatch(lensList, diff, files, round, prior, note)`. `reviewBatch` passes `note` through. In
`reviewTask` the line

```js
need, including a changed file in full when its hunks are not enough. Do not edit anything.${priorRound(prior)}
```

becomes

```js
need, including a changed file in full when its hunks are not enough. Do not edit anything.${priorRound(prior)}${note ? `\n${note}` : ""}
```

Existing calls pass no note, so their prompts do not change.

#### New section: 5. Integration

Insert this between the end of the revise `while` loop and the follow-up/PR section. Renumber
that section's comment to `// ---- 6. Follow-up issue, PR ---...`. Everything is top-level code or
plain functions that return the `runs.run` promise. There are no nested async functions.

```js
// ---- 5. Integration --------------------------------------------------------------------
// Parallel runs pass their own checks and still break each other once merged (#5). Merge the latest
// origin/main into the branch and run every check; on a conflict or a failure, one Sonnet fix round
// and a re-check. The code lens re-reviews a fix that touched non-test files. Never stops the run: a
// branch that does not integrate opens as a draft.
const MERGE_MSG = `Merge origin/main into ${branch} for the integration check`;
const mergeCmd = `${gitAs} -C ${cwdQ} merge --no-edit -m ${shellQuote(MERGE_MSG)} -m ${shellQuote("Co-Authored-By: Claude <noreply@anthropic.com>")} origin/main`;
const MERGE_EXCEPTION = `Merging origin/main into ${branch} is this stage's job and the one exception to "never
merge": never merge anything else, never merge into main, and never push, rebase or reset.`;
// Every check, pass or fail: unlike implement and revise, "n/a" is not an answer here.
const fullChecksSchema = {
  type: "object",
  required: CHECKS.map((c) => c.name),
  properties: Object.fromEntries(CHECKS.map((c) => [c.name, { type: "string", enum: ["pass", "fail"] }])),
};
// The tail of each failing check's output handed to the fix round.
const FAILURE_CHARS = 3000;

function integrateRun(key, recheck) {
  return runs.run(key, {
    label: `${recheck ? "Re-check integration" : "Integrate main"} for issue #${issue}`,
    agent: "worker",
    model: HAIKU,
    cwd,
    outputSchema: statusSchema({
      summary: { type: "string" },
      main: { type: "string" },
      merge: { type: "string", enum: ["merged", "up-to-date", "conflict"] },
      conflicts: { type: "array", items: { type: "string" } },
      checks: fullChecksSchema,
      failures: {
        type: "array",
        items: {
          type: "object",
          required: ["check", "output"],
          properties: { check: { type: "string" }, output: { type: "string" } },
        },
      },
    }),
    task: `${COMMON}

You are the INTEGRATION stage${recheck ? ", re-checking after the fix round" : ""}. ${MERGE_EXCEPTION}
Do not edit, stage or commit anything else, and do not try to fix a failure: report it. Work in the
foreground. Run these commands from ${cwdQ}, in order, exactly as written:
  git -C ${cwdQ} fetch origin
  git -C ${cwdQ} rev-parse --short origin/main
  ${mergeCmd}
If the merge stops on conflicts, run
  git -C ${cwdQ} diff --name-only --diff-filter=U
  git -C ${cwdQ} merge --abort
then report merge "conflict" and conflicts (the paths the first of those printed), and do not run
the checks. Otherwise report merge "up-to-date" if git printed "Already up to date.", else "merged",
and run every one of these checks from ${cwdQ}, each to the end even when an earlier one fails:
${checkList}
Report each check "pass" (it exited 0) or "fail", and for each failing check add an entry to
failures with the check's name and the last 80 lines of its output. Report main (the commit
rev-parse printed) and status "done", whether or not the checks pass. If any other command fails
(the fetch, rev-parse, or a merge that fails without conflicts), stop, report status "blocked" and
put the command and its error in summary.`,
  });
}

const integrationPassed = (out) => out.merge !== "conflict" && CHECKS.every((c) => (out.checks || {})[c.name] === "pass");
const failingChecks = (out) => CHECKS.filter((c) => (out.checks || {})[c.name] !== "pass").map((c) => c.name);
const reason = (result) => String((result.structuredOutput || {}).summary || result.error || "no structured output").slice(0, 200);

// The PR's factory record and the run's result: what integration did.
const integration = { status: "pass", main: null, merge: null, conflicts: [], failing: [], checks: {}, fix: null, reReview: null, note: "" };
const first = await integrateRun("integrate", false);
const firstOut = first.structuredOutput || {};
if (!first.ok || firstOut.status !== "done") {
  integration.status = "error";
  integration.note = reason(first);
} else {
  integration.main = firstOut.main || null;
  integration.merge = firstOut.merge || null;
  integration.conflicts = firstOut.conflicts || [];
  integration.checks = firstOut.checks || {};
  if (!integrationPassed(firstOut)) {
    const conflicted = firstOut.merge === "conflict";
    integration.failing = conflicted ? [] : failingChecks(firstOut);
    const failures = (firstOut.failures || []).map((f) => ({ check: String(f.check), output: String(f.output).slice(-FAILURE_CHARS) }));
    const problem = conflicted
      ? `The merge conflicts in: ${integration.conflicts.join(", ")}. Nothing is merged yet. Run
  ${mergeCmd}
resolve every conflict, then commit the merge with
  ${commitCmd} --no-edit --cleanup=strip`
      : `The merge itself is committed, but these checks fail after it: ${integration.failing.join(", ")}. The end of their output:
${JSON.stringify(failures, null, 2)}`;
    const fix = await runs.run("integrate-fix", {
      label: `Fix integration for issue #${issue}`,
      agent: "worker",
      model: SONNET,
      ...withSkill(BUILD_SKILLS),
      cwd,
      outputSchema: statusSchema({
        summary: { type: "string" },
        changed_files: { type: "array", items: { type: "string" } },
        non_test_files: { type: "array", items: { type: "string" } },
        checks: fullChecksSchema,
      }),
      task: `${COMMON}

You are the INTEGRATION FIX stage, the only fix round. ${MERGE_EXCEPTION}
After review, merging origin/main${integration.main ? ` (${integration.main})` : ""} into ${branch} broke it.
${problem}
The break comes from combining this branch with changes that reached main after it was cut. Make the
branch work with main as it is now: keep both sides' intent, never revert or weaken main's changes,
and never delete or skip a failing test to make it pass. ${specPath} is still the contract; if main
changed something the spec relies on (a signature, a fixture, a rule), adapt to main and update
${specPath} in the same commit.
Project rules: ${config.implement}
Run every check, not only the failing ones, and fix failures:
${checkList}
Commit ("Fix integration with main for #${issue}"). If you cannot make it work, run
git -C ${cwdQ} merge --abort if a merge is still in progress, leave git status clean, and report
status "blocked" with the reason in summary.
Report changed_files: only the files you edited (conflict resolutions and fixes), not the files the
merge brought in from main unchanged; non_test_files: those of them that are not tests, test
fixtures or test data (when unsure, list the file); summary: one line on what broke and how you
fixed it; and each check's result by name.`,
    });
    const fixOut = fix.structuredOutput || {};
    if (!fix.ok || fixOut.status !== "done") {
      integration.status = "fail";
      integration.fix = { status: "blocked", summary: reason(fix), changed_files: [], non_test_files: [] };
    } else {
      const changed = fixOut.changed_files || [];
      integration.fix = { status: "done", summary: String(fixOut.summary || "").slice(0, 300), changed_files: changed, non_test_files: fixOut.non_test_files || changed };
      files = files.length ? Array.from(new Set(files.concat(changed))) : files;
      const re = await integrateRun("integrate-recheck", true);
      const reOut = re.structuredOutput || {};
      if (!re.ok || reOut.status !== "done") {
        integration.status = "error";
        integration.note = `re-check: ${reason(re)}`;
        integration.checks = fixOut.checks || integration.checks;
      } else {
        integration.status = integrationPassed(reOut) ? "pass" : "fail";
        integration.main = reOut.main || integration.main;
        integration.checks = reOut.checks || {};
      }
      if (integration.fix.non_test_files.length) {
        const r = round + 1;
        const note = `This round reviews the INTEGRATION FIX. After the review rounds, origin/main${integration.main ? ` (${integration.main})` : ""} was merged
into the branch and ${conflicted ? `conflicted in ${integration.conflicts.join(", ")}` : `these checks failed: ${integration.failing.join(", ")}`}. The fix round changed
${changed.join(", ") || "files it did not list"}: ${integration.fix.summary}
Judge whether the fix is right and keeps both this branch's and main's intent. The rest of the diff
was reviewed in earlier rounds: raise findings there only where the fix or main's changes affect it.`;
        diff = diffFor(await diffRun(r), r);
        const fixReview = await reviewBatch(["code"], diff, files, r, null, note);
        const fixBlocking = blocking(fixReview, ["code"]);
        open = open.concat(fixBlocking);
        followUps = followUps.concat(minors(fixReview, ["code"]));
        history.push({ round: r, lenses: ["code"], diff: diff.record, blocking: fixBlocking.length, after: "integration fix" });
        integration.reReview = r;
      }
    }
  }
}
if (Object.keys(integration.checks).length) checks = integration.checks;
```

With the worktree `/tmp/repo-worktrees/issue-2`, branch `issue-2-scaffold` and no
`commitAuthor`, the integrate prompt's command block reads:

```text
  git -C '/tmp/repo-worktrees/issue-2' fetch origin
  git -C '/tmp/repo-worktrees/issue-2' rev-parse --short origin/main
  git -C '/tmp/repo-worktrees/issue-2' merge --no-edit -m 'Merge origin/main into issue-2-scaffold for the integration check' -m 'Co-Authored-By: Claude <noreply@anthropic.com>' origin/main
```

With `commitAuthor: { name: "A B", email: "a@b.c" }` the merge line starts
`git -c 'user.name=A B' -c 'user.email=a@b.c' -C '/tmp/repo-worktrees/issue-2' merge --no-edit`.

Verified 2026-10-24 with git 2.55.0, in a scratch clone:

- `merge --no-edit -m <subject> -m <trailer> origin/main` prints `Already up to date.` and exits 0
  when main has not moved.
- When main has moved, it makes a merge commit whose author and committer come from the `-c`
  identity, with that subject and the `Co-Authored-By` trailer. The `-c` and `-C` options combine
  in either order.
- On a conflict it exits 1. Then `diff --name-only --diff-filter=U` lists the conflicting paths
  and `merge --abort` leaves `git status` clean.
- After rerunning that merge and resolving the conflict, `git commit --no-edit` keeps the merge
  message and the trailer. Without `--cleanup=strip`, it also keeps the `# Conflicts:` comment
  lines.
- `git fetch origin` updates `origin/main`.

Why a Haiku worker merges and runs the checks: like the diff stage, this is fixed commands and a
report, with no judgment. The merge leaves the tree clean either way. A conflicted merge is aborted
and redone by the fix stage. A clean merge is committed before the checks run, so the fix stage
starts from the merged tree. The only thing interpolated into the commands is the branch, which
`src/resource.ts` pins to `issue-<n>-<kebab>`. The worktree is pinned against shell metacharacters
and single-quoted, and the identity is single-quoted. Nothing from the issue text reaches a
command.

Why the `MERGE_EXCEPTION` sentence: `CONTEXT` tells every stage "never merge". `CONTEXT` itself is
unchanged, so every other stage keeps that rule. Only the integrate and fix prompts carry the
exception, which names the one merge they may make.

#### PR stage

`draft` becomes:

```js
const checksFailing = Object.keys(checks).some((k) => checks[k] === "fail");
const draft = open.length > 0 || checksFailing || integration.status !== "pass";
```

In step 3, the "Factory record" bullet becomes, exactly:

```js
   - "Factory record": a table with one row per review round (round, lenses, the diff the
     reviewers read, blocking findings, what was fixed or declined, one line each; a row with
     "after": "integration fix" is the code lens re-reviewing the integration fix) from
     ${JSON.stringify(history)}; then an "Integration" line from ${JSON.stringify(integration)}:
     the origin/main commit merged (main) and how (merge: merged, up-to-date or conflict, naming
     the conflicts), each check's result after the merge, what the fix round did (fix; "none" when
     null) and the re-review round (reReview; "not needed" when null). When status is not "pass",
     start that line with "Does not integrate with main:" and the reason (note, the conflicts or
     the failing checks). Then the checks ${JSON.stringify(checks)}; then the line "Engine: ${engineNote}".${startAt !== "spec" ? ` Note that this run started at the ${startAt} stage.` : ""}
```

The rest of the PR prompt is unchanged. The existing `${draft ? ...}` branches already mark the PR
draft.

#### Return values

Both the PR-stop return and the success return gain `integration` (the object above):

```js
  return { stage: "pr", stopped: true, flagged: flag.ok, rounds: history, unresolved: open, checks, integration, error: pr.error || null, engine: input.engine || null };
```

```js
return {
  issue,
  startAt,
  pr: prOut.pr_url || null,
  draft,
  spec: specOut.spec_path,
  checks,
  integration,
  rounds: history,
  unresolved: open,
  followUps: followUps.length,
  followUpIssue: prOut.followup_issue || null,
  engine: input.engine || null,
};
```

The spec and implement stop returns do not change: integration never runs on those paths.

No other stage, prompt or schema changes. That covers spec, implement, diff, revise, `flagHuman`,
`reviewSchema`, `checksSchema` and `CONTEXT`.

### What the PR's factory record shows

- The rounds table. An integration re-review is one more row, with lenses `code`, its own diff
  file (`.pi/factory-review/r<n>.diff …`) and `after: "integration fix"`.
- An **Integration** line. Examples of what the PR stage writes:
  - `Integration: merged origin/main @c57139f cleanly; test pass, check pass; no fix round; no re-review needed.`
  - `Integration: origin/main @c57139f conflicted in src/tools.ts; fix round resolved it (src/tools.ts, test/tools.test.ts); test pass, check pass; code lens re-reviewed in round 1.`
  - `Does not integrate with main: test fails after the fix round (fixture ids changed on main). Integration: …`
- The checks, now the post-merge results, and the engine line, as before.

### `src/resource.ts`

No change. No arg is added or changed, and `RESOURCE_VERSION` stays `2`.

### `src/config.ts` and `schema/factory.schema.json`

No new field. Two descriptions change, because the models now do more:

```ts
fast: Type.Optional(Type.String({ minLength: 1, description: "Implement, revise, the integration fix, PR (default claude-bridge/claude-sonnet-5-5)." })),
small: Type.Optional(Type.String({ minLength: 1, description: "Flagging a human, writing the review diff, and the integration merge and checks (default claude-bridge/claude-haiku-5-5)." })),
```

The `checks` array's description becomes `"Commands every writing stage runs and reports, by name;
integration runs all of them after merging main."`. Then run `npm run schema`. The existing schema
test checks that the two agree. `examples/*.factory.json` and `.pi/factory.json` need no change.

### Extension command (`/factory`)

No change. `/factory 12 --dry-run` prints the same args. `src/launcher.ts` and
`extensions/factory.ts` are untouched.

### Docs

**`docs/factory.md`**

- Title: `# The factory: spec → implement → review → revise → integrate → PR`.
- Stage table: insert between Revise and PR:

  ```markdown
  | Integrate | Haiku; Sonnet for the fix | `worker`, once after review | a merge of `origin/main` into the branch; on a conflict or failing check, one fix round and a re-check | `{status, summary, main, merge, conflicts, checks, failures}`; fix: `{status, summary, changed_files, non_test_files, checks}` |
  ```

- After the "**Follow-ups:**" paragraph, add:

  ```markdown
  **Integration:** each run's checks pass against the main it started from, and parallel runs can
  still break each other once merged (in bioc-mcp: a changed function signature, twice, and a test
  fixture's record ids). So after review a Haiku worker fetches `origin`, merges `origin/main` into
  the branch (a merge commit, never a rebase) and runs every configured check in full. On a
  conflict or a failing check, one Sonnet fix round gets the conflicting paths or the checks'
  output, fixes the branch without reverting main's changes, and a Haiku re-check merges and runs
  the checks again. If the fix touched files other than tests, fixtures and test data, the `code`
  lens re-reviews in one more round, with its own diff; its blocker/major findings stay unresolved
  rather than starting another revise round. The checks the PR reports are the post-merge ones, and
  its factory record gets an Integration line. A branch that still conflicts or fails, or whose
  integration could not run, opens as a draft PR saying why; the run does not stop (#5).
  ```

- "**Stops:**" paragraph: after "…stops the run at the end." add the sentence "Integration never
  stops the run; see above."
- "**Resuming:**": "`--start-at review` re-reviews an existing branch, e.g. after hand edits," →
  "`--start-at review` re-reviews an existing branch and integrates it again, e.g. after hand edits
  or when main has moved,".
- "**Never automated:** merging. A human merges, from the main session." → "**Never automated:**
  merging the PR. A human merges, from the main session. (The integration stage merges main into
  the branch, never the branch into main.)"
- Table 2: the `checks` row's "Used by" becomes "implement, revise, integration, PR" and its
  meaning gains "Integration runs all of them after merging main." The `implement` row's "Used by"
  becomes "implement, integration fix". The `skills` row's "Used by" becomes "implement, revise,
  integration fix, review", and its meaning becomes "`{build, lenses: {name: skill}}`; `build` goes
  to implement, revise and the integration fix."
- "Running it": "every stage that writes (spec, implement, diff, revise, PR)" → "every stage that
  writes (spec, implement, diff, revise, integrate, PR)". The first command's comment becomes
  `# spec → implement → review → revise → integrate → PR`, and the `--start-at review` comment
  becomes `# re-review and re-integrate the existing branch, update its PR`.
- "What to watch while it is an experiment": add
  `- Integration: how often main had moved, how often the merge conflicted or a check failed after
  it, whether the fix round converged, and whether the code re-review found anything. Did a merge
  break still reach a human?`

**`README.md`**

- Opening sentence: "**spec → implement → review → revise → PR**" → "**spec → implement → review
  → revise → integrate → PR**".
- Figure `alt` (and the SVG title, below): "The factory workflow: launch, spec (Opus), implement
  (Sonnet), a diff (Haiku) before each round of parallel review lenses (Opus), up to two revise
  rounds (Sonnet), integration with main (Haiku, one Sonnet fix round), then a PR (Sonnet) that a
  human merges. Spec or implement can stop and flag a human."
- Figure 1 caption: after "…review again." insert "Before the PR, the branch is merged with the
  latest main and every check runs. A conflict or a failure gets one fix round, and the `code` lens
  re-reviews a fix that touched non-test code."
- Table 1: insert between Revise and PR:
  `| Integrate | Haiku; Sonnet for one fix round | a merge commit from \`origin/main\`; fixes if the merge or the checks broke |`
- Table 1's caption: "The PR opens as a draft if blocker/major findings remain after two revise
  rounds or if checks fail." → "The PR opens as a draft if blocker/major findings remain after two
  revise rounds, if checks fail, or if the branch does not integrate with main."
- Status: `- [x] Integration step before the PR: merge main and run the full checks ([#5](…))`.
- "Lessons carried over": "an integration step (semantic merge breaks between parallel PRs surfaced
  only when merged by hand)" → "an integration step (semantic merge breaks between parallel PRs
  surfaced only when merged by hand; done in #5)".

**`docs/figures/make_figures.py`** (then run it and commit both SVGs)

- Insert an Integrate box where the PR box is now:
  `f.box(1280, top, 240, h, "Integrate · Haiku", ["fetch, merge", "  origin/main", "run every check", "never stops the run"], "CORAL")`.
- Move the PR box to x 1580 and its three notes to x 1580. The notes become four lines at
  `top + h + 28/50/72/94`: "draft if blocker/major", "findings remain,", "checks fail or", "main
  does not merge". Move "A human merges" to `f.box(1880, top, 210, h, …)`.
- The main-row arrows become `[(270, 325), (570, 625), (870, 925), (1210, 1275), (1520, 1575), (1820, 1875)]`.
- Fix box: `f.box(1280, 470, 240, 160, "Fix · Sonnet", ["conflict or failing", "  check: one round", "code lens re-reviews", "  non-test fixes"], "BLUE")`.
  Arrows: `f.arrow([(1350, top + h + 3), (1350, 465)], "BLUE", "conflict or\nfailing check", (1350, 377))`
  and `f.arrow([(1460, 468), (1460, top + h + 3)], "CORAL", "re-check", (1460, 420))`.
- Legend: the rule runs to `x2="2090"`. `("CORAL", "Haiku: diff, stop for a human")` becomes
  `("CORAL", "Haiku: diff, merge and checks, flag a human")`. `ly` stays 680.
- SVG size `2120 × 720`, and the title is the README `alt` text above.
- Box colour still means the model a stage runs on. Stops are still the dashed red arrows, and
  integration adds none. Nothing may overlap; check both rendered SVGs by eye.

`CONTRIBUTING.md`, `AGENTS.md`, `examples/`, `.pi/factory.json`, `src/resource.ts`,
`src/launcher.ts` and `extensions/factory.ts` do not change.

## Acceptance criteria

- [ ] After the review/revise loop and before `pr`, the script runs `integrate` (agent `worker`,
      model `config.models.small`, default `claude-bridge/claude-haiku-5-5`). This holds on the
      happy path, when findings remain after `maxRounds`, when a revise stage stopped, and on
      `--start-at review`.
- [ ] The integrate prompt starts with the branch check and contains, single-quoted, the three
      commands above: fetch, `rev-parse --short origin/main`, and the merge with `--no-edit`, the
      subject and the `Co-Authored-By` trailer. It also contains the abort sequence
      (`diff --name-only --diff-filter=U`, `merge --abort`), every configured check, and the
      `MERGE_EXCEPTION` sentence. The merge uses `config.commitAuthor` (single-quoted `-c`) when
      set.
- [ ] Its output schema's `checks` requires every check name and allows only `"pass"`/`"fail"`.
- [ ] A clean integration (merge not `"conflict"`, all checks `"pass"`) runs no `integrate-fix`.
      `result.integration.status` is `"pass"`, and `result.checks` equals the integrate checks.
- [ ] A conflict, or any failing check, runs `integrate-fix` once (Sonnet, `skills.build`). For a
      conflict, its prompt names the conflicting paths, the merge command and
      `--no-edit --cleanup=strip`. For failing checks, it names them and has the end of their
      output, at most 3000 characters per check. Every fix prompt contains `config.implement`, the
      check list, the spec path and the instruction not to revert main or delete failing tests.
      Then `integrate-recheck` runs, and its result decides `"pass"` or `"fail"`.
- [ ] A fix that reports non-test files leads to `diff-r<round+1>` and `review-code-r<round+1>`,
      and nothing for other lenses. The review prompt carries the integration note (the merged
      commit, the conflict or the failing checks, the fix's files and summary). The history gains
      `{ round, lenses: ["code"], diff, blocking, after: "integration fix" }`, and
      `integration.reReview` is that round. Its blocker/major findings are added to `open`
      (earlier findings, `code` ones included, stay), and its minor/nit findings join the follow-ups.
- [ ] A fix whose `non_test_files` is empty leads to no re-review. A fix with no `non_test_files`
      field falls back to `changed_files`.
- [ ] `integrate` failing (`ok: false` or `status: "blocked"`) gives status `"error"`, no fix, no
      `flag-*` child and a draft PR. A failed fix gives status `"fail"`, no re-check, no re-review
      and a draft PR. A re-check that still fails gives `"fail"` and a draft PR.
- [ ] `result.integration` (on success and on the PR-stop path) has
      `status, main, merge, conflicts, failing, checks, firstAttempt, fix, reReview, note`. The PR prompt contains
      `JSON.stringify(integration)`, the "Integration" line instructions and
      `"Does not integrate with main:"`.
- [ ] No other stage's prompt contains `merge --no-edit`. `CONTEXT` still says "never merge".
- [ ] `src/config.ts`'s descriptions and `schema/factory.schema.json` agree (`npm run schema`
      leaves no diff).
- [ ] `docs/factory.md`, `README.md` and the figure (both SVGs regenerated) describe the stage as
      above.
- [ ] `npm test` and `npm run check` pass. `subagent({ action: "validate", workflow:
      "<worktree>/workflows/factory.js" })` passes when run from a pi session; if the implementer
      cannot run it, they say so in the PR.
- [ ] Manual, after merge (the issue's acceptance): in a scratch repository with a factory config
      (`test` check), open two issues whose changes conflict semantically. For example, A renames a
      function that B's new code calls. Launch both. Merge A's PR, then let B's run reach
      integration, or re-run it with `--start-at review`. B's factory record shows the check
      failing after the merge, a fix round and a passing re-check. Nobody fixes B by hand. Record
      the result in a factory run report.

## Test plan

All of this goes in `test/workflow.test.ts`, using the existing `simulate` harness (a fake `runs`,
no git, gh or models).

Update existing tests:

- `happy()` answers `integrate` and `integrate-recheck` with
  `{ structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: { test: "pass" }, failures: [] } }`.
  It answers `integrate-fix` with
  `{ structuredOutput: { status: "done", summary: "renamed call", changed_files: ["a.ts"], non_test_files: ["a.ts"], checks: { test: "pass" } } }`.
- Add `"integrate"` just before `"pr"` in the expected key lists of: "every stage's prompt comes
  from the config", "blocker findings trigger revise …", "code review runs whatever lenses …",
  "a failed diff step degrades …" and "on --start-at review …".
- "every writing stage checks the worktree's HEAD …": the guarded keys become
  `["spec", "implement", "diff-r0", "integrate", "pr"]`. The single-quote check holds, because the
  worktree only appears quoted.
- "a failing configured check makes the PR a draft" becomes **"the checks the PR reports are the
  integration's"**. Case 1: implement reports `test: "fail"` and integrate reports `pass`, so
  `result.checks.test === "pass"` and `draft === false`. Case 2: integrate and `integrate-recheck`
  report `test: "fail"`, so `draft === true` and `result.integration.status === "fail"`.

New tests:

1. **"after review, a Haiku worker merges main and runs every check"**: `integrate` has agent
   `worker` and model `claude-bridge/claude-haiku-5-5`. It comes after every `review-*` call and
   right before `pr`. Its task contains the three exact command lines above (worktree
   `/tmp/repo-worktrees/issue-2`, branch `issue-2-scaffold`), `merge --abort`, `- test: npm test`
   and `the one exception to "never`. Its `outputSchema.properties.checks` has `required: ["test"]`
   and `enum: ["pass", "fail"]`. With `commitAuthor: { name: "Pat O'Brien", email: "pat@example.org" }`,
   the task contains `git -c 'user.name=Pat O'\''Brien' -c 'user.email=pat@example.org' -C '/tmp/repo-worktrees/issue-2' merge --no-edit`.
2. **"a clean integration needs no fix"**: in the happy run, keys end `integrate, pr`,
   `result.integration` deep-equals
   `{ status: "pass", main: "c57139f", merge: "merged", conflicts: [], failing: [], checks: { test: "pass" }, firstAttempt: null, fix: null, reReview: null, note: "" }`,
   and the PR task contains `JSON.stringify(result.integration)` and `"Integration" line`.
3. **"a conflict gets one fix round, a re-check and a code re-review"**: `integrate` answers
   `merge: "conflict", conflicts: ["src/tools.ts"]` with no checks. The keys are
   `spec, implement, diff-r0, review-code-r0, review-ux-r0, integrate, integrate-fix, integrate-recheck, diff-r1, review-code-r1, pr`.
   `integrate-fix` has model `claude-bridge/claude-sonnet-5-5` and its task contains
   `conflicts in: src/tools.ts`, the merge command, `--no-edit --cleanup=strip`,
   `Tests never use the network.` and `never revert or weaken main's changes`. `review-code-r1`
   contains `INTEGRATION FIX`, `conflicted in src/tools.ts` and `/.pi/factory-review/r1.diff`.
   `result.rounds.at(-1)` deep-equals
   `{ round: 1, lenses: ["code"], diff: ".pi/factory-review/r1.diff (120 lines, 2 files)", blocking: 0, after: "integration fix" }`.
   `result.integration.reReview === 1` and `result.integration.status === "pass"`.
4. **"failing checks after the merge: the fix gets their output"**: `integrate` answers
   `checks: { test: "fail" }, failures: [{ check: "test", output: "x".repeat(5000) + "END" }]`. The
   `integrate-fix` task contains `these checks fail after it: test` and `END`, and does not
   contain `"x".repeat(3001)`. The re-check passes, so
   `result.integration.failing` deep-equals `[]` and `result.integration.firstAttempt.failing`
   deep-equals `["test"]`.
5. **"a fix that touched only tests is not re-reviewed"**: the failing-check case with
   `integrate-fix` answering `changed_files: ["test/a.test.ts"], non_test_files: []`. The keys end
   `integrate, integrate-fix, integrate-recheck, pr`, and `result.integration.reReview === null`.
   A second case with no `non_test_files` field and `changed_files: ["a.ts"]` does re-review.
6. **"the integration re-review follows the last revise round"**: with `blockerOnCode` plus a
   failing integrate, the keys after `review-code-r1` are
   `integrate, integrate-fix, integrate-recheck, diff-r2, review-code-r2, pr`, and the
   `review-code-r2` prompt asks for ids `code-r2-<n>`.
7. **"integration re-review findings add to earlier findings and make a draft"**: with
   `maxRounds: 1`, round 0 returns a `code` blocker and a `ux` major. After `revise-r1`,
   `review-code-r1` returns blocker `code-r1-1` and `review-ux-r1` returns major `ux-r1-1`, so the
   loop ends with both open. A failing integrate, a successful fix with `non_test_files: ["a.ts"]`,
   and `review-code-r2` returning major `code-r2-1` plus one minor give `result.unresolved` ids
   `["code-r1-1", "ux-r1-1", "code-r2-1"]` (nothing dropped), `result.draft === true`, and a
   `result.followUps` one higher than the same run without that minor.
   A second case: same setup, but `review-code-r2` approves with no findings. `result.unresolved`
   ids are still `["code-r1-1", "ux-r1-1"]` and `result.draft === true`: a narrow re-review cannot
   clear a finding it never re-judged.
8. **"integration that cannot run, or a fix that fails, opens a draft without flagging"**:
   (a) `integrate: { ok: false, error: "boom" }` gives keys ending `integrate, pr`, status
   `"error"`, note `"boom"`, `draft === true`, no `flag-*` key, and the PR task contains
   `Does not integrate with main:`.
   (b) A failing integrate with `integrate-fix: { structuredOutput: { status: "blocked", summary: "cannot" } }`
   gives keys ending `integrate, integrate-fix, pr`, status `"fail"`, `fix.status === "blocked"`,
   `fix.summary === "cannot"` and `draft === true`.
   (c) A failing integrate, a successful fix and `integrate-recheck` still failing give status
   `"fail"` and `draft === true`.
   (d) `integrate-recheck: { ok: false, error: "gone" }` gives status `"error"` and note
   `"re-check: gone"`.
9. **"models follow the config for integration"**: extend "models, skills, commit identity and
   spec dir follow the config". With a failing integrate, `integrate` and `integrate-recheck` have
   model `p/small`, `integrate-fix` has model `p/fast`, and `integrate-fix.skill === "build-skill"`.
10. **"only the integration stages may merge"**: in the conflict run, the only tasks that contain
    `merge --no-edit` are `integrate`, `integrate-fix` and `integrate-recheck`. Every task still
    contains `never merge`.
11. **"a PR stage stop still reports the integration"**: `pr: { ok: false, error: "boom" }`
    gives `result.integration.status === "pass"`.

Also run `npm run check` (the script parses as a sandbox body), then `npm run schema` followed by
`git diff --exit-code schema/`, then `python3 docs/figures/make_figures.py` and check both SVGs by
eye, then `subagent({ action: "validate", … })` from a pi session.

## Risks

- **Main moves during the run.** The first integration merges whatever main was at that moment. A
  PR that lands after it is caught only by a later run (`--start-at review` re-integrates) or by
  GitHub's own mergeability check. This narrows the window to minutes; it does not close it.
- **Deps change on main.** A changed lockfile can make the checks fail from stale installs. The
  Haiku stage does not run setup. The fix round gets `config.implement` (e.g. "Run npm ci
  first"), reinstalls, and the re-check then runs in the updated worktree. If this turns out to be
  the common failure, a later issue can add a per-repo setup command.
- **The fix round "fixes" by weakening main.** For example, it reverts main's rename or deletes
  the failing test. The prompt forbids both. The `code` re-review sees any non-test change, and a
  deleted test shows in the diff. A test-only fix is not re-reviewed, so a weakened test could pass
  unseen. Watch for this in the first runs, and if it happens, re-review all fixes.
- **Non-test classification is the model's call.** Sonnet may call a test helper non-test (which
  costs an extra review) or the other way round (which skips a review). The prompt says "when
  unsure, list the file", and a missing field means re-review.
- **Integration re-review findings do not loop back to revise.** A real major found here makes the
  PR a draft for a human, rather than running another revise round. This is deliberate: it bounds
  the run. If it happens often, a later issue can give integration a revise round.
- **Haiku paraphrases the commands.** For example, it skips `merge --abort`, or rebases. The
  schema catches a missing report, and a failure there means "error" and a draft PR. A merge left
  in progress would show in the fix stage or the PR stage's push. The prompt forbids rebasing and
  resetting.
- **Cost and time.** Every run now runs the full checks one more time, plus a fetch and a merge.
  A failure adds a Sonnet round, another check run and possibly an Opus review. For slow test
  suites this is the main added cost.
- **The diff after integration.** Later diffs (`origin/main...HEAD`) run from the new merge base.
  So the integration re-review sees the branch's own changes plus the conflict resolutions, not
  main's changes. That is the intent.
- **A seam.** Every consuming repository's PRs now carry merge commits from `origin/main`. Repos
  that require linear history would need squash-merging, which GitHub's "Squash and merge" handles.
  This is noted in docs/factory.md through the Integration paragraph's "a merge commit, never a
  rebase".
