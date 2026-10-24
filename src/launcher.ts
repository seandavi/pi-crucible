// The /factory command's logic: from "/factory 12" in a repo checkout to the workflow's args.
//
//   parseCommand  "/factory" arguments → issue number and options
//   prepare       reads .pi/factory.json, the issue and the engine commit; plans the launch
//   ensureWorktree creates (or reuses) the issue's worktree and branch
//
// Side effects go through an injected `exec`, so tests can run without git, gh or a network.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engineConfigOf, factoryFileErrors, type FactoryFile } from "./config.ts";
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
  "Usage: /factory <issue> [--start-at implement|review] [--lens <name>]... [--dry-run]";

/** Parse the text after "/factory". Returns an error message instead of throwing. */
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
export function pickLenses(file: FactoryFile, labels: string[], extra: string[]) {
  const defined = Object.keys(file.lenses);
  const wanted = [...(file.defaultLenses ?? ["code"])];
  const warnings: string[] = [];
  for (const label of labels) {
    const m = /^review:(.+)$/.exec(label);
    if (!m) continue;
    if (defined.includes(m[1])) wanted.push(m[1]);
    else warnings.push(`label ${label} names no lens in .pi/factory.json; ignored`);
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

export function worktreeRootFor(file: FactoryFile, repoRoot: string, home = homedir()): string {
  const root = file.worktreeRoot ? expandHome(file.worktreeRoot, home) : `../${path.basename(repoRoot)}-worktrees`;
  return path.resolve(repoRoot, root);
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
  args: Record<string, unknown>;
  warnings: string[];
}

export function planLaunch(input: {
  file: FactoryFile;
  repoRoot: string;
  repo: string;
  issue: Issue;
  options: CommandOptions;
  engine?: { commit: string; dirty?: boolean };
  home?: string;
}): Plan {
  const { file, repoRoot, repo, issue, options } = input;
  const slug = slugify(issue.title);
  const branch = `issue-${issue.number}-${slug}`;
  const worktree = path.join(worktreeRootFor(file, repoRoot, input.home), `issue-${issue.number}`);
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
  if (size > 16 * 1024) throw new Error(`args are ${size} bytes; pi-subagents allows 16384. Shorten lens texts in .pi/factory.json.`);
  return { repoRoot, worktree, branch, startAt: options.startAt, args, warnings };
}

async function run(exec: Exec, cmd: string, args: string[], cwd?: string): Promise<string> {
  const r = await exec(cmd, args, cwd ? { cwd } : undefined);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
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

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function prepare(exec: Exec, cwd: string, options: CommandOptions, readText = (p: string) => readFile(p, "utf8")): Promise<Plan> {
  // The main checkout, even when /factory runs inside one of its worktrees: worktreeRoot is
  // relative to it, and new worktrees must not nest inside old ones.
  const commonDir = await run(exec, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).catch(() => {
    throw new Error(`${cwd} is not inside a git repository`);
  });
  if (path.basename(commonDir) !== ".git") throw new Error(`${cwd}: bare or unusual repository layout (${commonDir})`);
  const repoRoot = path.dirname(commonDir);
  const configPath = path.join(repoRoot, ".pi", "factory.json");
  let file: unknown;
  try {
    file = JSON.parse(await readText(configPath));
  } catch (e) {
    throw new Error(`cannot read ${configPath}: ${(e as Error).message}`);
  }
  const problems = factoryFileErrors(file);
  if (problems.length) throw new Error(`${configPath} is invalid:\n- ${problems.join("\n- ")}`);
  const config = file as FactoryFile;

  const repo = config.repo ?? repoFromRemote(await run(exec, "git", ["remote", "get-url", "origin"], repoRoot));
  if (!repo) throw new Error('cannot tell the GitHub repo from the origin remote; set "repo" in .pi/factory.json');

  const raw = JSON.parse(
    await run(exec, "gh", ["issue", "view", String(options.issue), "-R", repo, "--json", "number,title,state,labels"]),
  ) as { number: number; title: string; state: string; labels: { name: string }[] };
  if (raw.state !== "OPEN") throw new Error(`${repo}#${raw.number} is ${raw.state.toLowerCase()}`);
  const issue: Issue = { number: raw.number, title: raw.title, state: raw.state, labels: raw.labels.map((l) => l.name) };

  const engine = await engineCommit(exec, PACKAGE_ROOT);
  return planLaunch({ file: config, repoRoot, repo, issue, options, engine });
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
