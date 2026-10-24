// The factory as a named pi-subagents workflow resource: `subagent({ workflow: "pi-factory", args })`.
//
// pi-subagents calls `resolve` synchronously with core-validated plain-JSON args (≤ 16 KiB, ≤ 16
// fields per object) and runs the returned script with those same args bound to `args`. resolve may
// not do I/O, so the extension reads the script once per session and hands it in here.

import { readFileSync } from "node:fs";
import { engineConfigErrors } from "./config.ts";

export const RESOURCE_NAME = "pi-factory";
export const RESOURCE_VERSION = 1;

/** The workflow script shipped with this package. */
export const SCRIPT_URL = new URL("../workflows/factory.js", import.meta.url);

export function loadScript(url: URL = SCRIPT_URL): string {
  return readFileSync(url, "utf8");
}

type Args = Readonly<Record<string, unknown>>;
type Check = (value: unknown) => string | null;

const STAGES = ["spec", "implement", "review"];

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const str: Check = (v) => (typeof v === "string" && v.trim() ? null : "must be a non-empty string");

// One entry per argument the script reads. Keep in step with the args comment in factory.js.
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
    const lenses = (args.lenses as string[] | undefined) ?? ["code"];
    const missing = lenses.filter((l) => !defined[l]);
    if (missing.length) errors.push(`no lens text in config.lenses for: ${missing.join(", ")}`);
  }
  return errors;
}

/** The resource definition for registerWorkflowResource, closed over an already-read script. */
export function factoryResource(script: string) {
  return {
    name: RESOURCE_NAME,
    version: RESOURCE_VERSION,
    resolve(args: Args): { script: string } | { error: string } {
      const errors = argErrors(args);
      if (errors.length) return { error: `pi-factory: ${errors.join("; ")}.` };
      return { script };
    },
  };
}
