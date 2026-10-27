import { readFileSync } from "node:fs";
import type { EngineConfig, CrucibleFile } from "../src/config.ts";

export const engineConfig: EngineConfig = {
  design: "The design record is README.md.",
  spec: { design: "files and interfaces" },
  implement: "Tests never use the network.",
  checks: [{ name: "test", command: "npm test" }],
  lenses: { code: "CODE review.", ux: "UX review." },
};

export const crucibleFile: CrucibleFile = { ...engineConfig, parent: 1, defaultLenses: ["code"] };

export const validArgs = {
  repo: "seandavi/bioc-mcp",
  issue: 2,
  slug: "scaffold",
  worktree: "/tmp/bioc-mcp-worktrees/issue-2",
  branch: "issue-2-scaffold",
  lenses: ["code", "ux"],
  maxRounds: 2,
  seam: true,
  startAt: "review",
  parent: 1,
  config: engineConfig,
  engine: { commit: "4d310bf", dirty: true },
};

export const readJson = (rel: string) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"));

type Handler = (event: unknown, ctx: unknown) => unknown;
export interface ExecCall { cmd: string; args: string[]; cwd?: string }

/** A stand-in for pi's ExtensionAPI: records handlers, commands, exec calls and emitted events. */
export function fakePi(execImpl: (call: ExecCall) => { stdout?: string; stderr?: string; code?: number } = () => ({})) {
  const handlers: Record<string, Handler> = {};
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: { channel: string; data: unknown }[] = [];
  const execCalls: ExecCall[] = [];
  const sent: { message: { customType: string; content: string; details?: unknown }; options?: { deliverAs?: string } }[] = [];
  const pi = {
    sendMessage: (message: (typeof sent)[number]["message"], options?: { deliverAs?: string }) => void sent.push({ message, options }),
    on: (name: string, fn: Handler) => void (handlers[name] = fn),
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => void (commands[name] = def),
    exec: async (cmd: string, args: string[], o?: { cwd?: string }) => {
      const call = { cmd, args, cwd: o?.cwd };
      execCalls.push(call);
      const r = execImpl(call);
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0, killed: false };
    },
    events: {
      on: (channel: string, fn: (data: unknown) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(fn);
        return () => listeners.get(channel)!.delete(fn);
      },
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data });
        for (const fn of listeners.get(channel) ?? []) fn(data);
      },
    },
  };
  return { pi, handlers, commands, emitted, execCalls, sent };
}
