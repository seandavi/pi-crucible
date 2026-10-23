// pi extension: registers the factory workflow as the named pi-subagents resource "pi-factory"
// in every session, so callers launch it by name instead of by a path into the installed package:
//
//   subagent({ workflow: "pi-factory", async: true, cwd: <repo>, args: { repo, issue, ... } })
//
// Registration is per session (pi-subagents' rule): register on session_start, dispose on
// session_shutdown. The script is re-read on each session_start, so a local checkout picks up
// edits after /reload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { factoryResource, loadScript } from "../src/resource.ts";

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
}
