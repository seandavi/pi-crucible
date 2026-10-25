# Spec for #32: /crucible warns or stops when the issue already has an open PR from another branch

Issue: [seandavi/pi-crucible#32](https://github.com/seandavi/pi-crucible/issues/32), under the
tracking issue #1. Found in bioc-registry: #68 already had an open PR (#74, `Fixes #68`, branch
`seed-replace-same-version`). `/crucible 68 --dry-run` planned a fresh `issue-68-*` worktree and
branch without mentioning it, and a real launch would have opened a second, competing PR.

## Goal

`prepare` (`src/launcher.ts`) learns which open pull requests already close the issue. Any open PR
that is not the run's own branch counts as **competing**. Then:

1. `/crucible <n> --dry-run` shows a warning that lists the competing PRs and says a real launch
   would refuse.
2. `/crucible <n>` (a real launch, at any `--start-at`) refuses before it creates a worktree or
   spawns anything. The error lists the PRs and says how to proceed.
3. A new flag, `--ignore-open-pr`, turns the refusal into a warning, and the run launches.
4. The run's own PR (head branch = the planned `issue-<n>-<slug>` branch, in the same repository,
   not from a fork) never counts. `--start-at review`, which edits that PR, keeps working.

## Non-goals

- **PRs that only mention `#N`.** The issue suggests two ways to find PRs:
  `gh pr list --search "<n> in:body"` or the issue's `closedByPullRequestsReferences`. This spec
  uses the second. It finds PRs that will close the issue, through a closing keyword (`Fixes #68`)
  or a link in the issue's Development sidebar, and gives their state and head branch directly.
  A body search for `68` also matches `#680`, `v0.68`, other repositories' `#68`, and PRs that only
  say "see #68". None of those compete for the issue, and each one would block a launch until
  someone passes `--ignore-open-pr`. A PR that only mentions the issue does not close it when it
  merges, so it is not the duplicate-PR problem the issue reports.
- **Recording an ignored competing PR in the PR's crucible record.** That would need a new arg, a
  `src/resource.ts` change and a PR-stage prompt change. The operator sees the warning at launch.
  It can be a follow-up if wanted.
- **Closing, commenting on or relabelling the competing PR.** `/crucible` only reads it.
- **Competing *issue branches*.** Several `issue-<n>-*` branches are already an error in
  `findIssueBranch`. This change does not touch that.
- **Paging past 50 linked PRs.** See Risks.
- `workflows/crucible.js`, its stages, prompts, output schemas and args; `src/resource.ts`;
  `src/config.ts`; `schema/crucible.schema.json`; `.pi/crucible.json` and the examples. None of
  them change.

## Design

### Verified GitHub behaviour

Checked on 2026-10-24 with gh 2.103.0 against github.com:

- `gh issue view --json closedByPullRequestsReferences` exists, but it returns only `id`, `number`,
  `repository` and `url` for each PR: no state, no head branch. It also includes merged PRs
  (pi-crucible#14 lists the merged #22). So the launcher calls `gh api graphql` itself.
- The GraphQL field `Issue.closedByPullRequestsReferences` takes `includeClosedPrs` (default
  `false`), `orderByState`, `userLinkedOnly`, `excludeUserLinked` and the usual `first`/`after`
  pagination arguments (from schema introspection).
- With `includeClosedPrs` left at its default, **merged PRs are still returned**
  (bioc-registry#68 → #77 `MERGED`; pi-crucible#14 → #22 `MERGED`). Closed, unmerged PRs are not
  (bioc-registry#74 `CLOSED` appears only with `includeClosedPrs: true`). So the code must filter
  `state === "OPEN"` itself.
- An open closing PR comes back as, for example (lookout#30):
  `{"number":39,"url":"https://github.com/seandavi/lookout/pull/39","state":"OPEN","headRefName":"issue-30-outer-loop-state-triage-calls-as-facts","isCrossRepository":false,"repository":{"nameWithOwner":"seandavi/lookout"}}`.
- `gh api graphql -f query=… -f owner=… -f name=… -F number=30` works. `-F` gives a typed value,
  which `Int!` needs: `-f number=30` fails with `Could not coerce value "30" to Int`. Owner and
  name go through `-f` (raw strings), so a numeric repository name is not turned into a number,
  and a value starting with `@` is not read as a file, which `-F` would do.
- A GraphQL error (for example an unknown issue number) exits 1, with the error on stderr. `run`
  then throws, as it does for every other gh call in `prepare`.

### `src/launcher.ts`

#### `CommandOptions`, `USAGE`, `parseCommand`

- `CommandOptions` gets `ignoreOpenPr: boolean`, after `lenses`:

  ```ts
  export interface CommandOptions {
    issue: number;
    startAt: StartAt;
    lenses: string[];
    /** Launch even when another branch already has an open PR that closes the issue. */
    ignoreOpenPr: boolean;
    dryRun: boolean;
  }
  ```

- `USAGE` becomes:

  ```ts
  export const USAGE =
    "Usage: /crucible <issue> [--start-at implement|review] [--lens <name>]... [--ignore-open-pr] [--dry-run]";
  ```

- In `parseCommand`, the initial value becomes
  `{ issue: 0, startAt: "spec", lenses: [], ignoreOpenPr: false, dryRun: false }`, and the loop
  gets a branch right after the `--dry-run` one:

  ```ts
      else if (w === "--ignore-open-pr") out.ignoreOpenPr = true;
  ```

#### New: `LinkedPr`, `LINKED_PRS_QUERY`, `findCompetingPrs`, `competingPrCheck`

Add after `labelProblems` and before `engineCommit`:

```ts
/** A pull request that closes an issue, as GitHub's closedByPullRequestsReferences reports it. */
export interface LinkedPr {
  number: number;
  url: string;
  /** "OPEN", "MERGED" or "CLOSED". */
  state: string;
  headRefName: string;
  isCrossRepository: boolean;
  repository: { nameWithOwner: string };
}

/**
 * PRs that close an issue: a closing keyword ("Fixes #12") or a link in the issue's Development
 * sidebar. Without includeClosedPrs GitHub leaves out closed PRs but still returns merged ones, so
 * callers filter on state.
 */
export const LINKED_PRS_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { " +
  "closedByPullRequestsReferences(first: 50) { nodes { number url state headRefName isCrossRepository repository { nameWithOwner } } } } } }";

/**
 * Open PRs that would close the issue from a branch other than the run's own, so a run does not
 * open a second PR for an issue that already has one. The run's own PR (`branch` in `repo`, not
 * from a fork) is left out: --start-at review updates it.
 */
export async function findCompetingPrs(exec: Exec, repo: string, issue: number, branch: string): Promise<LinkedPr[]> {
  const [owner, name] = repo.split("/");
  const out = await run(exec, "gh", [
    "api", "graphql",
    "-f", `query=${LINKED_PRS_QUERY}`,
    "-f", `owner=${owner}`,
    "-f", `name=${name}`,
    "-F", `number=${issue}`,
  ]);
  const nodes = (JSON.parse(out) as { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: LinkedPr[] } } } } })
    .data.repository.issue.closedByPullRequestsReferences.nodes;
  const own = (pr: LinkedPr) =>
    pr.repository.nameWithOwner.toLowerCase() === repo.toLowerCase() && !pr.isCrossRepository && pr.headRefName === branch;
  return nodes.filter((pr) => pr.state === "OPEN" && !own(pr));
}

/** A dry run or --ignore-open-pr warns about competing PRs; a real launch without the flag refuses. */
export function competingPrCheck(
  repo: string,
  issue: number,
  prs: LinkedPr[],
  options: Pick<CommandOptions, "dryRun" | "ignoreOpenPr">,
): { errors: string[]; warnings: string[] } {
  if (!prs.length) return { errors: [], warnings: [] };
  const list = prs.map((pr) => `${pr.url} (branch ${pr.headRefName}${pr.isCrossRepository ? " on a fork" : ""})`).join(", ");
  const head = `${repo}#${issue} already has an open PR from another branch: ${list}.`;
  if (options.ignoreOpenPr) return { errors: [], warnings: [`${head} --ignore-open-pr: launching anyway, so the issue will have a second PR.`] };
  if (options.dryRun) return { errors: [], warnings: [`${head} A real launch refuses unless you pass --ignore-open-pr.`] };
  return { errors: [`${head} A run would open a second, competing PR. Close or merge that PR first, or pass --ignore-open-pr to launch anyway.`], warnings: [] };
}
```

Notes for the implementer:

- `exec` receives an argument array with no shell (`pi.exec`, the test fakes), so the query's
  spaces, `$` and braces need no quoting. Keep the query one string, as above.
- `repo` is already `owner/name`: from `config.repo` or `repoFromRemote`, and `gh issue view -R`
  accepted it.
- `{ errors, warnings }` is the same shape `labelProblems` returns. `ignoreOpenPr` wins over
  `dryRun`: `--dry-run --ignore-open-pr` previews what the real launch with the flag would say.

#### `prepare`

The check runs after `planLaunch`, which decides the branch, and before `prepare` returns, so
`ensureWorktree` never runs for a refused launch. Replace the end of `prepare`:

```ts
  const engine = await engineCommit(exec, PACKAGE_ROOT);
  const plan = planLaunch({ file: config, repoRoot, repo, issue, options, existingBranch, engine, configSource: loaded.source });
  plan.warnings = [...fetchWarning, ...loaded.warnings, ...plan.warnings, ...labelCheck.warnings];
  return plan;
```

with:

```ts
  const engine = await engineCommit(exec, PACKAGE_ROOT);
  const plan = planLaunch({ file: config, repoRoot, repo, issue, options, existingBranch, engine, configSource: loaded.source });
  const prCheck = competingPrCheck(repo, issue.number, await findCompetingPrs(exec, repo, issue.number, plan.branch), options);
  if (prCheck.errors.length) throw new Error(prCheck.errors.join("\n"));
  plan.warnings = [...fetchWarning, ...loaded.warnings, ...plan.warnings, ...labelCheck.warnings, ...prCheck.warnings];
  return plan;
```

`Plan` and `planLaunch` do not change. `ignoreOpenPr` is not passed to the workflow.

#### Header comment

Line 4 becomes:

```ts
//   prepare       fetches origin; reads .pi/crucible.json from origin/main, the issue, its branch, competing PRs and the engine commit; plans the launch
```

### `extensions/crucible.ts`

- The completions list becomes
  `["--start-at implement", "--start-at review", "--lens ", "--ignore-open-pr", "--dry-run"]`.
- The `crucible` command's description becomes:
  `"Run an issue through pi-crucible: /crucible <issue> [--start-at implement|review] [--lens <name>] [--ignore-open-pr] [--dry-run] | /crucible init [--write] [--dry-run]"`.
- `runCommand` itself does not change. A refusal is an error thrown by `prepare`, so it is shown as
  `/crucible: <message>` at level `error`. Nothing is created and no RPC is sent. Warnings,
  including the dry-run and `--ignore-open-pr` ones, are already shown as `warning` notices before
  the dry-run notice or the launch. `/factory` shares `runCommand` and gets the same behaviour.

What the operator sees for the bioc-registry case (`/crucible 68`, #74 open):

```text
/crucible: seandavi/bioc-registry#68 already has an open PR from another branch: https://github.com/seandavi/bioc-registry/pull/74 (branch seed-replace-same-version). A run would open a second, competing PR. Close or merge that PR first, or pass --ignore-open-pr to launch anyway.
```

### `workflows/crucible.js`, `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json`

No change. No stage, prompt, output schema, arg or config field changes, and `RESOURCE_VERSION`
stays as it is. The PR's crucible record is unchanged. It does not say whether
`--ignore-open-pr` was used (see Non-goals).

### Docs

**`docs/crucible.md`**

- "Running it", the command block: add a line after the `--lens security` line:

  ```text
  /crucible 12 --ignore-open-pr      # launch even though another branch has an open PR for #12
  ```

- "Running it": after the paragraph that starts "The slug comes from the issue's title only for a
  new branch." (and ends with "…for the lenses it defines (a warning if not)."), add a paragraph:

  ```markdown
  Before it launches, `/crucible` asks GitHub which open PRs would close the issue (a closing
  keyword such as `Fixes #12`, or a link in the issue's Development sidebar). An open PR from any
  branch other than the run's own means the run would open a second, competing PR. `--dry-run`
  warns and lists them. A real launch refuses, before it creates a worktree, unless you pass
  `--ignore-open-pr`, which launches with a warning. The run's own PR, from its `issue-<n>-<slug>`
  branch, never counts, so `--start-at review` still updates it. PRs that only mention the issue
  are not checked.
  ```

- "Stops" is about the workflow's stops, which flag `needs:human`. This refusal happens before any
  run starts and flags nothing, so "Stops" does not change.

**`README.md`**: no change. Its Quick start and "Configure a repository" do not list every flag,
and docs/crucible.md is linked from both.

**`docs/figures/make_figures.py`**: no change. The figure shows the workflow's stages and stops.
The `/crucible <issue>` box already has four lines in a 175-px box, and a launcher-side
precondition is not a stage, stop rule, model or lens (AGENTS.md's trigger for regenerating it).

`CONTRIBUTING.md` and `AGENTS.md` do not change.

## Acceptance criteria

- [ ] `parseCommand("12")` returns
      `{ issue: 12, startAt: "spec", lenses: [], ignoreOpenPr: false, dryRun: false }`;
      `parseCommand("12 --ignore-open-pr --dry-run")` returns `ignoreOpenPr: true, dryRun: true`.
- [ ] `USAGE` and the `crucible` command description list `[--ignore-open-pr]`, and the
      completions for `--i` offer `--ignore-open-pr`.
- [ ] `findCompetingPrs` runs exactly
      `gh api graphql -f query=<LINKED_PRS_QUERY> -f owner=<owner> -f name=<name> -F number=<n>`.
- [ ] `findCompetingPrs` returns only `OPEN` PRs. `MERGED` and `CLOSED` nodes are dropped.
- [ ] It leaves out the PR whose `headRefName` is the planned branch, in the same repository
      (case-insensitive) and not cross-repository. It keeps a PR with that branch name from a fork,
      or from another repository.
- [ ] `competingPrCheck` with no PRs returns `{ errors: [], warnings: [] }`.
- [ ] With PRs and neither flag, `competingPrCheck` returns one error:
      `<repo>#<n> already has an open PR from another branch: <url> (branch <head>). A run would open a second, competing PR. Close or merge that PR first, or pass --ignore-open-pr to launch anyway.`
      Several PRs are joined with `, `, and a fork's PR reads `(branch <head> on a fork)`.
- [ ] With `dryRun` only, it returns one warning ending
      `A real launch refuses unless you pass --ignore-open-pr.`. With `ignoreOpenPr` (with or
      without `dryRun`), one warning ending
      `--ignore-open-pr: launching anyway, so the issue will have a second PR.`.
- [ ] `prepare` rejects with the error text when there is a competing PR and neither flag is set,
      at every `startAt`. With `--dry-run` or `--ignore-open-pr`, it returns a plan whose last
      warning is the check's warning.
- [ ] `prepare` runs the query after the branch is known (the `-F number=<n>` call follows
      `git for-each-ref` in the call order), and it is not a failure when the only open PR is the
      run's own.
- [ ] A failing `gh api graphql` call makes `prepare` reject with
      `gh api graphql … failed: <stderr>` (the existing `run` behaviour).
- [ ] Through the extension: a real `/crucible 4` with a competing PR shows one `error` notice
      starting `/crucible: seandavi/pi-crucible#4 already has an open PR from another branch:`,
      runs no `git worktree add` and emits no `subagents:rpc:v1:request`. `/crucible 4 --dry-run`
      shows the warning and then the dry-run notice. `/crucible 4 --ignore-open-pr` launches.
- [ ] `workflows/crucible.js`, `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json`
      and `docs/figures/` are unchanged (`git diff origin/main --stat` lists none of them).
- [ ] `docs/crucible.md` is updated as in Design.
- [ ] `npm test` and `npm run check` pass.

## Test plan

All in `test/launcher.test.ts`, with the existing `scripted` exec and `fakePi`. Unmatched commands
fail loudly in `scripted`, so the new gh call needs a rule. No test calls the network or gh.

Add a helper near `MAIN_SHA`:

```ts
const linkedPrs = (...nodes: Partial<LinkedPr>[]) =>
  JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: nodes.map((n) => ({
    number: 74, url: "https://github.com/seandavi/pi-crucible/pull/74", state: "OPEN", headRefName: "seed-replace",
    isCrossRepository: false, repository: { nameWithOwner: "seandavi/pi-crucible" }, ...n,
  })) } } } } });
```

(import `type LinkedPr`, `competingPrCheck`, `findCompetingPrs` and `LINKED_PRS_QUERY` from
`../src/launcher.ts`).

1. **`repoRules` default.** Add `[/^gh api graphql /, { stdout: linkedPrs() }]` (no nodes), so
   every existing `prepare` test sees no linked PRs. `extra` rules come first, so a test's own
   `gh api graphql` rule overrides it.
2. **`options` and `parseCommand`.** Add `ignoreOpenPr: false` to the shared `options` constant and
   to the two `parseCommand` expectations. Add an assertion that
   `parseCommand("12 --ignore-open-pr --dry-run")` has `ignoreOpenPr: true` and `dryRun: true`.
   Update the `USAGE` literal in "/crucible prepares the worktree…" (the `""` handler case).
3. **New test: "findCompetingPrs keeps open PRs from other branches and drops the run's own".**
   One `scripted` rule answers `gh api graphql` with nodes: #74 `OPEN` on `seed-replace`; #75
   `MERGED` on `other`; #76 `CLOSED` on `other2`; #77 `OPEN` on `issue-4-x` (the run's own); #78
   `OPEN` on `issue-4-x` with `isCrossRepository: true`; #79 `OPEN` on `issue-4-x` with
   `repository: { nameWithOwner: "someone/else" }`; #80 `OPEN` on `issue-4-x` with
   `repository: { nameWithOwner: "SeanDavi/Pi-Crucible" }`. Call
   `findCompetingPrs(s.exec, "seandavi/pi-crucible", 4, "issue-4-x")` and assert the numbers are
   `[74, 78, 79]`. Assert the single call's args equal
   `["api", "graphql", "-f", \`query=${LINKED_PRS_QUERY}\`, "-f", "owner=seandavi", "-f", "name=pi-crucible", "-F", "number=4"]`.
4. **New test: "competingPrCheck refuses a real launch and warns otherwise".** With a fork PR and a
   plain PR, assert the exact error string from the acceptance criteria (two items joined by `, `,
   the fork's ending ` on a fork)`). Assert `{ errors: [], warnings: [] }` for no PRs, the dry-run
   warning, and the `--ignore-open-pr` warning for both `{ ignoreOpenPr: true, dryRun: false }` and
   `{ ignoreOpenPr: true, dryRun: true }`.
5. **New test: "prepare stops for an open PR from another branch unless asked not to".**
   - `extra` rule `[/^gh api graphql /, { stdout: linkedPrs({}) }]` (#74 on `seed-replace`). With
     the default `options`, assert a rejection matching
     `/seandavi\/pi-crucible#4 already has an open PR from another branch: https:\/\/github\.com\/seandavi\/pi-crucible\/pull\/74 \(branch seed-replace\)\. A run would open a second, competing PR/`.
     Repeat with `startAt: "review"` and a `for-each-ref` rule giving `refs/heads/issue-4-by-hand`
     (as in the existing branch test). It still rejects.
   - Same rule with `{ ...options, dryRun: true }`: resolves, and `plan.warnings.at(-1)` ends with
     `A real launch refuses unless you pass --ignore-open-pr.`.
   - Same rule with `{ ...options, ignoreOpenPr: true }`: resolves, and `plan.warnings.at(-1)` ends
     with `--ignore-open-pr: launching anyway, so the issue will have a second PR.`.
   - The run's own PR only: `linkedPrs({ headRefName: "issue-4-reviewers-always-get-the-diff" })`
     with the default options resolves, with no warning containing `open PR`.
   - Call order: in a resolving run, the index of the line starting `gh api graphql` in `s.lines()`
     is greater than the index of the line starting `git for-each-ref`.
   - `extra` rule `[/^gh api graphql /, { code: 1, stderr: "HTTP 401" }]`: rejects with
     `/gh api graphql .* failed: HTTP 401/`.
6. **Update "/crucible prepares the worktree and launches the named resource over RPC".** In its
   `fakePi` exec, add before the final `return {}`:
   `if (line.startsWith("gh api graphql")) return { stdout: linkedPrs() };`, so the existing real
   and dry-run launches see no linked PRs and keep their notice levels.
7. **New test: "/crucible refuses a launch that would compete with an open PR".** Build the
   extension as in test 6, with `gh api graphql` answered by
   `linkedPrs({ url: "https://github.com/seandavi/pi-crucible/pull/74" })`. Then:
   - `handler("4", ctx)`: notices are exactly one `["error", …]` whose text starts with
     `/crucible: seandavi/pi-crucible#4 already has an open PR from another branch:`. No exec call
     starts `git worktree add`, and no `subagents:rpc:v1:request` was emitted.
   - `handler("4 --dry-run", ctx)`: the levels are `["warning", "info"]`, and the warning ends with
     `A real launch refuses unless you pass --ignore-open-pr.`.
   - `handler("4 --ignore-open-pr", ctx)`: the levels are `["warning", "info", "info"]`, and one
     `subagents:rpc:v1:request` was emitted.

   Answer the RPC request as test 6 does. Use a fresh temp repo, so the worktree path does not
   exist yet.

Then run `npm test` and `npm run check`. `subagent({ action: "validate", … })` and
`python3 docs/figures/make_figures.py` are not needed, because neither `workflows/crucible.js` nor
the figure changes.

## Risks

- **False negatives.** A competing PR that neither uses a closing keyword nor is linked in the
  Development sidebar (for example "Part of #68") is not found, and the run launches as it does
  today. This is the trade for no false positives from a text search (see Non-goals).
- **False positives from a stale link.** A PR that is open but abandoned still blocks. That is the
  intended behaviour: close it, or pass `--ignore-open-pr`.
- **More than 50 PRs linked to one issue.** Only the first 50 are read. In practice an issue has
  a few, so the spec does not page.
- **One more GitHub call per launch.** `prepare` already needs gh for `gh issue view` and
  `gh label list`. A failure of the new call stops the launch with gh's message, as theirs do.
  `--ignore-open-pr` does not skip the query, so an operator cannot bypass a broken query with it.
  That is deliberate: the flag means "I know about the PR", not "don't check".
- **GitHub's merged-PR behaviour could change.** The code filters on `state === "OPEN"` instead of
  relying on `includeClosedPrs`, so a change in what GitHub returns by default cannot let merged
  or closed PRs block a launch.
- **Every consuming repository is affected** on its next `pi update --extensions`. A repository
  whose issues have open PRs from hand-made branches now gets a refusal where it used to get a
  duplicate PR. The message names the PR and the flag.
