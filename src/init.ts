// `/crucible init`: get a repository ready for its first run.
//
//   - creates the labels a run uses that the repository lacks (a GitHub write, so it is explicit
//     here and never a side effect of a run);
//   - when AGENTS.md is missing (every stage reads it first, and only it), names the agent and
//     contributor docs it found and prints a starter AGENTS.md that points to them, or writes it
//     with --write;
//   - detects check commands from package.json, justfile, pyproject.toml and Makefile;
//   - when there is no config yet, prints a starter .pi/crucible.json, or writes it with --write.
//
// A first slice of #26 (engine defaults, check detection): the generic texts here become the
// engine's default config layer there.

import path from "node:path";
import { crucibleFileErrors, type CrucibleFile } from "./config.ts";
import { CONFIG_NAMES, repoFromRemote, type Exec } from "./launcher.ts";

export interface InitOptions {
  write: boolean;
  dryRun: boolean;
}

export const INIT_USAGE = "Usage: /crucible init [--write] [--dry-run]";

export function parseInit(words: string[]): InitOptions | { error: string } {
  const out: InitOptions = { write: false, dryRun: false };
  for (const w of words) {
    if (w === "--write") out.write = true;
    else if (w === "--dry-run") out.dryRun = true;
    else return { error: `Unexpected "${w}". ${INIT_USAGE}` };
  }
  return out;
}

/** Generic, project-neutral texts for a starter config. Edit them: project-specific text makes better runs. */
export const GENERIC = {
  design:
    "AGENTS.md, README.md and the docs/ directory are the design record; read them before changing anything, and say in the spec when a change departs from them.",
  specDesign:
    "files to add or change, the functions or interfaces and their signatures, data and config changes, the tests that prove it",
  implement:
    "Tests must not use the network or real credentials; use small fixtures written in the test. Follow AGENTS.md for setup and conventions.",
  lenses: {
    code: "CODE review. Correctness against the spec and the issue's acceptance criteria; tests that would catch a regression; clear module boundaries; dead code; error handling; the spec and the code agree (a stale spec is \"major\").",
    security:
      "SECURITY review. Input validation; secrets never in code, fixtures, logs or CI; injection (shell, SQL, HTML); untrusted URLs and paths; least privilege; CI safe for pull requests from forks.",
    ux: "UX review, for whoever uses this change: names, defaults and error messages that say what to do next; docs and examples a first-time user can follow.",
  },
};

/**
 * Agent and contributor docs a repository may have instead of AGENTS.md, in the order a starter
 * AGENTS.md lists them. Runs read only AGENTS.md, so these reach a run only through it.
 */
export const AGENT_DOCS = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
];

export interface Check {
  name: string;
  command: string;
  from: string;
}

/**
 * Check commands from the files a repository usually has, in a stable order; at most one per name.
 * `files` maps a repo-relative path to its text (absent files are missing keys).
 */
export function detectChecks(files: Record<string, string | undefined>): Check[] {
  const out: Check[] = [];
  const add = (name: string, command: string, from: string) => {
    if (!out.some((c) => c.name === name)) out.push({ name, command, from });
  };
  const pkg = files["package.json"];
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const name of ["typecheck", "lint", "test"]) {
        if (scripts[name] && !/no test specified/.test(scripts[name])) add(name, name === "test" ? "npm test" : `npm run ${name}`, "package.json");
      }
    } catch {
      // unparseable package.json: detect nothing from it
    }
  }
  const just = files["justfile"] ?? files["Justfile"];
  if (just) {
    for (const name of ["check", "lint", "test"]) {
      if (new RegExp(`^${name}(\\s[^:]*)?:`, "m").test(just)) add(name, `just ${name}`, "justfile");
    }
  }
  const py = files["pyproject.toml"];
  if (py) {
    if (/\bruff\b/.test(py)) add("ruff", "uv run ruff check", "pyproject.toml");
    if (/\bpytest\b/.test(py)) add("test", "uv run pytest -q", "pyproject.toml");
  }
  const make = files["Makefile"];
  if (make) {
    for (const name of ["check", "lint", "test"]) {
      if (new RegExp(`^${name}:`, "m").test(make)) add(name, `make ${name}`, "Makefile");
    }
  }
  return out;
}

export function starterConfig(checks: Check[]): CrucibleFile {
  return {
    $schema: "https://raw.githubusercontent.com/seandavi/pi-crucible/main/schema/crucible.schema.json",
    design: GENERIC.design,
    spec: { design: GENERIC.specDesign },
    implement: GENERIC.implement,
    checks: checks.map(({ name, command }) => ({ name, command })),
    lenses: { ...GENERIC.lenses },
  };
}

/** A starter AGENTS.md: read the docs the repository already has, then sections to fill in. */
export function starterAgentsMd(docs: string[], checks: { name: string; command: string }[]): string {
  const lines = [
    "# AGENTS.md",
    "",
    "Started by `/crucible init`. Every pi-crucible stage reads this file first, and only this file:",
    "fill in the sections below, and move the rules that matter most into them.",
    "",
  ];
  if (docs.length) {
    lines.push("## Read first", "", "Read these before changing anything, and follow them:", "", ...docs.map((d) => `- [${d}](${d})`), "");
  }
  lines.push(
    "## Stack and layout",
    "",
    "<!-- Languages, frameworks, and where the code, tests and docs live. -->",
    "",
    "## Rules",
    "",
    "<!-- Hard rules: files that must change together, things never to do. -->",
    "",
    "## Commands",
    "",
    ...(checks.length ? checks.map((c) => `- ${c.name}: \`${c.command}\``) : ["<!-- How to set up, test and lint. -->"]),
  );
  return lines.join("\n") + "\n";
}

/** Labels a run uses: needs:human on every stop and PR, seam, and review:<lens> for each lens but code. */
export function wantedLabels(lenses: string[]): { name: string; color: string; description: string }[] {
  return [
    { name: "needs:human", color: "D93F0B", description: "Waiting on a person (pi-crucible stops and PRs)" },
    { name: "seam", color: "5319E7", description: "Shared foundation; reviewers rate defects by blast radius" },
    ...lenses
      .filter((l) => l !== "code")
      .map((l) => ({ name: `review:${l}`, color: "1D76DB", description: `Add the ${l} review lens to a pi-crucible run` })),
  ];
}

async function out(exec: Exec, cmd: string, args: string[], cwd?: string): Promise<string> {
  const r = await exec(cmd, args, cwd ? { cwd } : undefined);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export interface InitIO {
  exec: Exec;
  readText: (p: string) => Promise<string>;
  writeText: (p: string, text: string) => Promise<void>;
}

/** Returns the lines to show the user, in order, each with a level. */
export async function init(io: InitIO, cwd: string, options: InitOptions): Promise<[level: "info" | "warning", text: string][]> {
  const notes: ["info" | "warning", string][] = [];
  const commonDir = await out(io.exec, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).catch(() => {
    throw new Error(`${cwd} is not inside a git repository`);
  });
  const repoRoot = path.dirname(commonDir);
  const read = (rel: string) => io.readText(path.join(repoRoot, rel)).then((t) => t, () => undefined);

  // Existing config: its lenses decide the labels. Any of the config names counts.
  let config: CrucibleFile | undefined;
  let configName: string | undefined;
  for (const name of CONFIG_NAMES) {
    const text = await read(name);
    if (text === undefined) continue;
    configName = name;
    try {
      config = JSON.parse(text) as CrucibleFile;
    } catch (e) {
      throw new Error(`cannot parse ${name}: ${(e as Error).message}`);
    }
    const problems = crucibleFileErrors(config);
    if (problems.length) notes.push(["warning", `${name} is invalid:\n- ${problems.join("\n- ")}`]);
    break;
  }

  const repo = config?.repo ?? repoFromRemote(await out(io.exec, "git", ["remote", "get-url", "origin"], repoRoot).catch(() => ""));
  if (!repo) throw new Error('cannot tell the GitHub repo from the origin remote; set "repo" in .pi/crucible.json');

  // Runs read only AGENTS.md; other agent docs reach a run only if it points to them.
  const hasAgentsMd = (await read("AGENTS.md")) !== undefined;
  const agentDocs: string[] = [];
  if (!hasAgentsMd) {
    for (const doc of AGENT_DOCS) if ((await read(doc)) !== undefined) agentDocs.push(doc);
    notes.push([
      "warning",
      agentDocs.length
        ? `No AGENTS.md: every stage reads it first, and only it. Found ${agentDocs.join(", ")}, which runs will not read unless AGENTS.md points to them. Start one from them with /crucible init --write.`
        : "No AGENTS.md: every stage reads it first, and runs are much worse without one. Start one with /crucible init --write, then add the project's stack, layout, rules and commands.",
    ]);
  }

  // Labels.
  const lenses = Object.keys(config?.lenses ?? GENERIC.lenses);
  const existing = new Set(
    (JSON.parse(await out(io.exec, "gh", ["label", "list", "-R", repo, "--limit", "1000", "--json", "name"])) as { name: string }[]).map((l) =>
      l.name.toLowerCase(),
    ),
  );
  const missing = wantedLabels(lenses).filter((l) => !existing.has(l.name));
  for (const l of missing) {
    if (options.dryRun) continue;
    await out(io.exec, "gh", ["label", "create", l.name, "-R", repo, "--color", l.color, "--description", l.description]);
  }
  notes.push([
    "info",
    missing.length
      ? `${options.dryRun ? "Would create" : "Created"} label(s) in ${repo}: ${missing.map((l) => l.name).join(", ")}`
      : `${repo} has every label a run uses.`,
  ]);

  // Config.
  let checks: { name: string; command: string }[] = [];
  if (config) {
    checks = Array.isArray(config.checks)
      ? config.checks.filter((c) => typeof c?.name === "string" && typeof c?.command === "string")
      : [];
    notes.push(["info", `Config: ${configName} exists; not changing it.${configName !== CONFIG_NAMES[0] ? ` Rename it to ${CONFIG_NAMES[0]}.` : ""}`]);
  } else {
    const files: Record<string, string | undefined> = {};
    for (const f of ["package.json", "justfile", "Justfile", "pyproject.toml", "Makefile"]) files[f] = await read(f);
    const detected = detectChecks(files);
    checks = detected;
    notes.push([
      detected.length ? "info" : "warning",
      detected.length
        ? `Detected checks: ${detected.map((c) => `${c.name} = \`${c.command}\` (${c.from})`).join("; ")}`
        : "No checks detected (package.json scripts, justfile or Makefile recipes, pytest/ruff in pyproject.toml). Runs will report \"no checks configured\"; add checks to the config.",
    ]);
    const text = JSON.stringify(starterConfig(detected), null, 2) + "\n";
    const target = path.join(repoRoot, CONFIG_NAMES[0]);
    if (options.write && !options.dryRun) {
      await io.writeText(target, text);
      notes.push(["info", `Wrote ${target}. Edit the generic texts for this project, then merge it to main: runs read it from origin/main.`]);
    } else {
      notes.push(["info", `Starter ${CONFIG_NAMES[0]} (write it with /crucible init --write):\n${text}`]);
    }
  }
  if (!hasAgentsMd) {
    const text = starterAgentsMd(agentDocs, checks);
    const target = path.join(repoRoot, "AGENTS.md");
    if (options.write && !options.dryRun) {
      await io.writeText(target, text);
      notes.push([
        "info",
        `Wrote ${target}${agentDocs.length ? `, pointing to ${agentDocs.join(", ")}` : ""}. Fill in its sections, then merge it to main: runs work from branches of origin/main.`,
      ]);
    } else {
      notes.push(["info", `Starter AGENTS.md (write it with /crucible init --write):\n${text}`]);
    }
  }
  notes.push(["info", "Next: /crucible <issue> --dry-run"]);
  return notes;
}
