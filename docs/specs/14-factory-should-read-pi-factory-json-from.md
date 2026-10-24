# Spec for #14: /factory reads .pi/factory.json from origin/main

Issue: [seandavi/pi-factory#14](https://github.com/seandavi/pi-factory/issues/14) (label `seam`),
under the tracking issue #1. Found while setting up monode (seandavi/monode#70).

## Goal

`prepare` (`src/launcher.ts`) reads `.pi/factory.json` from the main checkout's working tree
(`<git common dir>/../.pi/factory.json`). That checkout is often on a feature branch with
uncommitted work. On onclappc02, monode's main checkout is on `infra/clickhouse-system-log-ttl`, so
after monode#70 merges, `/factory` there still finds no config, or a stale one.

After this change:

1. `prepare` fetches `origin` first, then reads the config as `origin/main` has it
   (`git cat-file blob <origin/main commit>:.pi/factory.json`). The config that drives a run is
   then the one reviewed on main, whatever branch the main checkout is on and whatever it has
   uncommitted.
2. It falls back to the main checkout's working tree only when `origin/main` has no
   `.pi/factory.json`, which is the case while a repository's first config PR is open, or when
   there is no `origin/main` ref at all. A fallback is always a warning.
3. When `origin/main` has the config and the main checkout's working-tree copy differs from it,
   `/factory` warns that the run uses main's copy. Otherwise an operator who edited the file
   locally would not know why nothing changed.
4. `/factory --dry-run` says which config it used: `origin/main:.pi/factory.json (<short sha>)`, or
   `<repoRoot>/.pi/factory.json (working tree)`.

## Non-goals

- **Detecting the default branch.** The issue proposes `origin/<default branch>`, but its title
  says `origin/main`, and the engine assumes `main` everywhere else: new branches start from
  `origin/main` (`ensureWorktree`), the diff and integration stages use `origin/main`, and the PR
  stage uses `gh pr create --base main`. Reading the config from another branch would make it the
  only exception. Supporting repositories whose default branch is not `main` is a separate,
  engine-wide change.
- **Recording the config's source in the PR's factory record.** The issue asks only for the
  dry-run output. No arg is added, `workflows/factory.js` does not change, and the PR record still
  ends with `Engine: …`. A `config` provenance line in the record would need a new arg (and a
  `src/resource.ts` change). It can be filed as a follow-up if wanted.
- **Reading the config from the issue branch or the worktree `/factory` runs in.** The issue asks
  for main's reviewed copy, not the branch under work.
- **The second `git fetch origin` in `ensureWorktree`** (follow-up ux-r1-3 in #12) and
  `--prune` (code-r1-2 in #12). Both stay as they are.
- Changing where worktrees go. `worktreeRoot` is still resolved against the main checkout
  (`repoRoot`), which is unchanged.
- Changing the config's fields, the schema or the args.

## Design

### `src/launcher.ts`

#### New: `readFactoryFile`

Add after `engineCommit` and before `PACKAGE_ROOT`:

```ts
export interface LoadedConfig {
  /** The parsed JSON, not yet validated. */
  file: unknown;
  /** Where it came from, for messages: "origin/main:.pi/factory.json (abc1234)" or "<path> (working tree)". */
  source: string;
  warnings: string[];
}

/**
 * The repository's .pi/factory.json as origin/main has it, so a run uses the config reviewed on main
 * rather than whatever the main checkout has checked out. Falls back to the main checkout's working
 * tree only when origin/main has no such file (a repository's first config PR) or there is no
 * origin/main. Call it after fetching origin.
 */
export async function readFactoryFile(
  exec: Exec,
  repoRoot: string,
  readText: (p: string) => Promise<string>,
): Promise<LoadedConfig> {
  const configPath = path.join(repoRoot, ".pi", "factory.json");
  const local = await readText(configPath).catch((e: Error) => e);
  const parse = (text: string, source: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`cannot parse ${source}: ${(e as Error).message}`);
    }
  };
  const main = await exec("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: repoRoot });
  const commit = main.code === 0 ? main.stdout.trim() : "";
  const onMain = commit !== "" && (await exec("git", ["cat-file", "-e", `${commit}:.pi/factory.json`], { cwd: repoRoot })).code === 0;
  if (onMain) {
    const source = `origin/main:.pi/factory.json (${commit.slice(0, 7)})`;
    const text = await run(exec, "git", ["cat-file", "blob", `${commit}:.pi/factory.json`], repoRoot);
    const warnings =
      typeof local === "string" && local.trim() !== text
        ? [`${configPath} differs from ${source}; this run uses origin/main's. Merge the change to main to use it.`]
        : [];
    return { file: parse(text, source), source, warnings };
  }
  const why = commit ? "origin/main has no .pi/factory.json" : "there is no origin/main";
  if (typeof local !== "string") throw new Error(`no config to read: ${why}, and reading ${configPath} failed (${local.message})`);
  const source = `${configPath} (working tree)`;
  return {
    file: parse(local, source),
    source,
    warnings: [`${why}; using ${source}, which has not been reviewed on main. Merge it to main.`],
  };
}
```

Notes for the implementer:

- `run` already trims stdout, so `text` is trimmed; compare it with `local.trim()`. A difference
  in whitespace alone still warns. That is accurate ("differs") and costs nothing.
- `git cat-file blob`, not `git show`: plumbing that prints the committed bytes exactly, with no
  textconv or pager. Pin the read to the commit `rev-parse` returned, so the sha in `source` is the
  one read.
- `exec`, not `run`, for the two probes. A non-zero exit there is an answer, not an error.
- Git behaviour verified 2026-10-24 with git 2.55.0 in a scratch clone:
  `git rev-parse --verify --quiet refs/remotes/origin/main` prints the sha with exit 0, and for a
  missing ref prints nothing with exit 1. `git cat-file -e <sha>:.pi/factory.json` exits 0 when the
  path exists and 128 (`fatal: path '.pi/factory.json' does not exist in '<sha>'`) when it does
  not. `git cat-file blob <sha>:.pi/factory.json` prints the committed contents while the checkout
  is on another branch with a modified copy.

#### `prepare`

The new order is: common dir → `repoRoot` → **fetch** → **read config** → validate → repo → issue →
labels → worktree and branch → engine. The fetch moves up from its current place after the label
check, because the config read needs a fresh `origin/main`. It still runs once, and a failure is
still only a warning: offline, `origin/main` is the local remote-tracking ref.

Replace the block from `const configPath = …` through `const config = file as FactoryFile;` and
the later fetch block with:

```ts
  // origin/main is only current after a fetch; offline, the local refs still answer.
  const fetchWarning: string[] = [];
  await run(exec, "git", ["fetch", "origin"], repoRoot).catch((e: Error) =>
    fetchWarning.push(`could not fetch origin (${e.message}); the config and the branch lookup used local refs`),
  );
  const loaded = await readFactoryFile(exec, repoRoot, readText);
  const problems = factoryFileErrors(loaded.file);
  if (problems.length) throw new Error(`${loaded.source} is invalid:\n- ${problems.join("\n- ")}`);
  const config = loaded.file as FactoryFile;
```

The rest of `prepare` keeps its logic, minus the old fetch block (the `// Remote branches are only
known after a fetch…` comment and its two lines). The end becomes:

```ts
  const engine = await engineCommit(exec, PACKAGE_ROOT);
  const plan = planLaunch({ file: config, repoRoot, repo, issue, options, existingBranch, engine, configSource: loaded.source });
  plan.warnings = [...fetchWarning, ...loaded.warnings, ...plan.warnings, ...labelCheck.warnings];
  return plan;
```

The `readText` parameter and its default (`readFile(p, "utf8")`) stay. They now read only the
working-tree copy, for the fallback and the difference warning.

#### `Plan` and `planLaunch`

- `Plan` gets a required field `configSource: string`, after `startAt`. It is `LoadedConfig.source`.
- `planLaunch`'s input gets a required `configSource: string`, which is copied into the returned
  plan (`return { repoRoot, worktree, branch, startAt, configSource: input.configSource, args, warnings }`).
  It does not affect `args`.

#### Header comment

Line 4 becomes:

```ts
//   prepare       fetches origin; reads .pi/factory.json from origin/main, the issue, its branch and the engine commit; plans the launch
```

### `extensions/factory.ts`

The dry-run notice names the config's source. Its first line changes from
`` `Dry run: would prepare ${plan.worktree} on ${plan.branch} and launch "${RESOURCE_NAME}" with\n` ``
to:

```ts
`Dry run: would prepare ${plan.worktree} on ${plan.branch} and launch "${RESOURCE_NAME}"\n` +
  `Config: ${plan.configSource}\n` +
  `Args:\n` +
  JSON.stringify(plan.args, null, 2),
```

Nothing else in the extension changes. Warnings, including a fallback or a difference, are already
shown as `warning` notices in both a dry run and a real run, before the launch. The launch notice is
unchanged. `getArgumentCompletions` is untouched.

### `workflows/factory.js`, `src/resource.ts`, `src/config.ts`, `schema/factory.schema.json`

No change. No stage, prompt, output schema, arg or config field changes, and `RESOURCE_VERSION`
stays `1`. The PR's factory record is unchanged: it still ends with
`Engine: seandavi/pi-factory@<sha>`, and it does not show the config's source (see Non-goals).

### Docs

**`docs/factory.md`**

- "Running it": replace the sentence start
  "`/factory` reads `.pi/factory.json` from the main checkout and validates it; reads the issue"
  with:

  ```markdown
  `/factory` fetches `origin` and reads `.pi/factory.json` as `origin/main` has it, so the config
  that drives a run is the one reviewed on main, whatever branch the main checkout is on or has
  uncommitted. Only when `origin/main` has no config yet (while a repository's first config PR is
  open) does it read the main checkout's working tree instead, with a warning. It also warns when
  the working tree's copy differs from main's, and `--dry-run` says which copy it used. It
  validates the config; reads the issue
  ```

  (the rest of that sentence, "(it must be open) for its title and labels; …", is unchanged).
- "Configuring a repository": after the first sentence ("Each repository … `.pi/factory.json`."),
  add: "Merge the config to `main`: `/factory` reads it from `origin/main` (see
  [Running it](#running-it))."
- "Provenance" paragraph: add a second sentence: "The config is read from `origin/main`, so the
  run's config is the one at that commit (`--dry-run` shows it), unless `/factory` warned that it
  fell back to the working tree."

**`README.md`**, "Set up a repository": after the sentence ending
"The fields are in [docs/factory.md](docs/factory.md#configuring-a-repository).", add:

```markdown
Merge both to `main`: `/factory` reads `.pi/factory.json` from `origin/main`, and uses the working
tree's copy (with a warning) only until main has one.
```

**`docs/figures/make_figures.py`**: in the `/factory <issue>` box, the first line
`".pi/factory.json"` becomes `".pi/factory.json @ main"`. Regenerate with
`python3 docs/figures/make_figures.py` and commit both SVGs. Check that the line fits inside the
240-px box: it is 23 characters at 15 px, shorter than other lines already in the figure.

`CONTRIBUTING.md` and `AGENTS.md` do not change.

## Acceptance criteria

- [ ] `prepare` runs `git fetch origin` before any config read, and only once. The order of
      `s.lines()` in a scripted test shows `git fetch origin` before
      `git rev-parse --verify --quiet refs/remotes/origin/main`.
- [ ] With `origin/main` carrying `.pi/factory.json`, `prepare` uses that content even when the
      working-tree copy differs or is missing. `plan.configSource` is
      `origin/main:.pi/factory.json (<first 7 of the sha>)`.
- [ ] When the working-tree copy differs from origin/main's, `plan.warnings` contains
      `<repoRoot>/.pi/factory.json differs from origin/main:.pi/factory.json (<sha7>); this run uses origin/main's. Merge the change to main to use it.`
      When they are equal, or the working tree has no copy, there is no such warning.
- [ ] When `origin/main` exists but has no `.pi/factory.json`, the working-tree copy is used.
      `plan.configSource` is `<repoRoot>/.pi/factory.json (working tree)`, and `plan.warnings`
      contains `origin/main has no .pi/factory.json; using <repoRoot>/.pi/factory.json (working tree), which has not been reviewed on main. Merge it to main.`
- [ ] When there is no `refs/remotes/origin/main`, the same fallback happens, with the warning
      starting `there is no origin/main; using`.
- [ ] With neither copy, `prepare` rejects with
      `no config to read: origin/main has no .pi/factory.json, and reading <path> failed (<message>)`.
- [ ] An invalid config on origin/main rejects with
      `origin/main:.pi/factory.json (<sha7>) is invalid:\n- …`. Unparseable JSON rejects with
      `cannot parse origin/main:.pi/factory.json (<sha7>): …`. The working-tree equivalents name
      `<path> (working tree)`.
- [ ] A failed fetch still does not stop `prepare`. Its warning reads
      `could not fetch origin (…); the config and the branch lookup used local refs` and comes
      first in `plan.warnings`.
- [ ] `/factory 4 --dry-run` prints a notice whose second line is `Config: <source>`.
- [ ] `workflows/factory.js`, `src/resource.ts`, `src/config.ts` and `schema/factory.schema.json`
      are unchanged (`git diff origin/main --stat` lists none of them).
- [ ] `docs/factory.md`, `README.md` and the figure (script and both SVGs) are updated as in
      Design.
- [ ] `npm test` and `npm run check` pass.

## Test plan

All in `test/launcher.test.ts`, using the existing `scripted` exec. Unmatched commands fail
loudly, so every new git call needs a rule.

1. **`repoRules` default.** Add rules so that by default `origin/main` has the config:
   - `[/^git rev-parse --verify --quiet refs\/remotes\/origin\/main$/, { stdout: MAIN_SHA + "\n" }]`
     with `const MAIN_SHA = "fedcba9876543210fedcba9876543210fedcba98"`;
   - `[/^git cat-file -e fedcba9.*:\.pi\/factory\.json$/, {}]`;
   - `[/^git cat-file blob fedcba9.*:\.pi\/factory\.json$/, { stdout: JSON.stringify(factoryFile) }]`.

   Existing tests that pass a `read` callback keep working. The callback now supplies only the
   working-tree copy. In "prepare reads config, issue and engine commit…", keep the path
   assertion inside `read` (it is still called with `/src/pi-factory/.pi/factory.json`), and add
   `assert.equal(plan.configSource, "origin/main:.pi/factory.json (fedcba9)")`.
2. **Update "prepare refuses invalid config and closed issues…".**
   - Invalid config: serve the bad JSON from the `cat-file blob` rule (as an `extra` rule) and
     assert `/origin\/main:\.pi\/factory\.json \(fedcba9\) is invalid:\n- \(root\): unknown field\(s\) typo/`.
   - Missing everywhere: an `extra` rule `[/^git cat-file -e /, { code: 128 }]` and a `read`
     callback that throws `ENOENT`. Assert
     `/no config to read: origin\/main has no \.pi\/factory\.json, and reading \/src\/pi-factory\/\.pi\/factory\.json failed \(ENOENT\)/`.
   - Closed issue: unchanged.
3. **New test: "the config comes from origin/main, not the main checkout's working tree".**
   - `read` returns a different but valid config (e.g. `{ ...factoryFile, parent: 99 }`). Assert
     that `plan.args.parent` is `1` (main's), that `configSource` is as above, and that the warnings
     include the "differs from" text.
   - `read` returns `JSON.stringify(factoryFile)`. Assert there is no "differs" warning.
   - `read` throws. Assert main's config is used and there is no warning about the working tree.
   - Assert that `s.lines().indexOf("git fetch origin")` is less than the index of
     `git rev-parse --verify --quiet refs/remotes/origin/main`, and that `git fetch origin`
     appears exactly once in `s.lines()`.
4. **New test: "the working tree is the fallback, with a warning, until origin/main has a config".**
   - An `extra` rule `[/^git cat-file -e /, { code: 128 }]`, with `read` returning the valid config.
     Assert `configSource` is `/src/pi-factory/.pi/factory.json (working tree)` and the warning text
     from the acceptance criteria. Assert that no `git cat-file blob` call was made.
   - An `extra` rule `[/^git rev-parse --verify --quiet refs\/remotes\/origin\/main$/, { code: 1 }]`.
     Assert the warning starts with `there is no origin/main; using`, and that no `git cat-file`
     call was made.
   - Fallback with unparseable text (`read` returns `"{"`). Assert a rejection matching
     `/cannot parse \/src\/pi-factory\/\.pi\/factory\.json \(working tree\): /`.
5. **Update "a failed fetch is a warning, not a stop".** Assert
   `/could not fetch origin .*offline.*the config and the branch lookup used local refs/`, and that
   `plan.warnings[0]` is that warning.
6. **Update the `planLaunch` calls** ("planLaunch builds args the resource accepts") to pass
   `configSource: "test"`, and the `plan()` helper to include `configSource: "test"`.
7. **Update "/factory prepares the worktree and launches the named resource over RPC".** In the
   `fakePi` exec, before the generic `--verify --quiet` → `code: 1` line, answer:
   - `line.includes("refs/remotes/origin/main")` → `{ stdout: "0123456789abcdef0123456789abcdef01234567" }`;
   - `line.startsWith("git cat-file -e")` → `{}`;
   - `line.startsWith("git cat-file blob")` → `{ stdout: JSON.stringify(factoryFile) }`.

   The file the test writes to the temp repo equals main's, so the notice levels stay
   `["info", "info"]`. In the dry-run part, also assert `notes[0][1]` matches
   `/\nConfig: origin\/main:\.pi\/factory\.json \(0123456\)\n/`.

Then run `npm test`, `npm run check` and `python3 docs/figures/make_figures.py`. The figure step
must leave the SVGs consistent with the script: commit them, and `git status` is clean afterwards.
`subagent({ action: "validate", … })` is not needed, because `workflows/factory.js` does not change.

## Risks

- **A merged config is needed for config changes to take effect.** Once main has a config, local
  edits to it are ignored, with a warning. This is the intended behaviour; trying a config change
  means merging it first. The difference warning and the dry-run line make this visible.
- **Stale origin/main offline.** If the fetch fails, the config is read from the local
  `origin/main`, which may be behind. The fetch warning now says the config used local refs.
- **Fallback hides a mistake.** If someone deletes `.pi/factory.json` on main, `/factory` falls
  back to whatever the working tree has. Every launch then warns, which is the signal, and the
  operator still sees the warning before the run is spawned. Refusing to launch would block the
  first-config-PR case the issue wants to keep working.
- **`main` is assumed.** A repository whose default branch is not `main` always falls back
  ("there is no origin/main"). It already could not create new branches (`ensureWorktree` uses
  `origin/main`), so this adds no new failure. See Non-goals.
- **Every consuming repository is affected** on its next `pi update --extensions`. Repos whose
  config is already on main (bioc-mcp, bioc-support-archive, this repo) see no difference except
  the dry-run line and a possible "differs" warning. A repo with an unmerged config gets the
  fallback warning on each launch until it merges.
