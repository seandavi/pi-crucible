// The engine as a named pi-subagents workflow resource: `subagent({ workflow: "pi-crucible", args })`.
//
// pi-subagents calls `resolve` synchronously with core-validated plain-JSON args (≤ 16 KiB, ≤ 16
// fields per object) and runs only the script it returns: for a named resource the sandbox's `args`
// is empty, so resolve prepends the validated args as `const CRUCIBLE_ARGS = {...};` and the script
// reads them from there. resolve may not do I/O, so the extension reads the script once per session
// and hands it in here.
//
// resolve also grants the run's host commands (runs.host, #57): the fixed table in hostTable below,
// prepended as CRUCIBLE_HOST so the script runs exactly the granted strings. pi-subagents matches a
// call to its grant by exact key and command and runs the command with `sh -c` in the workflow cwd
// (the worktree: /crucible launches there, and the script's first host step checks it).
//
// The args are the caller's, so they cannot be what authorises a check command. The extension
// records the checks of each config /crucible read from origin/main (CheckGrants, kept in the
// session as CHECK_GRANT_ENTRY entries so a /reload restores them), and resolve grants a run's
// checks only when they are one of those records for its worktree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { engineConfigErrors, type EngineConfig } from "./config.ts";

type Check = EngineConfig["checks"][number];

export const RESOURCE_NAME = "pi-crucible";
/** The name before the rename to pi-crucible (#23); still registered so old launches resolve. */
export const LEGACY_RESOURCE_NAME = "pi-factory";
// 2: args are prepended to the script; 3: renamed (pi-crucible, CRUCIBLE_ARGS); 4: host commands.
export const RESOURCE_VERSION = 4;

/** The workflow script shipped with this package. */
export const SCRIPT_URL = new URL("../workflows/crucible.js", import.meta.url);

export function loadScript(url: URL = SCRIPT_URL): string {
  return readFileSync(url, "utf8");
}

type Args = Readonly<Record<string, unknown>>;
type FieldCheck = (value: unknown) => string | null;

const STAGES = ["spec", "implement", "review"];
/** The most review rounds a run may ask for; it bounds the diff grants below. */
export const MAX_ROUNDS = 5;
// The worktree path is written into commands the stages run; spaces are fine (it is single-quoted there).
const UNSAFE_PATH_CHARS = /[\x00-\x1f\x7f`$\\"';|&<>(){}*?!~]/;

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const str: FieldCheck = (v) => (typeof v === "string" && v.trim() ? null : "must be a non-empty string");

// One entry per argument the script reads. Keep in step with the args comment in crucible.js.
const FIELDS: Record<string, { required: boolean; check: FieldCheck }> = {
  repo: {
    required: true,
    check: (v) => (typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v) ? null : 'must be "owner/name"'),
  },
  issue: { required: true, check: (v) => (isPositiveInt(v) ? null : "must be a positive integer") },
  slug: {
    required: true,
    check: (v) => (typeof v === "string" && /^[a-z0-9][a-z0-9-]*$/.test(v) ? null : "must be kebab-case"),
  },
  worktree: {
    required: true,
    check: (v) => (typeof v === "string" && v.startsWith("/") ? null : "must be an absolute path"),
  },
  branch: { required: true, check: str },
  lenses: {
    required: false,
    check: (v) =>
      Array.isArray(v) && v.length > 0 && v.every((l) => typeof l === "string" && l.trim())
        ? null
        : "must be a non-empty array of lens names",
  },
  maxRounds: {
    required: false,
    check: (v) => (isPositiveInt(v) && v <= MAX_ROUNDS ? null : `must be an integer 1–${MAX_ROUNDS}`),
  },
  seam: { required: false, check: (v) => (typeof v === "boolean" ? null : "must be a boolean") },
  startAt: {
    required: false,
    check: (v) => (typeof v === "string" && STAGES.includes(v) ? null : `must be one of ${STAGES.join(", ")}`),
  },
  parent: { required: false, check: (v) => (isPositiveInt(v) ? null : "must be a positive integer") },
  config: {
    required: true,
    check: (v) => {
      const errors = engineConfigErrors(v);
      return errors.length ? `is not a valid engine config (${errors.join("; ")})` : null;
    },
  },
  engine: {
    required: false,
    check: (v) => {
      const e = v as { commit?: unknown; dirty?: unknown };
      const ok =
        typeof v === "object" && v !== null && !Array.isArray(v) &&
        Object.keys(v).every((k) => k === "commit" || k === "dirty") &&
        typeof e.commit === "string" && /^[0-9a-f]{7,40}$/.test(e.commit) &&
        (e.dirty === undefined || typeof e.dirty === "boolean");
      return ok ? null : "must be { commit: <git sha>, dirty?: boolean }";
    },
  },
};

/** Every problem with `args`, as messages an agent can act on; empty when the args are valid. */
export function argErrors(args: Args): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(args)) {
    if (!(key in FIELDS)) errors.push(`unknown arg "${key}" (known: ${Object.keys(FIELDS).join(", ")})`);
  }
  for (const [key, { required, check }] of Object.entries(FIELDS)) {
    if (args[key] === undefined) {
      if (required) errors.push(`missing required arg "${key}"`);
      continue;
    }
    const problem = check(args[key]);
    if (problem) errors.push(`arg "${key}" ${problem}`);
  }
  if (!errors.length) {
    const defined = (args.config as { lenses: Record<string, string> }).lenses;
    const lenses = ["code", ...((args.lenses as string[] | undefined) ?? [])];
    const missing = lenses.filter((l) => !defined[l]);
    if (missing.length) errors.push(`no lens text in config.lenses for: ${missing.join(", ")}`);
    // This validator is the only guard for hand launches. Pin the names the launcher derives, so
    // stages cannot be pointed at main (or a path outside the issue's worktree) and the branch
    // is safe to put in shell commands.
    const { issue, slug, branch, worktree } = args as { issue: number; slug: string; branch: string; worktree: string };
    if (branch !== `issue-${issue}-${slug}`) errors.push(`arg "branch" must be "issue-${issue}-${slug}" (issue-<issue>-<slug>)`);
    if (path.posix.normalize(worktree) !== worktree || !worktree.endsWith(`/issue-${issue}`)) {
      errors.push(`arg "worktree" must be a normalized absolute path ending in /issue-${issue}`);
    }
    if (UNSAFE_PATH_CHARS.test(worktree)) {
      errors.push('arg "worktree" may not contain control characters or shell metacharacters (` $ \\ " \' ; | & < > ( ) { } * ? ! ~)');
    }
  }
  return errors;
}

export const GIT_TIMEOUT_MS = 5 * 60_000;
/** Each configured check's time limit on the host (#58 makes it configurable). */
export const CHECK_TIMEOUT_MS = 20 * 60_000;
/** pi-subagents' limits: grants per resource, and runs.host calls per run (one per key here). */
export const HOST_LIMIT = 32;
/** Where the diff steps write, in the worktree; host-review-ignore's `*` .gitignore keeps it out of git. */
export const REVIEW_DIR = ".pi/crucible-review";

/** `output`: a path in the workflow cwd that pi-subagents writes the step's output to (else the run's artifacts). */
export type HostStep = { command: string; timeoutMs: number; output?: string };

// Repository hooks never run from a host step; the rest of the repository's config still applies.
const GIT = "git -c core.hooksPath=/dev/null";

/**
 * Every host command a run may execute, by runs.host key; resolve grants exactly these. The git
 * commands are constants. The checks are the strings of a config /crucible read from origin/main
 * (resolve passes none otherwise), and the stages ran the same strings in their shell before.
 * Nothing from issue, PR or model text reaches a command. Each key runs at most once per run, so a
 * replay (auto-resume) repeats the same idempotent steps.
 */
export function hostTable(checks: readonly Check[]): Record<string, HostStep> {
  const git = (command: string, output?: string): HostStep => ({ command, timeoutMs: GIT_TIMEOUT_MS, ...(output ? { output } : {}) });
  // The fetch prints the fetched origin/main, which the merge task names: a main that moved
  // between a run and its resume changes that task, so the merge runs again.
  const fetch = `${GIT} fetch origin && ${GIT} rev-parse --short origin/main`;
  // ponytail: --short implies --verify, which takes one revision; print full shas, shorten in the script.
  const heads = `${GIT} rev-parse origin/main HEAD`;
  const table: Record<string, HostStep> = {
    "host-worktree": git(`${GIT} rev-parse --show-toplevel --abbrev-ref HEAD`),
    // Its output is the .gitignore. pi-subagents writes an output only inside the workflow cwd and
    // never through a link, which a shell redirect would follow.
    "host-review-ignore": git("echo '*'", `${REVIEW_DIR}/.gitignore`),
    "host-fetch": git(fetch),
    "host-heads": git(heads),
    "host-recheck-fetch": git(fetch),
    "host-recheck-heads": git(heads),
  };
  // Review rounds 0..MAX_ROUNDS, and the integration fix's re-review after the last one. A fixed
  // path per round keeps the reviewers' tasks the same on a resume, so their results are reused.
  for (let r = 0; r <= MAX_ROUNDS + 1; r++) {
    table[`host-diff-r${r}`] = git(`${GIT} diff --no-color --no-ext-diff --no-textconv --numstat --shortstat -p origin/main...HEAD`, `${REVIEW_DIR}/r${r}.diff`);
  }
  for (const c of checks) {
    table[`check-${c.name}`] = { command: c.command, timeoutMs: CHECK_TIMEOUT_MS };
    table[`recheck-${c.name}`] = { command: c.command, timeoutMs: CHECK_TIMEOUT_MS };
  }
  return table;
}

/** The custom session entry the extension writes for each launch whose checks it granted. */
export const CHECK_GRANT_ENTRY = "pi-crucible-check-grant";
export type CheckGrant = { worktree: string; checks: Check[] };

const checksKey = (checks: readonly Check[]) => JSON.stringify(checks.map((c) => [c.name, c.command]));

/**
 * The check lists /crucible launched with, by worktree. Every recorded list stays granted, so a
 * resume after a relaunch with a newer config still resolves to the script it started with.
 */
export class CheckGrants {
  private byWorktree = new Map<string, Set<string>>();

  record(grant: CheckGrant): void {
    const keys = this.byWorktree.get(grant.worktree) ?? new Set();
    keys.add(checksKey(grant.checks));
    this.byWorktree.set(grant.worktree, keys);
  }

  grants(worktree: string, checks: readonly Check[]): boolean {
    return this.byWorktree.get(worktree)?.has(checksKey(checks)) ?? false;
  }

  /** Rebuilt from the session's entries, on session_start. Entries of the wrong shape are skipped. */
  static fromEntries(entries: readonly { type: string; customType?: string; data?: unknown }[]): CheckGrants {
    const out = new CheckGrants();
    for (const e of entries) {
      if (e.type !== "custom" || e.customType !== CHECK_GRANT_ENTRY) continue;
      const g = e.data as Partial<CheckGrant> | undefined;
      const ok =
        typeof g?.worktree === "string" && Array.isArray(g.checks) &&
        g.checks.every((c) => typeof c?.name === "string" && typeof c?.command === "string");
      if (ok) out.record(g as CheckGrant);
    }
    return out;
  }
}

/** The resource definition for registerWorkflowResource, closed over an already-read script. */
export function crucibleResource(script: string, name: string = RESOURCE_NAME, checkGrants: CheckGrants = new CheckGrants()) {
  return {
    name,
    version: RESOURCE_VERSION,
    resolve(args: Args): { script: string; hostCommands: { key: string; command: string }[] } | { error: string } {
      const errors = argErrors(args);
      if (errors.length) return { error: `pi-crucible: ${errors.join("; ")}.` };
      const { checks } = args.config as EngineConfig;
      const table = hostTable(checkGrants.grants(args.worktree as string, checks) ? checks : []);
      return {
        script: `const CRUCIBLE_ARGS = ${JSON.stringify(args)};\nconst CRUCIBLE_HOST = ${JSON.stringify(table)};\n${script}`,
        hostCommands: Object.entries(table).map(([key, { command }]) => ({ key, command })),
      };
    },
  };
}
