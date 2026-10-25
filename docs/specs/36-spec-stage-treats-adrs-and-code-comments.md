# Spec for #36: the spec stage treats ADRs and code comments as inputs, not constraints

Issue: [seandavi/pi-crucible#36](https://github.com/seandavi/pi-crucible/issues/36), under the
tracking issue #1.

## Goal

The issue reports (bioc-registry #68 → PR #77): the spec stage found the real root cause, then
ruled out the fix as a non-goal: "**No gate change.** ADR 0011 ... and the
`GateConfig.replace_seed` comment settle this." The comment's premise ("r-universe never
re-publishes a version") was contradicted by the spec's own evidence, and the ADR only recorded the
config value as it was at the time, without arguing for it. The PR "made the banner truthful and
left the behaviour the issue was about unchanged." A follow-up issue had to say "treat the ADR line
as describing the code, not as a constraint" before a run fixed it.

The issue asks for two things:

1. The spec prompt says ADRs and code comments are inputs, not constraints. When the issue's
   evidence contradicts a premise they state, the spec says so and either proposes the change or
   stops with `needs:human`. It never makes the fix the issue asks for a non-goal because a
   document describes the current behaviour.
2. A matching check for the `code` lens: "Does the PR fix what the issue reported, or only how it
   is described?"

After this change:

- The spec prompt carries that rule, with a stated test for when to propose the change and when
  to stop. A stop uses the existing path: status `blocked`, the contradiction in
  `blocking_questions`, and `flagHuman` labels the issue `needs:human`.
- The spec's Goal opens with what the issue reports, in the issue's words. The `code` reviewer
  can then compare the diff with the report, not only with the spec's restatement of it.
- In every review round except the integration-fix round, the `code` reviewer's task carries the
  engine's report check. A change that leaves the reported behaviour in place is `major`, and so is
  a non-goal that rules out the requested fix only because a document describes the current
  behaviour. Both send the branch to revise like any other `major`. If they stay unresolved, the
  PR opens as a draft that lists them.
- The spec stage's command for reading the issue shows the issue's body as well as its comments.
  This fixes a bug found while writing this spec; see Design.

## Non-goals

- **Giving reviewers the issue text.** Reviewers keep getting the spec, the diff and AGENTS.md.
  The report check works from the report the spec's Goal quotes. #31 (open) argues that the
  issue's story should reach the judges less, not more, so this change adds no new channel for it.
- **Changing the revise stage.** Revise may still decline a finding that contradicts the spec. If
  it declines a report-check finding because the spec's Non-goals exclude the fix, the re-reviewer
  keeps it open (existing rule: "A 'declined' response you disagree with stays open at its old
  severity"). The PR then opens as a draft listing it, so a person decides.
- **Changing any repository's lens text.** The report check is generic, so it lives in the engine
  and every repository's `code` lens gets it. No `.pi/crucible.json`, example or `/crucible init`
  starter text changes.
- Args, config fields, `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json`,
  `extensions/crucible.ts`, `src/launcher.ts` and `src/init.ts` do not change.
- Output schemas do not change: spec, review and the others keep their current shape.
- The threat-model proposals in #31 (blind lens, tripwires, comment filtering, dropping the
  "review against the issue" fallback).

## Design

### Why the issue-read command changes

`workflows/crucible.js:171` tells the spec stage to run
`gh issue view <n> -R <repo> --comments`. When stdout is not a terminal (as it never is for an
agent's bash tool), gh prints **only the comments** for `--comments`: no title, no body. Verified
2026-10-24 with gh 2.103.0:

- `gh issue view 36 -R seandavi/pi-crucible --comments | cat` prints nothing. #36 has a body and
  no comments.
- `gh issue view 4 -R seandavi/pi-crucible | cat` prints the metadata (`title:`, `state:`, ...,
  `--`) and then the body. With `--comments` it prints only the one comment
  (`author:`/`association:`/`--`/text).

The prompt therefore names both commands. The body carries the evidence this issue is about, and
a spec that never sees the body cannot weigh that evidence against a premise. This is the one
change here the issue does not ask for. It is a single prompt line, and reviewers may push back on
it.

### `workflows/crucible.js`

No new stage, arg, output schema, `runs` call or async function. Two prompts change, and one
top-level constant is added.

#### Spec stage prompt (the `task` of `runs.run("spec", ...)`)

The whole task string becomes the following. Unchanged lines are kept as they are, with the same
two-space indentation as the current text:

```js
    task: `${COMMON}

  You are the SPEC stage. Do not write any code.
  1. Read the issue: gh issue view ${issue} -R ${repo} prints its title and body, then
     gh issue view ${issue} -R ${repo} --comments prints its comments (outside a terminal,
     --comments prints the comments only). Read AGENTS.md and the design sources above.
  2. Write ${specPath}: Goal; Non-goals; Design (${config.spec.design}); Acceptance criteria as a
     testable checklist; Test plan; Risks. Start the Goal with what the issue reports: the
     behaviour it says is wrong and its evidence, in the issue's own words; then say how the
     change ends that behaviour. Be concrete enough that an implementer never has to
     choose a library or an interface. Verify package APIs you rely on (the package manager's
     metadata or the package's docs) rather than guessing.
  3. Commit only that file ("Spec for #${issue}").
  ADRs and code comments are inputs, not constraints, and so are the other design sources: they
  describe the code as it was when they were written. If the issue's evidence contradicts a
  premise one of them states (a comment says a case never happens; the issue shows it happening),
  say so in the spec's Design section, naming the document and the evidence. Then propose the
  change the evidence calls for, unless the document argues for the current behaviour on grounds
  the issue does not answer: then stop, with status "blocked" and the contradiction in
  blocking_questions. Never make the fix the issue asks for a non-goal because a document
  describes the current behaviour; a non-goal needs a reason of its own.
  Set status "blocked" only for such a contradiction, or if a question has two reasonable answers
  with materially different outcomes that the issue and the design sources do not settle; list
  them in blocking_questions.`,
```

When to propose and when to stop is decided by the document, not by the model's confidence. A
document that only records the current value or behaviour (as ADR 0011 did) leads to a proposal.
A document that argues for the behaviour, on grounds the issue's evidence does not address, leads
to a stop. A stop goes through the existing code path unchanged. `specOut.status !== "ready"`
calls `flagHuman("flag-spec", ...)` with the blocking questions, which adds `needs:human` and
comments on the issue, and the run returns `{ stage: "spec", stopped: true, ... }`.

#### Code lens report check (new constant and `reviewTask`)

Add this right after `const specPath = ...` (it uses `specPath`, so it cannot go earlier):

```js
// The code lens checks the change against the issue's report, which the spec's Goal opens with
// (#36): a fix that only changes how the problem is described is not a fix.
const REPORT_CHECK = `
Also check that the change fixes what the issue reported, not only how it is described. The Goal
in ${specPath} opens with the behaviour the issue reports: does the diff end that behaviour? A
change that leaves it in place (for example by only rewording a message, a log line or a doc about
it) is a "major" finding. So is a non-goal in the spec that rules out the fix the issue asks for
with no reason but an ADR, a doc or a code comment describing the current behaviour.`;
```

In `reviewTask`, the lens line changes from

```js
You are a READ-ONLY reviewer (round ${round}). Lens: ${LENS[lens]}${SEAM_NOTE}
```

to

```js
You are a READ-ONLY reviewer (round ${round}). Lens: ${LENS[lens]}${SEAM_NOTE}${lens === "code" && !note ? REPORT_CHECK : ""}
```

The check therefore:

- runs for the `code` lens in round 0 and in every re-review round after revise (`note` is
  `undefined` there), so a re-reviewer can judge whether revise fixed a report-check finding;
- does not run for other lenses;
- does not run in the integration-fix review round. That round's `note` limits findings to the
  fix and to what main's changes affect, and the report was judged in earlier rounds.

Findings from the check use the existing schema, ids (`code-r<round>-<n>`) and severities. Nothing
in `blocking`, `minors`, revise or the PR stage changes.

#### Header comments

The header comment block (lines 1–18) does not change, since no args or stages change.

### Args, config, schema, extension

No changes: no new or changed args (`src/resource.ts` validation is unchanged), no config fields
(`src/config.ts`, and `npm run schema` leaves `schema/crucible.schema.json` byte-identical). The
`/crucible` command behaves as before. The script stays inside the sandbox rules: one more
top-level template string, and no I/O or nested async functions.

### What the PR's crucible record shows

The record's format does not change. A report-check finding appears like any other `code` finding:
in the round table (blocking count, fixed/declined), and under "Unresolved review findings" if it
is still open, which makes the PR a draft. A spec stopped on a contradicted premise opens no PR;
the issue gets the `needs:human` comment listing the blocking question, as today.

### Docs

- **`docs/crucible.md`**:
  - Add this paragraph after the **Seams** paragraph:

    > **Premises:** ADRs, code comments and the other design sources are inputs to the spec, not
    > constraints. The spec's Goal opens with what the issue reports, in its own words. When the
    > issue's evidence contradicts a premise a document states, the spec says so in its Design
    > section. It then proposes the change, or, when the document argues for the current behaviour
    > on grounds the issue does not answer, stops with the contradiction as a blocking question. It
    > never makes the requested fix a non-goal only because a document describes the current
    > behaviour. In every review round but the integration fix's, the `code` lens also checks that
    > the change ends the reported behaviour, not only how it is described; a miss is `major`.
    > Added after bioc-registry #68, whose spec ruled out the gate fix the issue was about because
    > an ADR recorded the config value (#36).

  - In **Stops**, change "a spec with blocking questions stops the run before any code is written"
    to "a spec with blocking questions (an open design question, or a premise the issue's
    evidence contradicts and a document argues for) stops the run before any code is written".
  - In **What to watch while it is an experiment**, add the bullet:
    "- Premises (#36): how often a spec reports a contradicted premise, and whether it proposed
    the change or stopped; how often the `code` lens's report check fires, and whether it was
    right."
- **README.md**: no change. Its stage table and summary say nothing at this level of detail.
- **Figure** (`docs/figures/make_figures.py`): no change. The spec stop arrow is still labelled
  "blocking questions", and a contradicted premise is reported as one. No stage, model, lens or
  stop path is added. Running `python3 docs/figures/make_figures.py` must leave the SVGs unchanged
  (checked 2026-10-24: the script is deterministic on the current tree).
- `CONTRIBUTING.md`, `examples/`, `.pi/crucible.json`: no change.

## Acceptance criteria

- [ ] The spec task contains `gh issue view <issue> -R <repo> prints its title and body` and
      `gh issue view <issue> -R <repo> --comments prints its comments`. The old single command
      `Read the issue: gh issue view <issue> -R <repo> --comments.` is gone.
- [ ] The spec task contains "ADRs and code comments are inputs, not constraints", "Start the Goal
      with what the issue reports", "Never make the fix the issue asks for a non-goal because a
      document describes the current behaviour" and
      `Set status "blocked" only for such a contradiction, or if a question has two reasonable answers`.
- [ ] The spec task's text matches the block under "Spec stage prompt" exactly, apart from the
      substituted `${...}` values.
- [ ] `review-code-r0` contains "fixes what the issue reported, not only how it is described" and
      names the run's spec path (e.g. `docs/specs/2-scaffold.md`); `review-ux-r0` does not
      contain that phrase.
- [ ] After a blocker on `code` and a revise round, `review-code-r1` contains the phrase.
- [ ] In the integration-fix review round (a conflict at `integrate`, reviewed as
      `review-code-r1` with the INTEGRATION FIX note), the phrase is absent.
- [ ] No engine prompt mentions a project (`bioc`, `ADR 0011`, `replace_seed`, `r-universe`): the
      existing "every stage's prompt comes from the config, not the engine" test still passes, and
      its pattern is extended with `replace_seed|r-universe|ADR 0011`.
- [ ] A spec stage reporting `blocked` with a contradiction in `blocking_questions` still stops the
      run and flags it (`["spec", "flag-spec"]`), with the question in the flag's comment (the
      existing test covers this; unchanged).
- [ ] `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json`, `extensions/`, `examples/`
      and `.pi/crucible.json` are unchanged (`git diff --stat origin/main...HEAD` lists none of
      them).
- [ ] `docs/crucible.md` has the **Premises** paragraph, the amended **Stops** sentence and the
      new watch bullet as worded above.
- [ ] `npm test` and `npm run check` pass; `python3 docs/figures/make_figures.py` leaves
      `git status` clean; `subagent({ action: "validate", workflow: "<worktree>/workflows/crucible.js" })`
      passes when run from a pi session. If the implementer has no pi session, say so in the PR.

## Test plan

Add to `test/workflow.test.ts`, using the existing `simulate`, `happy`, `args`, `blockerOnCode`
and `conflict` helpers (`conflict` is defined in the Integration section, so put the new tests
after it, at the end of the file under a `// ---- Premises (#36)` comment):

1. `test("the spec reads the issue's body and comments, and weighs the evidence against the design sources (#36)")`:
   run `simulate(args, happy())`. `task("spec")` includes
   `gh issue view 2 -R owner/repo prints its title and body` and
   `gh issue view 2 -R owner/repo --comments prints its comments`, does not include
   `Read the issue: gh issue view 2 -R owner/repo --comments.`, and matches
   `/ADRs and code comments are inputs, not constraints/`, `/Start the Goal with what the issue reports/`,
   `/Never make the fix the issue asks for a non-goal because a document\s+describes the current behaviour/`
   and `/Set status "blocked" only for such a contradiction/`.
2. `test("the code lens checks that the change ends the reported behaviour (#36)")`:
   - with `simulate(args, happy())`: `task("review-code-r0")` matches
     `/fixes what the issue reported, not only how it is described/` and includes
     `docs/specs/2-scaffold.md opens with the behaviour the issue reports`. `task("review-ux-r0")`
     does not match the first pattern;
   - with `simulate(args, blockerOnCode)`: `task("review-code-r1")` matches it;
   - with `simulate(args, happy({ integrate: conflict }))`: `task("review-code-r1")` matches
     `/INTEGRATION FIX/` and does not match the report-check pattern.
3. Extend the `doesNotMatch` pattern in "every stage's prompt comes from the config, not the
   engine" to `/bioc|zod|MCP tool|workers-best-practices|seandavi@|replace_seed|r-universe|ADR 0011/i`.

No new fakes are needed: the tests only inspect the tasks the script builds. Run `npm test`,
`npm run check` and the figure script as above.

## Risks

- **Over-correction.** A spec might now propose reversing decisions that were deliberate. The
  stop test ("the document argues for the current behaviour on grounds the issue does not
  answer") is the guard. The engine already labels every PR `needs:human`, and a person merges.
- **False positives from the report check.** A spec that narrows scope for a real reason (a
  non-goal with its own reason) should not be flagged; the check's wording only targets non-goals
  whose sole reason is a document describing the current behaviour. Watch it (new watch bullet).
  Each false positive costs one revise round or a draft PR, not a wrong merge.
- **The report check relies on the spec's Goal quoting the issue faithfully.** A spec that
  misquotes the report would mislead the check. Reviewers deliberately get no raw issue text (#31).
  If runs show misquoting, revisit this together with #31's blind-lens proposal, not here.
- **Specs written before this change** have no quoted report at the start of their Goal. On
  `--start-at implement` or `review` with such a spec, the code reviewer compares the diff against
  whatever the Goal says. This is no worse than today.
- **The issue-read fix is outside the issue's literal ask.** It is included because the spec
  cannot weigh evidence it never sees. A reviewer who wants it split out can say so; it is one
  prompt line plus one test assertion.
- **Prompt length.** The spec and code-review tasks grow by about 1 KB each. The prompts are
  part of the script, not the args, so the 16 KiB args cap is unaffected.
