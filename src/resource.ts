// The engine as a named pi-subagents workflow resource: `subagent({ workflow: "pi-crucible", args })`.
//
// pi-subagents calls `resolve` synchronously with core-validated plain-JSON args (≤ 16 KiB, ≤ 16
// fields per object) and runs only the script it returns: for a named resource the sandbox's `args`
// is empty, so resolve prepends the validated args as `const CRUCIBLE_ARGS = {...};` and the script
// reads them from there. resolve may not do I/O, so the extension reads the script once per session
// and hands it in here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { engineConfigErrors } from "./config.ts";

export const RESOURCE_NAME = "pi-crucible";
/** The name before the rename to pi-crucible (#23); still registered so old launches resolve. */
export const LEGACY_RESOURCE_NAME = "pi-factory";
// 2: args are prepended to the script; 3: renamed (pi-crucible, CRUCIBLE_ARGS).
export const RESOURCE_VERSION = 3;

/** The workflow script shipped with this package. */
export const SCRIPT_URL = new URL("../workflows/crucible.js", import.meta.url);

export function loadScript(url: URL = SCRIPT_URL): string {
  return readFileSync(url, "utf8");
}

type Args = Readonly<Record<string, unknown>>;
type Check = (value: unknown) => string | null;

const STAGES = ["spec", "implement", "review"];
// The worktree path is written into commands the stages run; spaces are fine (it is single-quoted there).
const UNSAFE_PATH_CHARS = /[\x00-\x1f\x7f`$\\"';|&<>(){}*?!~]/;

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const str: Check = (v) => (typeof v === "string" && v.trim() ? null : "must be a non-empty string");

// One entry per argument the script reads. Keep in step with the args comment in crucible.js.
const FIELDS: Record<string, { required: boolean; check: Check }> = {
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
    check: (v) => (isPositiveInt(v) && v <= 5 ? null : "must be an integer 1–5"),
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

/** The resource definition for registerWorkflowResource, closed over an already-read script. */
export function crucibleResource(script: string, name: string = RESOURCE_NAME) {
  return {
    name,
    version: RESOURCE_VERSION,
    resolve(args: Args): { script: string } | { error: string } {
      const errors = argErrors(args);
      if (errors.length) return { error: `pi-crucible: ${errors.join("; ")}.` };
      return { script: `const CRUCIBLE_ARGS = ${JSON.stringify(args)};\n${script}` };
    },
  };
}
