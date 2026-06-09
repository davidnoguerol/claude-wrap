# claude-wrap — Design & Build Plan

**A reusable, multi-provider Node/TypeScript SDK that drives coding-agent CLIs (Claude Code first, Codex next) by controlling the interactive terminal via a PTY, on subscription auth only, exposing a clean structured API to consumer projects (first consumer: rondel).**

Status: design for review. No product code written yet. Findings cited as `[transcript]`, `[hooks]`, `[ptyRecipe]`, `[auth]`, `[codex]`, plus `[rondel]` from direct inspection of `/Users/david/Code/rondel/apps/daemon/src/agents/agent-process.ts` (the `rondelContract` spike returned **null**; I reverse-engineered the contract myself — see §3).

---

## 1. Validated Assumptions — what held, what broke

### Confirmed (green-light the hybrid)
- **Transcript JSONL is written live, line-buffered, mid-turn.** `[transcript]` polled a 41s turn and saw monotonic incremental growth (18→23→24→…→38) with mtime advancing per tool step. `tail -f` / FSEvents is a valid **live** structured channel — this was the single biggest risk to the whole "structured side-channel" plan and it **held**. Confidence: high.
- **Hooks fire identically in interactive and headless modes**, deliver complete single-line JSON on stdin, and carry `transcript_path` + `tool_use_id` on every event for tight correlation. `[hooks]` PostToolUse fired once per tool with `tool_name/tool_input/tool_response/tool_use_id/duration_ms`; Stop fired once with `last_assistant_message`. Confidence: high.
- **Subscription auth works and the failure mode is understood.** `[auth]` empirically reproduced the original breakage: a stale `ANTHROPIC_API_KEY` outranks the OAuth token/subscription (precedence 3 > 5/6) and silently bypasses Max until its billing dies. The fix (env scrub) is concrete and tested. Confidence: high.
- **Turn completion is detectable from the data channel alone**, three independent ways: hook `Stop`, transcript assistant line with `stop_reason:"end_turn"`, or (SDK mode) `session_state_changed("idle")`. Confidence: high.
- **The provider-agnostic abstraction generalizes to Codex** — but not via PTY screen-scrape. cortextOS already ships the clean path (`codex app-server` JSON-RPC behind a duck-typed PTY-shaped adapter). Confidence: high on channel mapping.

### Broke / surprised us — and how the design adapts

1. **The big one: PTY ready/turn-done signals from `[ptyRecipe]` are SDK/stream-json signals, not interactive-TUI signals.** Every robust signal `[ptyRecipe]` found — `session_state_changed("idle")`, `control_request`/`control_response`, NDJSON `firstUserMessage` bootstrap — lives in `--print`/`--sdk-url`/`stream-json` mode, gated behind `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. The recipe explicitly says interactive REPL "drives interaction via Ink components; no pattern-based ready detection." **We are NOT running stream-json (that's the path we rejected), so we cannot assume those events exist in our interactive PTY session.**
   - **Mitigation (decisive):** Do **not** derive turn-done or ready from the PTY stream at all. Use the **side-channel** as the authority: turn-done = **hooks `Stop`/`StopFailure`** (primary) cross-checked by **transcript `stop_reason != "tool_use"`** (secondary). Ready = a **`SessionStart` hook canary** (primary) cross-checked by first transcript line appearing. The PTY screen is demoted to *liveness + live text streaming only*, never to structured control. This is fully consistent with the agreed "Structured-HYBRID" decision and removes all dependence on Ink rendering/version churn.

2. **There is no `result`/`summary` line in the transcript.** `[transcript]` grep count 0. The rich result object (`total_cost_usd`, `modelUsage`, `duration_ms`, `subtype`) is **stdout-only** under `--output-format json` — which an interactive PTY session does not emit. **This directly affects rondel**, whose `turnComplete` event today carries the stdout `result` object including `total_cost_usd` `[rondel agent-process.ts:751-761]`.
   - **Mitigation:** Reconstruct the result object from the data channel. Per-turn cost is **not** directly available without stdout; instead surface **token usage** (deduped by `message.id` per `[transcript]`) and let consumers compute cost from a model price table, OR take cost from the **hook `Stop` + statusline `rate_limits`** path. Rondel's `turnComplete` becomes a synthesized `TurnResult` (text from `Stop.last_assistant_message`, usage from transcript). We explicitly flag "exact `total_cost_usd` parity" as a capability change (see §3).

3. **Hooks are synchronous and BLOCK the turn by default (600s timeout).** `[hooks]` A slow observer would freeze the user's session; writing JSON to stdout or `exit 2` on Stop/PostToolUse can *alter/block the turn*.
   - **Mitigation:** All wrapper hooks are pure observers: `"async": true`, exit 0, empty stdout, no `asyncRewake`. The hook binary is a tiny forwarder that writes the raw event JSON to a Unix domain socket and exits. Register **PostToolUse + PostToolUseFailure + Stop + StopFailure + SessionStart + UserPromptSubmit** (failure variants are mandatory — registering only PostToolUse/Stop *silently misses every failed tool call and every error-terminated turn* `[hooks risks]`).

4. **`--bare` silently kills hooks (and auth/LSP/plugins).** `[hooks]`/`[auth]` The side-channel goes dark with no error.
   - **Mitigation:** Hard invariant in the Claude adapter: never pass `--bare`. Add a `SessionStart` canary hook; if it doesn't fire within a timeout, fail fast with a clear "hooks not loaded — refusing to run blind" error rather than silently degrading.

5. **Token double-counting.** `[transcript]` A single assistant API response is split across N JSONL lines sharing `message.id` but each duplicating the identical `usage` object.
   - **Mitigation:** Dedupe usage by `message.id` before summing. Built into the transcript reader from day one.

6. **Trailing metadata after `end_turn`.** `[transcript]` `last-prompt`/`ai-title`/`mode` lines arrive *after* the terminal assistant line.
   - **Mitigation:** Key turn-state off the assistant `stop_reason`, never off "last physical line." Tolerate unknown line types (parse defensively, skip unknown `type`).

7. **Interactive (TUI) transcript schema is UNVERIFIED.** Both `[transcript]` and `[hooks]` probed headless `-p`/SDK runs. `[transcript openQuestions]` flags that interactive sessions may differ in envelope fields and metadata lines.
   - **Mitigation:** Phase 0 of the build plan is a dedicated **interactive-PTY probe** that re-confirms the 8 line types, `stop_reason`, and hook payloads against a real interactive session *before* any adapter code is trusted. This is the gating spike.

---

## 2. Data-Source Decision Table

Three channels: **PTY screen** (raw terminal bytes), **transcript JSONL** (`~/.claude/projects/<slug>/<uuid>.jsonl`), **hooks** (async observer over Unix socket). One recommended primary per row.

| Data | **Primary** | Conf. | Fallback | Rationale |
|---|---|---|---|---|
| **Assistant text (final)** | Hooks `Stop.last_assistant_message` | High | Transcript terminal `text` block | `Stop` delivers the reply directly, no transcript write-race `[hooks designImplications]`. |
| **Streaming text deltas** | PTY screen (ANSI-stripped, live) | Med | None (deltas are best-effort) | The transcript stores *consolidated* blocks, not deltas, under `--output-format json` `[transcript openQuestions]`; hooks have no delta event. Live token UX must come from the screen. Treat as *hints*, reconcile against `Stop` text — exactly rondel's existing "deltas are hints, blocks are truth" rule `[rondel:147]`. |
| **`tool_use` (call started, name+input)** | Hooks `PostToolUse.tool_input` | High | Transcript assistant `tool_use` block (join by `tool_use_id`) | Hook is the realtime trigger; `tool_use_id` is verbatim in transcript `[hooks §4]`. (`PreToolUse` exists if we ever need "about to call".) |
| **`tool_result` (call finished, output)** | Hooks `PostToolUse.tool_response` (+ `PostToolUseFailure`) | High | Transcript `type:"user"` tool_result line + `toolUseResult` | Hook gives typed result inline; failures only fire on the Failure variant `[hooks risks]`. Large/binary payloads (image Bash output) read from transcript `toolUseResult` on demand `[transcript risks]`. |
| **Turn-complete** | Hooks `Stop` / `StopFailure` | High | Transcript: assistant `stop_reason != "tool_use"` | `Stop` is the explicit turn boundary; transcript `end_turn` cross-checks `[hooks §3][transcript §3]`. Do **not** use PTY quiescence or `session_state_changed` (SDK-only). |
| **Token usage** | Transcript `message.usage` (dedup by `message.id`) | High | Hook statusline `rate_limits` | Usage is on every assistant line; dedup mandatory `[transcript]`. No stdout `result` in interactive mode → this is the only complete source. |
| **Errors / rate-limits** | Hooks `StopFailure` + statusline `rate_limits` JSON | Med | PTY screen regex (`usage limit reached`, `429`, `overloaded`) | `rate_limits.five_hour/seven_day.used_percentage` + `resets_at` are structured `[auth]`; PTY text is the human-readable fallback when structured fields are absent (they're optional). |
| **Session id** | Wrapper-assigned UUID via `--session-id` | High | Hook payload `session_id` / transcript filename | We mint the UUID and pass it in (rejected literal `"undefined"` `[transcript]`); the hook echoes it back for confirmation. Resolve transcript path from `session_id` + cwd, **not** by reverse-mangling the dir name (lossy `[transcript risks]`). |

**Net design rule:** *Hooks are the realtime event spine; transcript is the authoritative detail/replay store; PTY is liveness + best-effort live text.* No structured decision ever depends on screen-scraping a tool rendering.

---

## 3. Normalized API Surface (TypeScript)

Designed as a **near-drop-in for rondel's `AgentProcess`** `[rondel agent-process.ts]`. Rondel today consumes: events `response(text, blockId?)`, `response_delta(blockId, chunk)`, `turnComplete(result)`, `stateChange(state)`, `sessionEstablished(sessionId)`, `error(err)`; methods `start()`, `sendMessage(text, {attachments})`, `stop()`, `restart()`, `getSessionId()`, `getState()`, `setSessionOptions()`.

### 3.1 Event taxonomy (provider-neutral)

```ts
export type AgentEventMap = {
  ready:            [info: { sessionId: string }];
  state:            [state: SessionState];
  text:             [e: TextEvent];          // complete assistant text block
  textDelta:        [e: TextDeltaEvent];     // streaming chunk (best-effort)
  toolUse:          [e: ToolUseEvent];       // tool call started
  toolResult:       [e: ToolResultEvent];    // tool call finished (incl. failures)
  turnComplete:     [e: TurnResult];         // turn boundary + synthesized result
  usage:            [e: UsageEvent];         // per-turn token usage (deduped)
  limit:            [e: LimitEvent];         // rate/usage-limit hit + backoff hint
  error:            [e: AgentError];
  exit:             [e: { code: number | null; signal: string | null }];
};

export type SessionState = "starting" | "ready" | "busy" | "limited" | "crashed" | "halted" | "stopped";

export interface TextEvent       { text: string; blockId?: string; turnId: string; }
export interface TextDeltaEvent   { blockId: string; chunk: string; turnId: string; }
export interface ToolUseEvent     { toolUseId: string; name: string; input: unknown; turnId: string; }
export interface ToolResultEvent  { toolUseId: string; name: string; ok: boolean; result?: unknown; error?: string; durationMs?: number; turnId: string; }
export interface UsageEvent       { turnId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; }
export interface LimitEvent       { kind: "five_hour" | "seven_day" | "usage_credit" | "context" | "api_429" | "overloaded"; usedPercent?: number; resetsAt?: number; raw: string; }
export interface AgentError       { message: string; fatal: boolean; raw?: unknown; }

/** Synthesized at turn boundary — replaces rondel's stdout `result` object. */
export interface TurnResult {
  turnId: string;
  text: string;                       // from Stop.last_assistant_message
  stopReason: "end_turn" | "max_tokens" | "stop_sequence" | "refusal" | "error" | "unknown";
  isError: boolean;
  usage: UsageEvent;                  // deduped from transcript
  costUsd?: number;                   // OPTIONAL — see capability note below
  tools: ToolUseEvent[];              // tools called this turn
}
```

### 3.2 `AgentSession` (the consumer-facing class)

```ts
export interface SessionOptions {
  provider: "claude-code" | "codex";
  cwd: string;
  sessionId?: string;                 // UUID; minted if absent
  resume?: boolean;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];                 // --add-dir mounts
  mcpConfig?: Record<string, McpServerEntry>;
  permission?: PermissionPolicy;      // see §4.4
  env?: Record<string, string>;       // merged onto the scrubbed allowlist
  transcriptPath?: string;            // mirror raw events for the consumer (rondel's existing behavior)
  cliPath?: string;                   // override binary; defaults to discovered `claude`
}

export interface AgentSession extends TypedEmitter<AgentEventMap> {
  start(): Promise<void>;                                   // resolves on `ready`
  send(text: string, opts?: SendOptions): Promise<void>;   // SendOptions.attachments preserved
  interrupt(): Promise<void>;                               // ESC / Ctrl-C into PTY (cancel turn)
  stop(): Promise<void>;                                    // graceful SIGTERM→SIGKILL
  restart(): Promise<void>;
  getState(): SessionState;
  getSessionId(): string;
  setSessionOptions(o: Partial<SessionOptions>): void;
}

export interface SendOptions {
  attachments?: readonly Attachment[];  // same shape rondel stages today
  senderId?: string; senderName?: string;
}
```

### 3.3 Provider adapter interface (duck-typed, per `[codex]`)

The adapter satisfies a **transport-agnostic** surface so a JSON-RPC-backed Codex adapter and a PTY-backed Claude adapter are interchangeable (the cortextOS proof: `AgentPTY | CodexAppServerPTY` `[codex]`).

```ts
export interface AgentDriver {
  spawn(opts: ResolvedSessionOptions): Promise<void>;
  /** For Claude: type text + Enter into PTY. For Codex: buffer to \r → turn/start RPC. */
  write(text: string, attachments?: readonly Attachment[]): Promise<void>;
  interrupt(): Promise<void>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
  onExit(cb: (e: { code: number | null; signal: string | null }) => void): void;
  isAlive(): boolean;
  getPid(): number | undefined;
  /** Emits normalized AgentEventMap events upward via the session emitter. */
  readonly events: TypedEmitter<AgentEventMap>;
}
```

A **`DataChannel`** abstraction (transcript-tailer + hook-socket-listener for Claude; JSON-RPC notification stream for Codex) feeds the driver's normalized events. Adapters compose `Control` (PTY/RPC) + `DataChannel`.

### 3.4 Rondel cutover — required changes & lost capability

**Mechanical rename (mostly a shim):** rondel's `AgentProcess` is replaced by `new AgentSession({provider:"claude-code", ...})`. A thin `AgentProcessCompat` shim re-emits new events under old names so the router/scheduler/conversation-manager need minimal edits:

- `text` → re-emit as `response(text, blockId)` — **1:1**, blockId preserved `[rondel:138]`.
- `textDelta` → `response_delta(blockId, chunk)` — **1:1** `[rondel:147]`.
- `state` → `stateChange` — map new `ready`→`idle`, `limited`→(new) so router's `idle`-drains and `crashed`/`halted` messaging still work `[router.ts:306-335]`. **Rondel change:** handle the new `limited` state (pause drain, show "rate-limited, resuming at …").
- `ready` → `sessionEstablished(sessionId)` — **1:1**, but fires on hook canary not stdout `system/init`. **Rondel change:** the `system init`→flip-to-resume logic `[rondel:700-714]` moves into the adapter; rondel just listens for `ready`.
- `turnComplete(TurnResult)` — **the one real change.** Rondel today reads `raw.total_cost_usd` and the full stdout `result` `[rondel:751-761]`.
  - **Capability genuinely lost:** exact per-turn `total_cost_usd` and `modelUsage` (stdout-only, absent in interactive PTY). **Replacement:** `TurnResult.usage` (token counts) + an optional `costUsd` computed from a bundled model price table. Cost becomes an *estimate*, not the CLI's authoritative number. **Decision needed from user (see §9).**
  - `result.result` text → `TurnResult.text` (from `Stop.last_assistant_message`) — equivalent.
  - `is_error` → `TurnResult.isError` — equivalent (now from `StopFailure`).

**Capability gained:** real `toolUse`/`toolResult` events (rondel currently has no structured tool events on the persistent agent — it only saw `assistant`/`result`); per-tool failure visibility; `limit` events with `resetsAt` backoff.

**No longer rondel's job:** the MCP-tool-routing of Bash/Write/Edit (`FRAMEWORK_DISALLOWED_TOOLS`) stays exactly as-is — that's spawn-time `--disallowedTools` + `--mcp-config`, both first-class `SessionOptions`. The wrapper does not touch rondel's safety classifier.

---

## 4. Claude Adapter Design

### 4.1 Spawn recipe (interactive, PTY-driven)

Spawn the **interactive binary** under node-pty — **no `-p`, no `--bare`, no stream-json**.

```ts
pty.spawn(cliPath /* discovered `claude` */, args, {
  name: "xterm-256color", cols: 120, rows: 40,
  cwd: opts.cwd,
  env: scrubbedEnv(opts.env),          // §4.6 allowlist
});
```

`args` (interactive):
- `--session-id <uuid>` (fresh) **or** `--resume <uuid>` (resume) — mint a valid UUID; never `"undefined"` `[transcript]`.
- `--settings <abs path to wrapper-hooks.json>` — registers our async observer hooks `[hooks §1]`. **Absolute paths only.**
- `--model`, `--append-system-prompt`/`--system-prompt`, `--add-dir …`, `--mcp-config <file>`, `--allowedTools`, `--disallowedTools` — pass-through from `SessionOptions` (rondel parity `[rondel:238-321]`).
- **Permission:** prefer `--permission-mode` over `--dangerously-skip-permissions` where the consumer routes its own tools (rondel's case). See §4.4.

Env additions: `TERM=xterm-256color`, `COLORTERM=truecolor`, and `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is **not** relied upon (interactive may not honor it). `HOME`/`CLAUDE_CONFIG_DIR` preserved for keychain auth `[ptyRecipe §1][auth]`.

### 4.2 READY detection
**Primary:** a `SessionStart` hook (canary) writes to our socket → emit `ready`. **Secondary:** first transcript line for the session UUID appears. **Timeout → fatal error** ("hooks not loaded; refusing to run blind", catches accidental `--bare` / missing settings). We deliberately do **not** scrape the Ink splash screen `[ptyRecipe: no pattern-based ready detection in REPL]`.

### 4.3 TURN-DONE detection
**Primary:** hook `Stop`/`StopFailure` over the socket. **Secondary/cross-check:** transcript assistant line with `stop_reason != "tool_use"`. Treat *any* non-`tool_use` stop_reason as terminal (`end_turn`/`max_tokens`/`refusal`) `[transcript §3]`. Ignore trailing `last-prompt`/`ai-title`/`mode`. State machine: `send()`→`busy`; first `PostToolUse`/`text` keeps `busy`; `Stop`→`ready` + `turnComplete`.

### 4.4 Input injection & permission/trust
- **Input:** `write()` types the text and a trailing `\r` into the PTY (Ink fires the submit handler on the full pasted string `[ptyRecipe §4]`). Binary pass-through; no bracketed-paste handling needed `[ptyRecipe]`. Attachments: stage to an `--add-dir` mount and inject a path-manifest in the text (exactly rondel's existing approach `[rondel:452-515]`) — interactive PTY cannot accept base64 image content blocks the way stream-json stdin did, so **inline-image-in-turn is replaced by add-dir + manifest universally** (see §9 open question).
- **Permissions:** two policies.
  1. `bypass` → `--dangerously-skip-permissions` (rondel's model: it pre-blocks native Bash/Write/Edit and routes through `rondel_*` MCP tools, so the CLI never needs to prompt `[rondel:253-277]`). Pre-accept trust per dir via `~/.claude.json` `projects[<abs cwd>].hasTrustDialogAccepted = true` + top-level `bypassPermissionsModeAccepted = true` `[auth]` — this is the **only blocking dialog** for a daemon launch.
  2. `prompt` → a `PreToolUse` hook forwards the request to a consumer callback; the wrapper answers by typing into the PTY's approval UI. (Phase 4; not needed for rondel's MVP.)
- **Trust:** the wrapper seeds `hasTrustDialogAccepted` for `cwd` (and inherits from accepted parent) before spawn `[auth]`.

### 4.5 Session & resume
Mint UUID → `--session-id`. On `ready`, mark session as "exists on disk"; thereafter any restart/crash-recovery uses `--resume <uuid>` (this is rondel's proven flip-to-resume logic `[rondel:700-714]`, moved into the adapter). Crash recovery, escalating backoff, and the SIGTERM→SIGKILL exit handshake are ported directly from rondel `[rondel:608-678, 826-871]` — they're provider-neutral and already battle-tested.

### 4.6 Env scrubbing (subscription auth) — see §6.

### 4.7 Version-fragility — **isolated to this adapter**
All of these live behind the Claude `AgentDriver`/`DataChannel`; the normalized API and Codex adapter are unaffected:
- Transcript line-type set & envelope fields (pinned to v2.1.169; tolerate unknown types) `[transcript risks]`.
- Hook payload fields (`tool_use_id`, `duration_ms`, `last_assistant_message` are additive, not in minimal docs) `[hooks risks]`.
- `stop_reason` enum coverage (only `tool_use`/`end_turn` observed).
- Path-mangling rule (resolve via session UUID + cwd, never reverse-mangle) `[transcript risks]`.
- Interactive-vs-headless schema delta (Phase 0 gate, §8).

A **capability/version probe** runs at adapter init: `claude --version`, confirm a known-good range, log a drift warning otherwise.

---

## 5. Codex Adapter (sketch)

cortextOS proves the path `[codex]`: **do not PTY-screen-scrape the Codex TUI** — it leaks. Back the duck-typed driver with `codex app-server` JSON-RPC.

| Concern | Mapping |
|---|---|
| **Control** | `codex app-server --listen unix://…` under node-pty (PTY only captures the `ready` bootstrap line + lifecycle); `write()` buffers to `\r` then sends `turn/start` RPC. |
| **Data** | app-server notifications (`item/agentMessage/delta` → `textDelta`, `turn/completed` → `turnComplete`, `thread/tokenUsage/updated` → `usage`, `account/rateLimits/updated` → `limit`); rollout JSONL (`~/.codex/sessions/…`) for replay. |
| **Auth** | ChatGPT subscription via `~/.codex/auth.json`; **scrub `OPENAI_API_KEY`**; set `CODEX_HOME` for isolation. |
| **Resume** | "session" = **thread**; capture `threadId` from `thread/start`, persist out-of-band, `thread/resume` `[codex]`. |
| **Permissions** | Declarative RPC params (`approvalPolicy`, `sandboxPolicy`), not prompts — *positive* leak. |

**Leak points → escape hatches:**
1. PTY ≠ control channel → the `AgentDriver.write()` contract already abstracts "type+enter" from transport.
2. Session-id is a thread-id → `getSessionId()` returns thread id; never infer from file presence.
3. Server may **push** approval-request RPCs → an `onApprovalRequest` responder hook (default policy + log unknowns; don't hang) `[codex risks]`.
4. Forked-build RPC variance (`goals`, `skills`) → gate behind `initialize` capability negotiation; verify stock methods via `codex app-server generate-json-schema` before relying on them `[codex openQuestions]`.
5. Unix socket >100 bytes → `/tmp` fallback + pointer file `[codex]`.

Codex is Phase 6 — **unverified live** (no agentic turns were run `[codex risks]`); the sketch is sound but `turn/start` round-trips need empirical confirmation before commitment.

---

## 6. Auth & Limits

### 6.1 Subscription setup (Claude Max, never API)
- **Daemon on a machine with Keychain (rondel's case):** human runs once `claude auth login --claudeai`; verify `claude auth status --json` → `authMethod: claude.ai`, `apiProvider: firstParty`, `subscriptionType: max` `[auth]`. Creds live in macOS Keychain.
- **Headless / no-keychain:** `claude setup-token` → inject the one-year token as `CLAUDE_CODE_OAUTH_TOKEN` (inference-only, on subscription, **do not scrub this one**, never with `--bare`) `[auth]`.
- **Defense-in-depth:** pin `forceLoginMethod: "claudeai"` in managed settings (hard-blocks API-key sessions at startup) `[auth]`.
- **Self-check before driving:** in the *scrubbed child env*, `claude auth status --text` must show "Claude Max account" / "claude.ai" with **no API key line**; abort if an API key is detected.

### 6.2 Env-scrub list (the fix — `[auth]`)
Build child env from an **allowlist** (`PATH HOME TERM LANG COLORTERM CLAUDE_CONFIG_DIR` + caller's explicit `opts.env`), and explicitly **delete**:
- `ANTHROPIC_API_KEY` (precedence 3 — *the original breakage*; a dead-org key silently bypasses Max).
- `ANTHROPIC_AUTH_TOKEN` (precedence 2 — Bearer hijack).
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` (proxy/header injection).
- `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` (precedence 1 — cloud-provider billing).
- Ensure **no `apiKeyHelper`** in any loaded settings (precedence 4).
- **Keep** `CLAUDE_CODE_OAUTH_TOKEN`. **Never** `--bare`.
- Codex: delete `OPENAI_API_KEY`.

### 6.3 Limit detection & backoff
**Primary (structured):** statusline/hook `rate_limits` JSON — `five_hour.{used_percentage,resets_at}`, `seven_day.{…}`, `context_window.used_percentage` (all optional; tolerate missing) `[auth]`. Soft back-off when `used_percentage ≥ 90`; emit `limit` event with `resetsAt`; transition to `limited` state; schedule resume at `resets_at + jitter`.
**Secondary (text regex on PTY/transcript):** case-insensitive `usage limit reached`, `upgrade to increase your usage limit`, `usage credit limit reached`, `429`, `rate limited`, `overloaded`, `529`, `credit balance too low`. **Note:** `Context limit reached` is *context*, not usage → emit `limit{kind:"context"}` and let consumer `/compact` or `/clear`, do **not** back off `[auth]`.
**Post-2026-06-15 note:** interactive PTY stays on the normal 5h+weekly subscription allowance; `-p`/Agent SDK would meter against the separate $200 Agent-SDK credit — another reason the interactive-PTY choice is correct `[auth]`.

---

## 7. Package / Repo Layout & Tech Choices

**Decision: single package, not a monorepo.** One publishable npm package `claude-wrap` with internal provider folders. A monorepo is premature (YAGNI) — there's one consumer and two providers; split later only if Codex needs independent release cadence.

```
claude-wrap/
  package.json            # name: "claude-wrap", type: module, exports map
  tsconfig.json           # strict, NodeNext, target ES2022
  src/
    index.ts              # public exports: AgentSession, types
    session.ts            # AgentSession (provider-neutral orchestration)
    types.ts              # AgentEventMap, SessionOptions, TurnResult, …
    auth/scrub.ts         # env allowlist + scrub list (§6.2)
    transport/
      pty.ts              # node-pty wrapper (lazy require, like cortextOS)
      hook-socket.ts      # Unix-socket listener for async hook events
      transcript-tail.ts  # live JSONL tailer (dedupe, partial-line buffer)
    providers/
      claude/
        adapter.ts        # AgentDriver impl
        hooks-settings.ts # generates wrapper-hooks.json
        hook-forwarder.ts # tiny built binary: stdin→socket, exit 0
        version.ts        # pin/probe v2.1.169 range
      codex/
        adapter.ts        # Phase 6 (app-server JSON-RPC)
  bin/
    cw-hook-forward       # compiled forwarder shipped with the package
  tests/
    interactive-probe.ts  # Phase 0 gate (real CLI)
    *.unit.test.ts
```

**Tech choices:**
- **node-pty** — lazy-`require`d (native addon; mirror cortextOS so it doesn't break bundlers/test runners) `[codex AgentPTY]`.
- **TypeScript strict, ESM (`NodeNext`)** — matches rondel's `tsconfig.base.json` and ESM `.js`-extension imports `[rondel]`.
- **Build:** `tsc` to `dist/` (no bundler — it's a Node library). **Test:** `vitest` (rondel already uses `*.unit.test.ts`/`*.integration.test.ts` conventions). Lint: rondel's eslint config.
- **Hook forwarder** is a tiny standalone script (Node or a compiled Bun/Go binary) so per-event fork cost is minimal; `async:true` removes blocking. Consider an **HTTP hook** instead of command-per-event if benchmarks show fork churn at high tool volume `[hooks openQuestions]`.
- **Consumer install/import:** `pnpm add claude-wrap` (rondel uses pnpm workspaces `[rondel]`); `import { AgentSession } from "claude-wrap"`. Initially consumed via `file:`/workspace link from rondel for co-development.
- **CLI version pinning & drift detection:** `providers/claude/version.ts` declares a tested range; on `start()` it runs `claude --version`, and on **mismatch** logs a structured drift warning (does not hard-fail — degrade-with-warning). A `tests/interactive-probe.ts` is run in CI against the installed CLI to detect schema drift early.

---

## 8. Phased Build Plan

### Phase 0 — Interactive-PTY confirmation (GATE, ~0.5 day)
- **Deliverable:** `tests/interactive-probe.ts` that spawns the *real interactive* `claude` under node-pty with wrapper hooks + transcript tail, runs one forced-tool turn, and dumps: hook events received, transcript line types, `stop_reason` values, `ready` canary timing.
- **Accept:** Confirms (or refutes) that interactive sessions emit the same 8 line types, the same hook payloads, and `Stop`/`end_turn` — the assumptions §1.7 flags as unverified. **If hooks don't fire interactively or schema differs materially, redesign before Phase 1.**

### Phase 1 — Minimal Claude adapter (MVP, proven against real CLI)
- **Deliverable:** `AgentSession` for `claude-code` that: opens a session (subscription auth, env-scrubbed), `send()`s a prompt, emits `text`, `toolUse`, `toolResult`, `turnComplete`; supports `--session-id`/`--resume`; `getSessionId()`; clean `stop()`.
- **Accept (against real CLI, Max sub):**
  1. `claude auth status` in child env shows Max, no API key.
  2. A 3-tool turn (Write/Read/Bash) emits correct `toolUse`/`toolResult` and one `turnComplete{stopReason:"end_turn"}`.
  3. Token usage in `UsageEvent` is deduped (matches a hand-count by `message.id`).
  4. Resume: stop, restart with `--resume`, prior context intact.
  5. A stale `ANTHROPIC_API_KEY` in parent env does **not** leak (auth self-check passes).

### Phase 2 — Robustness
- Crash recovery + escalating backoff + SIGTERM→SIGKILL handshake (port `[rondel]`); `limited` state + `limit` events + `resets_at` backoff (§6.3); partial-line/unknown-type tolerance in the tailer; `SessionStart` canary fail-fast; `interrupt()`.
- **Accept:** kill the CLI mid-turn → auto-restart+resume; simulate `usage limit reached` → `limited` + scheduled resume; feed malformed JSONL → no crash.

### Phase 3 — Streaming text
- PTY-screen ANSI-strip → `textDelta` (best-effort), reconciled against `Stop` text ("deltas are hints").
- **Accept:** deltas accumulate to exactly the final `text`; no missing/duplicated content.

### Phase 4 — Rondel cutover
- `AgentProcessCompat` shim (§3.4); migrate router/scheduler/conversation-manager; handle new `limited` state; switch `turnComplete` consumers to `TurnResult` (cost-estimate or accept loss per §9).
- **Accept:** rondel's existing `agent-process.unit.test.ts` + `agent-manager.integration.test.ts` pass against the shim; a live Telegram round-trip works end-to-end with tool calls visible.

### Phase 5 — Permission-prompt mode
- `PreToolUse`-hook → consumer callback → PTY approval injection (the non-bypass policy). Optional for rondel (it bypasses), needed for interactive consumers.

### Phase 6 — Codex adapter
- `app-server` JSON-RPC driver behind the same `AgentDriver`; capability negotiation; approval-request responder; thread resume; `OPENAI_API_KEY` scrub.
- **Accept:** one live Codex turn round-trips `turn/start`→`turn/completed`; `textDelta`/`usage`/`turnComplete` normalize identically to Claude; switching `provider` is the only consumer change.

### Phase 7 — Multi-provider hardening
- Version-drift CI probe for both CLIs; HTTP-hook vs command-hook benchmark; subagent/one-shot mode (port rondel's `SubagentProcess` `[rondel subagent-process.ts]` as `runOnce()` — note one-shot *can* use stdout `result` JSON, recovering exact cost there); docs.

---

## 9. Top Risks, Mitigations & Open Questions

### Top risks
1. **Interactive schema ≠ headless schema** (the gating unknown). → **Phase 0 gate** before any adapter code `[transcript/hooks openQuestions]`.
2. **Exact per-turn cost is lost in interactive mode** (no stdout `result`). → Token-based estimate from a price table; exact cost only via one-shot `runOnce()` path. **User decision below.**
3. **Hook blocking / misconfiguration freezes the user's session.** → `async:true`, exit-0 forwarder, `SessionStart` canary fail-fast, never `--bare` `[hooks risks]`.
4. **Stale `ANTHROPIC_API_KEY` silently bypasses Max.** → allowlist env + scrub + auth self-check `[auth]` (this *was* the original breakage; treat as a regression test).
5. **Version drift breaks the transcript/hook readers.** → isolated to the Claude adapter; pinned range + drift warning + CI probe.
6. **Codex is unverified live.** → Phase 6, gated on an empirical `turn/start` spike `[codex risks]`.
7. **Untested `stop_reason`s (max_tokens/refusal/interrupt) could hang the turn-done detector.** → treat any non-`tool_use` stop_reason as terminal; `StopFailure` covers error turns `[transcript risks]`.

### Open questions needing the user's decision (before/while building)
1. **Cost handling:** Accept estimated per-turn cost (token table) for the interactive path, OR require exact cost (forces a periodic one-shot reconciliation, or accepting that rondel's cost display becomes approximate)? *Recommendation: ship token-usage + estimate; mark cost "approx" in rondel UI.*
2. **Attachments/images:** OK to drop inline-base64-image-in-turn (stream-json only) and route **all** attachments via `--add-dir` + manifest in interactive mode `[rondel:452-515]`? This means the model `Read`s images rather than seeing them in-turn. *Recommendation: yes for MVP; revisit if vision-in-turn is a hard rondel requirement.*
3. **Permission model for the first non-rondel consumer:** is `bypass` (rondel-style, MCP-tool-routed safety) sufficient for v1, deferring the `prompt`-mode `PreToolUse` flow to Phase 5? *Recommendation: yes.*
4. **Daemon auth source:** Keychain (`claude auth login`) vs `CLAUDE_CODE_OAUTH_TOKEN` — which is the target deployment? Affects whether §6.1 headless path is Phase-1 or later.
5. **Hook transport:** command-forwarder (simple, per-event fork) vs single HTTP endpoint (one process, lower churn). *Recommendation: start with command+async; switch to HTTP only if Phase 7 benchmark shows fork churn matters.*
6. **Package distribution:** publish to a registry now, or workspace-link into rondel until the API stabilizes? *Recommendation: workspace-link through Phase 4, publish after rondel cutover proves the surface.*
