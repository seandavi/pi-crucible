# Spec for #34: init, when AGENTS.md is missing, uses CLAUDE.md / CONTRIBUTING.md

Issue: [seandavi/pi-crucible#34](https://github.com/seandavi/pi-crucible/issues/34), part of #26
(zero-config runs), under the tracking issues #28 and #1.

## Goal

bioc-registry had no `AGENTS.md`. Its one hard rule (route changes update `docs/api.md` and
`src/openapi.ts` together) was in `CLAUDE.md`. `/crucible init` printed "No AGENTS.md: … runs are
much worse without one" and nothing more. Every stage is told only "Read AGENTS.md … first and
follow it", so a run would have skipped that rule without saying so.

After this change, when the repository has no `AGENTS.md`, `/crucible init`:

1. **Names the agent and contributor docs it found** (`CLAUDE.md`, `.github/copilot-instructions.md`,
   `CONTRIBUTING.md` and the other paths listed below) in its warning, and says that runs will not
   read them unless `AGENTS.md` points to them.
2. **Offers a starter `AGENTS.md`** built from what it found. The starter tells every stage to read
   those files first and follow them, so their rules reach the run through `AGENTS.md`. It has empty
   sections for the stack and layout and for the rules, and a Commands section filled from the
   checks. Without `--write` the starter is printed, the same way the starter config is.
   `/crucible init --write` writes it to `<repoRoot>/AGENTS.md` and never overwrites a file.

The stages need no change. `AGENTS.md` stays the single entry point the engine names, and the
starter carries the run to `CLAUDE.md` and the rest.

## Non-goals

- **Letting the stages read `CLAUDE.md` when there is no `AGENTS.md`** (the issue's third option).
  That changes the CONTEXT prompt every stage of every consuming repository gets, for a case that
  `init` now fixes at its source. It would also leave the rule implicit: a repository with both files
  would get different behaviour from one with only `CLAUDE.md`. `workflows/crucible.js` does not
  change. If hand-launched runs in repositories without `AGENTS.md` turn out to matter, that is a
  separate issue.
- **Copying the found files' text into `AGENTS.md`.** The starter links to them. Copies would drift
  from the originals. `CLAUDE.md` often holds tool-specific text (for example `@AGENTS.md` imports
  or Claude Code settings) that would be wrong in `AGENTS.md`. Moving the rules that matter into
  `AGENTS.md` itself is left to the person, and the starter says so.
- **Writing `AGENTS.md` with a model.** `init` is a deterministic extension command with no model
  call. Its output is a starting point that a person edits.
- **A warning from `/crucible <issue>`** when `origin/main` has no `AGENTS.md`. `init` is the
  first-run command. The launcher is unchanged.
- **Changing the starter config** (`GENERIC`, `starterConfig`) or the label logic.
- Detecting checks from CI workflows (#33).

## Design

### `src/init.ts`

#### Header comment

Replace the line

```ts
//   - warns when AGENTS.md is missing (every stage reads it first);
```

with

```ts
//   - when AGENTS.md is missing (every stage reads it first, and only it), names the agent and
//     contributor docs it found and prints a starter AGENTS.md that points to them, or writes it
//     with --write;
```

#### New: `AGENT_DOCS`

Add after `GENERIC`:

```ts
/**
 * Agent and contributor docs a repository may have instead of AGENTS.md, in the order a starter
 * AGENTS.md lists them. Runs read only AGENTS.md, so these reach a run only through it.
 */
export const AGENT_DOCS = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
];
```

These are the locations the tools and GitHub look in: Claude Code reads `./CLAUDE.md` or
`./.claude/CLAUDE.md`; Gemini CLI reads `GEMINI.md`; Copilot reads
`.github/copilot-instructions.md`; GitHub shows `CONTRIBUTING.md` from the root, `.github/` or
`docs/`. `README.md` is not listed: nearly every repository has one, and the generic `design` text
already names it.

#### New: `starterAgentsMd`

Add after `starterConfig`:

```ts
/** A starter AGENTS.md: read the docs the repository already has, then sections to fill in. */
export function starterAgentsMd(docs: string[], checks: { name: string; command: string }[]): string {
  const lines = [
    "# AGENTS.md",
    "",
    "Started by `/crucible init`. Every pi-crucible stage reads this file first, and only this file:",
    "fill in the sections below, and move the rules that matter most into them.",
    "",
  ];
  if (docs.length) {
    lines.push("## Read first", "", "Read these before changing anything, and follow them:", "", ...docs.map((d) => `- [${d}](${d})`), "");
  }
  lines.push(
    "## Stack and layout",
    "",
    "<!-- Languages, frameworks, and where the code, tests and docs live. -->",
    "",
    "## Rules",
    "",
    "<!-- Hard rules: files that must change together, things never to do. -->",
    "",
    "## Commands",
    "",
    ...(checks.length ? checks.map((c) => `- ${c.name}: \`${c.command}\``) : ["<!-- How to set up, test and lint. -->"]),
  );
  return lines.join("\n") + "\n";
}
```

#### `init`

The function keeps its signature (`init(io, cwd, options)`) and its return type. The changes, in
order:

1. **AGENTS.md check.** Replace

   ```ts
   if ((await read("AGENTS.md")) === undefined) {
     notes.push(["warning", "No AGENTS.md: every stage reads it first, and runs are much worse without one. Add the project's stack, layout, rules and commands."]);
   }
   ```

   with

   ```ts
   // Runs read only AGENTS.md; other agent docs reach a run only if it points to them.
   const hasAgentsMd = (await read("AGENTS.md")) !== undefined;
   const agentDocs: string[] = [];
   if (!hasAgentsMd) {
     for (const doc of AGENT_DOCS) if ((await read(doc)) !== undefined) agentDocs.push(doc);
     notes.push([
       "warning",
       agentDocs.length
         ? `No AGENTS.md: every stage reads it first, and only it. Found ${agentDocs.join(", ")}, which runs will not read unless AGENTS.md points to them. Start one from them with /crucible init --write.`
         : "No AGENTS.md: every stage reads it first, and runs are much worse without one. Start one with /crucible init --write, then add the project's stack, layout, rules and commands.",
     ]);
   }
   ```

   The note stays where it is today: after the config is read and the repo resolved, before the
   labels.

2. **Checks are known before the config block.** The starter `AGENTS.md` needs them whether or not
   a config exists. Inside the existing `else` branch (no config), the detection stays as it is
   (`files`, `detectChecks`, the "Detected checks" / "No checks detected" note). Declare
   `let checks: { name: string; command: string }[] = [];` before `if (config) {`, assign the
   detected checks to it in the `else` branch (replace `const checks = detectChecks(files);` with
   `const detected = detectChecks(files);` and `checks = detected;`, and use `detected` in that
   branch's note and `starterConfig(detected)` call), and in the `if (config)` branch set

   ```ts
   checks = Array.isArray(config.checks)
     ? config.checks.filter((c) => typeof c?.name === "string" && typeof c?.command === "string")
     : [];
   ```

   (an invalid config has already been warned about; this keeps a malformed `checks` from throwing).

3. **Starter AGENTS.md.** After the config block and before the final
   `notes.push(["info", "Next: /crucible <issue> --dry-run"])`, add:

   ```ts
   if (!hasAgentsMd) {
     const text = starterAgentsMd(agentDocs, checks);
     const target = path.join(repoRoot, "AGENTS.md");
     if (options.write && !options.dryRun) {
       await io.writeText(target, text);
       notes.push([
         "info",
         `Wrote ${target}${agentDocs.length ? `, pointing to ${agentDocs.join(", ")}` : ""}. Fill in its sections, then merge it to main: runs work from branches of origin/main.`,
       ]);
     } else {
       notes.push(["info", `Starter AGENTS.md (write it with /crucible init --write):\n${text}`]);
     }
   }
   ```

   The config is written before `AGENTS.md`, so the existing config behaviour is unchanged if the
   `AGENTS.md` write fails.

`parseInit`, `INIT_USAGE`, `detectChecks`, `starterConfig`, `wantedLabels` and `GENERIC` do not
change. `--write` already means "write what init offers"; it now covers `AGENTS.md` too, and
`--dry-run` still writes nothing.

### `extensions/crucible.ts`

No change. `runInit`'s `writeText` already creates parent directories and writes with
`{ flag: "wx" }` (Node's `fs/promises.writeFile`: `wx` fails with `EEXIST` if the path exists), so
`AGENTS.md` is never overwritten. If it appeared between the check and the write, `init` rejects
and the user sees `/crucible init: EEXIST: file already exists, open '<path>'`. The command's
description and completions are unchanged.

### `workflows/crucible.js`, `src/resource.ts`, `src/config.ts`, `src/launcher.ts`, `schema/crucible.schema.json`

No change. No stage, prompt, output schema, arg or config field changes. The PR's crucible record
is unchanged: `init` runs before any crucible run and leaves nothing in a run's record.

### Docs

**`docs/crucible.md`**, "First run in a new repository":

- The code block's comments become:

  ```text
  /crucible init               # labels, AGENTS.md check, detected checks, starter config and AGENTS.md (printed)
  /crucible init --write       # also write .pi/crucible.json and AGENTS.md (never overwrites either)
  /crucible init --dry-run     # report only: create nothing
  ```

- Replace the sentence "It warns when there is no `AGENTS.md`." with:

  ```markdown
  When there is no `AGENTS.md`, it names the agent and contributor docs it finds (`CLAUDE.md`,
  `.claude/CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, and `CONTRIBUTING.md` in the
  root, `.github/` or `docs/`) and offers a starter `AGENTS.md` that tells every stage to read them
  first, with sections to fill in for the stack and layout and the rules, and the checks as its
  commands. Runs read only `AGENTS.md`, so a rule that lives only in `CLAUDE.md` reaches a run only
  through it. The starter links to those files rather than copying them; move the rules that matter
  most into `AGENTS.md` itself.
  ```

- The last paragraph's "Edit those texts for the project (they make better runs) and merge the file
  to `main`." becomes "Edit those texts, and the starter `AGENTS.md`, for the project (they make
  better runs) and merge both to `main`."

**`README.md`**, Quick start: the line

```text
/crucible init --write     # write .pi/crucible.json; edit it, then merge it to main
```

becomes

```text
/crucible init --write     # write .pi/crucible.json (and AGENTS.md if missing); edit, then merge to main
```

and in the paragraph after the block, after "every stage reads it first.", add: "If the repository
keeps its rules in `CLAUDE.md` or `CONTRIBUTING.md` instead, `/crucible init` offers an `AGENTS.md`
that points to them."

**`docs/figures/make_figures.py`**: no change. The figure shows a run, not `init`, and no stage,
model, lens or stop rule changes.

`CONTRIBUTING.md` and `AGENTS.md` do not change.

## Acceptance criteria

- [ ] With no `AGENTS.md` and `CLAUDE.md` and `CONTRIBUTING.md` present, `init` returns a warning
      that is exactly `No AGENTS.md: every stage reads it first, and only it. Found CLAUDE.md, CONTRIBUTING.md, which runs will not read unless AGENTS.md points to them. Start one from them with /crucible init --write.`
- [ ] Found docs are listed in `AGENT_DOCS` order, whatever order they are read in, and include
      `.github/copilot-instructions.md`, `.claude/CLAUDE.md`, `GEMINI.md`, `.github/CONTRIBUTING.md`
      and `docs/CONTRIBUTING.md` when present.
- [ ] With no `AGENTS.md` and none of the docs, the warning is
      `No AGENTS.md: every stage reads it first, and runs are much worse without one. Start one with /crucible init --write, then add the project's stack, layout, rules and commands.`
- [ ] Without `--write` (or with `--dry-run`), `init` writes nothing and returns an info note
      starting `Starter AGENTS.md (write it with /crucible init --write):\n# AGENTS.md\n`.
- [ ] With `--write`, `init` writes `<repoRoot>/AGENTS.md` (after the config, when it writes one)
      with the text of `starterAgentsMd(found docs, checks)`, and returns
      `Wrote <repoRoot>/AGENTS.md, pointing to <docs>. Fill in its sections, then merge it to main: runs work from branches of origin/main.`
      (no `, pointing to …` when no docs were found).
- [ ] The starter's checks are the detected ones when there is no config, and the config's
      `checks` (name and command) when there is one; a config whose `checks` is not an array gives
      the placeholder and does not throw.
- [ ] `starterAgentsMd(["CLAUDE.md"], [{ name: "test", command: "npm test" }])` contains
      `## Read first`, `- [CLAUDE.md](CLAUDE.md)`, `## Stack and layout`, `## Rules`, `## Commands`
      and `` - test: `npm test` ``, and ends with a single newline. With no docs it has no
      `## Read first` section; with no checks its Commands section is
      `<!-- How to set up, test and lint. -->`.
- [ ] With `AGENTS.md` present, `init` reads none of `AGENT_DOCS`, gives no AGENTS.md warning, and
      neither prints nor writes a starter `AGENTS.md`.
- [ ] The existing init tests still pass, with only the assertions named in the test plan changed.
- [ ] `workflows/crucible.js`, `src/resource.ts`, `src/config.ts`, `src/launcher.ts`,
      `extensions/crucible.ts`, `schema/crucible.schema.json` and `docs/figures/` are unchanged
      (`git diff origin/main --stat` lists none of them).
- [ ] `docs/crucible.md` and `README.md` are updated as in Design.
- [ ] `npm test` and `npm run check` pass.

## Test plan

All in `test/init.test.ts`, with the existing `fakeRepo` helper (its `readText` throws `ENOENT` for
files not in the map, and `writeText` records into `written`). Import `AGENT_DOCS` and
`starterAgentsMd` alongside the existing imports. To check which files were read, extend `fakeRepo`
to record every relative path its `readText` is asked for in a `reads: string[]` array it returns.

1. **Update "init in a fresh repo creates labels, warns about AGENTS.md, and writes a starter
   config".** Its repo has no agent docs, so assert the new no-docs warning text exactly, and that
   `repo.written["/r/AGENTS.md"]` equals
   `starterAgentsMd([], [{ name: "test", command: "npm test" }])` and the notes include
   `Wrote /r/AGENTS.md. Fill in its sections, then merge it to main: runs work from branches of origin/main.`
   The final note is still `Next: /crucible <issue> --dry-run`.
2. **New test: "init names the agent docs it finds and writes an AGENTS.md that points to them".**
   A fake repo with `CONTRIBUTING.md`, `CLAUDE.md` and `.github/copilot-instructions.md` (put in
   the map in that order) and a `package.json` with a `test` script, run with
   `{ write: true, dryRun: false }`:
   - the warning equals `No AGENTS.md: every stage reads it first, and only it. Found CLAUDE.md, .github/copilot-instructions.md, CONTRIBUTING.md, which runs will not read unless AGENTS.md points to them. Start one from them with /crucible init --write.`;
   - `written["/r/AGENTS.md"]` equals
     `starterAgentsMd(["CLAUDE.md", ".github/copilot-instructions.md", "CONTRIBUTING.md"], [{ name: "test", command: "npm test" }])`;
   - `written` has both `/r/.pi/crucible.json` and `/r/AGENTS.md`, and the config key was written
     first (`Object.keys(written)` order);
   - a note equals `Wrote /r/AGENTS.md, pointing to CLAUDE.md, .github/copilot-instructions.md, CONTRIBUTING.md. Fill in its sections, then merge it to main: runs work from branches of origin/main.`
3. **New test: "without --write, or with --dry-run, the starter AGENTS.md is printed, not written".**
   A repo with `.claude/CLAUDE.md` only. With `{ write: false, dryRun: false }` and again with
   `{ write: true, dryRun: true }`: `written` is `{}`, and one note starts with
   `Starter AGENTS.md (write it with /crucible init --write):\n# AGENTS.md\n` and contains
   `- [.claude/CLAUDE.md](.claude/CLAUDE.md)`.
4. **New test: "with an existing config, the starter AGENTS.md lists the config's checks".** A repo
   with a valid `.pi/crucible.json` whose `checks` is
   `[{ name: "check", command: "just check" }]`, `GEMINI.md`, and no `AGENTS.md`, run with
   `{ write: true, dryRun: false }`: `written` has only `/r/AGENTS.md`, and its text contains
   `` - check: `just check` ``. Repeat with a config whose `checks` is `"oops"` (invalid): `init`
   resolves, warns that the config is invalid, and the starter's Commands section is the
   placeholder.
5. **Update "init --dry-run changes nothing; an existing config is left alone…".** Both of its repos
   have `AGENTS.md`. Add, for both repos: no note matches
   `/^(No AGENTS\.md|Starter AGENTS\.md|Wrote .*AGENTS\.md)/` (not plain `/AGENTS\.md/`, because the
   starter config's generic design and implement texts mention AGENTS.md and the dry repo prints
   them), and `reads` contains none of `AGENT_DOCS`. `has.written` is still `{}`.
6. **New test: "starterAgentsMd".** The three cases in the acceptance criteria: docs and checks;
   no docs (no `## Read first`); no checks (the placeholder line). Assert the text ends with
   `"\n"` and not `"\n\n"`.
7. **New test: "AGENT_DOCS holds the documented locations".** `assert.deepEqual(AGENT_DOCS, [...])`
   with the seven paths in Design, so a change to the list is deliberate and the docs follow.

Then run `npm test` and `npm run check`. `subagent({ action: "validate", … })` and the figure
script are not needed, because `workflows/crucible.js` and the figure do not change.

## Risks

- **A starter with empty sections.** The written `AGENTS.md` has HTML-comment placeholders, which
  runs read. They are harmless, but a repository that merges the starter unedited gets only the
  pointers and the commands. The note says to fill it in, and the pointers alone already fix the
  issue's failure: the run is told to read `CLAUDE.md`.
- **Links, not copies.** A stage must follow the "Read first" list to see the rules. The prompts
  already say "Read AGENTS.md … first and follow it", and the starter's list is an instruction
  ("Read these before changing anything, and follow them"). If runs turn out to skip linked files,
  the remedy is moving the rules into `AGENTS.md`, which the starter already asks for.
- **Tool-specific docs.** `CLAUDE.md` or `.github/copilot-instructions.md` may hold instructions
  for another tool (settings, imports, model hints). Stages told to follow them might act on those.
  This is no worse than the hand-written `AGENTS.md` in bioc-registry #75, and a person reviews the
  starter before merging it.
- **`--write` now writes two files.** Someone who ran `init --write` for the config alone also gets
  an `AGENTS.md` when there was none. It is never overwritten, it is reported, and it is not
  committed: the person reviews and merges it.
- **The list of locations is a guess at what matters.** Other tools (Cursor's `.cursor/rules`,
  Windsurf) keep rules elsewhere. They can be added to `AGENT_DOCS` later; test 7 makes that a
  deliberate change.
- **Every consuming repository** sees this only when it runs `/crucible init` with no `AGENTS.md`.
  Runs are unchanged.
