import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checksFromWorkflows } from "../src/ci-checks.ts";
import { crucibleFileErrors } from "../src/config.ts";
import { starterConfig } from "../src/init.ts";

/** A one-job pull_request workflow whose steps are the given YAML lines (already indented 6). */
function pr(steps: string, extra = ""): string {
  return `on: pull_request\n${extra}jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
}

const F = ".github/workflows/ci.yml";
const summary = (r: ReturnType<typeof checksFromWorkflows>) => r.checks.map((c) => [c.name, c.command]);

test("this repository's CI gives test and check, and reports npm ci as setup", () => {
  const r = checksFromWorkflows({ [F]: readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8") });
  assert.deepEqual(r.checks, [
    { name: "test", command: "npm test", from: F },
    { name: "check", command: "npm run check", from: F },
  ]);
  assert.deepEqual(r.skipped, [`\`npm ci\` in ${F}: setup`]);
});

test("the bioc-registry typecheck is copied verbatim", () => {
  const tsc = "npx tsc -p . --noEmit 2>&1 | grep -E '^src/' && exit 1 || exit 0";
  const r = checksFromWorkflows({ [F]: pr(`      - run: npm ci\n      - run: npm test\n      - run: ${tsc}\n`) });
  assert.deepEqual(r.checks, [
    { name: "test", command: "npm test", from: F },
    { name: "tsc", command: tsc, from: F },
  ]);
  const named = checksFromWorkflows({ [F]: pr(`      - name: Typecheck\n        run: ${tsc}\n`) });
  assert.deepEqual(named.checks, [{ name: "typecheck", command: tsc, from: F }]);
});

test("only pull_request workflows count", () => {
  const job = "jobs:\n  j:\n    steps:\n      - run: npm test\n";
  const r = checksFromWorkflows({
    "a.yml": `on: pull_request\n${job}`,
    "b.yml": `on: [push, pull_request]\n${job.replace("npm test", "npm run b")}`,
    "c.yml": `on:\n  pull_request:\n${job.replace("npm test", "npm run c")}`,
    "d.yml": `on:\n  pull_request:\n    branches: [main]\n${job.replace("npm test", "npm run d")}`,
    "e.yml": `on: push\n${job.replace("npm test", "npm run e")}`,
    "f.yml": `on: [push]\n${job.replace("npm test", "npm run f")}`,
    "g.yml": `on: pull_request_target\n${job.replace("npm test", "npm run g")}`,
    "h.yml": `on:\n  push:\n  merge_group:\n  workflow_dispatch:\n${job.replace("npm test", "npm run h")}`,
  });
  assert.deepEqual(summary(r), [["test", "npm test"], ["b", "npm run b"], ["c", "npm run c"], ["d", "npm run d"]]);
  assert.deepEqual(r.skipped, []);
});

test("setup is dropped, multi-line scripts are joined", () => {
  const r = checksFromWorkflows({
    [F]: pr(
      [
        "      - uses: actions/checkout@v7",
        "      - run: npm ci",
        "      - run: npm install",
        "      - run: pip install -r x",
        "      - run: uv sync",
        "      - run: corepack enable",
        "      - run: npm ci && npm test",
        "      - run: |",
        "          npm ci",
        "          # lint it",
        "          npm run lint",
        "          npm run typecheck \\",
        "            --pretty",
        "",
      ].join("\n"),
    ),
  });
  assert.deepEqual(summary(r), [["test", "npm test"], ["lint", "npm run lint && npm run typecheck --pretty"]]);
  assert.deepEqual(r.skipped, [
    `\`npm ci\` in ${F}: setup`,
    `\`npm install\` in ${F}: setup`,
    `\`pip install -r x\` in ${F}: setup`,
    `\`uv sync\` in ${F}: setup`,
    `\`corepack enable\` in ${F}: setup`,
  ]);

  const literal = checksFromWorkflows({ [F]: pr("      - run: |\n          npm ci\n          npm test\n          npm run lint\n") });
  assert.deepEqual(summary(literal), [["test", "npm test && npm run lint"]]);
});

test("steps that need Actions are left out, with reasons", () => {
  const long = `echo ${"x".repeat(500)}`;
  const nine = Array.from({ length: 9 }, (_, i) => `      - run: tool${i} --check`).join("\n");
  const r = checksFromWorkflows({
    "a.yml": pr(
      [
        "      - run: echo ${{ github.sha }}",
        "      - run: make a",
        "        env:",
        "          TOKEN: ${{ secrets.T }}",
        "      - run: make b",
        "        working-directory: ${{ matrix.dir }}",
        "      - run: echo x >> $GITHUB_OUTPUT",
        '      - run: echo "$GITHUB_PATH"',
        "      - run: Get-ChildItem",
        "        shell: pwsh",
        "      - run: |",
        "          if [ -f x ]; then",
        "            echo y",
        "          fi",
        "      - run: |",
        "          cat <<EOF",
        "          hi",
        "          EOF",
        `      - run: ${long}`,
        "",
      ].join("\n"),
    ),
    "b.yml": pr("      - run: print(1)\n", "defaults:\n  run:\n    shell: python\n"),
    "c.yml": pr(`${nine}\n`),
  });
  assert.equal(r.checks.length, 8);
  assert.deepEqual(r.checks.map((c) => c.command), Array.from({ length: 8 }, (_, i) => `tool${i} --check`));
  const want = [
    /^`echo \$\{\{ github\.sha \}\}` in a\.yml: uses GitHub Actions expressions/,
    /^`make a` in a\.yml: uses GitHub Actions expressions/,
    /^`make b` in a\.yml: uses GitHub Actions expressions/,
    /^`echo x >> \$GITHUB_OUTPUT` in a\.yml: writes GitHub Actions files/,
    /^`echo "\$GITHUB_PATH"` in a\.yml: writes GitHub Actions files/,
    /^`Get-ChildItem` in a\.yml: runs in pwsh, not bash or sh/,
    /^`if \[ -f x \]; then` in a\.yml: multi-line script with shell control flow or a heredoc/,
    /^`cat <<EOF` in a\.yml: multi-line script with shell control flow or a heredoc/,
    /^`echo x{55}…` in a\.yml: longer than 500 characters/,
    /^`print\(1\)` in b\.yml: runs in python, not bash or sh/,
    /^`tool8 --check` in c\.yml: more than 8 checks; the config allows 8/,
  ];
  assert.equal(r.skipped.length, want.length, r.skipped.join("\n"));
  want.forEach((re, i) => assert.match(r.skipped[i], re));
});

test("working-directory becomes a cd prefix", () => {
  const r = checksFromWorkflows({
    "a.yml": pr(
      [
        "      - run: npm test",
        "        working-directory: web",
        "      - run: make dot",
        "        working-directory: .",
        "      - run: make up",
        "        working-directory: ../x",
        "      - run: make space",
        '        working-directory: "a b"',
        "",
      ].join("\n"),
    ),
    "b.yml": "on: pull_request\njobs:\n  j:\n    defaults:\n      run:\n        working-directory: job\n    steps:\n      - run: make jobdir\n",
    "c.yml": pr("      - run: make wfdir\n", "defaults:\n  run:\n    working-directory: wf\n"),
  });
  assert.deepEqual(r.checks.map((c) => c.command), ["cd web && npm test", "make dot", "cd job && make jobdir", "cd wf && make wfdir"]);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0], /^`make up` in a\.yml: working-directory \.\.\/x is not a plain path inside the repository$/);
  assert.match(r.skipped[1], /^`make space` in a\.yml: working-directory a b is not a plain path inside the repository$/);
});

test("names are slugs, unique and valid", () => {
  const steps = [
    ["npm test", undefined],
    ["npm run check", undefined],
    ["npx tsc -p . --noEmit 2>&1 | grep -E '^src/'", undefined],
    ["uv run pytest -q", undefined],
    ["./scripts/lint.sh", undefined],
    ["echo one", "Typecheck (src only)"],
    ["echo two", "2nd pass"],
    ["echo three", "A very long step name that goes past thirty-two characters"],
    ["pnpm lint", undefined],
    ["npm run lint", undefined],
  ];
  const body = steps.map(([run, name]) => (name ? `      - name: ${name}\n        run: ${run}` : `      - run: ${run}`)).join("\n") + "\n";
  const r = checksFromWorkflows({ [F]: pr(body.split("\n").slice(0).join("\n")) });
  assert.deepEqual(
    r.checks.map((c) => c.name),
    ["test", "check", "tsc", "pytest", "lint", "typecheck-src-only", "check-2nd-pass", "a-very-long-step-name-that-goes", "lint-2", "lint-3"].slice(0, 8),
  );
  assert.equal(r.checks.length, 8);

  const more = checksFromWorkflows({
    "a.yml": pr("      - run: npm run lint\n      - run: pnpm lint\n      - run: npm run lint\n      - run: yarn lint\n"),
    "b.yml": pr("      - run: npm run lint\n      - run: just lint\n      - run: make -j4 lint\n"),
  });
  assert.deepEqual(more.checks.map((c) => [c.name, c.command]), [
    ["lint", "npm run lint"],
    ["lint-2", "pnpm lint"],
    ["lint-3", "yarn lint"],
    ["lint-4", "just lint"],
    ["lint-5", "make -j4 lint"],
  ]);
  for (const c of [...r.checks, ...more.checks]) assert.match(c.name, /^[a-z][a-z0-9-]{0,31}$/);
  assert.deepEqual(crucibleFileErrors(starterConfig(r.checks)), []);
  assert.deepEqual(crucibleFileErrors(starterConfig(more.checks)), []);
});

test("unparseable files and reusable workflows are reported", () => {
  const r = checksFromWorkflows({
    "a-bad.yml": "on: pull_request\njobs: [unclosed\n",
    "b-dup.yml": "on: pull_request\non: push\njobs: {}\n",
    "c-empty.yml": "",
    "d-list.yml": "- a\n- b\n",
    "e-reuse.yml": "on: pull_request\njobs:\n  lint:\n    uses: ./.github/workflows/x.yml\n  ext:\n    uses: o/r/.github/workflows/y.yml@v1\n",
    "f-good.yml": pr("      - run: npm test\n"),
  });
  assert.deepEqual(summary(r), [["test", "npm test"]]);
  assert.equal(r.skipped.length, 4, r.skipped.join("\n"));
  assert.match(r.skipped[0], /^a-bad\.yml: cannot parse \(.+\)$/);
  assert.doesNotMatch(r.skipped[0], /\n/);
  assert.match(r.skipped[1], /^b-dup\.yml: cannot parse \(.*[Mm]ap keys must be unique/);
  assert.equal(r.skipped[2], "e-reuse.yml job lint: calls ./.github/workflows/x.yml; reusable workflows are not followed");
  assert.equal(r.skipped[3], "e-reuse.yml job ext: calls o/r/.github/workflows/y.yml@v1; reusable workflows are not followed");
});
