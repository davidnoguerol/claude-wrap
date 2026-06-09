// Generates the --settings JSON that registers our async, pure-observer hooks.
// Every event routes to the shipped forwarder, which ships the payload to the
// wrapper's Unix socket. async:true so observation never blocks the turn.
// Failure variants are mandatory: PostToolUseFailure (else failed tool calls are
// silently missed) and StopFailure (else error-terminated turns are missed).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // src|dist /providers/claude
// Resolves to <package-root>/bin/cw-hook-forward.mjs from both src and dist
// (both are exactly 3 levels under the package root).
const FORWARDER = path.resolve(here, "../../../bin/cw-hook-forward.mjs");

export interface HooksSettings {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; async: boolean }> }>>;
}

export function forwarderPath(): string {
  return FORWARDER;
}

export function buildHooksSettings(socketPath: string): HooksSettings {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(FORWARDER)} ${JSON.stringify(socketPath)}`;
  const obs = [{ type: "command", command, async: true }];
  const tool = (): Array<{ matcher?: string; hooks: typeof obs }> => [{ matcher: "*", hooks: obs }];
  const plain = (): Array<{ hooks: typeof obs }> => [{ hooks: obs }];
  return {
    hooks: {
      SessionStart: plain(),
      UserPromptSubmit: plain(),
      PreToolUse: tool(),
      PostToolUse: tool(),
      PostToolUseFailure: tool(),
      Stop: plain(),
      StopFailure: plain(),
      SubagentStop: plain(),
    },
  };
}
