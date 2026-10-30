// pi extension for pi-crucible:
//
// - registers workflows/crucible.js as the named pi-subagents resource "pi-crucible" in every session,
//   so it launches by name instead of by a path into the installed package;
// - adds `/crucible <issue>`, which reads the repo's .pi/crucible.json, prepares the issue's worktree
//   and launches the workflow asynchronously through pi-subagents' event-bus RPC;
// - registers the tools `crucible_plan` and `crucible_launch`, the same path for an agent (#53).
//
// Registration is per session (pi-subagents' rule): register on session_start, dispose on
// session_shutdown. The script is re-read on each session_start, so a local checkout picks up
// edits after /reload.

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { init, parseInit } from "../src/init.ts";
import { ensureWorktree, parseCommand, prepare, STARTS, type CommandOptions, type Plan } from "../src/launcher.ts";
import { crucibleResource, LEGACY_RESOURCE_NAME, loadScript, RESOURCE_NAME } from "../src/resource.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";

/** One pi-subagents RPC call; rejects if pi-subagents is not loaded or refuses the request. */
function rpc(pi: ExtensionAPI, method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("pi-subagents did not answer; is the pi-subagents package installed and loaded?"));
    }, timeoutMs);
    const off = pi.events.on(`${RPC_REPLY}${requestId}`, (data) => {
      clearTimeout(timer);
      off();
      const reply = data as { success: boolean; data?: unknown; error?: { code: string; message: string } };
      if (reply.success) resolve(reply.data);
      else reject(new Error(`pi-subagents ${reply.error?.code}: ${reply.error?.message}`));
    });
    pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, params });
  });
}

const exists = (p: string) => access(p).then(() => true, () => false);

/**
 * What the agent that launched or hosts a run must not do when it finishes. A session with "merge on
 * green" instructions merged a crucible PR 28 seconds after it opened (#35).
 */
export const HOSTING =
  "The run opens a PR for a person to review and merge. Do not merge or approve it, push to its branch, " +
  "or comment on or close the issue or the PR; report the PR to the user and stop.";

const lensList = (plan: Plan) => `${(plan.args.lenses as string[]).join(", ")}${plan.args.seam ? ", seam" : ""}`;

const toolParams = Type.Object({
  issue: Type.Integer({ minimum: 1, description: "Issue number in the current repository" }),
  startAt: Type.Optional(Type.Union(STARTS.map((s) => Type.Literal(s)), { description: "Stage to start at; implement and review need the issue's existing branch. Default spec." })),
  lenses: Type.Optional(Type.Array(Type.String(), { description: "Extra review lenses beyond those the config and the issue's labels pick" })),
});
const toolOptions = (p: { issue: number; startAt?: string; lenses?: string[] }, dryRun: boolean): CommandOptions => ({
  issue: p.issue,
  startAt: (p.startAt ?? "spec") as CommandOptions["startAt"],
  lenses: p.lenses ?? [],
  dryRun,
});

export default function (pi: ExtensionAPI) {
  let registrations: { dispose(): void }[] = [];
  const dispose = () => {
    for (const r of registrations) r.dispose();
    registrations = [];
  };

  pi.on("session_start", (_event, ctx) => {
    dispose();
    const script = loadScript();
    // The legacy name keeps launches written before the rename (#23) working.
    registrations = [RESOURCE_NAME, LEGACY_RESOURCE_NAME].map((name) =>
      registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition: crucibleResource(script, name) }),
    );
  });

  pi.on("session_shutdown", dispose);

  const completions = (prefix: string) =>
    prefix.startsWith("-")
      ? ["--start-at implement", "--start-at review", "--lens ", "--dry-run"]
          .filter((o) => o.startsWith(prefix))
          .map((value) => ({ value, label: value }))
      : null;

  pi.registerCommand("crucible", {
    description: "Run an issue through pi-crucible: /crucible <issue> [--start-at implement|review] [--lens <name>] [--dry-run] | /crucible init [--write] [--dry-run]",
    handler: (input, ctx) => runCommand(input, ctx),
    getArgumentCompletions: completions,
  });
  pi.registerCommand("factory", {
    description: "Deprecated: renamed to /crucible",
    handler: (input, ctx) => {
      ctx.ui.notify("/factory is now /crucible (the project was renamed pi-crucible); /factory will go away.", "warning");
      return runCommand(input, ctx);
    },
    getArgumentCompletions: completions,
  });

  async function runCommand(input: string, ctx: ExtensionCommandContext): Promise<void> {
    const words = input.trim().split(/\s+/).filter(Boolean);
    if (words[0] === "init") return runInit(words.slice(1), ctx);
    const options = parseCommand(input);
    if ("error" in options) {
      ctx.ui.notify(options.error, "error");
      return;
    }
    try {
      const plan = await prepare(exec, ctx.cwd, options);
      for (const w of plan.warnings) ctx.ui.notify(w, "warning");
      if (options.dryRun) {
        ctx.ui.notify(
          `Dry run: would prepare ${plan.worktree} on ${plan.branch} and launch "${RESOURCE_NAME}"\n` +
            `Config: ${plan.configSource}\n` +
            `Args:\n` +
            JSON.stringify(plan.args, null, 2),
          "info",
        );
        return;
      }
      const { note, id } = await launch(plan);
      ctx.ui.notify(note, "info");
      const lenses = lensList(plan);
      ctx.ui.notify(`Crucible launched for #${plan.args.issue} (${lenses})${id ? `: run ${id}` : ""}. Follow it with /subagents-fleet.`, "info");
      // notify() reaches only the user. Tell the agent too, or the per-stage notices pi-subagents
      // sends it later name a run it knows nothing about (#49). nextTurn: no turn of its own.
      pi.sendMessage(
        {
          customType: "crucible",
          display: true,
          content:
            `The user ran /crucible for issue #${plan.args.issue}, which launched pi-crucible run ${id ?? "(id unknown)"} ` +
            `in the background, starting at the ${plan.startAt} stage with lenses ${lenses}.\n` +
            `Worktree: ${plan.worktree} (branch ${plan.branch}). Config: ${plan.configSource}.\n` +
            `Workflow notices for this run id are its stages finishing; the run opens a PR itself. ` +
            `When it completes, report the PR, check results, unresolved review findings and follow-up issue to the user. ` +
            `Do not edit the worktree while the run is going. ${HOSTING}`,
          details: { issue: plan.args.issue, runId: id, worktree: plan.worktree, branch: plan.branch, startAt: plan.startAt },
        },
        { deliverAs: "nextTurn" },
      );
    } catch (e) {
      ctx.ui.notify(`/crucible: ${(e as Error).message}`, "error");
    }
  }

  const exec = (cmd: string, args: string[], o?: { cwd?: string }) => pi.exec(cmd, args, o);

  /** Prepare the planned worktree and start the run. Shared by /crucible and crucible_launch. */
  async function launch(plan: Plan): Promise<{ note: string; id?: string }> {
    const note = await ensureWorktree(exec, plan, exists);
    // The workflow cwd is where its host commands run (pi-subagents has no per-step cwd): the worktree.
    const data = (await rpc(pi, "spawn", { workflow: RESOURCE_NAME, args: plan.args, cwd: plan.worktree })) as {
      details?: { asyncId?: string; runId?: string };
    };
    return { note, id: data?.details?.asyncId ?? data?.details?.runId };
  }

  const planSummary = (plan: Plan) => ({
    issue: plan.args.issue as number,
    worktree: plan.worktree,
    branch: plan.branch,
    startAt: plan.startAt,
    lenses: plan.args.lenses as string[],
    seam: Boolean(plan.args.seam),
    configSource: plan.configSource,
    warnings: plan.warnings,
  });

  pi.registerTool({
    name: "crucible_plan",
    label: "Crucible plan",
    description:
      "Plan a pi-crucible run for an issue in the current repository, exactly as `/crucible <issue> --dry-run` would: " +
      "the worktree, branch, lenses, config source, warnings and the validated workflow args. Changes nothing except " +
      "fetching origin. Use it to show the user what a run would do before calling crucible_launch. Errors are the " +
      "ones /crucible would show (closed issue, missing needs:human label, invalid config).",
    parameters: toolParams,
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const plan = await prepare(exec, ctx.cwd, toolOptions(params, true));
      const details = { ...planSummary(plan), args: plan.args };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "crucible_launch",
    label: "Crucible launch",
    description:
      "Start a pi-crucible run (spec → implement → review → revise → integrate → PR) for an issue in the current " +
      "repository, through the same code as `/crucible <issue>`: reads .pi/crucible.json from origin/main, prepares the " +
      "issue's worktree and launches the workflow in the background. Returns the run id. Do not build workflow args by " +
      "hand or launch pi-crucible through subagent directly; use this. Launch only issues the user asked you to run. " +
      "The run opens a PR that a person merges: never merge, approve or close it yourself.",
    parameters: toolParams,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const plan = await prepare(exec, ctx.cwd, toolOptions(params, false));
      const { note, id } = await launch(plan);
      const details = { ...planSummary(plan), runId: id ?? null };
      const text =
        `Launched pi-crucible run ${id ?? "(id unknown)"} for issue #${details.issue} (${lensList(plan)}), ` +
        `starting at ${plan.startAt}; ${note}. Config: ${plan.configSource}.` +
        (plan.warnings.length ? `\nWarnings:\n- ${plan.warnings.join("\n- ")}` : "") +
        `\nThe run is in the background; its stage notices arrive as messages. Do not edit the worktree while it runs. ${HOSTING}`;
      return { content: [{ type: "text", text }], details };
    },
  });

  async function runInit(words: string[], ctx: ExtensionCommandContext): Promise<void> {
    const options = parseInit(words);
    if ("error" in options) {
      ctx.ui.notify(options.error, "error");
      return;
    }
    try {
      const notes = await init(
        {
          exec: (cmd, args, o) => pi.exec(cmd, args, o),
          readText: (p) => readFile(p, "utf8"),
          writeText: async (p, text) => {
            await mkdir(path.dirname(p), { recursive: true });
            await writeFile(p, text, { flag: "wx" }); // never overwrite an existing config
          },
        },
        ctx.cwd,
        options,
      );
      for (const [level, text] of notes) ctx.ui.notify(text, level);
    } catch (e) {
      ctx.ui.notify(`/crucible init: ${(e as Error).message}`, "error");
    }
  }
}
