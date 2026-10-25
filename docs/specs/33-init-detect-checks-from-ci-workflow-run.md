# Spec for #33: `/crucible init` detects checks from CI workflow `run:` steps

Issue: [seandavi/pi-crucible#33](https://github.com/seandavi/pi-crucible/issues/33), part of #26
(check detection), under the tracking issue #1.

## Goal

On bioc-registry, `/crucible init` detected only `test = npm test`. Its CI
(`.github/workflows/test.yml`) also gates on a typecheck written for that repository:
`npx tsc -p . --noEmit 2>&1 | grep -E '^src/' && exit 1 || exit 0`. The obvious guess,
`npx tsc --noEmit`, fails on main because of existing `@cloudflare/workers-types` errors, so a guessed
`typecheck` check would have turned every PR into a draft. CI already says what "green" means for a
repository.

After this change:

1. `/crucible init` reads every `.github/workflows/*.yml` and `*.yaml` file in the main checkout,
   keeps the workflows that run on `pull_request`, and offers their `run:` steps as checks,
   verbatim apart from the normalisation rules below.
2. Setup steps are dropped: every `uses:` step (`actions/checkout`, `actions/setup-node`, …) and
   every `run:` step or line that only installs things (`npm ci`, `pip install …`, `uv sync`, …).
3. Steps that cannot run outside GitHub Actions (they use `${{ }}` expressions, write
   `$GITHUB_ENV`-style files, or run in a non-POSIX shell) are left out, and `init` says which ones
   it left out and why.
4. The existing detection (`package.json` scripts, `justfile`, `pyproject.toml`, `Makefile`) runs
   only when the pull-request workflows yield no check at all, and `init` says it fell back.

For this repository, `init` would detect `test = npm test` and `check = npm run check` from
`.github/workflows/ci.yml`, the two checks `.pi/crucible.json` has today.

## Non-goals

- **Run-time detection by `/crucible`** (a repository with no `checks` in any config layer). That
  is #26's launcher work and depends on #24's layered config. This issue changes only what
  `/crucible init` offers. `checksFromWorkflows` is written so #26 can call it, but nothing calls
  it from `prepare`.
- **Merging CI checks with `package.json` checks.** The issue calls `package.json` a fallback; it is
  used only when CI yields nothing. Merging would offer CI's `npm test` step and `package.json`'s
  `test` script as two checks for the same thing.
- **Following reusable workflows** (a job with `uses: ./.github/workflows/x.yml` or
  `owner/repo/.github/workflows/x.yml@ref`) and **composite actions**. Such jobs are reported as
  not followed.
- **Turning `uses:` actions that are checks into commands** (`astral-sh/ruff-action`,
  `golangci/golangci-lint-action`). They are dropped like every other `uses:` step.
- **Carrying step, job or workflow `env:` values into the command.** A literal `env:` is ignored; an
  `env:` value with `${{` drops the step (rule 3).
- **Triggers other than `pull_request`**: `push`-only, `pull_request_target`, `merge_group` and
  `workflow_dispatch` workflows are ignored.
- **The workflow script, args, config schema, PR record and figure.** `workflows/crucible.js`,
  `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json` and
  `docs/figures/make_figures.py` do not change. A run's checks still come from `.pi/crucible.json`,
  which the operator reviews and merges after `init`. Nothing new appears in the PR's crucible
  record.
- **Re-detecting for a repository that already has a config.** `init` still leaves an existing
  config alone and detects nothing (current behaviour).

## Design

### Dependency: `yaml`

Add `yaml` to `dependencies` in `package.json` with the range `^2.8.3`:

```sh
npm install --save yaml@^2.8.3
```

Commit the resulting `package.json` and `package-lock.json`.

Why this library (verified 2026-10-24):

- `npm view yaml`: latest 2.9.1, no dependencies, `engines: { node: ">= 14.6" }`, ISC licence.
- It is already installed: `pi-subagents` 0.80.0 depends on `"yaml": "2.8.3"` (its
  `package.json`). The `^2.8.3` range lets npm use that same copy, so the install adds no new code.
  The dependency must still be declared directly; relying on a transitive copy breaks when
  pi-subagents changes its dependencies.
- API, checked against yaml 2.8.3 in `node_modules`: `import { parse } from "yaml"` works from ESM
  (the package is CommonJS with named exports). `parse(text)` returns plain JS values. It uses the
  YAML 1.2 core schema by default, so the key `on:` stays the string `"on"` rather than becoming
  `true` as in YAML 1.1. It throws `YAMLParseError` on a syntax error, on a duplicate key (code
  `DUPLICATE_KEY`) and on a file with several documents (code `MULTIPLE_DOCS`). It returns `null`
  for an empty file. Block scalars (`run: |`) come back as one string with `\n` line ends, ending in
  `\n`.

A hand-written line parser is not an option: `run:` values come as plain, quoted, folded and
literal scalars, and `on:` comes as a string, a list or a map.

### New file: `src/ci-checks.ts`

One exported function behind a narrow seam: workflow texts in, checks and reasons out. No I/O.

```ts
// Checks from a repository's CI: the `run:` steps of the GitHub Actions workflows that run on
// pull_request, minus setup steps and steps that only work inside Actions (#33). CI already says
// what "green" means for a repository, so /crucible init prefers this to guessing from
// package.json and friends.

import { parse } from "yaml";
import type { Check } from "./init.ts";

export interface CiDetection {
  /** At most MAX_CHECKS, unique names and commands, in workflow-file, job and step order. */
  checks: Check[];
  /** One line per step, job or file not offered as a check, saying why. */
  skipped: string[];
}

/**
 * `workflows` maps a repo-relative path (".github/workflows/ci.yml") to the file's text.
 * Files are read in sorted path order, jobs and steps in document order.
 */
export function checksFromWorkflows(workflows: Record<string, string>): CiDetection;
```

`import type` keeps the cycle with `src/init.ts` type-only. Node's type stripping erases it, so there
is no runtime import cycle. `Check` stays defined in `src/init.ts` as
`{ name: string; command: string; from: string }`.

Constants in the module:

```ts
/** The config schema's checks.maxItems. */
const MAX_CHECKS = 8;
/** The config schema's checks[].command maxLength. */
const MAX_COMMAND = 500;
```

#### Algorithm

For each path in `Object.keys(workflows).sort()`:

1. **Parse.** `parse(text)`. On a throw, add the skip line
   `` `${path}: cannot parse (${message})` `` and go on to the next file, where `message` is the
   first line of the error's `message`. A result that is not a plain object (`null`, a list, a
   scalar) is ignored silently: it is not a workflow.
2. **Trigger.** Keep the file only if `runsOnPullRequest(doc.on)` holds:
   - a string equal to `"pull_request"`;
   - an array containing `"pull_request"`;
   - a plain object with an own key `"pull_request"` (its value may be `null`, as in
     `pull_request:` with nothing after it).

   Otherwise ignore the file silently. Most repositories have push-only or release workflows, and
   listing them would be noise.
3. **Jobs.** For each `[jobId, job]` of `Object.entries(doc.jobs ?? {})` where `job` is a plain
   object:
   - If `typeof job.uses === "string"`, add the skip line
     `` `${path} job ${jobId}: calls ${job.uses}; reusable workflows are not followed` `` and go
     on to the next job.
   - Otherwise, for each element of `job.steps` (when it is an array) that is a plain object with
     `typeof step.run === "string"`, apply the step rules below. Steps without `run` (`uses:` steps)
     are dropped silently: they are setup or actions, never shell commands.
4. **Step rules**, in this order. The first rule that fires drops the step with the skip line
   `` `\`${short(step.run)}\` in ${path}: ${reason}` ``. `short(s)` is the first non-empty line
   of `s`, trimmed and cut to 60 characters with `…` appended when longer.
   1. **Expressions.** `step.run`, the effective working directory (below) or any value of
      `step.env` (when it is an object), converted with `String(value)`, contains `${{`.
      Reason: `uses GitHub Actions expressions (\${{ }})`.
   2. **Actions files.** `step.run` matches
      `/\$\{?(GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH|GITHUB_STEP_SUMMARY|GITHUB_STATE)\b/`.
      Reason: `writes GitHub Actions files`.
   3. **Shell.** The effective shell is `step.shell`, else `job.defaults?.run?.shell`, else
      `doc.defaults?.run?.shell`. When it is set (a string) and does not match `/^(bash|sh)(\s|$)/`,
      reason: `runs in ${shell}, not bash or sh`.
   4. **Working directory.** The effective directory is `step["working-directory"]`, else
      `job.defaults?.run?.["working-directory"]`, else
      `doc.defaults?.run?.["working-directory"]`, as a string. After trimming and removing one
      trailing `/`, when it is `""` or `"."` there is no prefix. Otherwise it must match
      `/^[\w.-]+(\/[\w.-]+)*$/` and none of its `/`-separated parts may be `..`. Then the prefix is
      `cd ${dir} && `. Otherwise the reason is `working-directory ${dir} is not a plain path inside the repository`.
   5. **Normalise the script** (`normaliseScript(run)`, below). When it returns `{ setup: true }`,
      reason: `setup`. When it returns `{ error }`, the reason is that error.
   6. **Length.** `prefix + command` longer than `MAX_COMMAND` characters: reason
      `longer than 500 characters`.
   7. **Duplicate.** A check with the same command (`prefix + command`) is already in the list:
      drop silently. Matrix jobs and repeated jobs run the same step more than once.
   8. **Limit.** The list already has `MAX_CHECKS` checks: reason
      `more than 8 checks; the config allows 8`.

   A step that survives becomes
   `{ name: uniqueName(checkName(step, command), names), command: prefix + command, from: path }`.

#### `normaliseScript(run: string): { command: string } | { setup: true } | { error: string }`

GitHub runs a `run:` script with `bash -e`, so a multi-line script fails at its first failing line.
Joining its lines with ` && ` gives the same result in the single-line form the workflow prompt
lists (`  - <name>: <command>`, one line per check).

1. Join continuation lines: replace every `/\\\r?\n[ \t]*/g` with a single space.
2. Split on `/\r?\n/`, trim each line, and drop empty lines and lines starting with `#`.
3. For each line, split it on the literal `&&` into segments (trimmed). Drop the segments that are
   setup (`isSetup`, below). When none are dropped, keep the line unchanged. When all are dropped,
   drop the line. Otherwise the line becomes the remaining segments joined with ` && `.
4. No lines left: return `{ setup: true }`.
5. One line: return `{ command: line }`.
6. Several lines: if any line's first word is one of `if then else elif fi for while until do done
   case esac function select`, or a line ends with `{` or `(`, or is `}` or `)`, or contains `<<`,
   return `{ error: "multi-line script with shell control flow or a heredoc" }`. Otherwise return
   `{ command: lines.join(" && ") }`.

#### `isSetup(segment: string): boolean`

True when the whole segment matches one of these patterns (each anchored at both ends):

```ts
const SETUP = [
  /^(sudo\s+)?(apt-get|apt|brew|choco|yum|dnf|apk)\s.*$/,
  /^(npm|pnpm|bun)\s+(ci|install|i)(\s.*)?$/,
  /^yarn(\s+install)?(\s+--?[\w-]+)*$/,
  /^corepack\s.*$/,
  /^(python3?\s+-m\s+)?pip3?\s+install\s.*$/,
  /^pipx\s+install\s.*$/,
  /^uv\s+(sync|venv|pip\s+install|python\s+install|tool\s+install)(\s.*)?$/,
  /^poetry\s+install(\s.*)?$/,
  /^(npx\s+)?playwright\s+install(\s.*)?$/,
  /^go\s+mod\s+download(\s.*)?$/,
  /^cargo\s+fetch(\s.*)?$/,
  /^bundle\s+install(\s.*)?$/,
  /^git\s+config\s.*$/,
];
```

Builds (`npm run build`), code generation and test commands are not setup. A build is part of what
CI calls green, and the operator can remove it from the starter config.

#### `checkName(step, command): string`

1. When `step.name` is a non-empty string, the base is `slug(step.name)`.
2. Otherwise derive it from `command` (without the `cd … && ` prefix). Split on whitespace, drop
   leading `NAME=value` tokens (`/^[A-Za-z_][A-Za-z0-9_]*=/`), and call the rest `t`. Let
   `arg(i)` be the first token at index ≥ i that does not start with `-`.
   - `t[0]` in `npm pnpm yarn bun`: `t[1] === "run"` → `arg(2)`; `t[1]` in `test t` → `"test"`;
     else `arg(1)`.
   - `t[0]` in `just make`: `arg(1) ?? t[0]`.
   - `t[0]` in `npx pnpx uvx bunx`: `arg(1)`.
   - `t[0]` in `uv poetry pdm hatch` and `t[1] === "run"`: `arg(2)`.
   - otherwise `t[0]`.

   Take the token's basename (text after the last `/`), remove a trailing `/\.[A-Za-z]+$/`
   extension, and `slug` it. A missing token gives `""`.
3. `slug(s)`: lowercase; replace each run of characters outside `[a-z0-9]` with `-`; strip leading
   and trailing `-`. When the result is empty the base is `"check"`; when it does not start with
   `[a-z]` it is prefixed with `check-`. Cut to 32 characters and strip trailing `-` again.

Examples: unnamed `npm test` → `test`; `npm run check` → `check`;
`npx tsc -p . --noEmit 2>&1 | grep …` → `tsc`; `uv run pytest -q` → `pytest`;
`./scripts/lint.sh` → `lint`; a step named `Typecheck (src only)` → `typecheck-src-only`; a step
named `2nd pass` → `check-2nd-pass`.

#### `uniqueName(base, names): string`

`names` is the set of names already used. Return `base` when unused; else the first of
`${base.slice(0, 32 - suffix.length)}${suffix}` for suffix `-2`, `-3`, … that is unused. Add the
result to `names`. Every name then satisfies the schema's `^[a-z][a-z0-9-]{0,31}$`, and names are
unique, as `engineRules` requires.

### `src/init.ts`

- Header comment: replace the detection bullet with
  `//   - detects check commands from the run: steps of pull_request CI workflows, falling back to
  //     package.json, justfile, pyproject.toml and Makefile;`
- `detectChecks` is unchanged. Its doc comment gains: "The fallback when CI yields no checks
  (`checksFromWorkflows` in ./ci-checks.ts)."
- `InitIO` gains one member:

  ```ts
  /** Entry names in a directory (not paths); rejects when it does not exist. */
  listDir: (p: string) => Promise<string[]>;
  ```

- New helper next to `init`:

  ```ts
  /** The texts of .github/workflows/*.yml and *.yaml, keyed by repo-relative path. */
  async function readWorkflows(io: InitIO, repoRoot: string): Promise<Record<string, string>> {
    const dir = ".github/workflows";
    const names = await io.listDir(path.join(repoRoot, dir)).catch(() => [] as string[]);
    const out: Record<string, string> = {};
    for (const name of names.filter((n) => /\.ya?ml$/.test(n)).sort()) {
      const text = await io.readText(path.join(repoRoot, dir, name)).catch(() => undefined);
      if (text !== undefined) out[`${dir}/${name}`] = text;
    }
    return out;
  }
  ```

- In `init`, the `else` branch of `// Config.` replaces `const checks = detectChecks(files);` and the
  notes after it with:

  ```ts
  const ci = checksFromWorkflows(await readWorkflows(io, repoRoot));
  if (ci.skipped.length) notes.push(["info", `Not offered as checks from CI:\n- ${ci.skipped.join("\n- ")}`]);
  let checks = ci.checks;
  if (!checks.length) {
    const files: Record<string, string | undefined> = {};
    for (const f of ["package.json", "justfile", "Justfile", "pyproject.toml", "Makefile"]) files[f] = await read(f);
    checks = detectChecks(files);
    if (checks.length) notes.push(["info", "No checks in pull_request workflows under .github/workflows; detected from package.json, justfile, pyproject.toml and Makefile instead."]);
  }
  notes.push([
    checks.length ? "info" : "warning",
    checks.length
      ? `Detected checks: ${checks.map((c) => `${c.name} = \`${c.command}\` (${c.from})`).join("; ")}`
      : "No checks detected (run: steps of pull_request workflows in .github/workflows, package.json scripts, justfile or Makefile recipes, pytest/ruff in pyproject.toml). Runs will report \"no checks configured\"; add checks to the config.",
  ]);
  ```

  The files for `detectChecks` are read only when the fallback runs. The rest of the branch
  (starter config, write or print) is unchanged. `starterConfig` already drops `from`.

### `extensions/crucible.ts`

In `runInit`, the `InitIO` object gains `listDir: (p) => readdir(p)`. Add `readdir` to the existing
`node:fs/promises` import. `readdir(p)` without options returns entry names as strings and rejects
with `ENOENT` for a missing directory. Nothing else about the command changes: same syntax, flags,
completions and `--dry-run` semantics. `/crucible <issue>` is untouched.

### Docs

- **`docs/crucible.md`, "First run in a new repository"**: replace the sentence that begins "When no
  config exists, it detects checks from `package.json` scripts …" up to "… and offers a starter
  `.pi/crucible.json`" with:

  > When no config exists, it detects checks from CI first: the `run:` steps of the workflows in
  > `.github/workflows` that run on `pull_request`, in file, job and step order. It drops `uses:`
  > steps and setup (`npm ci`, `pip install`, `uv sync`, …), joins a multi-line script's lines
  > with `&&`, prefixes `cd <dir> &&` for a `working-directory`, and leaves out steps that only work
  > inside Actions: `${{ }}` expressions, writes to `$GITHUB_ENV` and friends, a non-bash shell, or
  > shell control flow across lines. It lists what it left out and why. Reusable workflows are not
  > followed. Check names come from the step's `name`, else from the command (`npm run lint` →
  > `lint`). Only when CI yields no check does it fall back to `package.json` scripts
  > (`typecheck`, `lint`, `test`), `justfile` or `Makefile` recipes (`check`, `lint`, `test`) and
  > `pyproject.toml` (pytest, ruff). It then offers a starter `.pi/crucible.json`

  The rest of the paragraph ("with generic texts for …") stays.
- **`README.md`, "Dependencies"**: add a bullet after the pi bullet:

  > - **[yaml](https://eemeli.org/yaml/)** (ISC, by Eemeli Aro) parses CI workflows for
  >   `/crucible init`'s check detection. pi-subagents already depends on it.

  The quick-start comment
  `# create the labels runs use, detect your checks, show a starter config` stays accurate and does
  not change.
- **Figure**: no change. It shows run stages; `init` is not one.
- **CONTRIBUTING.md**: no change.

## Acceptance criteria

- [ ] `package.json` lists `"yaml": "^2.8.3"` under `dependencies`, and `package-lock.json` is updated
      to match.
- [ ] `src/ci-checks.ts` exports `checksFromWorkflows` and `CiDetection` exactly as specified. It
      does no I/O.
- [ ] Given this repository's `.github/workflows/ci.yml`, `checksFromWorkflows` returns
      `[{ name: "test", command: "npm test", from: ".github/workflows/ci.yml" }, { name: "check", command: "npm run check", from: ".github/workflows/ci.yml" }]`
      and no skip lines.
- [ ] Given a workflow with the bioc-registry step
      `run: npx tsc -p . --noEmit 2>&1 | grep -E '^src/' && exit 1 || exit 0`, the check's command is
      exactly that string. Its name is `tsc` when the step has no `name` and the slug of `name` when it has one.
- [ ] `on: pull_request`, `on: [push, pull_request]` and `on: { pull_request: null }` (plus
      `on: { pull_request: { branches: [main] } }`) are detected. `on: push`, `on: [push]` and
      `on: pull_request_target` workflows yield nothing and no skip line.
- [ ] `uses:` steps are dropped silently. `npm ci`, `npm install`, `pip install -r x`, `uv sync` and
      `corepack enable` steps are dropped with reason `setup`. `npm ci && npm test` becomes `npm test`.
      A literal block `npm ci\nnpm test\nnpm run lint\n` becomes `npm test && npm run lint`.
- [ ] Steps whose `run`, `working-directory` or `env` values contain `${{` are dropped with the
      expressions reason. So are steps that write `$GITHUB_ENV`/`$GITHUB_OUTPUT`/`$GITHUB_PATH`/
      `$GITHUB_STEP_SUMMARY`/`$GITHUB_STATE`, steps with `shell: pwsh` or `shell: python` (directly or
      through `defaults.run.shell`), multi-line scripts with `if`/`for`/heredocs, commands over 500
      characters, and checks past the eighth. Each skip line names the command, the file and the reason.
- [ ] `working-directory: web` (step, job `defaults.run` or workflow `defaults.run`) gives
      `cd web && <command>`. `working-directory: ../x` and `working-directory: "a b"` are dropped
      with the working-directory reason. `working-directory: .` adds no prefix.
- [ ] A job with `uses: ./.github/workflows/x.yml` yields the "reusable workflows are not followed"
      skip line. An unparseable file yields a "cannot parse" skip line, and the other files are
      still read.
- [ ] Identical commands across jobs or files give one check. Colliding names get `-2`, `-3`. Every
      name matches `^[a-z][a-z0-9-]{0,31}$`. `starterConfig(checks)` passes `crucibleFileErrors`
      for every fixture in the tests.
- [ ] `init` in a repo with a pull-request workflow and a `package.json` uses only the CI checks:
      the written config's `checks` equal the CI checks, and the notes show `Detected checks: …
      (.github/workflows/…)`.
- [ ] `init` in a repo whose workflows are push-only (or that has no `.github/workflows`) falls
      back to `detectChecks`. The notes include the fallback line and
      `Detected checks: test = \`npm test\` (package.json)`.
- [ ] The existing `test/init.test.ts` cases pass, with their fakes extended by `listDir` and no
      other changes to their assertions.
- [ ] `docs/crucible.md` describes the CI-first detection as specified, and README's Dependencies
      section mentions `yaml`.
- [ ] `workflows/crucible.js`, `src/resource.ts`, `src/config.ts`, `schema/crucible.schema.json` and
      `docs/figures/` are unchanged.
- [ ] `npm test` and `npm run check` pass.

## Test plan

All tests use `node:test` and in-memory strings and fakes. None touch the network, `gh`, `git` or the
real filesystem.

**New `test/ci-checks.test.ts`** (source-named, for `src/ci-checks.ts`), one `test(...)` per group:

1. *"this repository's CI gives test and check"*: read `.github/workflows/ci.yml` with
   `readFileSync` (repo files are fixtures, as `test/fixtures.ts` already reads files) and assert
   the two checks and empty `skipped`.
2. *"the bioc-registry typecheck is copied verbatim"*: an inline workflow with `npm ci`, `npm test`
   and the `npx tsc … || exit 0` step, unnamed and named `Typecheck`. Assert the commands and the
   names `test`, `tsc` and `typecheck`.
3. *"only pull_request workflows count"*: the `on:` forms listed in the acceptance criteria, as
   separate files in one call.
4. *"setup is dropped, multi-line scripts are joined"*: `uses:` steps, the setup list,
   `npm ci && npm test`, and a literal block scalar. Check the `setup` skip lines.
5. *"steps that need Actions are left out, with reasons"*: `${{` in run, env and working-directory;
   `$GITHUB_OUTPUT`; `shell: pwsh` and workflow `defaults.run.shell: python`; an `if … fi` block;
   a heredoc; a 501-character command; nine distinct checks, giving eight checks and one "more than
   8" line. Assert every skip line with `assert.match` on file and reason.
6. *"working-directory becomes a cd prefix"*: step, job and workflow defaults; `.`, `../x` and `a b`.
7. *"names are slugs, unique and valid"*: the derivation examples from the Design section,
   collisions (`-2`, `-3`), a 40-character step name cut to 32, a step name starting with a digit,
   and duplicate commands across two jobs collapsing to one. Finish with
   `crucibleFileErrors(starterConfig(checks))` deep-equal `[]`.
8. *"unparseable files and reusable workflows are reported"*: a file with a YAML syntax error next to
   a valid one, a duplicate-key file, an empty file (ignored silently), and a job with `uses:`.

**`test/init.test.ts`**:

- `fakeRepo` gains `listDir`: for a directory `/r/<dir>`, it returns the names of the `files` keys
  directly under `<dir>/`, and rejects with `ENOENT` when there are none. It is passed in `io`.
- New test *"init prefers CI checks to package.json"*: files `AGENTS.md`, `package.json` with
  `test` and `lint` scripts, and `.github/workflows/ci.yml` running `npm ci` and `npm test` on
  `pull_request`. Assert the written config's `checks` are `[{ name: "test", command: "npm test" }]`,
  the notes contain `Detected checks: test = \`npm test\` (.github/workflows/ci.yml)` and a
  `Not offered as checks from CI` note with `npm ci`, and that the `lint` script was not offered.
- New test *"init falls back to package.json when CI has no pull_request workflow"*: a push-only
  workflow and a `package.json` `test` script. Assert the fallback note and the `(package.json)`
  detection.
- The existing two `init` tests stay as they are apart from the fake.

**Manual check** (reported in the PR, not automated): `/crucible init --dry-run` in this repository's
main checkout (which has a config, so expect "exists; not changing it"), and in a scratch clone of
bioc-registry with its `.pi/crucible.json` removed, if one exists, expecting the `tsc|grep` typecheck to be
offered. The implementer cannot run pi. If neither run is possible, the PR says so.

## Risks

- **Local and CI shells differ.** GitHub runs `bash -eo pipefail`, and the worker's shell may not.
  A pipeline can then pass in one and fail in the other. Under `pipefail`, bioc-registry's
  `tsc | grep … && exit 1 || exit 0` passes even when grep finds errors. Without it, which is how the
  worker runs it, the check behaves as its author meant. Commands are copied verbatim and the
  operator reviews the starter config, so this is reported, not corrected.
- **Ignored `env:`.** A step that depends on a literal `env:` (`CI: true`, `NODE_OPTIONS`) or a job
  `services:` container (a database) may fail locally. Then every PR becomes a draft until the
  operator edits the check. The starter config is printed for review before anything uses it.
- **The setup list is a heuristic.** An unlisted installer (`pdm install`, `R -e 'install.packages(…)'`)
  shows up as a check, and an over-eager pattern could hide a real check. Both show in `init`'s
  output: detected checks by name and command, dropped steps with reasons.
- **Splitting on `&&` ignores quoting.** A setup segment is dropped only when it matches a setup
  pattern as a whole, and lines without one are kept verbatim, so a quoted `&&` changes nothing
  unless one side of it is exactly an install command.
- **Repositories without `pull_request` CI** (push-only, or `pull_request_target`) keep the current
  detection through the fallback. Their CI steps are not offered, matching the issue's
  "workflows that run on `pull_request`".
- **New runtime dependency.** `yaml` reaches every consuming repository's pi install. It has no
  dependencies, pi-subagents already ships it, and the extension imports it only through
  `src/init.ts` → `src/ci-checks.ts`.
