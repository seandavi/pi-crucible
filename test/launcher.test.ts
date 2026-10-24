import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import extension from "../extensions/factory.ts";
import { engineConfigErrors, factoryFileErrors } from "../src/config.ts";
import {
  ensureWorktree,
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
import { factoryFile, fakePi, readJson, type ExecCall } from "./fixtures.ts";

test("parseCommand reads the issue and options, and explains mistakes", () => {
  assert.deepEqual(parseCommand("12"), { issue: 12, startAt: "spec", lenses: [], dryRun: false });
  assert.deepEqual(parseCommand("#12 --start-at review --lens ux --lens=security --dry-run"), {
    issue: 12, startAt: "review", lenses: ["ux", "security"], dryRun: true,
  });
  assert.match((parseCommand("") as { error: string }).error, /^Usage: \/factory <issue>/);
  assert.match((parseCommand("12 --start-at pr") as { error: string }).error, /--start-at must be one of spec, implement, review/);
  assert.match((parseCommand("12 --lens") as { error: string }).error, /--lens needs a value/);
  assert.match((parseCommand("12 13") as { error: string }).error, /Unexpected "13"/);
});

test("slugify makes short branch-safe slugs", () => {
  assert.equal(slugify("/factory launcher and per-repo .pi/factory.json"), "factory-launcher-and-per-repo-pi-factory");
  assert.equal(slugify("Reviewers always get the diff"), "reviewers-always-get-the-diff");
  assert.equal(slugify("Ünïcode ✨"), "n-code");
  assert.equal(slugify("✨"), "issue");
  assert.ok(slugify("a".repeat(80)).length <= 40);
});

test("lenses come from defaults, review:* labels and --lens; seam from its label", () => {
  const file = { ...factoryFile, lenses: { code: "c", ux: "u", security: "s" } };
  assert.deepEqual(pickLenses(file, ["review:ux", "seam", "bug", "review:privacy"], ["security"]), {
    lenses: ["code", "ux", "security"],
    seam: true,
    warnings: ["label review:privacy names no lens in .pi/factory.json; ignored"],
  });
  assert.throws(() => pickLenses(file, [], ["perf"]), /--lens perf: no such lens \(defined: code, ux, security\)/);
});

test("worktree roots and repos resolve as documented", () => {
  assert.equal(worktreeRootFor(factoryFile, "/src/repo"), "/src/repo-worktrees");
  assert.equal(worktreeRootFor({ ...factoryFile, worktreeRoot: "~/wt" }, "/src/repo", "/home/me"), "/home/me/wt");
  assert.equal(worktreeRootFor({ ...factoryFile, worktreeRoot: "/abs" }, "/src/repo"), "/abs");
  assert.equal(repoFromRemote("git@github.com:seandavi/pi-factory.git"), "seandavi/pi-factory");
  assert.equal(repoFromRemote("https://github.com/seandavi/bioc-mcp\n"), "seandavi/bioc-mcp");
  assert.equal(repoFromRemote("https://gitlab.com/a/b"), null);
});

const issue = { number: 4, title: "Reviewers always get the diff", state: "OPEN", labels: ["review:ux", "seam"] };
const options = { issue: 4, startAt: "spec" as const, lenses: [], dryRun: false };

test("planLaunch builds args the resource accepts", () => {
  const plan = planLaunch({ file: factoryFile, repoRoot: "/src/pi-factory", repo: "seandavi/pi-factory", issue, options, engine: { commit: "abc1234" } });
  assert.equal(plan.branch, "issue-4-reviewers-always-get-the-diff");
  assert.equal(plan.worktree, "/src/pi-factory-worktrees/issue-4");
  assert.deepEqual(argErrors(plan.args), []);
  assert.deepEqual(plan.args.lenses, ["code", "ux"]);
  assert.equal(plan.args.seam, true);
  assert.equal(plan.args.parent, 1);
  assert.equal(plan.args.startAt, undefined, "spec is the default and is left out");
  assert.deepEqual(Object.keys(plan.args.config as object).sort(), ["checks", "design", "implement", "lenses", "spec"]);
  const big = { ...factoryFile, lenses: { code: "x".repeat(3000), a: "x".repeat(3000), b: "x".repeat(3000), c: "x".repeat(3000), d: "x".repeat(3000), e: "x".repeat(3000) } };
  assert.throws(() => planLaunch({ file: big, repoRoot: "/r", repo: "a/b", issue, options }), /args are \d+ bytes; pi-subagents allows 16384/);
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

const repoRules = (state = "OPEN"): [RegExp, { stdout?: string; code?: number }][] => [
  [/^git rev-parse --path-format=absolute --git-common-dir$/, { stdout: "/src/pi-factory/.git\n" }],
  [/^git remote get-url origin$/, { stdout: "git@github.com:seandavi/pi-factory.git\n" }],
  [/^gh issue view 4 -R seandavi\/pi-factory/, { stdout: JSON.stringify({ number: 4, title: issue.title, state, labels: [{ name: "seam" }] }) }],
  [/^git -C .* rev-parse HEAD$/, { stdout: "0123456789abcdef0123456789abcdef01234567\n" }],
  [/^git -C .* status --porcelain/, { stdout: "" }],
];

test("prepare reads config, issue and engine commit from the main checkout", async () => {
  const s = scripted(repoRules());
  const read = async (p: string) => {
    assert.equal(p, "/src/pi-factory/.pi/factory.json");
    return JSON.stringify(factoryFile);
  };
  const plan = await prepare(s.exec, "/src/pi-factory-worktrees/issue-3/src", options, read);
  assert.equal(plan.repoRoot, "/src/pi-factory");
  assert.equal(plan.worktree, "/src/pi-factory-worktrees/issue-4", "not nested in the worktree /factory ran from");
  assert.deepEqual(plan.args.engine, { commit: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(plan.args.repo, "seandavi/pi-factory");
});

test("prepare refuses invalid config and closed issues with actionable errors", async () => {
  const bad = async () => JSON.stringify({ ...factoryFile, lenses: { ux: "u" }, typo: true });
  await assert.rejects(prepare(scripted(repoRules()).exec, "/x", options, bad), /factory\.json is invalid:\n- \(root\): unknown field\(s\) typo/);
  const missing = async () => { throw new Error("ENOENT"); };
  await assert.rejects(prepare(scripted(repoRules()).exec, "/x", options, missing), /cannot read \/src\/pi-factory\/\.pi\/factory\.json: ENOENT/);
  const good = async () => JSON.stringify(factoryFile);
  await assert.rejects(prepare(scripted(repoRules("CLOSED")).exec, "/x", options, good), /seandavi\/pi-factory#4 is closed/);
});

const plan = (startAt: Plan["startAt"] = "spec"): Plan => ({
  repoRoot: "/src/r", worktree: "/src/r-worktrees/issue-4", branch: "issue-4-x", startAt, args: {}, warnings: [],
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

test("/factory prepares the worktree and launches the named resource over RPC", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "pi-factory-"));
  const { pi, commands, emitted } = fakePi(({ cmd, args }) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line.includes("--git-common-dir")) return { stdout: `${repo}/.git` };
    if (line.startsWith("git remote get-url")) return { stdout: "https://github.com/seandavi/pi-factory.git" };
    if (line.startsWith("gh issue view")) return { stdout: JSON.stringify({ number: 4, title: "Diff for reviewers", state: "OPEN", labels: [] }) };
    if (line.includes("rev-parse HEAD")) return { stdout: "abcdef1" };
    if (line.includes("--verify --quiet")) return { code: 1 };
    return {};
  });
  // The config file is read from disk by the real command; put one in the temp "repo".
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(repo, ".pi"));
  writeFileSync(path.join(repo, ".pi", "factory.json"), JSON.stringify(factoryFile));
  extension(pi as never);
  pi.events.on("subagents:rpc:v1:request", (req) => {
    const { requestId, method, params } = req as { requestId: string; method: string; params: Record<string, unknown> };
    assert.equal(method, "spawn");
    assert.equal(params.workflow, "pi-factory");
    assert.equal(params.cwd, repo);
    assert.deepEqual(argErrors(params.args as Record<string, unknown>), []);
    pi.events.emit(`subagents:rpc:v1:reply:${requestId}`, { version: 1, requestId, success: true, data: { details: { asyncId: "run-42" } } });
  });
  const notes: [string, string][] = [];
  const ctx = { cwd: repo, ui: { notify: (m: string, level: string) => notes.push([level, m]) } };

  await commands.factory.handler("4", ctx);
  assert.deepEqual(notes.map(([l]) => l), ["info", "info"], JSON.stringify(notes));
  assert.match(notes[0][1], /new branch issue-4-diff-for-reviewers from origin\/main/);
  assert.match(notes[1][1], /Factory launched for #4 \(code\): run run-42/);
  assert.equal(emitted.filter((e) => e.channel === "subagents:rpc:v1:request").length, 1);

  notes.length = 0;
  await commands.factory.handler("4 --dry-run", ctx);
  assert.match(notes[0][1], /^Dry run: would prepare .*issue-4 on issue-4-diff-for-reviewers/);
  assert.equal(emitted.filter((e) => e.channel === "subagents:rpc:v1:request").length, 1, "dry run launches nothing");

  notes.length = 0;
  await commands.factory.handler("", ctx);
  assert.deepEqual(notes, [["error", "Usage: /factory <issue> [--start-at implement|review] [--lens <name>]... [--dry-run]"]]);
});

test("example configs and this repo's own config are valid; the schema file is current", () => {
  for (const f of readdirSync(new URL("../examples", import.meta.url))) {
    assert.deepEqual(factoryFileErrors(readJson(`examples/${f}`)), [], f);
  }
  assert.deepEqual(factoryFileErrors(readJson(".pi/factory.json")), []);
  assert.equal(readFileSync(SCHEMA_PATH, "utf8"), schemaText(), "run npm run schema");
  assert.deepEqual(engineConfigErrors({}).length > 0, true);
});
