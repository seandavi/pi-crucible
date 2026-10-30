# pi-subagents workflows: how pi-crucible uses them (review, 2026-10-29)

Question (Sean): what is the deal with pi-subagents and workflows, and are crucible and
pi-crucible using them correctly?

Sources: pi-subagents 0.83.1 as installed (`~/.pi/agent/npm/node_modules/pi-subagents`, cited
below as `ps:`), pi-crucible at `origin/main` 4f2fed2, and five crucible runs from today under
`$TMPDIR/pi-subagents-uid-1727698091/async-subagent-runs/` (#140 `91a2b4ec`, #141 `4121239d`,
#145 `a31aec22` with its diff child `287a36df`, #127 `affe3ce2`, #127 stopped `634f8e2c`).

How each claim is marked:
- **Tested**: I ran something (read a run's JSON, a transcript or a status file) and saw it.
- **Read**: it comes from code or docs, cited by file:line.
- **Inferred**: my reading, not checked.

## Verdict

**Mostly correct, with four issues that matter.** The architecture is what the docs recommend: one
async named-resource workflow, keyed sequential `runs.run` stages, `runs.all` for review lenses,
fresh-context reviewers, one writer per worktree, and an explicit `status` field in every
`outputSchema` that the script checks. The four issues:

1. **Loose output schemas, and missing values read as failures.** This caused lead 4a: the #140
   integration "failed" lint, typecheck and test when all three had passed.
2. **The integration record goes stale.** `failing`, `merge` and `conflicts` keep their first-pass
   values after the fix and re-check, so the PR's crucible record contradicts itself.
3. **Deterministic shell steps go through Haiku as prose.** That covers the diff, fetch, merge and
   checks. Haiku broke the required command order four times in today's runs. A named resource
   can run exact commands on the host itself (`hostCommands` + `runs.host`), so these steps don't
   need an LLM.
4. **No timeouts and no retries.** Every child silently gets pi-subagents' 30-minute default. A
   reviewer that crashes becomes a fake "major" finding instead of being retried.

There are smaller gaps too: the completion notice truncates the most useful children and the end
of the return value, and the script emits nothing an outside observer could follow. Some docs are
also out of date: the `/reload` rule, the "tested with" versions, and pi 1.1.

## 1. What pi-subagents workflows are, and what crucible uses

| Concept | What it is | Crucible uses it? |
|---|---|---|
| **Scripted workflow** | A JavaScript statement body run in a sandbox. Its helpers are `runs.run`, `runs.all`, `runs.lanes`, `runs.steer`, `runs.status`, `runs.ref(s)`, `emit`, `console` and mission `state`. It has no filesystem, shell or Pi tools (ps:docs/workflows.md:82). | Yes: `workflows/crucible.js`. |
| **Named workflow resource** | An extension registers `{name, version, resolve(args)}`. `resolve` validates args with no I/O and returns the script. It can also return **`hostCommands`**, exact `{key, command}` grants that the script then runs with `runs.host` (ps:docs/extension-api.md:7-28). | Yes: `pi-crucible`, `src/resource.ts:125-134`, registered in `extensions/crucible.ts:76-83`. It grants no host commands. |
| **Async run** | A background workflow. Its children run in a detached runner, and completion wakes the parent session (ps:docs/workflows.md:15). RPC `spawn` is async-only (ps:docs/extension-api.md:122). | Yes: RPC `spawn` in `extensions/crucible.ts:158-164`. Children run `async: true` (Tested: `status.json` steps). |
| **Child agents** | `worker` (writes, has bash, fresh context) and `reviewer` (read-only). Each child gets a model, cwd, skill and `outputSchema`, and the script reads `structuredOutput` (ps:docs/workflows.md:86-88, 336-353). | Yes: worker for spec, implement, diff, revise, integrate, fix, PR and flag; reviewer for lenses. |
| **Artifacts / output binding** | `output: "<path>"` on a child is the binding API. A filename written in task prose is only an instruction (ps:docs/tool-reference.md:170-176). The docs prefer passing earlier `output`/`structuredOutput` into later tasks over shared files (ps:docs/workflows.md:376-381). | Data passes as `structuredOutput` → JSON in the next task's prose (the documented pattern). The one exception is the review diff: a shared file in the worktree, written by a worker told to in prose (`crucible.js:222-252`). It never uses `output`/`outputReference`. |
| **Worktree isolation** | `worktree: true` gives each child a temporary worktree from clean HEAD, captures a patch, then removes the worktree (ps:docs/workflows.md:460-482). | No. The launcher makes one long-lived issue worktree (`src/launcher.ts:328-348`) and every stage runs there with `cwd`. That's right: crucible needs one branch that persists across stages and gets pushed, and temporary worktrees don't fit that. |
| **Retained children / resume** | Finished children stay resumable: `runs.run(key, {resume: runId})` continues one with its context (ps:docs/tool-reference.md:180-199). | No. Revise is a fresh worker with the findings in its task. That's defensible (fresh context is the documented default for workers), but implement → revise could resume the implementer instead (Inferred benefit: less re-reading). |
| **Relaunch reuse / auto-resume** | A stopped or interrupted workflow relaunched with the same script reuses its finished children by key and params. Since 0.82 it auto-resumes once when its session reopens or reloads within 24 h, and `subagent({action:"resume", id})` works (ps:docs/workflows.md:34-46). | Used implicitly. The docs still tell people to avoid `/reload` and use `options.reuseFrom` by hand (AGENTS.md:14, CONTRIBUTING.md:55). See §3. |
| **Missions** | Every workflow gets an auto-created mission: a durable JSON record under `~/.pi/agent/missions/projects/<hash>/` with run ids, status and artifact paths (ps:docs/missions.md:14). | Auto only. Tested: the mission for `affe3ce2` is titled `"[prompt redacted]"`, so nothing in it names the issue. |
| **Acceptance** | Each run gets an evidence policy. `worker` is an "async declared writer", so it gets inferred `checked` with a required review. `gate`/`acceptance.verify` run commands on the host and record them as verified (ps:docs/tool-reference.md:409-497). | Not configured. Tested: every worker child in `91a2b4ec` and `a31aec22` ends `review-required` or `rejected` (diff, integrate). Inferred gates don't fail runs (ps:docs/tool-reference.md:497), so this is noise, not breakage. |
| **Steer / stop / interrupt** | `runs.steer(key, msg)` inside a script. Top-level `steer`, `stop`, `interrupt` and `resume` by run id. | No steering. Stop is used by the parent session (Tested: `634f8e2c` was stopped after 94 s, `reason: "subagent-action"`). |
| **Supervisor dialogue** | A child can call `contact_supervisor` (need_decision), and the workflow pauses until the parent replies (ps:docs/workflows.md:513-547). | Not used by design: spec reports `blocking_questions` and the script flags a human. Workers still have the tool (Inferred risk: a worker that asks would pause the run on the launching session). |
| **Bounds** | `options.timeoutMs`, `toolBudget` and `usageBudget` are opt-in. Composite async workflows have no deadline; each child falls back to 30 min (ps:docs/tool-reference.md:108; ps:docs/workflows.md:136-162). | None set. Tested: child `dd9e4be9` has `timeoutMs: 1800000`. |

## 2. Does crucible.js follow the recommended pattern?

The documented loop is `clarify → scout → worker → fresh reviewers → worker`, launched async,
with each result consumed where a later step needs it (ps:docs/workflows.md:5-15). Crucible maps
onto it: spec (Opus, clarify and scout) → implement (Sonnet) → fresh Opus reviewers per lens →
revise (Sonnet), then integration and the PR.

| Aspect | Docs | crucible.js | Assessment |
|---|---|---|---|
| Launch | One top-level async workflow; children only inside it (ps:docs/workflows.md:82). Named resources for permission-sensitive work (ps:docs/workflows.md:122-132). | One RPC `spawn` of the named resource (`extensions/crucible.ts:160`). Args are prepended as `CRUCIBLE_ARGS` because a named resource's sandbox gets empty `args` (`crucible.js:20-23`, `src/resource.ts:1-7`). | Correct. The `CRUCIBLE_ARGS` workaround is still needed in 0.83.1 (Read: docs say only resolve sees args, ps:docs/extension-api.md:26). |
| Passing context | Earlier `output`/`structuredOutput` into later tasks (ps:docs/workflows.md:336-381). Each child starts cold, so the brief states goal, cwd, authority and success (ps:skills/pi-subagents/SKILL.md:90-96). | Shared `CONTEXT`/`COMMON` preamble with repo, cwd, rules and a branch check (`crucible.js:75-89`). Findings and responses go in as JSON (`crucible.js:276-283, 375-376`). | Correct. |
| Output binding | Explicit status field in `outputSchema`, and treat only that verdict as success (ps:docs/workflows.md:88). | Every stage has a `status` enum and the script checks it (`crucible.js:97-101, 182, 215, 388`). **But** the schemas require only `status` and allow extra properties, and the script reads absent fields as meaningful (`crucible.js:465-466`). | **Partly correct.** This is the 4a bug (§4a). |
| Shared files | Prefer returned data over shared files (ps:docs/workflows.md:376); use `output` for durable files (ps:docs/tool-reference.md:176). | Diff file written by a Haiku worker told to in prose (`crucible.js:222-252`). | Works, but goes against the advice, and it's the step where ordering broke (§4b). |
| Failures | `ok` means the child finished, not that the work was done (ps:docs/workflows.md:88). A failed lane: report, then retry once the same way (ps:skills/pi-subagents/SKILL.md:108-112). | Spec, implement or PR failure → flag `needs:human` and stop (`crucible.js:182-186, 215-218, 617-621`). A failed reviewer → synthetic `major` finding "re-run review" (`crucible.js:322`). Diff failure degrades the review (`crucible.js:256-269`). Integration never stops the run (`crucible.js:403-407`). | Mostly right, but there are **no retries**. A crashed reviewer sends the revise stage a finding it can't fix, and the reviewer never re-runs in that round. |
| Parallelism | `runs.all([...])` for fan-out; one writer per worktree; parallelize reading and review (ps:docs/workflows.md:70; ps:skills/pi-subagents/SKILL.md:100). | Lenses run in `runs.all` (`crucible.js:308-318`); every writer stage is sequential. Re-review only the lenses with open findings (`crucible.js:395`). | Correct. |
| cwd / worktree | `cwd` per child; `worktree: true` only for isolated parallel writers. | Workflow cwd is the main checkout (`extensions/crucible.ts:160`; Tested: `status.json` `cwd: /home/davsean/Documents/git/factory-control`). Every child gets `cwd: <worktree>`, and the validator pins the worktree and branch names (`src/resource.ts:109-120`). | Correct for children. It matters for `runs.host`, which runs in the *workflow* cwd (ps:docs/tool-reference.md:13). |
| Timeouts | Writers: a narrow task plus an outer `timeoutMs` with margin, and a checkpoint (ps:docs/tool-reference.md:125-129). | None. | **Gap.** Each child gets 30 min by default (Tested). The longest stages today were 12-13 min (`affe3ce2` spec 12.7 m, implement 12.2 m), so there's headroom for now, but a bigger issue would hit the default kill mid-edit. |
| Parent notification | Completion wakes the parent; don't poll (ps:docs/workflows.md:15). | Async; `/crucible` also posts a `nextTurn` message so the parent knows the run id (`extensions/crucible.ts:133-149`). | Correct. Notice content is truncated; see §4d. |

## 3. Version drift: 0.80.0 → 0.83.1

`package.json` declares `pi-subagents ^0.80.0`; 0.83.1 is installed. Nothing crucible calls was
renamed or removed: RPC `spawn` still takes `workflow`, `args` and `cwd`, and the resource API is
unchanged (Read: ps:docs/extension-api.md:7-28, 122). Changes that touch crucible:

| Version | Change | Effect on crucible |
|---|---|---|
| 0.80.0 | Needs **Pi ≥ 1.2.0** (ps:CHANGELOG.md:141, 155). | README says "tested with pi 1.1 and 1.4" and "Tested with 0.80 and 0.81" (`README.md:151-155`). Pi 1.1 cannot run this pi-subagents. Doc fix. |
| 0.81.0 | A child with an `outputSchema` that ends without calling `structured_output` gets one more turn (ps:CHANGELOG.md:126). | Free win: fewer "no structured output" stops. Nothing to change. |
| 0.82.0 | Async workflows interrupted by a Pi exit or `/reload` **auto-resume once** when the session reopens or reloads within 24 h, reusing finished children. Also adds `subagent({action:"resume", id})` (ps:CHANGELOG.md:83, 95-96; ps:docs/workflows.md:34-46). | The rule "Never `/reload` … resume with `options.reuseFrom`" (AGENTS.md:14, CONTRIBUTING.md:55) is out of date. `/reload` is now recoverable. The real hazard: a named resource "is resolved again and must still have the same script" (ps:docs/workflows.md:40), so `/reload` **after editing `crucible.js`** blocks the auto-resume. Also, on relaunch "`runs.steer` and `runs.host` calls run again" (ps:docs/workflows.md:36), which matters if §5 rec 3 is adopted. |
| 0.83.0 | New `subagent:jobs-changed` event, so hosts can refresh without polling (ps:CHANGELOG.md:37). | Useful for observers (§4c). |
| 0.83.1 | An **explicit** mission (`mission`/`missionId`) now stays `waiting` while any workflow child's acceptance is `review-required`, `rejected`, `claimed` or `pending` (ps:CHANGELOG.md:18). | No effect today, since crucible's missions are auto-created. But if crucible ever names its mission (one way to make runs findable, §4c), every crucible mission would stay `waiting`, because each worker child is `review-required` or `rejected` (Tested: acceptance statuses in `91a2b4ec`, `a31aec22`). Set `acceptance` on worker stages first (rec 8). |
| 0.83.1 | `runs.run({key, ...})` with one object now fails validation (ps:CHANGELOG.md:21). | Crucible always uses `runs.run("key", {...})`. No effect. |

Adopt: bump the dependency floor to the version whose behaviour crucible now relies on
(auto-resume, 0.82), and fix the docs. Nothing forces a code change.

## 4. Leads

### 4a. #140: `integration.failing` = lint, typecheck, test, yet everything passed

**Answer: a crucible bug, not flaky checks.** (Tested)

- The first `integrate` child (`dd9e4be9`, Haiku) ran fetch, rev-parse and merge in order. It ran
  the three checks (all `exit=0`, 1102 tests passed), then made **two `structured_output` calls
  in the same tool block**. The first had the right value (`merge: "merged"`, all checks `pass`).
  The second was `{"status": "done", "pr_url": ""}`. Haiku probably copied the `pr_url` line from
  the shared `COMMON` text at `crucible.js:87-89` (Inferred).
- pi-subagents captures every valid call and the last one wins (Read:
  ps:src/runs/shared/subagent-prompt-runtime.js:595-616, where `structured.capture(...)` runs on
  each call). `statusSchema` requires only `status` and doesn't forbid extra properties
  (`crucible.js:97-101`), so `{status, pr_url}` passed validation. The child's
  `structuredOutput` in `workflow-children.jsonl` is exactly that object.
- `integrationPassed` and `failingChecks` treat a missing check as a failure
  (`crucible.js:465-466`). So `failing = ["lint","typecheck","test"]` and `merge = null`
  (`crucible.js:477-483`), and a **needless Sonnet `integrate-fix`** ran. It reported "Nothing was
  broken … no fix and no commit was needed."
- The re-check passed (and merged a newer main, 5850ddf → 5e120a0), so `integration.status`
  became `pass` (`crucible.js:540-542`). But `failing` and `merge` are **never refreshed** from
  the re-check, so the final record shows `status: "pass"`, `merge: null`, and
  `failing: [lint, typecheck, test]`.
- The same staleness shows in #145 (`a31aec22`): the record has `merge: "conflict"` (first pass,
  against 2e83238) next to `main: "550ab05"` (the re-check's clean merge).

Fix: rec 1 and rec 2.

### 4b. Deterministic shell steps delegated to LLM children

**Yes, and the docs allow the script to run them.** Raw scripts can't run commands
(ps:docs/workflows.md:82), but a **named resource can**: `resolve` may return
`hostCommands: [{key, command}]`, and the script calls
`runs.host(key, {kind: "command", command, timeoutMs, output?})` with exactly that command
(Read: ps:docs/extension-api.md:7-28, 30-90; ps:docs/tool-reference.md:13). Crucible is already
a named resource, so it qualifies.

Evidence that prose delegation is fragile (Tested; every case is a Haiku "run these commands in
order, exactly as written" stage):

| Run | Stage | Slip |
|---|---|---|
| `287a36df` (#145 diff-r0) | diff | "I issued steps 3 and 4 in the same tool block, which breaks the required order", then re-ran everything. |
| `a31aec22` (#145) | integrate | Ran `fetch` and `rev-parse` in parallel, got a stale `5308ab3`, then re-ran. |
| `91a2b4ec` (#140) | integrate-recheck | Same: `rev-parse` in parallel with `fetch` printed a stale value. |
| `91a2b4ec` (#140) | integrate | Two parallel `structured_output` calls; the wrong one won (4a). |

Constraints for `runs.host`:
- Commands must be exact strings fixed at resolve time. The worktree, branch and identity are
  already validated and quoted (`src/resource.ts:109-120`, `crucible.js:67-74`), and
  `config.checks` comes from origin/main's reviewed config. ps:docs/extension-api.md:94 warns
  never to splice free text into commands.
- They run in the **workflow cwd** (the main checkout), so they need `git -C <worktree>` or
  `cd <worktree> &&`.
- Limits: at most 32 grants and 32 `runs.host` calls per workflow (Read:
  ps:src/runs/shared/host-step-status.js:10).
- A non-zero exit **rejects** with only about 200 characters of output
  (ps:src/workflows/scripted-workflow.js:1442-1447). Checks and merges should therefore be
  wrapped to exit 0 and print their status, with the full log written to a file the fix stage
  can read.
- They re-run on relaunch (ps:docs/workflows.md:36).

The alternative for checks is `gate` / `acceptance.verify` on the implement, revise and fix
stages: host-run, recorded as `verified` evidence (ps:docs/tool-reference.md:123, 434-442). But
a failing gate fails the child. That changes crucible's "failing checks → draft PR" behaviour, so
it's a product decision.

The interim cheaper step (Inferred to help): give each prose stage **one** compound command
(`{ a && b; } > file`) instead of an ordered list, so a model can't reorder it.

### 4c. Hooks an outside system (factory-control's bridge) could use

What exists (report only):

- **Run directory** `$TMPDIR/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/` (Tested):
  - `status.json`: `state`; `steps[]` with `workflowKey`, `label` ("Implement issue #145") and
    `status`; `workflow.resource.name = "pi-crucible"`; `workflow.trace`, `workflow.emits` and,
    at the end, `workflow.value`.
  - `launch.json`: the full `args`, including `repo`, `issue` and `branch`.
  - `events.jsonl`: `subagent.workflow.started`, `.trace`, `.child_settled` and `.completed`,
    `subagent.child-status`, and `subagent.workflow.emit` when the script emits (Read:
    ps:src grep).
  - The docs say to read these files rather than scrape output, and to ignore unknown fields
    (ps:docs/observability.md:201-227).
  - Retention: tmp. The host clears `/data/davsean/tmp` after 7 days, and pi-subagents cleans its
    own temp artifacts older than 24 h on startup (ps:docs/observability.md:306).
- **`.active-runs` marker**, pi-subagents' own active-run index (ps:docs/workflows.md:499).
- **Mission record** `~/.pi/agent/missions/projects/<hash>/<missionId>.json`. It's durable and
  lists the run, status and artifact paths, but the title and objective are redacted for
  auto-missions (Tested). An explicit `mission: {title, labels}` would name it
  (ps:docs/missions.md:28), but see the 0.83.1 caveat in §3. `mission.update` can record PR
  receipts and labels (ps:docs/missions.md:72-74).
- **In-process events** on `pi.events`: `subagent:async-started` (`mode: "workflow"`),
  `subagent:child-status`, `subagent:jobs-changed` (UI sessions only), `subagent:async-complete`
  and `subagent:process-terminal`, plus RPC `status` and `cost`
  (ps:docs/observability.md:229-242, 331-339; ps:docs/extension-api.md:117-153). These are
  **in-process only** (ps:docs/observability.md:348): only an extension in the same Pi (such as
  pi-crucible's own) can hear them.
- **Script `emit(...)`** feeds `workflow.emits` and the `subagent.workflow.emit` events
  (ps:docs/workflows.md:82, 452). Crucible emits nothing (Tested: `emits: []`).
- **Herdr pane metadata**: inside Herdr, pi-subagents publishes active-run counts, and "when an
  active workflow has an explicit bounded `label`" it shows that label (ps:docs/extension-api.md:590-596).
  Crucible's spawn passes no workflow `label` (`extensions/crucible.ts:160`). Whether RPC `spawn`
  accepts `label` is unverified.
- Crucible's own side effects: the `needs:human` label at a stop and on the PR. It adds no
  "running" label or marker today.

### 4d. Other findings

- **Notice truncation** (Tested). The completion notice shows previews for the first **8**
  children only, at 2,000 bytes each (Read: ps:src/runs/background/notify.js:20-22, 155-162).
  Crucible runs have 6-11 children. In `a31aec22` (10 children), `review-code-r1` and `pr` got
  "Preview: unavailable (notice preview budget exceeded)". The parent session has 23 such lines
  today. The return-value preview is cut too: after `integration` and `rounds`, the parent lost
  `unresolved`, `followUps` and `followUpIssue` (they're still in `status.json`). The child
  previews it does show are each child's last prose line (for example "The gh output seems
  missing; rerun."), not its result.
- **No retries** anywhere (Read). See rec 5.
- **No timeouts** (Tested: 30-minute default per child, no workflow bound). See rec 4.
- **Acceptance noise** (Tested). Every worker child carries an inferred `checked` +
  review-required policy that ends `review-required`, or `rejected` for diff and integrate. The
  `structured_output` tool also offers an `acceptanceReport` field (seen in `4121239d`'s
  integrate output). It's harmless today, but it's the trap in §3 if missions become explicit.
- **Artifacts and retention.** Diffs live in `<worktree>/.pi/crucible-review/` (git-ignored,
  removed with the worktree). Child outputs live in `~/.pi/agent/sessions/.../subagent-artifacts/`
  ("retention-managed"), and run dirs in tmp. The only durable record is the PR body plus the
  mission JSON, and the mission's artifact paths point into tmp. Auto-resume works only within
  24 h. No action needed (Inferred).

## 5. Recommendations (prioritised)

| # | Problem | Evidence | Change | Size |
|---|---|---|---|---|
| 1 | A stage can return `status: done` with none of the fields the script reads; a missing check counts as `fail`. | 4a, Tested; `crucible.js:97-101, 465-466`. | Add `additionalProperties: false` to every `outputSchema`, and `required` for every field the script reads: integrate needs `merge`, `main`, `checks`, `conflicts` and `failures`; diff needs `diff_lines` and `changed_files`; revise and fix need `checks`. In the script, treat a `done` without `checks` as `error` ("no result"), not as failing checks. Add a test with a `{status:"done"}`-only integrate answer. | S |
| 2 | The integration record goes stale after the fix and re-check. | 4a, Tested (`91a2b4ec`, `a31aec22`); `crucible.js:477-483, 540-542`. | Take `merge`, `main`, `conflicts` and `failing` from the re-check when it runs, and keep the first pass as `integration.first`, so the PR's Integration line describes the final state. | S |
| 3 | Deterministic steps (diff, fetch, rev-parse, merge, checks) depend on Haiku following an ordered list. | 4b, four slips Tested; ps:docs/extension-api.md:7-28. | Have `resolve` grant exact `hostCommands` and run them with `runs.host`. Use `cd <worktree> &&` wrappers that exit 0 and print the exit code, and write logs to `.pi/crucible-review/`. Keep LLM stages only for spec, implement, revise, the fix, review and the PR body. Interim (S): one compound command per prose stage. Optional: `gate`/`acceptance.verify` for checks, which is a behaviour change (product call). | M |
| 4 | No stage deadlines; the 30-minute default kills a writer mid-edit with no checkpoint. | Tested (`timeoutMs: 1800000` on children); ps:docs/tool-reference.md:108, 125-129. | Set an explicit `timeoutMs` per stage (writers longer, Haiku and reviewers shorter) and an overall workflow bound on the spawn. Values are Sean's call; today's slowest stage took 12.7 min. | S |
| 5 | A reviewer that crashes becomes a fake `major` finding; infrastructure failures stop or degrade the run with no retry. | `crucible.js:322`; ps:skills/pi-subagents/SKILL.md:108-112; README #20. | Retry once, with a new key, on `!ok` (not on `blocked`) for read-only and idempotent stages: review lenses and diff. | S |
| 6 | The parent's notice loses `unresolved`, `followUpIssue` and the last children. | 4d, Tested; ps:src/runs/background/notify.js:20-22. | Return a headline-first value: `pr`, `draft`, `unresolvedCount`, `followUpIssue` and `integration.status` first, details after. | S |
| 7 | Outside systems can't follow a run without parsing tmp files. | 4c, Tested (`emits: []`). | `emit({stage, issue, ...})` at each stage boundary; optionally a workflow `label` on spawn. The integration design belongs to factory-control. | S |
| 8 | Inferred acceptance marks every worker `review-required` or `rejected`. | Tested; ps:CHANGELOG.md:18. | Set `acceptance: {level: "none", reason: "crucible checks status and reviews itself"}` on worker stages, at least before using explicit missions. | S |
| 9 | Docs are out of date. | §3, Read. | AGENTS.md:14 and CONTRIBUTING.md:55: `/reload` now auto-resumes, but not after editing `crucible.js`. README: Pi ≥ 1.2 and "tested with 0.83". Bump `pi-subagents` to `^0.82.0` or higher. | S |

Not recommended: `worktree: true` (wrong fit for a persistent branch), and `runs.lanes` (crucible's
loop is conditional, which the docs say needs raw `runs.run`, ps:docs/workflows.md:240).

## What I did not check

- I couldn't call the `subagent` tool (`guide`/`validate`) from this session, so all
  recommended-pattern citations come from the packaged docs.
- I didn't run `npm test` or `npm run check`: this worktree has no `node_modules`, and no code
  changed.
- I didn't check whether RPC `spawn` accepts a workflow `label`, or `runs.all`'s behaviour when a
  child fails.
- I didn't read PR bodies on GitHub; the stale-record claim comes from the workflow return
  values, which the PR stage receives as JSON (`crucible.js:596-603`).
