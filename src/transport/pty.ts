// Thin wrapper over node-pty. Generic terminal control only — the bracketed-paste
// input framing and any provider-specific behavior live in the adapter.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// node-pty is a native CJS addon; lazy-require so bundlers/test runners don't choke.
// (Packaging note: its prebuilt `spawn-helper` may ship without +x — the package
// postinstall must `chmod +x` it, or `posix_spawnp failed` at spawn time.)
const nodePty: any = require("node-pty");

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}

export function spawnPty(file: string, args: string[], opts: PtyOptions): PtyHandle {
  const term = nodePty.spawn(file, args, {
    name: "xterm-256color",
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 40,
    cwd: opts.cwd,
    env: opts.env as { [key: string]: string },
  });
  return {
    pid: term.pid,
    write: (d: string) => term.write(d),
    resize: (c: number, r: number) => term.resize(c, r),
    kill: (s?: string) => term.kill(s),
    onData: (cb: (data: string) => void) => term.onData(cb),
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => term.onExit(cb),
  };
}
