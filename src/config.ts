// A repository's factory configuration: `.pi/factory.json`.
//
// The file has two parts. The launcher reads all of it. The engine part (EngineConfig) is everything
// the workflow script needs to know about the project, and travels to the script as `args.config`,
// because the sandbox cannot read files. pi-subagents caps args at 16 KiB of JSON and 16 fields per
// object, so the limits below keep the engine part inside those bounds.
//
// The schema is the single source of truth: schema/factory.schema.json is generated from it
// (npm run schema) for editors, and the tests fail if the two drift.

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const Text = (description: string, maxLength = 4000) => Type.String({ minLength: 1, maxLength, description });
const Name = Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" });
const Repo = Type.String({ pattern: "^[\\w.-]+/[\\w.-]+$", description: '"owner/name" on GitHub' });

export const EngineConfig = Type.Object(
  {
    design: Text(
      "Where the project's design lives and how to treat it, for every stage. E.g. 'The design record is README.md plus the ADRs in docs/adr/; a change that contradicts an ADR must say so in its spec.'",
    ),
    seamNote: Type.Optional(
      Text("What later issues build on, for the `seam` label's reviewer note. E.g. 'the export query, the page templates'.", 500),
    ),
    specDir: Type.Optional(
      Type.String({ pattern: "^[\\w.-]+(/[\\w.-]+)*$", description: "Where specs are written (default docs/specs)." }),
    ),
    spec: Type.Object(
      {
        design: Text(
          "What the spec's Design section must pin down for this project (files, interfaces, schemas, routes, fixtures...).",
        ),
      },
      { additionalProperties: false },
    ),
    implement: Text("Project rules for the implement stage: fixtures, data that tests must never read, how to run things."),
    checks: Type.Array(
      Type.Object(
        {
          name: Name,
          command: Text("Shell command, run from the worktree root.", 500),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 8, description: "Commands every writing stage runs and reports, by name; integration runs all of them after merging main." },
    ),
    lenses: Type.Record(Name, Text("What this reviewer checks.", 3000), {
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 8,
      description: "Review lenses by name. `code` must be defined; label `review:<name>` adds a lens to a run.",
    }),
    skills: Type.Optional(
      Type.Object(
        {
          build: Type.Optional(Type.String({ minLength: 1, description: "Skill(s) for implement and revise (comma-separated)." })),
          lenses: Type.Optional(Type.Record(Name, Type.String({ minLength: 1 }), { additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    commitAuthor: Type.Optional(
      Type.Object(
        {
          name: Type.String({ pattern: "^[^\\x00-\\x1f\\x7f`$\\\\]+$", description: "No control characters, backticks, $ or backslashes." }),
          email: Type.String({ pattern: "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$" }),
        },
        { additionalProperties: false, description: "Commit identity for the stages (default: the worktree's git config)." },
      ),
    ),
    models: Type.Optional(
      Type.Object(
        {
          strong: Type.Optional(Type.String({ minLength: 1, description: "Spec and review (default claude-bridge/claude-opus-5-5)." })),
          fast: Type.Optional(Type.String({ minLength: 1, description: "Implement, revise, the integration fix, PR (default claude-bridge/claude-sonnet-5-5)." })),
          small: Type.Optional(Type.String({ minLength: 1, description: "Flagging a human, writing the review diff, and the integration merge and checks (default claude-bridge/claude-haiku-5-5)." })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type EngineConfig = Static<typeof EngineConfig>;

const LAUNCHER_FIELDS = {
  $schema: Type.Optional(Type.String()),
  repo: Type.Optional(Repo),
  worktreeRoot: Type.Optional(
    Type.String({
      minLength: 1,
      description: "Where issue worktrees go: absolute, ~/..., or relative to the repo root (default ../<repo>-worktrees).",
    }),
  ),
  parent: Type.Optional(Type.Integer({ minimum: 1, description: "Tracking issue; follow-up issues become its sub-issues." })),
  defaultLenses: Type.Optional(
    Type.Array(Name, { minItems: 1, description: 'Lenses every run gets; must include "code" (default ["code"]).' }),
  ),
};

export const FactoryFile = Type.Object(
  { ...LAUNCHER_FIELDS, ...EngineConfig.properties },
  {
    additionalProperties: false,
    title: "pi-factory configuration (.pi/factory.json)",
    description: "See https://github.com/seandavi/pi-factory/blob/main/docs/factory.md",
  },
);
export type FactoryFile = Static<typeof FactoryFile>;

function errors(schema: Parameters<typeof Value.Errors>[0], value: unknown, extra: string[]): string[] {
  const out = [...Value.Errors(schema, value)]
    .filter((e) => e.keyword !== "boolean") // "schema is false" repeats an additionalProperties error
    .map((e) => {
      const path = e.instancePath || "(root)";
      const extraKeys = (e.params as { additionalProperties?: string[] }).additionalProperties;
      return extraKeys ? `${path}: unknown field(s) ${extraKeys.join(", ")}` : `${path}: ${e.message}`;
    });
  return [...new Set(out)].concat(extra);
}

/** Cross-field rules the schema cannot express. Only meaningful once the shape is valid. */
function engineRules(c: EngineConfig): string[] {
  const out: string[] = [];
  if (!c.lenses.code) out.push('/lenses: must define the "code" lens');
  for (const lens of Object.keys(c.skills?.lenses ?? {})) {
    if (!c.lenses[lens]) out.push(`/skills/lenses/${lens}: no such lens`);
  }
  const names = c.checks.map((k) => k.name);
  if (new Set(names).size !== names.length) out.push("/checks: names must be unique");
  return out;
}

export function engineConfigErrors(value: unknown): string[] {
  if (!Value.Check(EngineConfig, value)) return errors(EngineConfig, value, []);
  return engineRules(value);
}

export function factoryFileErrors(value: unknown): string[] {
  if (!Value.Check(FactoryFile, value)) return errors(FactoryFile, value, []);
  const out = engineRules(value);
  if (value.defaultLenses && !value.defaultLenses.includes("code")) out.push('/defaultLenses: must include "code"');
  for (const lens of value.defaultLenses ?? []) {
    if (!value.lenses[lens]) out.push(`/defaultLenses: no lens named "${lens}"`);
  }
  return out;
}

/** The part of the file the workflow script receives as args.config. */
export function engineConfigOf(file: FactoryFile): EngineConfig {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(EngineConfig.properties)) {
    if ((file as Record<string, unknown>)[key] !== undefined) out[key] = (file as Record<string, unknown>)[key];
  }
  return out as EngineConfig;
}
