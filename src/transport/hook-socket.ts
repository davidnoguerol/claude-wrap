// Unix-domain-socket listener for hook events. The shipped forwarder
// (bin/cw-hook-forward.mjs) connects once per hook event and writes the raw
// single-line JSON payload; we parse and emit it. A stream socket (one
// connection per event) avoids the line-interleaving a shared FIFO/file would
// suffer when a hook payload exceeds PIPE_BUF.
import net from "node:net";
import fs from "node:fs";
import { EventEmitter } from "node:events";

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  source?: string;
  model?: string;
  error?: unknown;
  [k: string]: unknown;
}

export class HookSocket extends EventEmitter {
  private server?: net.Server;

  constructor(public readonly socketPath: string) {
    super();
  }

  async start(): Promise<void> {
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* no stale socket */
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((conn) => {
        const chunks: Buffer[] = [];
        conn.on("data", (d: Buffer) => chunks.push(d));
        conn.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          if (!text) return;
          for (const line of text.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              this.emit("event", JSON.parse(t) as HookEvent);
            } catch {
              this.emit("bad", t);
            }
          }
        });
        conn.on("error", () => {
          /* ignore broken forwarder connection */
        });
      });
      server.on("error", reject);
      server.listen(this.socketPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  close(): void {
    try {
      this.server?.close();
    } catch {
      /* */
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* */
    }
  }
}
