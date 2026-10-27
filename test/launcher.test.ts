import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import extension from "../extensions/crucible.ts";
import { engineConfigErrors, crucibleFileErrors } from "../src/config.ts";
import {
  ensureWorktree,
  findIssueBranch,
  labelProblems,
  parseCommand,
  pickLenses,
  planLaunch,
  prepare,
  repoFromRemote,
  slugify,
  worktreeRootFor,
  type Exec,
  type Plan,
} from "../src/launcher.ts";
import { argErrors } from "../src/resource.ts";
import { schemaText, SCHEMA_PATH } from "../scripts/write-schema.ts";
import { crucibleFile, fakePi, readJson, type ExecCall } from "./fixtures.ts";

test("parseCommand reads the issue and options, and explains mistakes", () => {
  assert.deepEqual(parseCommand("12"), { issue: 12, startAt: "spec", lenses: [], dryRun: false });
  assert.deepEqual(parseCommand("#12 --start-at review --lens ux --lens=security --dry-run"), {
    issue: 12, startAt: "review", lenses: ["ux", "security"], dryRun: true,
  });
  assert.match((parseCommand("") as { error: string }).error, /^Usage: \/crucible <issue>/);
  assert.match((parseCommand("12 --start-at pr") as { error: string }).error, /--start-at must be one of spec, implement, review/);
  assert.match((parseCommand("12 --lens") as { error: string }).error, /--lens needs a value/);
  assert.match((parseCommand("12 13") as { error: string }).error, /Unexpected "13"/);
});

test("slugify makes short branch-safe slugs", () => {
  assert.equal(slugify("/crucible launcher and per-repo .pi/crucible.json"), "crucible-launcher-and-per-repo-pi");
  assert.equal(slugify("Reviewers always get the diff"), "reviewers-always-get-the-diff");
  assert.equal(slugify("Ünïcode ✨"), "n-code");
  assert.equal(slugify("✨"), "issue");
  assert.ok(slugify("a".repeat(80)).length <= 40);
});

test("lenses come from defaults, review:* labels and --lens; seam from its label", () => {
  const file = { ...crucibleFile, lenses: { code: "c", ux: "u", security: "s" } };
  assert.deepEqual(pickLenses(file, ["review:ux", "seam", "bug", "review:privacy"], ["security"]), {
    lenses: ["code", "ux", "security"],
    seam: true,
    warnings: ["label review:privacy names no lens in .pi/crucible.json; ignored"],
  });
  assert.throws(() => pickLenses(file, [], ["perf"]), /--lens perf: no such lens \(defined: code, ux, security\)/);
});

test("worktree roots and repos resolve as documented", () => {
  assert.equal(worktreeRootFor(crucibleFile, "/src/repo"), "/src/repo-worktrees");
  assert.equal(worktreeRootFor({ ...crucibleFile, worktreeRoot: "~/wt" }, "/src/repo", "/home/me"), "/home/me/wt");
  assert.equal(worktreeRootFor({ ...crucibleFile, worktreeRoot: "/abs" }, "/src/repo"), "/abs");
  assert.equal(repoFromRemote("git@github.com:seandavi/pi-crucible.git"), "seandavi/pi-crucible");
  assert.equal(repoFromRemote("https://github.com/seandavi/bioc-mcp\n"), "seandavi/bioc-mcp");
  assert.equal(repoFromRemote("https://gitlab.com/a/b"), null);
});

const issue = { number: 4, title: "Reviewers always get the diff", state: "OPEN", labels: ["review:ux", "seam"] };
const options = { issue: 4, startAt: "spec" as const, lenses: [], dryRun: false };

test("planLaunch builds args the resource accepts", () => {
  const plan = planLaunch({ file: crucibleFile, repoRoot: "/src/pi-crucible", repo: "seandavi/pi-crucible", issue, options, engine: { commit: "abc1234" }, configSource: "test" });
  assert.equal(plan.branch, "issue-4-reviewers-always-get-the-diff");
  assert.equal(plan.worktree, "/src/pi-crucible-worktrees/issue-4");
  assert.deepEqual(argErrors(plan.args), []);
  assert.deepEqual(plan.args.lenses, ["code", "ux"]);
  assert.equal(plan.args.seam, true);
  assert.equal(plan.args.parent, 1);
  assert.equal(plan.args.startAt, undefined, "spec is the default and is left out");
  assert.deepEqual(Object.keys(plan.args.config as object).sort(), ["checks", "design", "implement", "lenses", "spec"]);
  const big = { ...crucibleFile, lenses: { code: "x".repeat(3000), a: "x".repeat(3000), b: "x".repeat(3000), c: "x".repeat(3000), d: "x".repeat(3000), e: "x".repeat(3000) } };
  assert.throws(() => planLaunch({ file: big, repoRoot: "/r", repo: "a/b", issue, options, configSource: "test" }), /args are \d+ bytes; pi-subagents allows 16384/);
});

/** A scripted exec: the first matching rule answers; unmatched commands fail loudly. */
function scripted(rules: [RegExp, { stdout?: string; code?: number; stderr?: string }][]) {
  const calls: ExecCall[] = [];
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o?.cwd });
    const line = `${cmd} ${args.join(" ")}`;
    const hit = rules.find(([re]) => re.test(line));
    if (!hit) throw new Error(`unexpected command: ${line}`);
    return { stdout: hit[1].stdout ?? "", stderr: hit[1].stderr ?? "", code: hit[1].code ?? 0 };
  };
  return { exec, calls, lines: () => calls.map((c) => `${c.cmd} ${c.args.join(" ")}`) };
}

const MAIN_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const repoRules = (state = "OPEN", extra: [RegExp, { stdout?: string; code?: number }][] = []): [RegExp, { stdout?: string; code?: number }][] => [
  ...extra,
  [/^git rev-parse --path-format=absolute --git-common-dir$/, { stdout: "/src/pi-crucible/.git\n" }],
  [/^git remote get-url origin$/, { stdout: "git@github.com:seandavi/pi-crucible.git\n" }],
  [/^gh issue view 4 -R seandavi\/pi-crucible/, { stdout: JSON.stringify({ number: 4, title: issue.title, state, labels: [{ name: "seam" }] }) }],
  [/^gh label list -R seandavi\/pi-crucible/, { stdout: JSON.stringify(["needs:human", "seam", "review:ux"].map((name) => ({ name }))) }],
  [/^git fetch origin$/, {}],
  [/^git rev-parse --verify --quiet refs\/remotes\/origin\/main$/, { stdout: MAIN_SHA + "\n" }],
  [/^git cat-file -e fedcba9.*:\.pi\/crucible\.json$/, {}],
  [/^git cat-file blob fedcba9.*:\.pi\/crucible\.json$/, { stdout: JSON.stringify(crucibleFile) }],
  [/^git -C .* rev-parse --abbrev-ref HEAD$/, { code: 128 }],
  [/^git for-each-ref /, { stdout: "" }],
  [/^git -C .* rev-parse HEAD$/, { stdout: "0123456789abcdef0123456789abcdef01234567\n" }],
  [/^git -C .* status --porcelain/, { stdout: "" }],
];

test("prepare reads config, issue and engine commit from the main checkout", async () => {
  const s = scripted(repoRules());
  const read = async (p: string) => {
    assert.equal(p, "/src/pi-crucible/.pi/crucible.json");
    return JSON.stringify(crucibleFile);
  };
  const plan = await prepare(s.exec, "/src/pi-crucible-worktrees/issue-3/src", options, read);
  assert.equal(plan.repoRoot, "/src/pi-crucible");
  assert.equal(plan.worktree, "/src/pi-crucible-worktrees/issue-4", "not nested in the worktree /crucible ran from");
  assert.deepEqual(plan.args.engine, { commit: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(plan.args.repo, "seandavi/pi-crucible");
  assert.equal(plan.configSource, "origin/main:.pi/crucible.json (fedcba9)");
});

test("prepare refuses invalid config and closed issues with actionable errors", async () => {
  const good = async () => JSON.stringify(crucibleFile);
  const bad: [RegExp, { stdout?: string }] = [/^git cat-file blob /, { stdout: JSON.stringify({ ...crucibleFile, lenses: { ux: "u" }, typo: true }) }];
  await assert.rejects(
    prepare(scripted(repoRules("OPEN", [bad])).exec, "/x", options, good),
    /origin\/main:\.pi\/crucible\.json \(fedcba9\) is invalid:\n- \(root\): unknown field\(s\) typo/,
  );
  const missing = async () => { throw new Error("ENOENT"); };
  await assert.rejects(
    prepare(scripted(repoRules("OPEN", [[/^git cat-file -e /, { code: 128 }]])).exec, "/x", options, missing),
    /no config to read: origin\/main has no \.pi\/crucible\.json, and \/src\/pi-crucible\/\.pi\/crucible\.json: ENOENT; \/src\/pi-crucible\/\.pi\/factory\.json: ENOENT\. Run \/crucible init/,
  );
  await assert.rejects(prepare(scripted(repoRules("CLOSED")).exec, "/x", options, good), /seandavi\/pi-crucible#4 is closed/);
});

test("the config comes from origin/main, not the main checkout's working tree", async () => {
  const differs = `/src/pi-crucible/.pi/crucible.json differs from origin/main:.pi/crucible.json (fedcba9); this run uses origin/main's. Merge the change to main to use it.`;
  const s = scripted(repoRules());
  const plan = await prepare(s.exec, "/x", options, async () => JSON.stringify({ ...crucibleFile, parent: 99 }));
  assert.equal(plan.args.parent, 1, "main's copy, not the working tree's");
  assert.equal(plan.configSource, "origin/main:.pi/crucible.json (fedcba9)");
  assert.ok(plan.warnings.includes(differs), plan.warnings.join());
  const lines = s.lines();
  assert.equal(lines.filter((l) => l === "git fetch origin").length, 1);
  assert.ok(lines.indexOf("git fetch origin") < lines.indexOf("git rev-parse --verify --quiet refs/remotes/origin/main"));

  const same = await prepare(scripted(repoRules()).exec, "/x", options, async () => JSON.stringify(crucibleFile));
  assert.ok(!same.warnings.some((w) => w.includes("differs")), same.warnings.join());
  const absent = await prepare(scripted(repoRules()).exec, "/x", options, async () => { throw new Error("ENOENT"); });
  assert.equal(absent.args.parent, 1);
  assert.deepEqual(absent.warnings.filter((w) => w.includes("crucible.json")), [], "a missing working-tree copy is not worth a warning");
});

test("the working tree is the fallback, with a warning, until origin/main has a config", async () => {
  const read = async () => JSON.stringify(crucibleFile);
  const noFile: [RegExp, { code: number }] = [/^git cat-file -e /, { code: 128 }];
  let s = scripted(repoRules("OPEN", [noFile]));
  let plan = await prepare(s.exec, "/x", options, read);
  assert.equal(plan.configSource, "/src/pi-crucible/.pi/crucible.json (working tree)");
  assert.ok(
    plan.warnings.includes(
      "origin/main has no .pi/crucible.json; using /src/pi-crucible/.pi/crucible.json (working tree), which has not been reviewed on main. Merge it to main.",
    ),
    plan.warnings.join(),
  );
  assert.ok(!s.lines().some((l) => l.startsWith("git cat-file blob")));

  s = scripted(repoRules("OPEN", [[/^git rev-parse --verify --quiet refs\/remotes\/origin\/main$/, { code: 1 }]]));
  plan = await prepare(s.exec, "/x", options, read);
  assert.ok(plan.warnings.some((w) => w.startsWith("there is no origin/main; using")), plan.warnings.join());
  assert.ok(!s.lines().some((l) => l.startsWith("git cat-file")));

  await assert.rejects(
    prepare(scripted(repoRules("OPEN", [noFile])).exec, "/x", options, async () => "{"),
    /cannot parse \/src\/pi-crucible\/\.pi\/crucible\.json \(working tree\): /,
  );
});

test("an issue that already has a branch keeps it, whatever its title says now", async () => {
  const read = async () => JSON.stringify(crucibleFile);
  const wt = "/src/pi-crucible-worktrees/issue-4";
  // Worktree present on the old slug: it decides, so --start-at review still finds its branch and spec.
  let plan = await prepare(scripted(repoRules("OPEN", [[new RegExp(`^git -C ${wt} rev-parse --abbrev-ref HEAD$`), { stdout: "issue-4-old-title\n" }]])).exec, "/x", options, read);
  assert.equal(plan.branch, "issue-4-old-title");
  assert.equal(plan.args.slug, "old-title");
  assert.deepEqual(argErrors(plan.args), []);
  // No worktree: a hand-made local branch, also listed on origin, counts once.
  const refs = "refs/heads/issue-4-by-hand\nrefs/remotes/origin/issue-4-by-hand\nrefs/remotes/origin/issue-40-other\n";
  plan = await prepare(scripted(repoRules("OPEN", [[/^git for-each-ref /, { stdout: refs }]])).exec, "/x", { ...options, startAt: "review" }, read);
  assert.equal(plan.branch, "issue-4-by-hand");
  // Several candidates: say which, rather than pick.
  await assert.rejects(
    prepare(scripted(repoRules("OPEN", [[/^git for-each-ref /, { stdout: "refs/heads/issue-4-a\nrefs/remotes/origin/issue-4-b\n" }]])).exec, "/x", options, read),
    /issue #4 has several branches \(issue-4-a, issue-4-b\)/,
  );
  // Nothing yet: the title names the branch.
  assert.equal((await prepare(scripted(repoRules()).exec, "/x", options, read)).branch, "issue-4-reviewers-always-get-the-diff");
  // A worktree on another branch (say main) does not decide anything.
  const s = scripted([[/rev-parse --abbrev-ref HEAD/, { stdout: "main\n" }], [/^git for-each-ref /, { stdout: "" }]]);
  assert.equal(await findIssueBranch(s.exec, "/src/r", "/src/r-worktrees/issue-4", 4), null);
});

test("prepare insists on needs:human and suggests the other labels", async () => {
  const read = async () => JSON.stringify(crucibleFile);
  const noLabels: [RegExp, { stdout?: string }] = [/^gh label list /, { stdout: "[]" }];
  await assert.rejects(prepare(scripted(repoRules("OPEN", [noLabels])).exec, "/x", options, read), /no "needs:human" label.*Run \/crucible init to create the labels \(or: gh label create 'needs:human' -R seandavi\/pi-crucible\)/);
  const file = { ...crucibleFile, lenses: { code: "c", ux: "u" } };
  assert.deepEqual(labelProblems(file, "o/r", ["Needs:Human"]), {
    errors: [],
    warnings: ["o/r lacks the label(s) seam, review:ux, so issues cannot ask for them. /crucible init creates them."],
  });
  assert.deepEqual(labelProblems(file, "o/r", ["needs:human", "seam", "review:ux"]), { errors: [], warnings: [] });
  const plan = await prepare(scripted(repoRules("OPEN", [[/^gh label list /, { stdout: '[{"name":"needs:human"}]' }]])).exec, "/x", options, read);
  assert.match(plan.warnings.join(), /lacks the label\(s\) seam, review:ux/);
});

test("a failed fetch is a warning, not a stop", async () => {
  const plan = await prepare(scripted(repoRules("OPEN", [[/^git fetch origin$/, { code: 1, stderr: "offline" }]])).exec, "/x", options, async () => JSON.stringify(crucibleFile));
  assert.match(plan.warnings[0], /could not fetch origin .*offline.*the config and the branch lookup used local refs/);
});

const plan = (startAt: Plan["startAt"] = "spec"): Plan => ({
  repoRoot: "/src/r", worktree: "/src/r-worktrees/issue-4", branch: "issue-4-x", startAt, configSource: "test", args: {}, warnings: [],
});

test("ensureWorktree creates a branch from origin/main, or reuses what exists", async () => {
  let s = scripted([[/^git fetch origin$/, {}], [/rev-parse --verify --quiet/, { code: 1 }], [/^git worktree add -b issue-4-x \/src\/r-worktrees\/issue-4 origin\/main$/, {}]]);
  assert.match(await ensureWorktree(s.exec, plan(), async () => false), /new branch issue-4-x from origin\/main/);

  s = scripted([[/^git fetch origin$/, {}], [/refs\/heads\/issue-4-x/, { code: 1 }], [/refs\/remotes\/origin\/issue-4-x/, {}], [/^git worktree add --track -b issue-4-x .* origin\/issue-4-x$/, {}]]);
  assert.match(await ensureWorktree(s.exec, plan("review"), async () => false), /tracking origin\/issue-4-x/);

  s = scripted([[/rev-parse --abbrev-ref HEAD/, { stdout: "issue-4-x\n" }]]);
  assert.match(await ensureWorktree(s.exec, plan(), async () => true), /^reusing/);

  s = scripted([[/rev-parse --abbrev-ref HEAD/, { stdout: "main\n" }]]);
  await assert.rejects(ensureWorktree(s.exec, plan(), async () => true), /is on "main", not issue-4-x/);

  s = scripted([[/^git fetch origin$/, {}], [/rev-parse --verify --quiet/, { code: 1 }]]);
  await assert.rejects(ensureWorktree(s.exec, plan("implement"), async () => false), /--start-at implement needs an existing branch issue-4-x/);
});

test("/crucible prepares the worktree and launches the named resource over RPC", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "pi-crucible-"));
  const { pi, commands, emitted, sent } = fakePi(({ cmd, args }) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line.includes("--git-common-dir")) return { stdout: `${repo}/.git` };
    if (line.startsWith("git remote get-url")) return { stdout: "https://github.com/seandavi/pi-crucible.git" };
    if (line.startsWith("gh issue view")) return { stdout: JSON.stringify({ number: 4, title: "Diff for reviewers", state: "OPEN", labels: [] }) };
    if (line.startsWith("gh label list")) return { stdout: JSON.stringify(["needs:human", "seam", "review:ux"].map((name) => ({ name }))) };
    if (line.includes("rev-parse HEAD")) return { stdout: "abcdef1" };
    if (line.includes("refs/remotes/origin/main")) return { stdout: "0123456789abcdef0123456789abcdef01234567" };
    if (line.startsWith("git cat-file -e")) return {};
    if (line.startsWith("git cat-file blob")) return { stdout: JSON.stringify(crucibleFile) };
    if (line.includes("--verify --quiet")) return { code: 1 };
    return {};
  });
  // The config file is read from disk by the real command; put one in the temp "repo".
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(repo, ".pi"));
  writeFileSync(path.join(repo, ".pi", "crucible.json"), JSON.stringify(crucibleFile));
  extension(pi as never);
  pi.events.on("subagents:rpc:v1:request", (req) => {
    const { requestId, method, params } = req as { requestId: string; method: string; params: Record<string, unknown> };
    assert.equal(method, "spawn");
    assert.equal(params.workflow, "pi-crucible");
    assert.equal(params.cwd, repo);
    assert.deepEqual(argErrors(params.args as Record<string, unknown>), []);
    pi.events.emit(`subagents:rpc:v1:reply:${requestId}`, { version: 1, requestId, success: true, data: { details: { asyncId: "run-42" } } });
  });
  const notes: [string, string][] = [];
  const ctx = { cwd: repo, ui: { notify: (m: string, level: string) => notes.push([level, m]) } };

  await commands.crucible.handler("4", ctx);
  assert.deepEqual(notes.map(([l]) => l), ["info", "info"], JSON.stringify(notes));
  assert.match(notes[0][1], /new branch issue-4-diff-for-reviewers from origin\/main/);
  assert.match(notes[1][1], /Crucible launched for #4 \(code\): run run-42/);
  assert.equal(emitted.filter((e) => e.channel === "subagents:rpc:v1:request").length, 1);
  // The agent hears about the launch too, without a turn of its own (#49).
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options?.deliverAs, "nextTurn");
  assert.match(sent[0].message.content, /issue #4, which launched pi-crucible run run-42/);
  assert.match(sent[0].message.content, /branch issue-4-diff-for-reviewers/);

  notes.length = 0;
  await commands.crucible.handler("4 --dry-run", ctx);
  assert.match(notes[0][1], /^Dry run: would prepare .*issue-4 on issue-4-diff-for-reviewers/);
  assert.match(notes[0][1], /\nConfig: origin\/main:\.pi\/crucible\.json \(0123456\)\n/);
  assert.equal(emitted.filter((e) => e.channel === "subagents:rpc:v1:request").length, 1, "dry run launches nothing");
  assert.equal(sent.length, 1, "dry run tells the agent nothing");

  notes.length = 0;
  await commands.crucible.handler("", ctx);
  assert.deepEqual(notes, [["error", "Usage: /crucible <issue> [--start-at implement|review] [--lens <name>]... [--dry-run]"]]);
});

test("example configs and this repo's own config are valid; the schema file is current", () => {
  for (const f of readdirSync(new URL("../examples", import.meta.url))) {
    assert.deepEqual(crucibleFileErrors(readJson(`examples/${f}`)), [], f);
  }
  assert.deepEqual(crucibleFileErrors(readJson(".pi/crucible.json")), []);
  assert.equal(readFileSync(SCHEMA_PATH, "utf8"), schemaText(), "run npm run schema");
  assert.deepEqual(engineConfigErrors({}).length > 0, true);
});

test("defaultLenses must include code, and the commit identity cannot carry shell syntax", () => {
  const lenses = { code: "c", ux: "u" };
  assert.deepEqual(crucibleFileErrors({ ...crucibleFile, lenses, defaultLenses: ["code", "ux"] }), []);
  assert.deepEqual(crucibleFileErrors({ ...crucibleFile, lenses, defaultLenses: ["ux"] }), ['/defaultLenses: must include "code"']);
  const author = (name: string, email: string) => crucibleFileErrors({ ...crucibleFile, commitAuthor: { name, email } }).length;
  assert.equal(author("Pat O'Brien", "pat@example.org"), 0);
  assert.equal(author('Sean "SD" Davis', "sd+bot@example.org"), 0);
  assert.ok(author("$(id)", "a@b.c") > 0);
  assert.ok(author("`id`", "a@b.c") > 0);
  assert.ok(author("A\nB", "a@b.c") > 0);
  assert.ok(author("A B", "a@b;git push -f origin main") > 0);
  assert.ok(author("A B", "a@b$(id)") > 0);
});

test("the pre-rename config name still works, with a warning to rename it", async () => {
  const { readCrucibleFile } = await import("../src/launcher.ts");
  // On origin/main, only the legacy name.
  const onMain = scripted([
    [/^git rev-parse --verify --quiet refs\/remotes\/origin\/main$/, { stdout: "fedcba9876\n" }],
    [/^git cat-file -e fedcba9876:\.pi\/crucible\.json$/, { code: 1 }],
    [/^git cat-file -e fedcba9876:\.pi\/factory\.json$/, {}],
    [/^git cat-file blob fedcba9876:\.pi\/factory\.json$/, { stdout: JSON.stringify(crucibleFile) }],
  ]);
  const a = await readCrucibleFile(onMain.exec, "/r", async () => { throw new Error("ENOENT"); });
  assert.equal(a.source, "origin/main:.pi/factory.json (fedcba9)");
  assert.match(a.warnings.join(), /\.pi\/factory\.json is the old name; rename it to \.pi\/crucible\.json/);
  // No origin/main: the working tree's legacy file.
  const none = scripted([[/^git rev-parse --verify --quiet refs\/remotes\/origin\/main$/, { code: 1 }]]);
  const b = await readCrucibleFile(none.exec, "/r", async (p: string) => {
    if (p.endsWith("factory.json")) return JSON.stringify(crucibleFile);
    throw new Error("ENOENT");
  });
  assert.equal(b.source, "/r/.pi/factory.json (working tree)");
  assert.match(b.warnings[0], /old name/);
});

test("/factory still works, warning that it is now /crucible", async () => {
  const { pi, commands } = fakePi();
  extension(pi as never);
  assert.ok(commands.crucible && commands.factory);
  const notes: [string, string][] = [];
  await commands.factory.handler("", { cwd: "/x", ui: { notify: (m: string, l: string) => notes.push([l, m]) } });
  assert.deepEqual(notes[0], ["warning", "/factory is now /crucible (the project was renamed pi-crucible); /factory will go away."]);
  assert.match(notes[1][1], /^Usage: \/crucible <issue>/);
});
