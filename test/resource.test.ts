import { test } from "node:test";
import assert from "node:assert/strict";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import extension from "../extensions/factory.ts";
import { argErrors, factoryResource, loadScript, RESOURCE_NAME } from "../src/resource.ts";

const valid = {
  repo: "seandavi/bioc-mcp",
  issue: 2,
  slug: "scaffold",
  worktree: "/tmp/bioc-mcp-worktrees/issue-2",
  branch: "issue-2-scaffold",
  lenses: ["code", "ux"],
  maxRounds: 2,
  seam: true,
  startAt: "review",
  parent: 1,
};

test("valid args resolve to the shipped script", () => {
  const script = loadScript();
  assert.match(script, /runs\.run\("spec"/);
  assert.deepEqual(factoryResource(script).resolve(valid), { script });
});

test("only the required args are needed", () => {
  const { repo, issue, slug, worktree, branch } = valid;
  assert.deepEqual(argErrors({ repo, issue, slug, worktree, branch }), []);
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
    'unknown arg "typo" (known: repo, issue, slug, worktree, branch, lenses, maxRounds, seam, startAt, parent)',
  ]);
  const resolved = factoryResource("x").resolve({});
  assert.ok("error" in resolved && resolved.error.startsWith("pi-factory: missing required arg"));
});

// The extension registers through its own copy of pi-subagents; the host resolves through the copy
// pi loaded. They share one registry on globalThis, so resolve through pi-subagents' internal
// resolver here, as the subagent tool does.
test("extension registers per session and disposes on shutdown", async () => {
  const { resolveWorkflowResource } = await import(
    new URL("../node_modules/pi-subagents/src/workflows/workflow-resources.js", import.meta.url).href
  );
  const handlers: Record<string, (event: unknown, ctx: unknown) => void> = {};
  extension({ on: (name: string, fn: (e: unknown, c: unknown) => void) => (handlers[name] = fn) } as never);
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
