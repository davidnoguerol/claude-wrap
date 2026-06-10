// Provider-neutral public types for claude-wrap.
// The wrapper drives coding-agent CLIs via a PTY (control + liveness) and a
// structured side-channel (hooks + transcript) for events. These types are the
// consumer-facing contract and must stay provider-agnostic.

export type Provider = "claude-code" | "codex";

export type SessionState =
  | "starting"
  | "ready"
  | "busy"
  | "limited"
  | "crashed"
  | "halted"
  | "stopped";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "error"
  | "unknown";

export interface ReadyEvent {
  sessionId: string;
  model?: string;
  /** Absolute path of the CLI's own session transcript JSONL (from the
   *  SessionStart hook). Lets consumers read/copy the full-fidelity record
   *  without re-deriving the CLI's path-mangling scheme. */
  transcriptPath?: string;
}

export interface TextEvent {
  text: string;
  blockId?: string;
  turnId: string;
}

export interface TextDeltaEvent {
  chunk: string;
  blockId?: string;
  turnId: string;
}

export interface ToolUseEvent {
  toolUseId: string;
  name: string;
  input: unknown;
  turnId: string;
}

export interface ToolResultEvent {
  toolUseId: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
  turnId: string;
}

export interface UsageEvent {
  turnId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type LimitKind =
  | "five_hour"
  | "seven_day"
  | "usage_credit"
  | "context"
  | "api_429"
  | "overloaded";

export interface LimitEvent {
  kind: LimitKind;
  usedPercent?: number;
  resetsAt?: number; // epoch ms
  raw: string;
}

/** Emitted after the CLI compacts the conversation (PostCompact hook). The
 *  summary is the full compaction summary the CLI generated — the only place
 *  it is observable. */
export interface CompactionEvent {
  trigger: "manual" | "auto" | "unknown";
  summary?: string;
}

/** Emitted when the CLI session terminates (SessionEnd hook). */
export interface SessionEndEvent {
  reason: string;
}

/** Context-pressure telemetry from the CLI's statusLine channel. Fields are
 *  optional: used_percentage can be null before the first API response. */
export interface ContextStatusEvent {
  usedPercentage?: number;
  remainingPercentage?: number;
  totalInputTokens?: number;
  contextWindowSize?: number;
  costUsd?: number;
}

export interface AgentErrorEvent {
  message: string;
  fatal: boolean;
  raw?: unknown;
}

export interface ExitEvent {
  code: number | null;
  signal: string | null;
}

/** Synthesized at the turn boundary. Replaces the stdout `result` object that
 *  headless mode emits (unavailable when driving the interactive CLI). */
export interface TurnResult {
  turnId: string;
  text: string;
  stopReason: StopReason;
  isError: boolean;
  usage: UsageEvent;
  /** Estimated from a token price table — NOT the CLI's authoritative cost
   *  (that is stdout-only and absent in interactive mode). */
  costUsd?: number;
  tools: ToolUseEvent[];
}

export type AgentEventMap = {
  ready: [ReadyEvent];
  state: [SessionState];
  text: [TextEvent];
  textDelta: [TextDeltaEvent];
  toolUse: [ToolUseEvent];
  toolResult: [ToolResultEvent];
  turnComplete: [TurnResult];
  usage: [UsageEvent];
  limit: [LimitEvent];
  compaction: [CompactionEvent];
  sessionEnd: [SessionEndEvent];
  contextStatus: [ContextStatusEvent];
  error: [AgentErrorEvent];
  exit: [ExitEvent];
};

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export interface PermissionPolicy {
  mode: PermissionMode;
}

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

/** Attachments are staged to an `--add-dir` mount and referenced by path in the
 *  message (inline-image-in-turn is a stream-json-only feature, unavailable here). */
export interface Attachment {
  path: string;
  name?: string;
  mimeType?: string;
}

export interface SendOptions {
  attachments?: readonly Attachment[];
  senderId?: string;
  senderName?: string;
}

export interface SessionOptions {
  provider: Provider;
  cwd: string;
  /** Valid UUID; minted if absent. */
  sessionId?: string;
  resume?: boolean;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Extra directories the CLI may access (`--add-dir`). */
  addDirs?: string[];
  mcpConfig?: Record<string, McpServerEntry>;
  /** Defaults to `{ mode: "bypassPermissions" }` for v1 (consumer routes its own tools). */
  permission?: PermissionPolicy;
  /** Caller env merged onto the scrubbed allowlist (see auth/scrub). */
  env?: Record<string, string>;
  /** Override the discovered CLI binary path. */
  cliPath?: string;
}
