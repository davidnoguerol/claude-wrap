// AgentSession: the provider-neutral public handle. Dispatches to a provider
// adapter, re-emits its normalized events with typed signatures, and supports
// restart() (stop + fresh resume) for crash recovery driven by the consumer.
import { EventEmitter } from "node:events";
import type { SessionOptions, AgentEventMap, SessionState, SendOptions } from "./types.js";
import { ClaudeCodeAdapter } from "./providers/claude/adapter.js";

const FORWARDED: (keyof AgentEventMap)[] = [
  "ready",
  "state",
  "text",
  "textDelta",
  "toolUse",
  "toolResult",
  "turnComplete",
  "usage",
  "limit",
  "compaction",
  "sessionEnd",
  "contextStatus",
  "error",
  "exit",
];

function makeAdapter(opts: SessionOptions): ClaudeCodeAdapter {
  if (opts.provider !== "claude-code") {
    throw new Error(`provider '${opts.provider}' is not implemented yet (Codex lands in Phase 6)`);
  }
  return new ClaudeCodeAdapter(opts);
}

// Typed event-emitter surface (declaration-merged onto the class; adds typed
// overloads without overriding EventEmitter's runtime methods).
export interface AgentSession {
  on<K extends keyof AgentEventMap>(event: K, listener: (...args: AgentEventMap[K]) => void): this;
  once<K extends keyof AgentEventMap>(event: K, listener: (...args: AgentEventMap[K]) => void): this;
  off<K extends keyof AgentEventMap>(event: K, listener: (...args: AgentEventMap[K]) => void): this;
}

export class AgentSession extends EventEmitter {
  private readonly opts: SessionOptions;
  private adapter: ClaudeCodeAdapter;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
    this.adapter = makeAdapter(opts);
    this.wire(this.adapter);
  }

  private wire(adapter: ClaudeCodeAdapter): void {
    for (const ev of FORWARDED) {
      adapter.on(ev, (...args: unknown[]) => {
        super.emit(ev, ...args);
      });
    }
  }

  start(): Promise<void> {
    return this.adapter.start();
  }
  send(text: string, opts?: SendOptions): Promise<void> {
    return this.adapter.send(text, opts);
  }
  interrupt(): Promise<void> {
    return this.adapter.interrupt();
  }
  stop(): Promise<void> {
    return this.adapter.stop();
  }
  getSessionId(): string {
    return this.adapter.getSessionId();
  }
  getState(): SessionState {
    return this.adapter.getState();
  }
  /** Latest CLI transcript path (from SessionStart); undefined before ready. */
  getTranscriptPath(): string | undefined {
    return this.adapter.getTranscriptPath();
  }

  /** Stop the current process and start a fresh one resuming the same session. */
  async restart(): Promise<void> {
    const sessionId = this.adapter.getSessionId();
    try {
      await this.adapter.stop();
    } catch {
      /* already gone */
    }
    this.adapter.removeAllListeners();
    this.adapter = makeAdapter({ ...this.opts, sessionId, resume: true });
    this.wire(this.adapter);
    await this.adapter.start();
  }
}
