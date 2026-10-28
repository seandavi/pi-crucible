import { test } from "node:test";
import assert from "node:assert/strict";
import { crucibleFileErrors } from "../src/config.ts";
import { AGENT_DOCS, detectChecks, init, parseInit, starterAgentsMd, starterConfig, wantedLabels } from "../src/init.ts";
import type { Exec } from "../src/launcher.ts";

test("parseInit takes --write and --dry-run only", () => {
  assert.deepEqual(parseInit([]), { write: false, dryRun: false });
  assert.deepEqual(parseInit(["--write", "--dry-run"]), { write: true, dryRun: true });
  assert.match((parseInit(["--force"]) as { error: string }).error, /Unexpected "--force"\. Usage: \/crucible init/);
});

test("checks are detected from package.json, justfile, pyproject.toml and Makefile, one per name", () => {
  assert.deepEqual(
    detectChecks({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc", build: "x" } }),
      justfile: "default:\n    @just --list\n\ntest:\n    uv run pytest\n\ncheck *flags:\n    ruff check\n",
      "pyproject.toml": '[dependency-groups]\ndev = ["pytest", "ruff"]\n',
      Makefile: "lint:\n\techo\n",
    }),
    [
      { name: "typecheck", command: "npm run typecheck", from: "package.json" },
      { name: "test", command: "npm test", from: "package.json" },
      { name: "check", command: "just check", from: "justfile" },
      { name: "ruff", command: "uv run ruff check", from: "pyproject.toml" },
      { name: "lint", command: "make lint", from: "Makefile" },
    ],
  );
  assert.deepEqual(detectChecks({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }), []);
  assert.deepEqual(detectChecks({ "package.json": "{not json" }), []);
  assert.deepEqual(detectChecks({}), []);
});

test("the starter config is valid, with or without detected checks", () => {
  assert.deepEqual(crucibleFileErrors(starterConfig([])), []);
  assert.deepEqual(crucibleFileErrors(starterConfig([{ name: "test", command: "npm test", from: "package.json" }])), []);
  assert.deepEqual(wantedLabels(["code", "security"]).map((l) => l.name), ["needs:human", "seam", "review:security"]);
});

function fakeRepo(files: Record<string, string>, labels: string[]) {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  const reads: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (line.includes("--git-common-dir")) return { stdout: "/r/.git", stderr: "", code: 0 };
    if (line.startsWith("git remote get-url")) return { stdout: "git@github.com:o/r.git", stderr: "", code: 0 };
    if (line.startsWith("gh label list")) return { stdout: JSON.stringify(labels.map((name) => ({ name }))), stderr: "", code: 0 };
    if (line.startsWith("gh label create")) return { stdout: "", stderr: "", code: 0 };
    throw new Error(`unexpected: ${line}`);
  };
  const readText = async (p: string) => {
    const rel = p.replace(/^\/r\//, "");
    reads.push(rel);
    if (rel in files) return files[rel];
    throw new Error("ENOENT");
  };
  const writeText = async (p: string, text: string) => void (written[p] = text);
  return { io: { exec, readText, writeText }, calls, written, reads };
}

test("init in a fresh repo creates labels, warns about AGENTS.md, and writes a starter config", async () => {
  const repo = fakeRepo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, ["bug"]);
  const notes = await init(repo.io, "/r/src", { write: true, dryRun: false });
  const created = repo.calls.filter((c) => c.startsWith("gh label create")).map((c) => c.split(" ")[3]);
  assert.deepEqual(created, ["needs:human", "seam", "review:security", "review:ux"]);
  assert.ok(
    notes.some(
      ([level, text]) =>
        level === "warning" &&
        text ===
          "No AGENTS.md: every stage reads it first, and runs are much worse without one. Start one with /crucible init --write, then add the project's stack, layout, rules and commands.",
    ),
  );
  assert.equal(repo.written["/r/AGENTS.md"], starterAgentsMd([], [{ name: "test", command: "npm test" }]));
  assert.ok(notes.some((n) => n[1] === "Wrote /r/AGENTS.md. Fill in its sections, then merge it to main: runs work from branches of origin/main."));
  assert.match(notes.map((n) => n[1]).join("\n"), /Detected checks: test = `npm test` \(package\.json\)/);
  const config = JSON.parse(repo.written["/r/.pi/crucible.json"]);
  assert.deepEqual(config.checks, [{ name: "test", command: "npm test" }]);
  assert.deepEqual(crucibleFileErrors(config), []);
  assert.equal(notes.at(-1)?.[1], "Next: /crucible <issue> --dry-run");
});

test("init --dry-run changes nothing; an existing config is left alone and decides the labels", async () => {
  const dry = fakeRepo({ "AGENTS.md": "x" }, []);
  const notes = await init(dry.io, "/r", { write: true, dryRun: true });
  assert.equal(dry.calls.filter((c) => c.startsWith("gh label create")).length, 0);
  assert.deepEqual(dry.written, {});
  assert.ok(!notes.some((n) => /^(No AGENTS\.md|Starter AGENTS\.md|Wrote .*AGENTS\.md)/.test(n[1])));
  assert.ok(!dry.reads.some((r) => AGENT_DOCS.includes(r)));
  assert.match(notes.map((n) => n[1]).join("\n"), /Would create label\(s\) in o\/r: needs:human, seam, review:security, review:ux/);
  assert.match(notes.map((n) => n[1]).join("\n"), /No checks detected/);

  const legacy = { design: "d", spec: { design: "s" }, implement: "i", checks: [], lenses: { code: "c", privacy: "p" } };
  const has = fakeRepo({ "AGENTS.md": "x", ".pi/factory.json": JSON.stringify(legacy) }, ["needs:human", "seam"]);
  const notes2 = await init(has.io, "/r", { write: true, dryRun: false });
  assert.deepEqual(has.calls.filter((c) => c.startsWith("gh label create")).map((c) => c.split(" ")[3]), ["review:privacy"]);
  assert.deepEqual(has.written, {});
  assert.ok(!notes2.some((n) => /^(No AGENTS\.md|Starter AGENTS\.md|Wrote .*AGENTS\.md)/.test(n[1])));
  assert.ok(!has.reads.some((r) => AGENT_DOCS.includes(r)));
  assert.match(notes2.map((n) => n[1]).join("\n"), /\.pi\/factory\.json exists; not changing it\. Rename it to \.pi\/crucible\.json\./);
});

test("init names the agent docs it finds and writes an AGENTS.md that points to them", async () => {
  const repo = fakeRepo(
    {
      "CONTRIBUTING.md": "c",
      "CLAUDE.md": "c",
      ".github/copilot-instructions.md": "c",
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    },
    ["needs:human", "seam", "review:security", "review:ux"],
  );
  const notes = await init(repo.io, "/r", { write: true, dryRun: false });
  const docs = ["CLAUDE.md", ".github/copilot-instructions.md", "CONTRIBUTING.md"];
  assert.ok(
    notes.some(
      ([level, text]) =>
        level === "warning" &&
        text ===
          "No AGENTS.md: every stage reads it first, and only it. Found CLAUDE.md, .github/copilot-instructions.md, CONTRIBUTING.md, which runs will not read unless AGENTS.md points to them. Start one from them with /crucible init --write.",
    ),
  );
  assert.equal(repo.written["/r/AGENTS.md"], starterAgentsMd(docs, [{ name: "test", command: "npm test" }]));
  assert.deepEqual(Object.keys(repo.written), ["/r/.pi/crucible.json", "/r/AGENTS.md"]);
  assert.ok(
    notes.some(
      (n) =>
        n[1] ===
        "Wrote /r/AGENTS.md, pointing to CLAUDE.md, .github/copilot-instructions.md, CONTRIBUTING.md. Fill in its sections, then merge it to main: runs work from branches of origin/main.",
    ),
  );
});

test("without --write, or with --dry-run, the starter AGENTS.md is printed, not written", async () => {
  for (const options of [
    { write: false, dryRun: false },
    { write: true, dryRun: true },
  ]) {
    const repo = fakeRepo({ ".claude/CLAUDE.md": "c" }, []);
    const notes = await init(repo.io, "/r", options);
    assert.deepEqual(repo.written, {});
    const starter = notes.filter((n) => n[1].startsWith("Starter AGENTS.md (write it with /crucible init --write):\n# AGENTS.md\n"));
    assert.equal(starter.length, 1);
    assert.ok(starter[0][1].includes("- [.claude/CLAUDE.md](.claude/CLAUDE.md)"));
  }
});

test("with an existing config, the starter AGENTS.md lists the config's checks", async () => {
  const config = { design: "d", spec: { design: "s" }, implement: "i", checks: [{ name: "check", command: "just check" }], lenses: { code: "c" } };
  const repo = fakeRepo({ ".pi/crucible.json": JSON.stringify(config), "GEMINI.md": "g" }, ["needs:human", "seam"]);
  await init(repo.io, "/r", { write: true, dryRun: false });
  assert.deepEqual(Object.keys(repo.written), ["/r/AGENTS.md"]);
  assert.ok(repo.written["/r/AGENTS.md"].includes("- check: `just check`"));

  const bad = fakeRepo({ ".pi/crucible.json": JSON.stringify({ ...config, checks: "oops" }), "GEMINI.md": "g" }, ["needs:human", "seam"]);
  const notes = await init(bad.io, "/r", { write: true, dryRun: false });
  assert.ok(notes.some(([level, text]) => level === "warning" && /\.pi\/crucible\.json is invalid/.test(text)));
  assert.ok(bad.written["/r/AGENTS.md"].endsWith("## Commands\n\n<!-- How to set up, test and lint. -->\n"));
});

test("starterAgentsMd", () => {
  const full = starterAgentsMd(["CLAUDE.md"], [{ name: "test", command: "npm test" }]);
  for (const part of ["## Read first", "- [CLAUDE.md](CLAUDE.md)", "## Stack and layout", "## Rules", "## Commands", "- test: `npm test`"]) {
    assert.ok(full.includes(part), part);
  }
  const noDocs = starterAgentsMd([], [{ name: "test", command: "npm test" }]);
  assert.ok(!noDocs.includes("## Read first"));
  const noChecks = starterAgentsMd(["CLAUDE.md"], []);
  assert.ok(noChecks.includes("## Commands\n\n<!-- How to set up, test and lint. -->\n"));
  for (const text of [full, noDocs, noChecks]) {
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
  }
});

test("AGENT_DOCS holds the documented locations", () => {
  assert.deepEqual(AGENT_DOCS, [
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "GEMINI.md",
    ".github/copilot-instructions.md",
    "CONTRIBUTING.md",
    ".github/CONTRIBUTING.md",
    "docs/CONTRIBUTING.md",
  ]);
});
