// The /crucible command's logic: from "/crucible 12" in a repo checkout to the workflow's args.
//
//   parseCommand  "/crucible" arguments → issue number and options
//   prepare       fetches origin; reads .pi/crucible.json from origin/main, the issue, its branch and the engine commit; plans the launch
//   ensureWorktree creates (or reuses) the issue's worktree and branch
//   resolveWorktree points the plan at the worktree's real path
//
// Side effects go through an injected `exec`, so tests can run without git, gh or a network.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engineConfigOf, crucibleFileErrors, type CrucibleFile } from "./config.ts";
import { argErrors } from "./resource.ts";

export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const STARTS = ["spec", "implement", "review"] as const;
export type StartAt = (typeof STARTS)[number];

export interface CommandOptions {
  issue: number;
  startAt: StartAt;
  lenses: string[];
  dryRun: boolean;
}

export const USAGE =
  "Usage: /crucible <issue> [--start-at implement|review] [--lens <name>]... [--dry-run]";

/** Parse the text after "/crucible". Returns an error message instead of throwing. */
export function parseCommand(input: string): CommandOptions | { error: string } {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const out: CommandOptions = { issue: 0, startAt: "spec", lenses: [], dryRun: false };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const value = () => {
      const v = words[++i];
      if (v === undefined) throw new Error(`${w} needs a value`);
      return v;
    };
    try {
      if (w === "--dry-run") out.dryRun = true;
      else if (w === "--start-at" || w.startsWith("--start-at=")) {
        const v = w.includes("=") ? w.split("=")[1] : value();
        if (!(STARTS as readonly string[]).includes(v)) return { error: `--start-at must be one of ${STARTS.join(", ")}. ${USAGE}` };
        out.startAt = v as StartAt;
      } else if (w === "--lens" || w.startsWith("--lens=")) {
        out.lenses.push(w.includes("=") ? w.split("=")[1] : value());
      } else if (/^#?\d+$/.test(w) && !out.issue) out.issue = Number(w.replace("#", ""));
      else return { error: `Unexpected "${w}". ${USAGE}` };
    } catch (e) {
      return { error: `${(e as Error).message}. ${USAGE}` };
    }
  }
  if (!out.issue) return { error: USAGE };
  return out;
}

/** A branch-safe slug from an issue title: lowercase words joined by "-", at most ~40 characters. */
export function slugify(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 40) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, 40) || "issue";
}

/** Lenses for a run: the defaults, plus each `review:<lens>` label, plus --lens; seam from the label. */
export function pickLenses(file: CrucibleFile, labels: string[], extra: string[]) {
  const defined = Object.keys(file.lenses);
  const wanted = [...(file.defaultLenses ?? ["code"])];
  const warnings: string[] = [];
  for (const label of labels) {
    const m = /^review:(.+)$/.exec(label);
    if (!m) continue;
    if (defined.includes(m[1])) wanted.push(m[1]);
    else warnings.push(`label ${label} names no lens in .pi/crucible.json; ignored`);
  }
  for (const lens of extra) {
    if (!defined.includes(lens)) throw new Error(`--lens ${lens}: no such lens (defined: ${defined.join(", ")})`);
    wanted.push(lens);
  }
  return { lenses: [...new Set(wanted)], seam: labels.includes("seam"), warnings };
}

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

export function worktreeRootFor(file: CrucibleFile, repoRoot: string, home = homedir()): string {
  const root = file.worktreeRoot ? expandHome(file.worktreeRoot, home) : `../${path.basename(repoRoot)}-worktrees`;
  return path.resolve(repoRoot, root);
}

export function worktreeFor(file: CrucibleFile, repoRoot: string, issue: number, home = homedir()): string {
  return path.join(worktreeRootFor(file, repoRoot, home), `issue-${issue}`);
}

/** "owner/name" from a GitHub remote URL (https or ssh), or null. */
export function repoFromRemote(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface Issue {
  number: number;
  title: string;
  state: string;
  labels: string[];
}

export interface Plan {
  repoRoot: string;
  worktree: string;
  branch: string;
  startAt: StartAt;
  /** Where the config was read from, for the dry run. */
  configSource: string;
  /** The config is origin/main's, so the launch may grant its checks as host commands. */
  configOnMain: boolean;
  args: Record<string, unknown>;
  warnings: string[];
}

export function planLaunch(input: {
  file: CrucibleFile;
  repoRoot: string;
  repo: string;
  issue: Issue;
  options: CommandOptions;
  existingBranch?: string;
  engine?: { commit: string; dirty?: boolean };
  configSource: string;
  configOnMain?: boolean;
  home?: string;
}): Plan {
  const { file, repoRoot, repo, issue, options } = input;
  // An existing branch decides the slug (and so the spec path); the title only names a new branch.
  const prefix = `issue-${issue.number}-`;
  const slug = input.existingBranch ? input.existingBranch.slice(prefix.length) : slugify(issue.title);
  const branch = `${prefix}${slug}`;
  const worktree = worktreeFor(file, repoRoot, issue.number, input.home);
  const { lenses, seam, warnings } = pickLenses(file, issue.labels, options.lenses);
  const args: Record<string, unknown> = {
    repo,
    issue: issue.number,
    slug,
    worktree,
    branch,
    lenses,
    seam,
    config: engineConfigOf(file),
  };
  if (options.startAt !== "spec") args.startAt = options.startAt;
  if (file.parent) args.parent = file.parent;
  if (input.engine) args.engine = input.engine;
  const errors = argErrors(args);
  if (errors.length) throw new Error(`the planned args are invalid: ${errors.join("; ")}`);
  const size = Buffer.byteLength(JSON.stringify(args));
  if (size > 16 * 1024) throw new Error(`args are ${size} bytes; pi-subagents allows 16384. Shorten lens texts in .pi/crucible.json.`);
  return { repoRoot, worktree, branch, startAt: options.startAt, configSource: input.configSource, configOnMain: input.configOnMain ?? false, args, warnings };
}

async function run(exec: Exec, cmd: string, args: string[], cwd?: string): Promise<string> {
  const r = await exec(cmd, args, cwd ? { cwd } : undefined);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/**
 * The branch this issue already has, so a retitled issue still resumes: the worktree's current branch,
 * else the one `issue-<n>-*` branch among local and origin refs. Null when there is none; throws when
 * there are several.
 */
export async function findIssueBranch(exec: Exec, repoRoot: string, worktree: string, issue: number): Promise<string | null> {
  const prefix = `issue-${issue}-`;
  const isIssueBranch = (name: string) => name.startsWith(prefix) && /^[a-z0-9][a-z0-9-]*$/.test(name.slice(prefix.length));
  const current = await run(exec, "git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (isIssueBranch(current)) return current;
  const refs = await run(exec, "git", ["for-each-ref", "--format=%(refname)", `refs/heads/${prefix}*`, `refs/remotes/origin/${prefix}*`], repoRoot);
  const names = new Set(
    refs.split("\n").map((r) => r.replace(/^refs\/(heads|remotes\/origin)\//, "")).filter(isIssueBranch),
  );
  if (names.size > 1) throw new Error(`issue #${issue} has several branches (${[...names].join(", ")}); delete or rename all but one`);
  return [...names][0] ?? null;
}

/** Lines of `gh label create` for the labels a repository lacks; the engine flags every stop with needs:human. */
export function labelProblems(file: CrucibleFile, repo: string, existing: string[]) {
  const have = new Set(existing.map((l) => l.toLowerCase()));
  const create = (name: string) => `gh label create '${name}' -R ${repo}`;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!have.has("needs:human")) {
    errors.push(`${repo} has no "needs:human" label, which pi-crucible puts on every stop and every PR. Run /crucible init to create the labels (or: ${create("needs:human")}).`);
  }
  const optional = ["seam", ...Object.keys(file.lenses).filter((l) => l !== "code").map((l) => `review:${l}`)];
  const missing = optional.filter((l) => !have.has(l));
  if (missing.length) warnings.push(`${repo} lacks the label(s) ${missing.join(", ")}, so issues cannot ask for them. /crucible init creates them.`);
  return { errors, warnings };
}

/** The engine's own checkout: its commit, and whether tracked files differ from it. */
export async function engineCommit(exec: Exec, packageRoot: string) {
  try {
    const commit = await run(exec, "git", ["-C", packageRoot, "rev-parse", "HEAD"]);
    const status = await run(exec, "git", ["-C", packageRoot, "status", "--porcelain", "--untracked-files=no", "--", ".", ":!package-lock.json"]);
    return { commit, ...(status ? { dirty: true } : {}) };
  } catch {
    return undefined; // not a git checkout (e.g. an npm install): no provenance, not an error
  }
}

export interface LoadedConfig {
  /** The parsed JSON, not yet validated. */
  file: unknown;
  /** Where it came from, for messages: "origin/main:.pi/crucible.json (abc1234)" or "<path> (working tree)". */
  source: string;
  /** Read from origin/main, not the working tree. */
  onMain: boolean;
  warnings: string[];
}

/** Config file names, newest first: `.pi/factory.json` is the name before the rename to pi-crucible (#23). */
export const CONFIG_NAMES = [".pi/crucible.json", ".pi/factory.json"];

/**
 * The repository's config as origin/main has it, so a run uses the config reviewed on main rather
 * than whatever the main checkout has checked out. Falls back to the main checkout's working tree
 * only when origin/main has no config (a repository's first config PR) or there is no origin/main.
 * Each place is tried with the current name first, then the legacy one (with a warning).
 * Call it after fetching origin.
 */
export async function readCrucibleFile(
  exec: Exec,
  repoRoot: string,
  readText: (p: string) => Promise<string>,
): Promise<LoadedConfig> {
  const parse = (text: string, source: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`cannot parse ${source}: ${(e as Error).message}`);
    }
  };
  const legacy = (name: string) =>
    name === CONFIG_NAMES[0] ? [] : [`${name} is the old name; rename it to ${CONFIG_NAMES[0]} (pi-factory is now pi-crucible).`];
  const main = await exec("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: repoRoot });
  const commit = main.code === 0 ? main.stdout.trim() : "";
  if (commit) {
    for (const name of CONFIG_NAMES) {
      if ((await exec("git", ["cat-file", "-e", `${commit}:${name}`], { cwd: repoRoot })).code !== 0) continue;
      const source = `origin/main:${name} (${commit.slice(0, 7)})`;
      const text = await run(exec, "git", ["cat-file", "blob", `${commit}:${name}`], repoRoot);
      const local = await readText(path.join(repoRoot, name)).catch(() => null);
      const differs =
        typeof local === "string" && local.trim() !== text
          ? [`${path.join(repoRoot, name)} differs from ${source}; this run uses origin/main's. Merge the change to main to use it.`]
          : [];
      return { file: parse(text, source), source, onMain: true, warnings: [...legacy(name), ...differs] };
    }
  }
  const why = commit ? `origin/main has no ${CONFIG_NAMES[0]}` : "there is no origin/main";
  const failures: string[] = [];
  for (const name of CONFIG_NAMES) {
    const configPath = path.join(repoRoot, name);
    const local = await readText(configPath).catch((e: Error) => e);
    if (typeof local !== "string") {
      failures.push(`${configPath}: ${local.message}`);
      continue;
    }
    const source = `${configPath} (working tree)`;
    return {
      file: parse(local, source),
      source,
      onMain: false,
      warnings: [
        ...legacy(name),
        `${why}; using ${source}, which has not been reviewed on main, so its checks are not granted as host commands and integration will report an error. Merge it to main.`,
      ],
    };
  }
  throw new Error(`no config to read: ${why}, and ${failures.join("; ")}. Run /crucible init, or see docs/crucible.md.`);
}

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function prepare(exec: Exec, cwd: string, options: CommandOptions, readText = (p: string) => readFile(p, "utf8")): Promise<Plan> {
  // The main checkout, even when /crucible runs inside one of its worktrees: worktreeRoot is
  // relative to it, and new worktrees must not nest inside old ones.
  const commonDir = await run(exec, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).catch(() => {
    throw new Error(`${cwd} is not inside a git repository`);
  });
  if (path.basename(commonDir) !== ".git") throw new Error(`${cwd}: bare or unusual repository layout (${commonDir})`);
  const repoRoot = path.dirname(commonDir);
  // origin/main is only current after a fetch; offline, the local refs still answer.
  const fetchWarning: string[] = [];
  await run(exec, "git", ["fetch", "origin"], repoRoot).catch((e: Error) =>
    fetchWarning.push(`could not fetch origin (${e.message}); the config and the branch lookup used local refs`),
  );
  const loaded = await readCrucibleFile(exec, repoRoot, readText);
  const problems = crucibleFileErrors(loaded.file);
  if (problems.length) throw new Error(`${loaded.source} is invalid:\n- ${problems.join("\n- ")}`);
  const config = loaded.file as CrucibleFile;

  const repo = config.repo ?? repoFromRemote(await run(exec, "git", ["remote", "get-url", "origin"], repoRoot));
  if (!repo) throw new Error('cannot tell the GitHub repo from the origin remote; set "repo" in .pi/crucible.json');

  const raw = JSON.parse(
    await run(exec, "gh", ["issue", "view", String(options.issue), "-R", repo, "--json", "number,title,state,labels"]),
  ) as { number: number; title: string; state: string; labels: { name: string }[] };
  if (raw.state !== "OPEN") throw new Error(`${repo}#${raw.number} is ${raw.state.toLowerCase()}`);
  const issue: Issue = { number: raw.number, title: raw.title, state: raw.state, labels: raw.labels.map((l) => l.name) };

  const labels = JSON.parse(await run(exec, "gh", ["label", "list", "-R", repo, "--limit", "1000", "--json", "name"])) as { name: string }[];
  const labelCheck = labelProblems(config, repo, labels.map((l) => l.name));
  if (labelCheck.errors.length) throw new Error(labelCheck.errors.join("\n"));

  const worktree = worktreeFor(config, repoRoot, issue.number);
  const existingBranch = (await findIssueBranch(exec, repoRoot, worktree, issue.number)) ?? undefined;

  const engine = await engineCommit(exec, PACKAGE_ROOT);
  const plan = planLaunch({ file: config, repoRoot, repo, issue, options, existingBranch, engine, configSource: loaded.source, configOnMain: loaded.onMain });
  plan.warnings = [...fetchWarning, ...loaded.warnings, ...plan.warnings, ...labelCheck.warnings];
  return plan;
}

/** Create the issue's worktree, or reuse it if it is already on the issue's branch. Returns what it did. */
export async function ensureWorktree(exec: Exec, plan: Plan, exists: (p: string) => Promise<boolean>): Promise<string> {
  const { repoRoot, worktree, branch, startAt } = plan;
  if (await exists(worktree)) {
    const current = await run(exec, "git", ["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    if (current !== branch) throw new Error(`${worktree} exists but is on "${current || "no branch"}", not ${branch}; remove it or move it aside`);
    return `reusing ${worktree} (${branch})`;
  }
  await run(exec, "git", ["fetch", "origin"], repoRoot);
  const has = async (ref: string) => (await exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repoRoot })).code === 0;
  if (await has(`refs/heads/${branch}`)) {
    await run(exec, "git", ["worktree", "add", worktree, branch], repoRoot);
    return `added ${worktree} on the existing branch ${branch}`;
  }
  if (await has(`refs/remotes/origin/${branch}`)) {
    await run(exec, "git", ["worktree", "add", "--track", "-b", branch, worktree, `origin/${branch}`], repoRoot);
    return `added ${worktree} tracking origin/${branch}`;
  }
  if (startAt !== "spec") throw new Error(`--start-at ${startAt} needs an existing branch ${branch}, locally or on origin`);
  await run(exec, "git", ["worktree", "add", "-b", branch, worktree, "origin/main"], repoRoot);
  return `added ${worktree} on a new branch ${branch} from origin/main`;
}

/**
 * Point the plan at the worktree's real path, as git prints it: the workflow's first host step
 * compares the two, so a symlink anywhere in the planned path would otherwise fail every run.
 */
export async function resolveWorktree(exec: Exec, plan: Plan): Promise<void> {
  const real = await run(exec, "git", ["-C", plan.worktree, "rev-parse", "--show-toplevel"]);
  if (real === plan.worktree) return;
  const args = { ...plan.args, worktree: real };
  const errors = argErrors(args);
  if (errors.length) throw new Error(`${plan.worktree} is ${real} on disk, which pi-crucible cannot use: ${errors.join("; ")}`);
  plan.worktree = real;
  plan.args = args;
}
