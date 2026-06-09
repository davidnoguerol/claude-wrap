// ClaudeCodeAdapter: drives the interactive `claude` CLI under a PTY and turns
// the hook stream (+ transcript tail) into normalized AgentEventMap events.
//
// Channel split (validated in Phase 0):
//   - Hooks (over a private Unix socket) are the realtime event spine:
//     SessionStart = ready canary (+ transcript_path); PreToolUse = toolUse;
//     PostToolUse(/Failure) = toolResult; Stop(/Failure) = turn-complete + text.
//   - Transcript JSONL tail supplies token usage (dedup by message.id) and the
//     authoritative terminal stop_reason. finishTurn() drain()s it synchronously
//     so the final assistant line is counted even if Stop beats the poll.
//   - The PTY is control (bracketed-paste input) + liveness (best-effort
//     usage-limit text scan) only.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  SessionOptions,
  SessionState,
  SendOptions,
  StopReason,
  ToolUseEvent,
  TurnResult,
  UsageEvent,
} from "../../types.js";
import { buildChildEnv, checkSubscriptionAuth } from "../../auth/scrub.js";
import { spawnPty, type PtyHandle } from "../../transport/pty.js";
import { HookSocket, type HookEvent } from "../../transport/hook-socket.js";
import { TranscriptTail, type TranscriptEntry } from "../../transport/transcript-tail.js";
import { buildHooksSettings } from "./hooks-settings.js";
import { estimateCostUsd } from "./pricing.js";

const READY_TIMEOUT_MS = 30_000;
const PASTE_ENTER_DELAY_MS = 300;
// NOTE: the Ink TUI positions text with cursor moves, not literal spaces, so
// after ANSI-stripping the screen text is whitespace-collapsed (e.g. "Yes,I
// trustthisfolder"). These patterns match the whitespace-removed form.
const LIMIT_RE = /usagelimitreached|usagecreditlimitreached|upgradetoincreaseyourusagelimit/i;
// Folder-trust dialog shown for an untrusted cwd. SessionStart does not fire
// until it is accepted; the default selection is "Yes, I trust this folder", so
// a single Enter clears it (and the CLI then persists trust for that cwd).
const TRUST_RE = /trustthisfolder|createdoroneyoutrust/i;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function discoverClaude(override?: string): string {
  if (override) return override;
  try {
    const p = execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim();
    if (p) return p;
  } catch {
    /* fall through to PATH lookup at spawn */
  }
  return "claude";
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export class ClaudeCodeAdapter extends EventEmitter {
  readonly sessionId: string;
  private state: SessionState = "starting";
  private readonly cliPath: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly opts: SessionOptions;

  private pty?: PtyHandle;
  private socket?: HookSocket;
  private tail?: TranscriptTail;
  private sockDir?: string; // 0700 dir holding the socket + temp settings/mcp files
  private settingsPath?: string;
  private mcpPath?: string;
  private socketPath?: string;
  private model?: string;
  private exited = false;
  private cleaned = false;
  private readied = false;

  private turnCounter = 0;
  private turnId = "";
  private turnActive = false;
  private sending = false;
  private turnTools: ToolUseEvent[] = [];
  private pendingTools = new Map<string, { name: string; input: unknown; turnId: string }>();
  private usageByMsg = new Map<string, RawUsage>();
  private terminalStopReason?: StopReason;
  private limitBuf = "";
  private trustHandled = false;

  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private readyTimer?: NodeJS.Timeout;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.sessionId)) {
      throw new Error(`invalid sessionId '${this.sessionId}': must be 1-64 chars of [A-Za-z0-9_-]`);
    }
    this.cliPath = discoverClaude(opts.cliPath);
    this.env = buildChildEnv(opts.env);
  }

  getSessionId(): string {
    return this.sessionId;
  }
  getState(): SessionState {
    return this.state;
  }

  private setState(s: SessionState): void {
    if (this.state !== s) {
      this.state = s;
      this.emit("state", s);
    }
  }

  async start(): Promise<void> {
    if (this.pty || this.socket) throw new Error("session already started (create a new session to restart)");

    // Private, current-user-only dir (0700) for the socket + temp files: blocks
    // other local users and gives a unique, short, collision-free socket path.
    this.sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
    this.socketPath = path.join(this.sockDir, "h.sock");
    this.socket = new HookSocket(this.socketPath);
    this.socket.on("event", (e: HookEvent) => this.onHook(e));
    await this.socket.start();

    // Write hooks settings BEFORE the auth probe.
    this.settingsPath = path.join(this.sockDir, "hooks.json");
    fs.writeFileSync(this.settingsPath, JSON.stringify(buildHooksSettings(this.socketPath)));

    // HARD REQUIREMENT: subscription-only. Probe in the session cwd so a project
    // .claude/ apiKeyHelper/env that could inject an API key is reflected here too.
    const auth = checkSubscriptionAuth(this.cliPath, this.env, this.cwd);
    if (!auth.ok) {
      this.cleanup();
      this.emit("error", { message: `subscription auth check failed: ${auth.detail}`, fatal: true });
      throw new Error(`subscription auth check failed: ${auth.detail}`);
    }

    const args = this.buildArgs();
    this.pty = spawnPty(this.cliPath, args, { cwd: this.cwd, env: this.env });
    this.pty.onData((d) => this.onPtyData(d));
    this.pty.onExit((e) => this.onExit(e));

    this.setState("starting");
    try {
      await new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
        this.readyTimer = setTimeout(() => {
          this.readyReject?.(new Error("ready timeout: SessionStart hook never fired (hooks not loaded? refusing to run blind)"));
        }, READY_TIMEOUT_MS);
      });
    } catch (e) {
      // Failed start: release the orphaned process + socket + temp files.
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      }
      this.readyResolve = undefined;
      this.readyReject = undefined;
      try {
        this.pty?.kill();
      } catch {
        /* */
      }
      if (this.state !== "stopped") this.setState("crashed");
      this.cleanup();
      throw e;
    }
  }

  private buildArgs(): string[] {
    const o = this.opts;
    const a: string[] = [];
    if (o.resume) a.push("--resume", this.sessionId);
    else a.push("--session-id", this.sessionId);
    a.push("--settings", this.settingsPath as string);
    a.push("--permission-mode", o.permission?.mode ?? "acceptEdits");
    if (o.model) a.push("--model", o.model);
    if (o.systemPrompt) a.push("--system-prompt", o.systemPrompt);
    if (o.appendSystemPrompt) a.push("--append-system-prompt", o.appendSystemPrompt);
    if (o.allowedTools?.length) a.push("--allowedTools", ...o.allowedTools);
    if (o.disallowedTools?.length) a.push("--disallowedTools", ...o.disallowedTools);
    for (const d of o.addDirs ?? []) a.push("--add-dir", d);
    if (o.mcpConfig && Object.keys(o.mcpConfig).length) {
      this.mcpPath = path.join(this.sockDir as string, "mcp.json");
      fs.writeFileSync(this.mcpPath, JSON.stringify({ mcpServers: o.mcpConfig }));
      a.push("--mcp-config", this.mcpPath);
    }
    return a;
  }

  private onHook(e: HookEvent): void {
    switch (e.hook_event_name) {
      case "SessionStart": {
        this.model = typeof e.model === "string" ? e.model : this.opts.model;
        if (e.transcript_path && !this.tail) {
          this.tail = new TranscriptTail(e.transcript_path);
          this.tail.on("entry", (en: TranscriptEntry) => this.onTranscript(en));
          this.tail.start();
        }
        // Only the FIRST SessionStart completes the ready handshake; later ones
        // (resume/compact/clear) must not reset state or re-fire ready.
        if (!this.readied) {
          this.readied = true;
          if (this.readyTimer) {
            clearTimeout(this.readyTimer);
            this.readyTimer = undefined;
          }
          this.setState("ready");
          this.emit("ready", { sessionId: this.sessionId, model: this.model });
          const res = this.readyResolve;
          this.readyResolve = undefined;
          this.readyReject = undefined;
          res?.();
        }
        break;
      }
      case "UserPromptSubmit":
        if (this.turnActive) this.setState("busy");
        break;
      case "PreToolUse": {
        const id = e.tool_use_id ?? "";
        if (id) this.pendingTools.set(id, { name: e.tool_name ?? "", input: e.tool_input, turnId: this.turnId });
        this.emit("toolUse", { toolUseId: id, name: e.tool_name ?? "", input: e.tool_input, turnId: this.turnId });
        break;
      }
      case "PostToolUse": {
        const tid = this.recordTool(e);
        this.emit("toolResult", {
          toolUseId: e.tool_use_id ?? "",
          name: e.tool_name ?? "",
          ok: true,
          result: e.tool_response,
          durationMs: e.duration_ms,
          turnId: tid,
        });
        break;
      }
      case "PostToolUseFailure": {
        const tid = this.recordTool(e);
        const err = typeof e.error === "string" ? e.error : e.error != null ? JSON.stringify(e.error) : "tool failed";
        this.emit("toolResult", { toolUseId: e.tool_use_id ?? "", name: e.tool_name ?? "", ok: false, error: err, turnId: tid });
        break;
      }
      case "Stop":
        void this.finishTurn(typeof e.last_assistant_message === "string" ? e.last_assistant_message : "", false);
        break;
      case "StopFailure":
        this.emit("error", { message: "turn ended on error (StopFailure)", fatal: false, raw: e.error });
        void this.finishTurn(typeof e.last_assistant_message === "string" ? e.last_assistant_message : "", true);
        break;
      default:
        break; // SubagentStop and others: not modeled in Phase 1/2
    }
  }

  /** Records the tool into the turn and returns the turnId it belongs to. */
  private recordTool(e: HookEvent): string {
    const id = e.tool_use_id ?? "";
    const p = this.pendingTools.get(id);
    const tid = p?.turnId ?? this.turnId;
    this.turnTools.push({ toolUseId: id, name: e.tool_name ?? p?.name ?? "", input: p?.input ?? e.tool_input, turnId: tid });
    return tid;
  }

  private onTranscript(en: TranscriptEntry): void {
    if (en.type !== "assistant" || !en.message) return;
    const id = en.message.id;
    if (id && en.message.usage) this.usageByMsg.set(id, en.message.usage as RawUsage);
    const sr = en.message.stop_reason;
    if (sr && sr !== "tool_use") this.terminalStopReason = this.mapStopReason(sr);
    // Emit each assistant text block as a complete `text` event. The transcript
    // splits one API response across lines (thinking / tool_use / text), each
    // carrying a single content block, so we emit as text blocks land — both
    // intermediate (via the poll) and the final one (via drain() at Stop).
    const content = en.message.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          this.emit("text", { text: block.text, blockId: en.uuid, turnId: this.turnId });
        }
      }
    }
  }

  private mapStopReason(sr: string): StopReason {
    switch (sr) {
      case "end_turn":
      case "max_tokens":
      case "stop_sequence":
      case "refusal":
        return sr;
      default:
        return "unknown";
    }
  }

  private sumUsage(): UsageEvent {
    let i = 0;
    let o = 0;
    let cr = 0;
    let cc = 0;
    for (const u of this.usageByMsg.values()) {
      i += u.input_tokens ?? 0;
      o += u.output_tokens ?? 0;
      cr += u.cache_read_input_tokens ?? 0;
      cc += u.cache_creation_input_tokens ?? 0;
    }
    return { turnId: this.turnId, inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc };
  }

  private async finishTurn(text: string, isError: boolean): Promise<void> {
    if (!this.turnActive) return; // ignore Stop with no active turn / duplicate terminal hook
    this.turnActive = false;
    // Stop can beat the transcript flush, so the final assistant line (its text
    // block, usage, and terminal stop_reason) may not be on disk yet. Drain in a
    // short bounded loop until we see a terminal stop_reason for the turn. Each
    // drain that ingests the text line also emits the `text` event.
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try {
        this.tail?.drain();
      } catch {
        /* */
      }
      if (this.terminalStopReason) break;
      await sleep(50);
    }
    try {
      this.tail?.drain();
    } catch {
      /* */
    }
    const usage = this.sumUsage();
    const result: TurnResult = {
      turnId: this.turnId,
      text,
      stopReason: this.terminalStopReason ?? (isError ? "error" : "end_turn"),
      isError,
      usage,
      costUsd: estimateCostUsd(this.model, usage),
      tools: this.turnTools.slice(),
    };
    this.emit("usage", usage);
    this.emit("turnComplete", result);
    this.resetTurn();
    if (this.state !== "stopped" && !this.exited && this.state !== "limited") this.setState("ready");
  }

  private resetTurn(): void {
    this.turnTools = [];
    this.pendingTools.clear();
    this.usageByMsg.clear();
    this.terminalStopReason = undefined;
  }

  private onPtyData(d: string): void {
    // PTY is liveness only. Two screen-scrape gates: (1) auto-accept the
    // folder-trust dialog (blocks an untrusted cwd; SessionStart won't fire
    // until accepted), (2) best-effort usage-limit notice (precise phrases only).
    this.limitBuf = (this.limitBuf + d).slice(-4000);
    const compact = this.limitBuf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, "");
    if (!this.readied && !this.trustHandled && TRUST_RE.test(compact)) {
      this.trustHandled = true;
      this.pty?.write("\r"); // accept default "Yes, I trust this folder"
    }
    if (this.state !== "limited") {
      const m = compact.match(LIMIT_RE);
      if (m) {
        const kind = /credit/i.test(m[0]) ? "usage_credit" : "five_hour";
        this.emit("limit", { kind, raw: m[0] });
        this.setState("limited");
      }
    }
  }

  private onExit(e: { exitCode: number; signal?: number }): void {
    this.exited = true;
    this.tail?.stop();
    const wasTurn = this.turnActive;
    const notReady = !this.readied;
    this.emit("exit", { code: e.exitCode ?? null, signal: e.signal != null ? String(e.signal) : null });
    if (this.state !== "stopped") {
      // Unexpected exit (crash). Surface it instead of hanging consumers.
      this.emit("error", { message: `claude exited unexpectedly (code=${e.exitCode ?? "?"}, signal=${e.signal ?? "?"})`, fatal: true });
      if (notReady && this.readyReject) {
        const rj = this.readyReject;
        this.readyResolve = undefined;
        this.readyReject = undefined;
        if (this.readyTimer) {
          clearTimeout(this.readyTimer);
          this.readyTimer = undefined;
        }
        rj(new Error("claude exited before becoming ready"));
      }
      if (wasTurn) void this.finishTurn("", true); // resolve the in-flight turn as errored
      this.setState("crashed");
    }
    this.cleanup();
  }

  async send(text: string, opts?: SendOptions): Promise<void> {
    if (this.exited || !this.pty) throw new Error("session is not running");
    if (this.state === "starting") throw new Error("session is not ready yet (await start())");
    if (this.state === "busy") throw new Error("a turn is already in progress");
    if (this.state === "limited") throw new Error("session is rate-limited");
    if (this.state !== "ready") throw new Error(`cannot send in state '${this.state}'`);

    this.turnCounter += 1;
    this.turnId = `turn-${this.turnCounter}`;
    this.resetTurn();
    this.turnActive = true;

    let full = text;
    if (opts?.attachments?.length) {
      const list = opts.attachments.map((x) => x.path).join(", ");
      full += `\n\n[Attached files (read them as needed): ${list}]`;
    }
    this.setState("busy");
    const pty = this.pty;
    this.sending = true;
    try {
      pty.write("\x1b[200~" + full + "\x1b[201~");
      await sleep(PASTE_ENTER_DELAY_MS);
      pty.write("\r");
    } finally {
      this.sending = false;
    }
  }

  async interrupt(): Promise<void> {
    // Never inject ESC mid-paste: wait for send()'s Enter to be written first.
    while (this.sending) await sleep(20);
    this.pty?.write("\x1b");
    if (this.state === "busy") {
      // The aborted turn may never emit Stop; unwedge proactively.
      this.turnActive = false;
      this.resetTurn();
      this.setState("ready");
    }
  }

  async stop(): Promise<void> {
    const wasStarting = !this.readied;
    this.setState("stopped");
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    if (wasStarting && this.readyReject) {
      const rj = this.readyReject;
      this.readyResolve = undefined;
      this.readyReject = undefined;
      rj(new Error("session stopped during startup"));
    }
    const pty = this.pty;
    if (pty && !this.exited) {
      try {
        pty.write("\x03");
      } catch {
        /* */
      }
      await sleep(300);
      try {
        pty.write("/exit\r");
      } catch {
        /* */
      }
      await this.waitExit(2500); // keep socket open so the final Stop hook can land
      try {
        if (!this.exited) pty.kill();
      } catch {
        /* */
      }
      await this.waitExit(500);
    }
    this.cleanup();
  }

  private async waitExit(ms: number): Promise<void> {
    const dl = Date.now() + ms;
    while (!this.exited && Date.now() < dl) await sleep(50);
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    try {
      this.tail?.stop();
    } catch {
      /* */
    }
    try {
      this.socket?.close();
    } catch {
      /* */
    }
    if (this.sockDir) {
      try {
        fs.rmSync(this.sockDir, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  }
}
