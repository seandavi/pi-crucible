// Runs workflows/crucible.js the way the pi-subagents sandbox does (the file is the body of an async
// function of `args` and `runs`), with a fake `runs` that records every child task and answers from
// a script of structured outputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "../src/resource.ts";
import { engineConfig, validArgs } from "./fixtures.ts";

type Opts = { agent: string; model: string; task: string; skill?: string; outputSchema?: { required?: string[] } };
// `invalid`: the test sends a report its stage's schema rejects on purpose.
type Answer = { ok?: boolean; structuredOutput?: unknown; error?: string; invalid?: true };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const { validateStructuredOutputValue } = await import(
  new URL("../node_modules/pi-subagents/src/runs/shared/structured-output.js", import.meta.url).href
);
const validates = async (schema: unknown, value: unknown) => (await validateStructuredOutputValue(schema, value)).status === "valid";

export async function simulate(args: Record<string, unknown>, answer: (key: string, opts: Opts) => Answer, script = loadScript()) {
  const calls: (Opts & { key: string })[] = [];
  const run = async (key: string, opts: Opts) => {
    calls.push({ key, ...opts });
    const a = answer(key, opts);
    if (opts.outputSchema && a.structuredOutput !== undefined) {
      // A fake flagged invalid must really be invalid, so the flag can't go stale and hide drift.
      assert.equal(await validates(opts.outputSchema, a.structuredOutput), !a.invalid, `the fake ${key} report must ${a.invalid ? "fail" : "satisfy"} its schema`);
    }
    return { ok: a.ok ?? true, structuredOutput: a.structuredOutput, error: a.error };
  };
  const runs = { run, all: (list: (Opts & { key: string })[]) => Promise.all(list.map((o) => run(o.key, o))) };
  const result = await new AsyncFunction("args", "runs", script)(args, runs);
  return { result, calls, task: (key: string) => calls.find((c) => c.key === key)?.task ?? "" };
}

const happy = (overrides: Record<string, Answer> = {}) => (key: string): Answer => {
  if (overrides[key]) return overrides[key];
  if (key === "spec") return { structuredOutput: { status: "ready", spec_path: "docs/specs/2-scaffold.md", blocking_questions: [] } };
  if (key === "implement") return { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: { test: "pass" } } };
  if (key.startsWith("diff-")) return { structuredOutput: { status: "done", summary: "", changed_files: ["a.ts", "b.ts"], diff_lines: 120 } };
  if (key.startsWith("review-")) return { structuredOutput: { verdict: "approve", findings: [] } };
  if (key === "integrate" || key === "integrate-recheck") return { structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: { test: "pass" }, failures: [] } };
  if (key === "integrate-fix") return { structuredOutput: { status: "done", summary: "renamed call", changed_files: ["a.ts"], non_test_files: ["a.ts"], checks: { test: "pass" } } };
  if (key === "pr") return { structuredOutput: { pr_url: "https://github.com/o/r/pull/9", draft: false, followup_issue: null } };
  return { structuredOutput: {} };
};

const args = { ...validArgs, repo: "owner/repo", worktree: "/tmp/repo-worktrees/issue-2", startAt: undefined, lenses: ["code", "ux"] };

test("every stage's prompt comes from the config, not the engine", async () => {
  const { result, calls, task } = await simulate(args, happy());
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "integrate", "pr"]);
  for (const c of calls) assert.match(c.task, /The design record is README\.md\./, c.key);
  assert.match(task("spec"), /Design \(files and interfaces\)/);
  assert.match(task("implement"), /Tests never use the network\.\n/);
  assert.match(task("implement"), /- test: npm test/);
  assert.match(task("review-code-r0"), /Lens: CODE review\./);
  assert.match(task("review-ux-r0"), /Lens: UX review\./);
  assert.match(task("pr"), /Engine: seandavi\/pi-crucible@4d310bf \(with uncommitted changes\)/);
  assert.match(task("spec"), /Commit with: git commit\n/, "no commitAuthor: the worktree's identity");
  const all = calls.map((c) => c.task).join("\n");
  assert.doesNotMatch(all, /bioc|zod|MCP tool|workers-best-practices|seandavi@/i);
  assert.equal(calls.find((c) => c.key === "implement")?.skill, undefined);
  assert.deepEqual(calls.find((c) => c.key === "implement")?.outputSchema && (calls.find((c) => c.key === "implement")!.outputSchema as { properties: { checks: { required: string[] } } }).properties.checks.required, ["test"]);
  assert.equal(result.pr, "https://github.com/o/r/pull/9");
  assert.equal(result.draft, false);
  assert.deepEqual(result.engine, { commit: "4d310bf", dirty: true });
});

test("the commit identity is single-quoted, so no part of it reaches the shell", async () => {
  const config = { ...engineConfig, commitAuthor: { name: "Pat O'Brien", email: "pat@example.org" } };
  const { task } = await simulate({ ...args, config }, happy());
  assert.ok(task("spec").includes(`git -c 'user.name=Pat O'\\''Brien' -c 'user.email=pat@example.org' commit`));
});

test("models, skills, commit identity and spec dir follow the config", async () => {
  const config = {
    ...engineConfig,
    specDir: "design/specs",
    models: { strong: "p/strong", fast: "p/fast", small: "p/small" },
    skills: { build: "build-skill", lenses: { code: "code-skill" } },
    commitAuthor: { name: "A B", email: "a@b.c" },
  };
  const failingIntegrate = { structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: { test: "fail" }, failures: [] } };
  const { calls, task } = await simulate({ ...args, config }, happy({ integrate: failingIntegrate }));
  const by = (k: string) => calls.find((c) => c.key === k)!;
  assert.equal(by("integrate").model, "p/small");
  assert.equal(by("integrate-recheck").model, "p/small");
  assert.equal(by("integrate-fix").model, "p/fast");
  assert.equal(by("integrate-fix").skill, "build-skill");
  assert.equal(by("spec").model, "p/strong");
  assert.equal(by("implement").model, "p/fast");
  assert.equal(by("pr").model, "p/fast");
  assert.equal(by("diff-r0").model, "p/small");
  assert.equal(by("implement").skill, "build-skill");
  assert.equal(by("review-code-r0").skill, "code-skill");
  assert.equal(by("review-ux-r0").skill, undefined);
  assert.match(task("spec"), /Write design\/specs\/2-scaffold\.md/);
  assert.match(task("spec"), /git -c 'user\.name=A B' -c 'user\.email=a@b\.c' commit/);
});

test("the checks the PR reports are the integration's", async () => {
  const failing = { structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: { test: "fail" }, failures: [{ check: "test", output: "x" }] } };
  const implementFails = { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: { test: "fail" } } };
  const passes = await simulate(args, happy({ implement: implementFails }));
  assert.equal(passes.result.checks.test, "pass");
  assert.equal(passes.result.draft, false);
  const fails = await simulate(args, happy({ implement: implementFails, integrate: failing, "integrate-recheck": failing }));
  assert.equal(fails.result.checks.test, "fail");
  assert.equal(fails.result.draft, true);
  assert.equal(fails.result.integration.status, "fail");
});

test("blocker findings trigger revise and a re-review by that lens only", async () => {
  let round = 0;
  const { calls, task } = await simulate(args, (key, opts) => {
    if (key === "review-code-r0") return { structuredOutput: { verdict: "changes", findings: [{ id: "code-r0-1", severity: "blocker", location: "a.ts", problem: "p", fix: "f" }] } };
    if (key === "revise-r1") { round++; return { structuredOutput: { status: "done", summary: "s", responses: [{ id: "code-r0-1", action: "fixed" }], changed_files: ["a.ts"], checks: { test: "pass" } } }; }
    return happy()(key);
  });
  assert.equal(round, 1);
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "revise-r1", "diff-r1", "review-code-r1", "integrate", "pr"]);
  assert.match(task("revise-r1"), /- test: npm test/);
});

test("a spec with blocking questions stops and flags a human", async () => {
  const { result, calls } = await simulate(args, happy({
    spec: { structuredOutput: { status: "blocked", spec_path: "x", blocking_questions: ["Which DB?"] } },
  }));
  assert.deepEqual(calls.map((c) => c.key), ["spec", "flag-spec"]);
  assert.match(calls[1].task, /Which DB\?/);
  assert.equal(result.stopped, true);
});

test("the script refuses to run without config or with a lens it has no text for", async () => {
  await assert.rejects(simulate({ ...args, config: undefined }, happy()), /args\.config is required/);
  await assert.rejects(simulate({ ...args, lenses: ["security"] }, happy()), /no lens text in config for: security/);
});

test("code review runs whatever lenses a hand launch names", async () => {
  const { calls } = await simulate({ ...args, lenses: ["ux"] }, happy());
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "integrate", "pr"]);
  const { calls: dup } = await simulate({ ...args, lenses: ["code", "ux", "code"] }, happy());
  assert.equal(dup.filter((c) => c.key === "review-code-r0").length, 1);
});

test("every writing stage checks the worktree's HEAD before working, with the path single-quoted", async () => {
  const { calls } = await simulate({ ...args, worktree: "/tmp/my repo/issue-2" }, happy());
  const guarded = calls.filter((c) => !c.key.startsWith("flag-") && !c.key.startsWith("review-"));
  assert.deepEqual(guarded.map((c) => c.key), ["spec", "implement", "diff-r0", "integrate", "pr"]);
  for (const c of guarded) {
    assert.match(c.task, /BEFORE ANYTHING ELSE run: git -C '\/tmp\/my repo\/issue-2' rev-parse --abbrev-ref HEAD\nIf the output is not exactly issue-2-scaffold, change nothing and stop/, c.key);
    assert.doesNotMatch(c.task, /\/tmp\/my repo\/issue-2(?<!')[ \n]/, c.key);
  }
});

test("a stop creates the needs:human label if the repository lacks it, and reports whether it flagged", async () => {
  const { result, task } = await simulate(args, happy({
    spec: { structuredOutput: { status: "blocked", spec_path: "x", blocking_questions: ["Which DB?"] } },
  }));
  assert.match(task("flag-spec"), /gh label create needs:human -R owner\/repo --description "Waiting on a person" 2>\/dev\/null \|\| true\n\s+gh issue edit 2 -R owner\/repo --add-label needs:human/);
  assert.doesNotMatch(task("flag-spec"), /rev-parse/, "flagging must work even when the worktree is wrong");
  assert.equal(result.flagged, true);
  const failed = await simulate(args, (key, o) => (key === "flag-spec" ? { ok: false } : happy({ spec: { structuredOutput: { status: "blocked", spec_path: "x", blocking_questions: [] } } })(key)));
  assert.equal(failed.result.flagged, false);
});

test("the PR stage creates the needs:human label before adding it", async () => {
  const { task } = await simulate(args, happy());
  assert.match(task("pr"), /gh label create needs:human -R owner\/repo --description "Waiting on a person" 2>\/dev\/null \|\| true\n\s+gh pr edit issue-2-scaffold -R owner\/repo --add-label needs:human/);
});

test("only the writing stages run the worktree check; reviewers have no shell", async () => {
  const { calls } = await simulate(args, happy());
  for (const c of calls) {
    const writes = !c.key.startsWith("review-");
    assert.equal(/rev-parse --abbrev-ref HEAD/.test(c.task), writes, c.key);
  }
  assert.ok(calls.some((c) => c.key === "diff-r0"));
});

test("a PR stage that opens no PR, or fails, flags a human and stops", async () => {
  for (const pr of [{ structuredOutput: { pr_url: "", followup_issue: null } }, { ok: false, error: "boom" }]) {
    const { result, calls } = await simulate(args, happy({ pr }));
    assert.equal(calls.at(-1)?.key, "flag-pr");
    assert.equal(result.stopped, true);
    assert.equal(result.stage, "pr");
  }
  const { calls } = await simulate(args, happy({ pr: { ok: false, error: "boom" } }));
  assert.match(calls.at(-1)!.task, /Stage: pr\. boom/);
});

const dir = "/tmp/repo-worktrees/issue-2/.pi/crucible-review";
const blockerOnCode = (key: string): Answer =>
  key === "review-code-r0"
    ? { structuredOutput: { verdict: "changes", findings: [{ id: "code-r0-1", severity: "blocker", location: "a.ts:1", problem: "p", fix: "f" }] } }
    : key === "revise-r1"
      ? { structuredOutput: { status: "done", summary: "s", responses: [{ id: "code-r0-1", action: "fixed" }], changed_files: ["a.ts"], checks: { test: "pass" } } }
      : happy()(key);

test("before each review round a Haiku worker writes an ignored diff file", async () => {
  const { calls, task } = await simulate(args, happy());
  const diff = calls.find((c) => c.key === "diff-r0")!;
  assert.equal(diff.agent, "worker");
  assert.equal(diff.model, "claude-bridge/claude-haiku-5-5");
  assert.ok(task("diff-r0").includes(`printf '*\\n' > '${dir}/.gitignore'\n`));
  assert.ok(task("diff-r0").includes(`git -C '/tmp/repo-worktrees/issue-2' diff --no-color --no-ext-diff --stat=200 origin/main...HEAD > '${dir}/r0.diff'\n`));
  assert.ok(task("diff-r0").includes(`git -C '/tmp/repo-worktrees/issue-2' diff --no-color --no-ext-diff origin/main...HEAD >> '${dir}/r0.diff'\n`));
  assert.ok(task("diff-r0").includes(`mkdir -p '${dir}'\n`));
  assert.ok(task("diff-r0").includes(`wc -l < '${dir}/r0.diff'\n`));
  assert.ok(task("diff-r0").includes("git -C '/tmp/repo-worktrees/issue-2' diff --name-only origin/main...HEAD\n"));
  const at = (k: string) => calls.findIndex((c) => c.key === k);
  assert.ok(at("diff-r0") < at("review-code-r0") && at("diff-r0") < at("review-ux-r0"));
});

test("every reviewer reads the round's diff and cites hunks", async () => {
  const { task } = await simulate(args, happy());
  for (const key of ["review-code-r0", "review-ux-r0"]) {
    assert.ok(task(key).includes(`${dir}/r0.diff`), key);
    assert.ok(task(key).includes("(120 lines)"), key);
    assert.ok(task(key).includes("Changed files: a.ts, b.ts."), key);
    assert.match(task(key), /continuing with offset/, key);
    assert.match(task(key), /"path:line"/, key);
    assert.doesNotMatch(task(key), /--name-only/, key);
  }
});

test("each re-review round gets a fresh diff", async () => {
  const { task } = await simulate(args, blockerOnCode);
  assert.ok(task("diff-r1").includes("r1.diff"));
  assert.ok(task("review-code-r1").includes(`${dir}/r1.diff`));
  assert.ok(!task("review-code-r1").includes("r0.diff"));
});

test("a failed diff step degrades the review and does not stop the run", async () => {
  const cases: [Answer, string][] = [
    [{ ok: false, error: "boom" }, "unavailable: boom"],
    [{ structuredOutput: { status: "blocked", summary: "wrong branch" } }, "unavailable: wrong branch"],
  ];
  for (const [diff, record] of cases) {
    const { result, calls, task } = await simulate(args, happy({ "diff-r0": diff }));
    assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "integrate", "pr"]);
    assert.match(task("review-code-r0"), /could not be prepared/);
    assert.ok(task("review-code-r0").includes("the changed files: a.ts"));
    assert.ok(!task("review-code-r0").includes(".pi/crucible-review"));
    assert.equal(result.rounds[0].diff, record);
    assert.ok(task("pr").includes(record));
  }
});

test("the crucible record shows the diff each round read", async () => {
  const { result, task } = await simulate(args, happy());
  assert.equal(result.rounds[0].diff, ".pi/crucible-review/r0.diff (120 lines, 2 files)");
  assert.ok(task("pr").includes("the diff the"));
  assert.ok(task("pr").includes('"diff":".pi/crucible-review/r0.diff (120 lines, 2 files)"'));
});

test("on --start-at review the reviewers get git's file list", async () => {
  const { calls, task } = await simulate({ ...args, startAt: "review" }, happy());
  assert.deepEqual(calls.map((c) => c.key), ["diff-r0", "review-code-r0", "review-ux-r0", "integrate", "pr"]);
  assert.ok(task("review-code-r0").includes("Changed files: a.ts, b.ts."));
});

// The regression behind the first /crucible run (2fbd7098): pi-subagents gives a named resource's args
// only to resolve and starts the sandbox with empty args. Resolve the way the subagent tool does and
// run the result exactly so.
test("launched by name, the script gets its args from resolve, not the sandbox", async () => {
  const { resolveWorkflowResource } = await import(
    new URL("../node_modules/pi-subagents/src/workflows/workflow-resources.js", import.meta.url).href
  );
  const { registerWorkflowResource } = await import("pi-subagents/workflow-resources");
  const { crucibleResource } = await import("../src/resource.ts");
  const reg = registerWorkflowResource({ sessionId: "by-name", definition: crucibleResource(loadScript()) });
  try {
    const { startAt: _unset, ...jsonArgs } = args;
    const resolved = resolveWorkflowResource("pi-crucible", jsonArgs, "by-name");
    assert.equal(resolved.ok, true, resolved.error);
    const { result, task } = await simulate({}, happy(), resolved.resource.script);
    assert.equal(result.pr, "https://github.com/o/r/pull/9");
    assert.match(task("spec"), /Repository: owner\/repo, issue #2\./);
  } finally {
    reg.dispose();
  }
});

// ---- Integration (#5) ------------------------------------------------------------------
const mergeLine = "  git -C '/tmp/repo-worktrees/issue-2' merge --no-edit -m 'Merge origin/main into issue-2-scaffold for the integration check' -m 'Co-Authored-By: Claude <noreply@anthropic.com>' origin/main\n";
const integrateAnswer = (extra: Record<string, unknown>): Answer => ({
  structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: { test: "pass" }, failures: [], ...extra },
});
// A conflict report leaves out checks and failures.
const conflict: Answer = { structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "conflict", conflicts: ["src/tools.ts"] } };
const failingTest = (output = "boom") => integrateAnswer({ checks: { test: "fail" }, failures: [{ check: "test", output }] });
const keysOf = (calls: { key: string }[]) => calls.map((c) => c.key);

test("after review, a Haiku worker merges main and runs every check", async () => {
  const { calls, task } = await simulate(args, happy());
  const integrate = calls.find((c) => c.key === "integrate")!;
  assert.equal(integrate.agent, "worker");
  assert.equal(integrate.model, "claude-bridge/claude-haiku-5-5");
  const keys = keysOf(calls);
  assert.equal(keys.indexOf("integrate"), keys.length - 2);
  assert.equal(keys.at(-1), "pr");
  assert.ok(keys.indexOf("integrate") > keys.lastIndexOf("review-ux-r0"));
  assert.ok(task("integrate").includes("  git -C '/tmp/repo-worktrees/issue-2' fetch origin\n"));
  assert.ok(task("integrate").includes("  git -C '/tmp/repo-worktrees/issue-2' rev-parse --short origin/main\n"));
  assert.ok(task("integrate").includes(mergeLine));
  assert.match(task("integrate"), /merge --abort/);
  assert.match(task("integrate"), /- test: npm test/);
  assert.match(task("integrate"), /the one exception to "never/);
  assert.match(task("integrate"), /BEFORE ANYTHING ELSE run: git -C '[^']+' rev-parse --abbrev-ref HEAD/);
  const checksSchema = (integrate.outputSchema as unknown as { properties: { checks: { required: string[]; properties: { test: { enum: string[] } } } } }).properties.checks;
  assert.deepEqual(checksSchema.required, ["test"]);
  assert.deepEqual(checksSchema.properties.test.enum, ["pass", "fail"]);

  const config = { ...engineConfig, commitAuthor: { name: "Pat O'Brien", email: "pat@example.org" } };
  const authored = await simulate({ ...args, config }, happy());
  assert.ok(authored.task("integrate").includes("git -c 'user.name=Pat O'\\''Brien' -c 'user.email=pat@example.org' -C '/tmp/repo-worktrees/issue-2' merge --no-edit"));
});

test("a clean integration needs no fix", async () => {
  const { result, calls, task } = await simulate(args, happy());
  assert.deepEqual(keysOf(calls).slice(-2), ["integrate", "pr"]);
  assert.deepEqual(result.integration, { status: "pass", main: "c57139f", merge: "merged", conflicts: [], failing: [], checks: { test: "pass" }, firstAttempt: null, fix: null, reReview: null, note: "" });
  assert.deepEqual(result.checks, { test: "pass" });
  assert.ok(task("pr").includes(JSON.stringify(result.integration)));
  assert.match(task("pr"), /"Integration" line/);
  assert.match(task("pr"), /Does not integrate with main:/);
  assert.equal(result.draft, false);
});

test("a conflict gets one fix round, a re-check and a code re-review", async () => {
  const { result, calls, task } = await simulate(args, happy({ integrate: conflict }));
  assert.deepEqual(keysOf(calls), ["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "integrate", "integrate-fix", "integrate-recheck", "diff-r1", "review-code-r1", "pr"]);
  assert.equal(calls.find((c) => c.key === "integrate-fix")!.model, "claude-bridge/claude-sonnet-5-5");
  const fix = task("integrate-fix");
  assert.match(fix, /conflicts in: src\/tools\.ts/);
  assert.ok(fix.includes(mergeLine.trim()));
  assert.match(fix, /--no-edit --cleanup=strip/);
  assert.match(fix, /Tests never use the network\./);
  assert.match(fix, /never revert or weaken main's changes/);
  assert.match(fix, /- test: npm test/);
  assert.match(fix, /docs\/specs\/2-scaffold\.md/);
  assert.match(task("review-code-r1"), /INTEGRATION FIX/);
  assert.match(task("review-code-r1"), /conflicted in src\/tools\.ts/);
  assert.ok(task("review-code-r1").includes("/.pi/crucible-review/r1.diff"));
  assert.deepEqual(result.rounds.at(-1), { round: 1, lenses: ["code"], diff: ".pi/crucible-review/r1.diff (120 lines, 2 files)", blocking: 0, after: "integration fix" });
  assert.equal(result.integration.reReview, 1);
  assert.equal(result.integration.status, "pass");
  assert.deepEqual(result.integration.conflicts, [], "the record is the re-check's");
  assert.deepEqual(result.integration.firstAttempt.conflicts, ["src/tools.ts"]);
  assert.equal(result.draft, false);
});

test("failing checks after the merge: the fix gets their output", async () => {
  const { result, task } = await simulate(args, happy({ integrate: failingTest("x".repeat(5000) + "END") }));
  assert.match(task("integrate-fix"), /these checks fail after it: test/);
  assert.ok(task("integrate-fix").includes("END"));
  assert.ok(!task("integrate-fix").includes("x".repeat(3001)));
  assert.ok(task("integrate-fix").includes("x".repeat(2997) + "END"));
  assert.deepEqual(result.integration.failing, [], "the re-check passed");
  assert.deepEqual(result.integration.firstAttempt.failing, ["test"]);
});

test("a fix that touched only tests is not re-reviewed", async () => {
  const testOnly = { structuredOutput: { status: "done", summary: "fixture", changed_files: ["test/a.test.ts"], non_test_files: [], checks: { test: "pass" } } };
  const { result, calls } = await simulate(args, happy({ integrate: failingTest(), "integrate-fix": testOnly }));
  assert.deepEqual(keysOf(calls).slice(-4), ["integrate", "integrate-fix", "integrate-recheck", "pr"]);
  assert.equal(result.integration.reReview, null);
  const noField = { structuredOutput: { status: "done", summary: "fixture", changed_files: ["a.ts"], checks: { test: "pass" } } };
  const fallback = await simulate(args, happy({ integrate: failingTest(), "integrate-fix": noField }));
  assert.ok(keysOf(fallback.calls).includes("review-code-r1"));
  assert.equal(fallback.result.integration.reReview, 1);
});

test("the integration re-review follows the last revise round", async () => {
  const { calls, task } = await simulate(args, (key) => (key === "integrate" ? failingTest() : blockerOnCode(key)));
  const keys = keysOf(calls);
  assert.deepEqual(keys.slice(keys.indexOf("review-code-r1")), ["review-code-r1", "integrate", "integrate-fix", "integrate-recheck", "diff-r2", "review-code-r2", "pr"]);
  assert.match(task("review-code-r2"), /"code-r2-<n>"/);
});

test("integration re-review findings add to earlier findings and make a draft", async () => {
  const finding = (id: string, severity: string) => ({ id, severity, location: "a.ts:1", problem: "p", fix: "f" });
  const run = (withMinor: boolean) => simulate({ ...args, maxRounds: 1 }, (key) => {
    if (key === "review-code-r0") return { structuredOutput: { verdict: "changes", findings: [finding("code-r0-1", "blocker")] } };
    if (key === "review-ux-r0") return { structuredOutput: { verdict: "changes", findings: [finding("ux-r0-1", "major")] } };
    if (key === "revise-r1") return { structuredOutput: { status: "done", summary: "s", responses: [], changed_files: ["a.ts"], checks: { test: "pass" } } };
    if (key === "review-code-r1") return { structuredOutput: { verdict: "changes", findings: [finding("code-r1-1", "blocker")] } };
    if (key === "review-ux-r1") return { structuredOutput: { verdict: "changes", findings: [finding("ux-r1-1", "major")] } };
    if (key === "review-code-r2") return { structuredOutput: { verdict: "changes", findings: [finding("code-r2-1", "major"), ...(withMinor ? [finding("code-r2-2", "minor")] : [])] } };
    if (key === "integrate") return failingTest();
    return happy()(key);
  });
  const { result, calls } = await run(true);
  assert.ok(keysOf(calls).includes("review-code-r2"));
  assert.deepEqual(result.unresolved.map((f: { id: string }) => f.id), ["code-r1-1", "ux-r1-1", "code-r2-1"]);
  assert.equal(result.draft, true);
  const without = await run(false);
  assert.equal(result.followUps, without.result.followUps + 1);
});

test("an approving integration re-review does not clear earlier code findings", async () => {
  const finding = (id: string) => ({ id, severity: "blocker", location: "a.ts:1", problem: "p", fix: "f" });
  const { result } = await simulate({ ...args, maxRounds: 1 }, (key) => {
    if (key === "review-code-r0") return { structuredOutput: { verdict: "changes", findings: [finding("code-r0-1")] } };
    if (key === "revise-r1") return { structuredOutput: { status: "done", summary: "s", responses: [], changed_files: ["a.ts"], checks: { test: "pass" } } };
    if (key === "review-code-r1") return { structuredOutput: { verdict: "changes", findings: [finding("code-r1-1")] } };
    if (key === "integrate") return failingTest();
    return happy()(key);
  });
  assert.equal(result.integration.reReview, 2);
  assert.deepEqual(result.unresolved.map((f: { id: string }) => f.id), ["code-r1-1"]);
  assert.equal(result.draft, true);
});

test("integration that cannot run, or a fix that fails, opens a draft without flagging", async () => {
  const noRun = await simulate(args, happy({ integrate: { ok: false, error: "boom" } }));
  assert.deepEqual(keysOf(noRun.calls).slice(-2), ["integrate", "pr"]);
  assert.equal(noRun.result.integration.status, "error");
  assert.equal(noRun.result.integration.note, "boom");
  assert.equal(noRun.result.draft, true);
  assert.ok(!keysOf(noRun.calls).some((k) => k.startsWith("flag-")));
  assert.match(noRun.task("pr"), /Does not integrate with main:/);

  const blocked = { structuredOutput: { status: "blocked", summary: "cannot" } };
  const failedFix = await simulate(args, happy({ integrate: failingTest(), "integrate-fix": blocked }));
  assert.deepEqual(keysOf(failedFix.calls).slice(-3), ["integrate", "integrate-fix", "pr"]);
  assert.equal(failedFix.result.integration.status, "fail");
  assert.equal(failedFix.result.integration.fix.status, "blocked");
  assert.equal(failedFix.result.integration.fix.summary, "cannot");
  assert.equal(failedFix.result.draft, true);

  const stillFailing = await simulate(args, happy({ integrate: failingTest(), "integrate-recheck": failingTest() }));
  assert.equal(stillFailing.result.integration.status, "fail");
  assert.equal(stillFailing.result.draft, true);

  const recheckGone = await simulate(args, happy({ integrate: failingTest(), "integrate-recheck": { ok: false, error: "gone" } }));
  assert.equal(recheckGone.result.integration.status, "error");
  assert.equal(recheckGone.result.integration.note, "re-check: gone");
});

test("only the integration stages may merge", async () => {
  const { calls } = await simulate(args, happy({ integrate: conflict }));
  const merging = calls.filter((c) => c.task.includes("merge --no-edit")).map((c) => c.key);
  assert.deepEqual(merging, ["integrate", "integrate-fix", "integrate-recheck"]);
  for (const c of calls) assert.match(c.task, /never merge/, c.key);
});

test("a PR stage stop still reports the integration", async () => {
  const { result } = await simulate(args, happy({ pr: { ok: false, error: "boom" } }));
  assert.equal(result.stopped, true);
  assert.equal(result.integration.status, "pass");
});

test("with no checks configured, stages say so and integration still passes", async () => {
  const config = { ...engineConfig, checks: [] };
  const { result, task } = await simulate({ ...args, config }, (key, opts) => {
    if (key === "implement") return { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: {} } };
    if (key === "integrate") return { structuredOutput: { status: "done", summary: "", main: "abc1234", merge: "up-to-date", conflicts: [], checks: {} } };
    return happy()(key);
  });
  assert.match(task("implement"), /\(none configured: say so in summary/);
  assert.equal(result.draft, false);
  assert.equal(result.integration.status, "pass");
});

// ---- Strict stage outputs (#56) --------------------------------------------------------
// The stray report from factory-control run 91a2b4ec: a second structured_output call, last one wins.
const stray = { status: "done", pr_url: "" };

test("every stage schema is closed, so the stray second report is rejected", async () => {
  const { calls } = await simulate(args, happy({ integrate: conflict }));
  const closed = (schema: Record<string, unknown>, where: string): void => {
    if (schema.type === "object") assert.equal(schema.additionalProperties, false, where);
    for (const [k, v] of Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>)) closed(v, `${where}.${k}`);
    if (schema.items) closed(schema.items as Record<string, unknown>, `${where}[]`);
  };
  const withSchema = calls.filter((c) => c.outputSchema);
  assert.deepEqual(withSchema.map((c) => c.key), ["spec", "implement", "diff-r0", "review-code-r0", "review-ux-r0", "integrate", "integrate-fix", "integrate-recheck", "diff-r1", "review-code-r1", "pr"]);
  for (const c of withSchema) {
    closed(c.outputSchema as Record<string, unknown>, c.key);
    assert.equal(await validates(c.outputSchema, stray), false, c.key);
    assert.match(c.task, /Call structured_output once, as your last step, with the whole report\. A later call replaces an\nearlier one\. If a call is rejected, fix the report and call it again\./, c.key);
  }
  const integrate = calls.find((c) => c.key === "integrate")!.outputSchema;
  assert.equal(await validates(integrate, happy()("integrate").structuredOutput), true);
  assert.equal(await validates(integrate, { status: "blocked", summary: "git fetch failed" }), true, "a blocked report invents nothing");
  assert.equal(await validates(integrate, { status: "done", summary: "", checks: { test: "pass", lint: "pass" } }), false, "no unknown check");
});

test("a done integration report without its checks is a stage error, never a fix round", async () => {
  for (const out of [stray, { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: {}, failures: [] }]) {
    const { result, calls, task } = await simulate(args, happy({ integrate: { structuredOutput: out, invalid: true } }));
    assert.deepEqual(keysOf(calls).slice(-2), ["integrate", "pr"]);
    assert.equal(result.integration.status, "error");
    assert.match(result.integration.note, /^integrate reported "done" without: .*checks/);
    assert.deepEqual(result.integration.failing, []);
    assert.equal(result.draft, true);
    assert.match(task("pr"), /Does not integrate with main:/);
  }
  const { result } = await simulate(args, happy({ integrate: { structuredOutput: stray, invalid: true } }));
  assert.equal(result.integration.note, 'integrate reported "done" without: main, merge, checks');
  assert.ok(keysOf((await simulate(args, happy({ integrate: conflict }))).calls).includes("integrate-fix"), "a conflict carries no checks");
  const noFailures = await simulate(args, happy({ integrate: { structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: { test: "fail" } } } }));
  assert.equal(noFailures.result.integration.note, 'integrate reported "done" without: failures');

  const recheck = await simulate(args, happy({ integrate: failingTest(), "integrate-recheck": { ...integrateAnswer({ checks: {} }), invalid: true } }));
  assert.deepEqual(recheck.result.integration, {
    status: "error",
    main: null,
    merge: null,
    conflicts: [],
    failing: [],
    checks: { test: "pass" },
    firstAttempt: { main: "c57139f", merge: "merged", conflicts: [], failing: ["test"], checks: { test: "fail" } },
    fix: { status: "done", summary: "renamed call", changed_files: ["a.ts"], non_test_files: ["a.ts"] },
    reReview: 1,
    note: 're-check: integrate reported "done" without: checks.test',
  });
});

test("an all-pass integration report needs no failures", async () => {
  const { result, calls } = await simulate(args, happy({ integrate: { structuredOutput: { status: "done", summary: "", main: "c57139f", merge: "merged", conflicts: [], checks: { test: "pass" } } } }));
  assert.deepEqual(keysOf(calls).slice(-2), ["integrate", "pr"]);
  assert.equal(result.integration.status, "pass");
  assert.equal(result.draft, false);
});

test("a recheck that changes the result updates the record", async () => {
  const recheck = integrateAnswer({ main: "d00d00d", merge: "up-to-date" });
  const { result, task } = await simulate(args, happy({ integrate: failingTest(), "integrate-recheck": recheck }));
  assert.equal(result.integration.status, "pass");
  assert.equal(result.integration.main, "d00d00d");
  assert.equal(result.integration.merge, "up-to-date");
  assert.deepEqual(result.integration.failing, []);
  assert.deepEqual(result.integration.checks, { test: "pass" });
  assert.deepEqual(result.integration.firstAttempt, { main: "c57139f", merge: "merged", conflicts: [], failing: ["test"], checks: { test: "fail" } });
  assert.ok(task("pr").includes(JSON.stringify(result.integration)));
  assert.match(task("pr"), /when firstAttempt is not null/);
  assert.match(task("pr"), /every string a stage reported \(diffs, errors, notes, summaries, revise responses\) in\n\s+inline code/);
  assert.match(task("review-code-r1"), /origin\/main \(c57139f\) was merged\ninto the branch and these checks failed: test/);

  const same = await simulate(args, happy({ integrate: failingTest(), "integrate-recheck": failingTest() }));
  assert.equal(same.result.integration.status, "fail");
  assert.deepEqual(same.result.integration.failing, ["test"]);
  assert.equal(same.result.integration.firstAttempt, null, "kept only when it differs");
});

test("other stages' done reports without the fields the script reads take their error paths", async () => {
  const impl = await simulate(args, happy({ implement: { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"] } } }));
  assert.deepEqual(keysOf(impl.calls), ["spec", "implement", "flag-implement"]);
  assert.match(impl.task("flag-implement"), /Stage: implement\. implement reported "done" without: checks/);

  const diff = await simulate(args, happy({ "diff-r0": { structuredOutput: { status: "done", summary: "", changed_files: [] } } }));
  assert.equal(diff.result.rounds[0].diff, 'unavailable: diff reported "done" without: diff_lines');

  const revise = await simulate(args, (key) => (key === "revise-r1" ? { structuredOutput: { status: "done", summary: "", responses: [] } } : blockerOnCode(key)));
  assert.deepEqual(revise.result.rounds[1], { round: 1, stopped: true, error: 'revise reported "done" without: changed_files, checks' });

  const fix = await simulate(args, happy({ integrate: failingTest(), "integrate-fix": { structuredOutput: { status: "done", summary: "", checks: { test: "pass" } } } }));
  assert.ok(!keysOf(fix.calls).includes("integrate-recheck"));
  assert.equal(fix.result.integration.fix.summary, 'integrate-fix reported "done" without: changed_files');
});
