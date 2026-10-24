// pi extension for the factory:
//
// - registers workflows/factory.js as the named pi-subagents resource "pi-factory" in every session,
//   so it launches by name instead of by a path into the installed package;
// - adds `/factory <issue>`, which reads the repo's .pi/factory.json, prepares the issue's worktree
//   and launches the workflow asynchronously through pi-subagents' event-bus RPC.
//
// Registration is per session (pi-subagents' rule): register on session_start, dispose on
// session_shutdown. The script is re-read on each session_start, so a local checkout picks up
// edits after /reload.

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { ensureWorktree, parseCommand, prepare } from "../src/launcher.ts";
import { factoryResource, loadScript, RESOURCE_NAME } from "../src/resource.ts";

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
  let registration: { dispose(): void } | undefined;

  pi.on("session_start", (_event, ctx) => {
    registration?.dispose();
    registration = registerWorkflowResource({
      sessionId: ctx.sessionManager.getSessionId(),
      definition: factoryResource(loadScript()),
    });
  });

  pi.on("session_shutdown", () => {
    registration?.dispose();
    registration = undefined;
  });

  pi.registerCommand("factory", {
    description: "Run an issue through the factory: /factory <issue> [--start-at implement|review] [--lens <name>] [--dry-run]",
    handler: async (input, ctx) => {
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
            `Dry run: would prepare ${plan.worktree} on ${plan.branch} and launch "${RESOURCE_NAME}" with\n` +
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
          `Factory launched for #${plan.args.issue} (${(plan.args.lenses as string[]).join(", ")}${plan.args.seam ? ", seam" : ""})` +
            `${id ? `: run ${id}` : ""}. Follow it with /subagents-fleet.`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`/factory: ${(e as Error).message}`, "error");
      }
    },
    getArgumentCompletions: (prefix) =>
      prefix.startsWith("-")
        ? ["--start-at implement", "--start-at review", "--lens ", "--dry-run"]
            .filter((o) => o.startsWith(prefix))
            .map((value) => ({ value, label: value }))
        : null,
  });
}
