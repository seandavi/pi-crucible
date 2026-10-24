import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import extension from "../extensions/factory.ts";
import { argErrors, factoryResource, loadScript, RESOURCE_NAME } from "../src/resource.ts";
import { engineConfig, fakePi, validArgs } from "./fixtures.ts";

const valid = validArgs;

test("valid args resolve to the shipped script", () => {
  const script = loadScript();
  assert.match(script, /runs\.run\("spec"/);
  assert.deepEqual(factoryResource(script).resolve(valid), { script });
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
    'unknown arg "typo" (known: repo, issue, slug, worktree, branch, lenses, maxRounds, seam, startAt, parent, config, engine)',
  ]);
  const resolved = factoryResource("x").resolve({});
  assert.ok("error" in resolved && resolved.error.includes('missing required arg "config"'));
  assert.ok("error" in resolved && resolved.error.startsWith("pi-factory: missing required arg"));
});

// The extension registers through its own copy of pi-subagents; the host resolves through the copy
// pi loaded. They share one registry on globalThis, so resolve through pi-subagents' internal
// resolver here, as the subagent tool does.
test("config and engine are validated, and lenses must have config text", () => {
  assert.match(argErrors({ ...valid, config: { ...engineConfig, lenses: { ux: "x" } } }).join(), /must define the "code" lens/);
  assert.match(argErrors({ ...valid, config: { ...engineConfig, extra: 1 } }).join(), /unknown field\(s\) extra/);
  assert.match(argErrors({ ...valid, engine: { commit: "main" } }).join(), /arg "engine" must be/);
  assert.deepEqual(argErrors({ ...valid, lenses: ["code", "security"] }), ["no lens text in config.lenses for: security"]);
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
  assert.deepEqual(argErrors(valid), []);
});

test("extension registers per session and disposes on shutdown", async () => {
  const { resolveWorkflowResource } = await import(
    new URL("../node_modules/pi-subagents/src/workflows/workflow-resources.js", import.meta.url).href
  );
  const { pi, handlers } = fakePi();
  extension(pi as never);
  const ctx = { sessionManager: { getSessionId: () => "test-session" } };

  handlers.session_start({}, ctx);
  handlers.session_start({}, ctx); // reload in the same session must not throw "already registered"
  const ok = resolveWorkflowResource(RESOURCE_NAME, valid, "test-session");
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.resource.script, loadScript());
  assert.equal(ok.resource.provenance.name, RESOURCE_NAME);
  assert.equal(ok.resource.provenance.invocation, "named");

  const bad = resolveWorkflowResource(RESOURCE_NAME, { repo: "x" }, "test-session");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /missing required arg "issue"/);

  assert.equal(resolveWorkflowResource(RESOURCE_NAME, valid, "other-session").ok, false);

  handlers.session_shutdown({}, ctx);
  assert.equal(resolveWorkflowResource(RESOURCE_NAME, valid, "test-session").ok, false);
  // After disposal the name can be registered again (no leaked registration).
  registerWorkflowResource({ sessionId: "test-session", definition: factoryResource("x") }).dispose();
});
