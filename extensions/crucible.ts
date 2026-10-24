// pi extension for pi-crucible:
//
// - registers workflows/crucible.js as the named pi-subagents resource "pi-crucible" in every session,
//   so it launches by name instead of by a path into the installed package;
// - adds `/crucible <issue>`, which reads the repo's .pi/crucible.json, prepares the issue's worktree
//   and launches the workflow asynchronously through pi-subagents' event-bus RPC.
//
// Registration is per session (pi-subagents' rule): register on session_start, dispose on
// session_shutdown. The script is re-read on each session_start, so a local checkout picks up
// edits after /reload.

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { init, parseInit } from "../src/init.ts";
import { ensureWorktree, parseCommand, prepare } from "../src/launcher.ts";
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
    const exec = (cmd: string, args: string[], o?: { cwd?: string }) => pi.exec(cmd, args, o);
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
      ctx.ui.notify(await ensureWorktree(exec, plan, exists), "info");
      const data = (await rpc(pi, "spawn", { workflow: RESOURCE_NAME, args: plan.args, cwd: plan.repoRoot })) as {
        text?: string;
        details?: { asyncId?: string; runId?: string };
      };
      const id = data?.details?.asyncId ?? data?.details?.runId;
      ctx.ui.notify(
        `Crucible launched for #${plan.args.issue} (${(plan.args.lenses as string[]).join(", ")}${plan.args.seam ? ", seam" : ""})` +
          `${id ? `: run ${id}` : ""}. Follow it with /subagents-fleet.`,
        "info",
      );
    } catch (e) {
      ctx.ui.notify(`/crucible: ${(e as Error).message}`, "error");
    }
  }

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
