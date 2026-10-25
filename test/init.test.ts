import { test } from "node:test";
import assert from "node:assert/strict";
import { crucibleFileErrors } from "../src/config.ts";
import { detectChecks, init, parseInit, starterConfig, wantedLabels } from "../src/init.ts";
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
    if (rel in files) return files[rel];
    throw new Error("ENOENT");
  };
  const listDir = async (p: string) => {
    const prefix = `${p.replace(/^\/r\//, "")}/`;
    const names = Object.keys(files).filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes("/")).map((f) => f.slice(prefix.length));
    if (!names.length) throw new Error("ENOENT");
    return names;
  };
  const writeText = async (p: string, text: string) => void (written[p] = text);
  return { io: { exec, readText, listDir, writeText }, calls, written };
}

test("init in a fresh repo creates labels, warns about AGENTS.md, and writes a starter config", async () => {
  const repo = fakeRepo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, ["bug"]);
  const notes = await init(repo.io, "/r/src", { write: true, dryRun: false });
  const created = repo.calls.filter((c) => c.startsWith("gh label create")).map((c) => c.split(" ")[3]);
  assert.deepEqual(created, ["needs:human", "seam", "review:security", "review:ux"]);
  assert.match(notes.map((n) => n[1]).join("\n"), /No AGENTS\.md/);
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
  assert.match(notes.map((n) => n[1]).join("\n"), /Would create label\(s\) in o\/r: needs:human, seam, review:security, review:ux/);
  assert.match(notes.map((n) => n[1]).join("\n"), /No checks detected/);

  const legacy = { design: "d", spec: { design: "s" }, implement: "i", checks: [], lenses: { code: "c", privacy: "p" } };
  const has = fakeRepo({ "AGENTS.md": "x", ".pi/factory.json": JSON.stringify(legacy) }, ["needs:human", "seam"]);
  const notes2 = await init(has.io, "/r", { write: true, dryRun: false });
  assert.deepEqual(has.calls.filter((c) => c.startsWith("gh label create")).map((c) => c.split(" ")[3]), ["review:privacy"]);
  assert.deepEqual(has.written, {});
  assert.match(notes2.map((n) => n[1]).join("\n"), /\.pi\/factory\.json exists; not changing it\. Rename it to \.pi\/crucible\.json\./);
});

test("init prefers CI checks to package.json", async () => {
  const workflow = "on: pull_request\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@v7\n      - run: npm ci\n      - run: npm test\n";
  const repo = fakeRepo(
    {
      "AGENTS.md": "x",
      "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
      ".github/workflows/ci.yml": workflow,
    },
    [],
  );
  const notes = await init(repo.io, "/r", { write: true, dryRun: false });
  const text = notes.map((n) => n[1]).join("\n");
  const config = JSON.parse(repo.written["/r/.pi/crucible.json"]);
  assert.deepEqual(config.checks, [{ name: "test", command: "npm test" }]);
  assert.match(text, /Detected checks: test = `npm test` \(\.github\/workflows\/ci\.yml\)/);
  assert.match(text, /Not offered as checks from CI:\n- `npm ci` in \.github\/workflows\/ci\.yml: setup/);
  assert.doesNotMatch(text, /npm run lint/);
  assert.doesNotMatch(text, /instead/);
});

test("init falls back to package.json when CI has no pull_request workflow", async () => {
  const repo = fakeRepo(
    {
      "AGENTS.md": "x",
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      ".github/workflows/release.yml": "on: push\njobs:\n  r:\n    steps:\n      - run: npm publish\n",
    },
    [],
  );
  const text = (await init(repo.io, "/r", { write: false, dryRun: false })).map((n) => n[1]).join("\n");
  assert.match(text, /No checks in pull_request workflows under \.github\/workflows; detected from package\.json/);
  assert.match(text, /Detected checks: test = `npm test` \(package\.json\)/);
  assert.doesNotMatch(text, /npm publish/);
});
