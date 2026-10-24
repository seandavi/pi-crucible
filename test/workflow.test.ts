// Runs workflows/factory.js the way the pi-subagents sandbox does (the file is the body of an async
// function of `args` and `runs`), with a fake `runs` that records every child task and answers from
// a script of structured outputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript } from "../src/resource.ts";
import { engineConfig, validArgs } from "./fixtures.ts";

type Opts = { agent: string; model: string; task: string; skill?: string; outputSchema?: { required?: string[] } };
type Answer = { ok?: boolean; structuredOutput?: unknown; error?: string };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

export async function simulate(args: Record<string, unknown>, answer: (key: string, opts: Opts) => Answer, script = loadScript()) {
  const calls: (Opts & { key: string })[] = [];
  const run = async (key: string, opts: Opts) => {
    calls.push({ key, ...opts });
    const a = answer(key, opts);
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
  if (key.startsWith("review-")) return { structuredOutput: { verdict: "approve", findings: [] } };
  if (key === "pr") return { structuredOutput: { pr_url: "https://github.com/o/r/pull/9", draft: false, followup_issue: null } };
  return { structuredOutput: {} };
};

const args = { ...validArgs, repo: "owner/repo", worktree: "/tmp/repo-worktrees/issue-2", startAt: undefined, lenses: ["code", "ux"] };

test("every stage's prompt comes from the config, not the engine", async () => {
  const { result, calls, task } = await simulate(args, happy());
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "review-code-r0", "review-ux-r0", "pr"]);
  for (const c of calls) assert.match(c.task, /The design record is README\.md\./, c.key);
  assert.match(task("spec"), /Design \(files and interfaces\)/);
  assert.match(task("implement"), /Tests never use the network\.\n/);
  assert.match(task("implement"), /- test: npm test/);
  assert.match(task("review-code-r0"), /Lens: CODE review\./);
  assert.match(task("review-ux-r0"), /Lens: UX review\./);
  assert.match(task("pr"), /Engine: seandavi\/pi-factory@4d310bf \(with uncommitted changes\)/);
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
    models: { strong: "p/strong", fast: "p/fast" },
    skills: { build: "build-skill", lenses: { code: "code-skill" } },
    commitAuthor: { name: "A B", email: "a@b.c" },
  };
  const { calls, task } = await simulate({ ...args, config }, happy());
  const by = (k: string) => calls.find((c) => c.key === k)!;
  assert.equal(by("spec").model, "p/strong");
  assert.equal(by("implement").model, "p/fast");
  assert.equal(by("pr").model, "p/fast");
  assert.equal(by("implement").skill, "build-skill");
  assert.equal(by("review-code-r0").skill, "code-skill");
  assert.equal(by("review-ux-r0").skill, undefined);
  assert.match(task("spec"), /Write design\/specs\/2-scaffold\.md/);
  assert.match(task("spec"), /git -c 'user\.name=A B' -c 'user\.email=a@b\.c' commit/);
});

test("a failing configured check makes the PR a draft", async () => {
  const { result } = await simulate(args, happy({
    implement: { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: { test: "fail" } } },
  }));
  assert.equal(result.draft, true);
});

test("blocker findings trigger revise and a re-review by that lens only", async () => {
  let round = 0;
  const { calls, task } = await simulate(args, (key, opts) => {
    if (key === "review-code-r0") return { structuredOutput: { verdict: "changes", findings: [{ id: "code-r0-1", severity: "blocker", location: "a.ts", problem: "p", fix: "f" }] } };
    if (key === "revise-r1") { round++; return { structuredOutput: { status: "done", responses: [{ id: "code-r0-1", action: "fixed" }], changed_files: ["a.ts"], checks: { test: "pass" } } }; }
    return happy()(key);
  });
  assert.equal(round, 1);
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "review-code-r0", "review-ux-r0", "revise-r1", "review-code-r1", "pr"]);
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
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "review-code-r0", "review-ux-r0", "pr"]);
  const { calls: dup } = await simulate({ ...args, lenses: ["code", "ux", "code"] }, happy());
  assert.equal(dup.filter((c) => c.key === "review-code-r0").length, 1);
});

test("every writing stage checks the worktree's HEAD before working, with the path single-quoted", async () => {
  const { calls } = await simulate({ ...args, worktree: "/tmp/my repo/issue-2" }, happy());
  const guarded = calls.filter((c) => !c.key.startsWith("flag-") && !c.key.startsWith("review-"));
  assert.deepEqual(guarded.map((c) => c.key), ["spec", "implement", "pr"]);
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
});

test("a PR stage that opens no PR, or fails, flags a human and stops", async () => {
  for (const pr of [{ structuredOutput: { pr_url: "" } }, { ok: false, error: "boom" }]) {
    const { result, calls } = await simulate(args, happy({ pr }));
    assert.equal(calls.at(-1)?.key, "flag-pr");
    assert.equal(result.stopped, true);
    assert.equal(result.stage, "pr");
  }
  const { calls } = await simulate(args, happy({ pr: { ok: false, error: "boom" } }));
  assert.match(calls.at(-1)!.task, /Stage: pr\. boom/);
});

// The regression behind the first /factory run (2fbd7098): pi-subagents gives a named resource's args
// only to resolve and starts the sandbox with empty args. Resolve the way the subagent tool does and
// run the result exactly so.
test("launched by name, the script gets its args from resolve, not the sandbox", async () => {
  const { resolveWorkflowResource } = await import(
    new URL("../node_modules/pi-subagents/src/workflows/workflow-resources.js", import.meta.url).href
  );
  const { registerWorkflowResource } = await import("pi-subagents/workflow-resources");
  const { factoryResource } = await import("../src/resource.ts");
  const reg = registerWorkflowResource({ sessionId: "by-name", definition: factoryResource(loadScript()) });
  try {
    const { startAt: _unset, ...jsonArgs } = args;
    const resolved = resolveWorkflowResource("pi-factory", jsonArgs, "by-name");
    assert.equal(resolved.ok, true, resolved.error);
    const { result, task } = await simulate({}, happy(), resolved.resource.script);
    assert.equal(result.pr, "https://github.com/o/r/pull/9");
    assert.match(task("spec"), /Repository: owner\/repo, issue #2\./);
  } finally {
    reg.dispose();
  }
});
