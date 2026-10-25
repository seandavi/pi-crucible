// Checks from a repository's CI: the `run:` steps of the GitHub Actions workflows that run on
// pull_request, minus setup steps and steps that only work inside Actions (#33). CI already says
// what "green" means for a repository, so /crucible init prefers this to guessing from
// package.json and friends.

import { parse } from "yaml";
import type { Check } from "./init.ts";

export interface CiDetection {
  /** At most MAX_CHECKS, unique names and commands, in workflow-file, job and step order. */
  checks: Check[];
  /** One line per step, job or file not offered as a check, saying why. */
  skipped: string[];
}

/** The config schema's checks.maxItems. */
const MAX_CHECKS = 8;
/** The config schema's checks[].command maxLength. */
const MAX_COMMAND = 500;

/** Whole-segment patterns for commands that only install or configure things. */
const SETUP = [
  /^(sudo\s+)?(apt-get|apt|brew|choco|yum|dnf|apk)\s.*$/,
  /^(npm|pnpm|bun)\s+(ci|install|i)(\s.*)?$/,
  /^yarn(\s+install)?(\s+--?[\w-]+)*$/,
  /^corepack\s.*$/,
  /^(python3?\s+-m\s+)?pip3?\s+install\s.*$/,
  /^pipx\s+install\s.*$/,
  /^uv\s+(sync|venv|pip\s+install|python\s+install|tool\s+install)(\s.*)?$/,
  /^poetry\s+install(\s.*)?$/,
  /^(npx\s+)?playwright\s+install(\s.*)?$/,
  /^go\s+mod\s+download(\s.*)?$/,
  /^cargo\s+fetch(\s.*)?$/,
  /^bundle\s+install(\s.*)?$/,
  /^git\s+config\s.*$/,
];

const CONTROL_WORDS = new Set("if then else elif fi for while until do done case esac function select".split(" "));

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `workflows` maps a repo-relative path (".github/workflows/ci.yml") to the file's text.
 * Files are read in sorted path order, jobs and steps in document order.
 */
export function checksFromWorkflows(workflows: Record<string, string>): CiDetection {
  const checks: Check[] = [];
  const skipped: string[] = [];
  const names = new Set<string>();

  for (const file of Object.keys(workflows).sort()) {
    let doc: unknown;
    try {
      doc = parse(workflows[file]);
    } catch (e) {
      skipped.push(`${file}: cannot parse (${((e as Error).message ?? "").split("\n")[0]})`);
      continue;
    }
    if (!isObj(doc) || !runsOnPullRequest(doc.on)) continue;

    for (const [jobId, job] of Object.entries(isObj(doc.jobs) ? doc.jobs : {})) {
      if (!isObj(job)) continue;
      if (typeof job.uses === "string") {
        skipped.push(`${file} job ${jobId}: calls ${job.uses}; reusable workflows are not followed`);
        continue;
      }
      if (!Array.isArray(job.steps)) continue;
      for (const step of job.steps) {
        if (!isObj(step) || typeof step.run !== "string") continue;
        const drop = (reason: string) => skipped.push(`\`${short(step.run as string)}\` in ${file}: ${reason}`);

        const dir = workingDirectory(step, job, doc);
        if ([step.run, dir, ...(isObj(step.env) ? Object.values(step.env) : [])].some((v) => v !== undefined && String(v).includes("${{"))) {
          drop("uses GitHub Actions expressions (${{ }})");
          continue;
        }
        if (/\$\{?(GITHUB_ENV|GITHUB_OUTPUT|GITHUB_PATH|GITHUB_STEP_SUMMARY|GITHUB_STATE)\b/.test(step.run)) {
          drop("writes GitHub Actions files");
          continue;
        }
        const shell = step.shell ?? defaultsRun(job).shell ?? defaultsRun(doc).shell;
        if (typeof shell === "string" && !/^(bash|sh)(\s|$)/.test(shell)) {
          drop(`runs in ${shell}, not bash or sh`);
          continue;
        }
        let prefix = "";
        if (dir !== undefined) {
          const clean = String(dir).trim().replace(/\/$/, "");
          if (clean !== "" && clean !== ".") {
            if (!/^[\w.-]+(\/[\w.-]+)*$/.test(clean) || clean.split("/").includes("..")) {
              drop(`working-directory ${clean} is not a plain path inside the repository`);
              continue;
            }
            prefix = `cd ${clean} && `;
          }
        }
        const script = normaliseScript(step.run);
        if ("setup" in script) {
          drop("setup");
          continue;
        }
        if ("error" in script) {
          drop(script.error);
          continue;
        }
        const command = prefix + script.command;
        if (command.length > MAX_COMMAND) {
          drop(`longer than ${MAX_COMMAND} characters`);
          continue;
        }
        if (checks.some((c) => c.command === command)) continue;
        if (checks.length >= MAX_CHECKS) {
          drop(`more than ${MAX_CHECKS} checks; the config allows ${MAX_CHECKS}`);
          continue;
        }
        checks.push({ name: uniqueName(checkName(step, script.command), names), command, from: file });
      }
    }
  }
  return { checks, skipped };
}

function runsOnPullRequest(on: unknown): boolean {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  return isObj(on) && Object.hasOwn(on, "pull_request");
}

/** The `defaults.run` map of a workflow or job, or an empty one. */
function defaultsRun(x: Obj): Obj {
  const defaults = x.defaults;
  const run = isObj(defaults) ? defaults.run : undefined;
  return isObj(run) ? run : {};
}

function workingDirectory(step: Obj, job: Obj, doc: Obj): unknown {
  return step["working-directory"] ?? defaultsRun(job)["working-directory"] ?? defaultsRun(doc)["working-directory"];
}

/** The first non-empty line of a script, for skip messages. */
function short(script: string): string {
  const line = script.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function isSetup(segment: string): boolean {
  return SETUP.some((re) => re.test(segment));
}

/**
 * GitHub runs a `run:` script with `bash -e`, so a multi-line script fails at its first failing line.
 * Joining its lines with ` && ` gives the same result on the single line the workflow prompt lists.
 */
function normaliseScript(run: string): { command: string } | { setup: true } | { error: string } {
  const lines: string[] = [];
  for (const raw of run.replace(/[ \t]*\\\r?\n[ \t]*/g, " ").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const segments = line.split("&&").map((s) => s.trim());
    const kept = segments.filter((s) => !isSetup(s));
    if (kept.length === segments.length) lines.push(line);
    else if (kept.length) lines.push(kept.join(" && "));
  }
  if (lines.length === 0) return { setup: true };
  if (lines.length === 1) return { command: lines[0] };
  const flow = lines.some(
    (l) => CONTROL_WORDS.has(l.split(/\s+/)[0]) || l.endsWith("{") || l.endsWith("(") || l === "}" || l === ")" || l.includes("<<"),
  );
  if (flow) return { error: "multi-line script with shell control flow or a heredoc" };
  return { command: lines.join(" && ") };
}

function slug(s: string): string {
  let out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (out === "") out = "check";
  else if (!/^[a-z]/.test(out)) out = `check-${out}`;
  return out.slice(0, 32).replace(/-+$/, "");
}

/** A step's `name`, else the command's own subject (`npm run lint` → `lint`), as a slug. */
function checkName(step: Obj, command: string): string {
  if (typeof step.name === "string" && step.name.trim() !== "") return slug(step.name);
  const t = command.split(/\s+/).filter(Boolean);
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
  const arg = (i: number) => t.slice(i).find((x) => !x.startsWith("-"));
  let token: string | undefined;
  if (["npm", "pnpm", "yarn", "bun"].includes(t[0])) token = t[1] === "run" ? arg(2) : t[1] === "test" || t[1] === "t" ? "test" : arg(1);
  else if (["just", "make"].includes(t[0])) token = arg(1) ?? t[0];
  else if (["npx", "pnpx", "uvx", "bunx"].includes(t[0])) token = arg(1);
  else if (["uv", "poetry", "pdm", "hatch"].includes(t[0]) && t[1] === "run") token = arg(2);
  else token = t[0];
  return slug((token ?? "").split("/").pop()!.replace(/\.[A-Za-z]+$/, ""));
}

function uniqueName(base: string, names: Set<string>): string {
  let name = base;
  for (let n = 2; names.has(name); n++) {
    const suffix = `-${n}`;
    name = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  names.add(name);
  return name;
}
