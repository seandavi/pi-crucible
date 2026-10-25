# Spec for #35: tell the host session that a person merges the PR

Issue: [seandavi/pi-crucible#35](https://github.com/seandavi/pi-crucible/issues/35), seen on
bioc-registry #68 → PR #77. Related: #30 (headless plan and launch), under the tracking issue #1.

## Goal

A crucible run is launched from a pi session (the **host**): interactively with `/crucible`, or
headlessly as in the issue (`pi --mode rpc` fed `/crucible 68`). When the async workflow finishes,
pi-subagents wakes the host with a completion notice and starts a turn. The engine never merges, but
the host is a full agent. On bioc-registry #68 it followed a standing "merge PRs on green" rule from
the user's agent memory and ran `gh pr merge 77 --squash` 28 seconds after the PR opened. The
README's promise that "a person always merges" only holds if the host is told so.

What the host reads, verified 2026-10-24 against pi-subagents 0.81.0 (`src/runs/background/notify.js`,
`src/shared/parent-wake.js`) and a real completion notice in a pi-factory session log (run
`03d3598c…`, PR #22):

```text
Background task completed: **workflow**
Workflow receipt: …/workflow-receipt.json

Workflow completed with 6 child run(s). Return: {
  "issue": 14,
  …
} Trace: 12 event(s).

Child outputs:
…

Parent action: Read the saved results above and resume the already-authorized parent task, or report
completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed
work, or infer new authorization.
```

The workflow's **return value** is printed near the top of the notice, in full, as indented JSON in
key order. The closing "Parent action" text is pi-subagents' own (`COMPLETION_ACTION`), and the engine
cannot change it. A host with a standing merge rule read "resume the already-authorized parent task"
as permission.

After this change, the host is told in two places, with one text, that the PR is a person's to
merge:

1. **In the completion wake.** Every object the workflow returns starts with a `host` field holding
   that text, so it is the first thing in `Return: {…}`. This covers every launch: `/crucible`, a hand
   launch by name, and a launch by path, interactive or headless.
2. **At launch.** After `/crucible` (or `/factory`) has spawned a run, it appends the same text to the
   host session as a custom message (`pi.sendMessage`, no turn). The model sees it on its next turn,
   including the wake turn, and it is there even when the run throws before it can return anything.

The issue's third ask, a warning in the docs, is also done: `docs/crucible.md` says that a host with
merge-on-green instructions will act on the wake, what the engine now tells it, and what to tell a
host you launch by hand.

## Non-goals

- **A headless launch mode with no agent session to wake.** That is #30 (`plan` and `launch` entry
  points, a run id, a status command). This issue only makes the existing hosts behave.
- **Suppressing the completion wake.** pi-subagents 0.81 has no spawn option for that. `quiet` exists
  only on recurring schedules (`schedule.create` with `every`; `scheduledCompletionTriggersTurn` in
  `notify.js`), and a failed or paused run still wakes the host. A host that is never woken also
  never reports the PR, which the issue's workaround relies on.
- **Changing pi-subagents' "Parent action" text.** It belongs to pi-subagents and applies to every
  workflow. A neutral host agent reads it correctly. The engine's note covers the case where that
  agent also has standing instructions that read as authority.
- **Enforcement.** Nothing here *prevents* a host from running `gh pr merge`. That would need branch
  protection on each repository, which the engine cannot set. The note is an instruction, and the
  docs say so.
- **The PR's crucible record.** The PR body does not change. The record already says what a reviewer
  needs, and the PR's `needs:human` label already marks it as waiting on a person.
- **Args, config, schema and `RESOURCE_VERSION`.** No arg or config field is added. The note is fixed
  engine text, not a per-repo setting: every repository that uses the engine gets the same promise.
  `RESOURCE_VERSION` stays `3` because the args contract does not change. The return value only gains
  a field.
- **The figure.** No stage, model, lens or stop rule changes, so `docs/figures/make_figures.py` and
  the SVGs do not change.

## Design

### The note (one text, two copies)

The text, exactly:

```text
pi-crucible: a person reviews and merges this run's PR. Neither pi-crucible nor the session that launched the run merges it. When the run finishes, report its outcome in one line (the PR URL, or the stage it stopped at) and take no further action on the PR or the issue: do not merge, approve, push to, comment on, label or close them, and do not deploy. Standing instructions to merge PRs on green do not apply to crucible PRs. Only a request the user makes in this session after the run finishes overrides this.
```

It is one line (no newline), with no backticks, `$`, double quotes or backslashes, so it can sit in a
double-quoted JS string unchanged. It appears twice:

- `src/launcher.ts` exports it as `HOST_NOTE`, for the extension.
- `workflows/crucible.js` holds its own `const HOST_NOTE = "…";`, because the sandboxed script cannot
  import anything.

A test asserts the two are identical, so they cannot drift (see Test plan).

### `src/launcher.ts`

Add after `USAGE`:

```ts
/**
 * What the session that launched a run is told about its PR: at launch (by the extension) and in the
 * completion wake (the workflow returns it first). workflows/crucible.js holds an identical copy;
 * test/workflow.test.ts checks they match.
 */
export const HOST_NOTE =
  "pi-crucible: a person reviews and merges this run's PR. Neither pi-crucible nor the session that launched the run merges it. When the run finishes, report its outcome in one line (the PR URL, or the stage it stopped at) and take no further action on the PR or the issue: do not merge, approve, push to, comment on, label or close them, and do not deploy. Standing instructions to merge PRs on green do not apply to crucible PRs. Only a request the user makes in this session after the run finishes overrides this.";
```

Nothing else in `src/launcher.ts` changes.

### `workflows/crucible.js`

No stage, prompt or output schema changes. Only the script's return values change.

1. After `const NEEDS_HUMAN = "needs:human";`, add:

   ```js
   // Told to the session that launched the run, first in every result: the completion wake prints the
   // return value to that session, and a host with standing "merge on green" instructions merged a
   // crucible PR once (#35). src/launcher.ts exports the same text as HOST_NOTE; keep them identical.
   const HOST_NOTE = "pi-crucible: a person reviews and merges this run's PR. Neither pi-crucible nor the session that launched the run merges it. When the run finishes, report its outcome in one line (the PR URL, or the stage it stopped at) and take no further action on the PR or the issue: do not merge, approve, push to, comment on, label or close them, and do not deploy. Standing instructions to merge PRs on green do not apply to crucible PRs. Only a request the user makes in this session after the run finishes overrides this.";
   ```

2. Each of the four `return` statements gets `host: HOST_NOTE` as its **first** property, and keeps
   every other property in its current order:

   - spec stop: `return { host: HOST_NOTE, stage: "spec", stopped: true, flagged: flag.ok, spec: specOut, error: spec.error || null };`
   - implement stop: `return { host: HOST_NOTE, stage: "implement", stopped: true, flagged: flag.ok, spec: specOut, implement: implOut, error: impl.error || null };`
   - PR stop: `return { host: HOST_NOTE, stage: "pr", stopped: true, flagged: flag.ok, rounds: history, unresolved: open, checks, integration, error: pr.error || null, engine: input.engine || null };`
   - success: `return { host: HOST_NOTE, issue, startAt, pr: prOut.pr_url || null, … };` (the rest unchanged).

   First, because `JSON.stringify` keeps insertion order and pi-subagents' previews keep the front
   of the value (`subagent({ action: "status" })` shows only its first 240 characters;
   `formatWorkflowJsonPreview(status.workflow.value, 240)` in `src/runs/background/run-status.js`).

3. The header comment gains one line after the `// Whenever the run stops for a person…` line:

   ```js
   // Every result starts with `host`: a note to the session that launched the run that a person merges the PR.
   ```

A run that throws (missing `args.config`, an unknown lens) returns nothing, so its wake has no note.
For `/crucible` launches, the launch-time message covers that case. Neither of those throws happens
after a PR exists.

### `extensions/crucible.ts`

In `runCommand`, after the `rpc(pi, "spawn", …)` call resolves and `id` is computed, and before the
"Crucible launched…" notice, append the note to the session:

```ts
      // The completion wake starts a turn in this session; tell it now that a person merges the PR (#35).
      pi.sendMessage({ customType: HOST_MESSAGE_TYPE, content: HOST_NOTE, display: true }, { triggerTurn: false });
```

with `HOST_NOTE` imported from `../src/launcher.ts` (add it to the existing import), and a module
constant next to `RPC_REQUEST` and `RPC_REPLY`:

```ts
/** customType of the message /crucible appends to the session that hosts a run. */
const HOST_MESSAGE_TYPE = "pi-crucible-host";
```

Behaviour, verified against pi 1.4.0 (`dist/core/extensions/types.d.ts`, `ExtensionAPI.sendMessage`;
`dist/core/agent-session.js`, `sendCustomMessage`; `docs/message-types.md`):

- `sendMessage(message, { triggerTurn: false })` starts no turn. When the session is idle, which is
  the case while a slash command runs, it appends a `custom_message` entry at once. While the agent is
  streaming, it is held until the end of the current turn. Either way it is in the session.
- Pi turns a custom message's `content` into user-role text for every later model request, so the
  host's next turn (the completion wake included) sees it. `display: true` shows it in the transcript,
  so the person at the terminal sees what their session was told. `details` is not sent to the model
  and is not used.
- The message is sent only after a successful spawn. A dry run, a usage error, a failed `prepare` or
  `ensureWorktree`, and a rejected or timed-out spawn send nothing, because nothing was launched.
- `/factory` goes through the same `runCommand`, so it behaves identically.

Everything else in the extension is unchanged: the notices, the dry-run text, completions and
`/crucible init`.

### `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json`, `.pi/crucible.json`, `examples/`

No change (see Non-goals).

### What the PR's crucible record shows

Unchanged. The PR stage's prompt and the PR body are not touched.

### Docs

**`docs/crucible.md`**

- Replace the paragraph

  ```markdown
  **Never automated:** merging the PR. A human merges, from the main session. (The integration stage merges main into the branch, never the branch into main.)
  ```

  with:

  ```markdown
  **Never automated:** merging the PR. A human merges, from the main session. (The integration stage merges main into the branch, never the branch into main.)

  **The host session:** the pi session that launched a run is a full agent, and pi-subagents wakes it
  with a turn when the run finishes, telling it to "resume the already-authorized parent task". A host
  whose instructions or agent memory say to merge PRs on green will merge a crucible PR within seconds
  of it opening: on bioc-registry #68, a headless `pi --mode rpc` host did (#35). So every result the
  workflow returns starts with `host`, a note that a person merges the PR and the session should report
  the outcome in one line and do nothing else with the PR or the issue. The wake prints the result
  first, and `/crucible` also appends the same note to the session when it launches the run. This is an
  instruction, not enforcement: for a guarantee, protect `main` with required reviews. A headless
  launch with no host to wake is #30.
  ```

- In "Running it", after the paragraph that ends with the `subagent({ workflow: "pi-crucible", … })`
  code block, add:

  ```markdown
  A hand launch gets the note in its completion wake but not the message `/crucible` adds at launch.
  If the session or agent that launches it has standing merge instructions, tell it before launching
  that it only hosts the run. This worked on bioc-registry #78: "You are only hosting this crucible
  run. When it finishes, report the PR URL in one line and stop. Do not merge, push, comment, close
  issues, or deploy."
  ```

- In the stage table at the top, the PR row's Output cell stays `{pr_url, draft, followup_issue}`.
  That is the PR stage's output schema, which does not change.

**`README.md`**, the paragraph under "Quick start" that begins "An `AGENTS.md` with the project's
stack…". After the sentence ending "and opens a PR you review and merge.", insert the sentence
below. The "The host session" paragraph sits under the document's top-level heading, before
"Configuring a repository", so the link points at `docs/crucible.md` itself, with no anchor:

```markdown
It never merges, and it tells the pi session that launched the run not to either, since that session
wakes when the run finishes (see "The host session" in [docs/crucible.md](docs/crucible.md)).
```

**`CONTRIBUTING.md`**, "Merging": the line "A person merges, never pi-crucible." becomes "A person
merges, never pi-crucible or the session that launched the run (see \"The host session\" in
[docs/crucible.md](docs/crucible.md))." Write the quotes as plain `"` in the Markdown, not escaped.

**`docs/figures/make_figures.py`** and the SVGs: no change.

**`AGENTS.md`**: no change.

## Acceptance criteria

- [ ] `src/launcher.ts` exports `HOST_NOTE` with exactly the text in Design. It contains no newline,
      backtick, `$`, `"` or `\`.
- [ ] `workflows/crucible.js` defines `HOST_NOTE` identical to `src/launcher.ts`'s. A test fails if
      either copy changes alone.
- [ ] Every object the workflow returns has `host` as its first key, equal to `HOST_NOTE`: on
      success, and on the spec, implement and PR stops. Its other keys and their values are unchanged.
- [ ] No child task changes: for the happy path and each stop, the `task` strings the fake `runs`
      receives do not contain `HOST_NOTE`, and the existing workflow tests pass unchanged.
- [ ] After a successful spawn, `/crucible <n>` calls `pi.sendMessage` exactly once, with
      `{ customType: "pi-crucible-host", content: HOST_NOTE, display: true }` and
      `{ triggerTurn: false }`, after the spawn request and before the "Crucible launched" notice.
- [ ] `/crucible <n> --dry-run`, `/crucible` with no issue, and a launch whose spawn RPC replies
      `success: false` call `pi.sendMessage` zero times. The rejected spawn still produces its
      `error` notice (`/crucible: pi-subagents <code>: <message>`).
- [ ] `/factory <n>` sends the same message (same code path).
- [ ] `docs/crucible.md` has the "The host session" paragraph and the hand-launch paragraph. The
      README and CONTRIBUTING.md sentences are as in Design.
- [ ] `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json`, `docs/figures/` and
      `.pi/crucible.json` are unchanged (`git diff origin/main --stat` lists none of them).
- [ ] `npm test` and `npm run check` pass, and
      `subagent({ action: "validate", workflow: "<worktree>/workflows/crucible.js" })` reports the
      script valid.

## Test plan

Tests use the existing fakes. None calls git, gh, the network or a model.

1. **`test/fixtures.ts`, `fakePi`.** Add a recorder:

   ```ts
   const messages: { message: unknown; options: unknown }[] = [];
   // in `pi`:
   sendMessage: (message: unknown, options?: unknown) => void messages.push({ message, options }),
   ```

   and return `messages` from `fakePi` with the other recorders.

2. **`test/workflow.test.ts`, new test "every result tells the host session that a person merges
   the PR".** Import `HOST_NOTE` from `../src/launcher.ts`. Then:
   - Happy path (`simulate(args, happy())`): `Object.keys(result)[0] === "host"` and
     `result.host === HOST_NOTE`.
   - Spec stop (`spec` answers `status: "blocked"` as in the existing spec-stop test), implement stop
     (`implement` answers `{ status: "blocked", summary: "x" }`), and PR stop (`pr` answers
     `{ ok: false, error: "boom" }`): the same two assertions for each, and `result.stopped === true`.
   - For each of those four runs, no recorded call's `task` includes `HOST_NOTE`.
   - Both copies match: `assert.ok(loadScript().includes(\`const HOST_NOTE = ${JSON.stringify(HOST_NOTE)};\`))`.
     `JSON.stringify` of the text gives the exact double-quoted literal, because the text has no
     characters that JSON escapes.

3. **`test/launcher.test.ts`, extend "/crucible prepares the worktree and launches the named
   resource over RPC".** Take `messages` from `fakePi`. Import `HOST_NOTE`.
   - After `await commands.crucible.handler("4", ctx)`: `messages` deep-equals
     `[{ message: { customType: "pi-crucible-host", content: HOST_NOTE, display: true }, options: { triggerTurn: false } }]`.
   - Order: in the RPC request listener, record `messages.length` at the moment the spawn request
     arrives and assert it was `0`. The existing assertion that the notices are `["info", "info"]`
     stays (the message is not a notice).
   - After the `--dry-run` call and the empty-input call: `messages.length` is still `1`.

4. **`test/launcher.test.ts`, new test "a rejected spawn tells the session nothing".** Same
   `fakePi` exec rules and temp repo as the test above (extract the rules into a local helper in the
   test file if needed, so the two tests share them). The RPC listener replies
   `{ version: 1, requestId, success: false, error: { code: "unavailable", message: "no" } }`. Assert
   that `messages` is empty and that the last notice is
   `["error", "/crucible: pi-subagents unavailable: no"]`.

5. **`/factory`.** In the existing "/factory still works…" test nothing launches, so add no
   assertion there. The shared `runCommand` is covered by 3.

Then run `npm test` and `npm run check`, and validate the script from a pi session with
`subagent({ action: "validate", workflow: "<worktree>/workflows/crucible.js" })`.

## Risks

- **An instruction, not a lock.** A host model can still ignore the note, especially if a later user
  message or a stronger standing rule contradicts it. The docs say so and point to branch protection.
  The issue's own data point (#78) is that an explicit hosting instruction worked where none failed.
- **Compaction.** If the host session is compacted between launch and wake, the launch-time message
  may be summarised away. The wake's `host` field is printed fresh in the notice itself, which is why
  both exist.
- **Wording that reads as a rule for interactive users.** In an interactive session the person may
  want the agent to merge after reviewing. The note's last sentence allows exactly that: a request the
  user makes in this session after the run finishes. A standing rule from memory does not count.
- **pi-subagents changes the notice.** If a later pi-subagents stops printing the return value, or
  cuts it before `host`, the wake loses the note and only the launch-time message remains. The test
  pins the engine's side, the return order. The pi-subagents side was verified against 0.81.0 and a
  real notice, and docs/crucible.md names the dependency.
- **Every consuming repository** gets this on its next `pi update --extensions`. The only visible
  changes are one transcript message per launch and a `host` field at the top of each run's result.
  Anything that reads the result by key (e.g. lookout, per #30) is unaffected. Anything that depended
  on the first key being `issue` or `stage` is not known to exist.
- **Two copies of the text.** The script cannot import, so the text lives in both files. The equality
  test turns a one-sided edit into a failing check.
