# Rondel Subscription-Only Conversion + Live-Smoke Plan

## 1. COMPLETENESS verdict

**Verdict: SubagentProcess is the ONE and ONLY remaining live headless/programmatic `claude` path. Everything else is already on claude-wrap or is dead-on-disk.** Verified against source, not just the audit.

### The single live gap

| Path | Status | Constructed at |
|------|--------|----------------|
| `agents/subagent-process.ts` — `spawn("claude", ["-p","--input-format","stream-json","--output-format","stream-json",...])` | **LIVE — last headless protocol** | `subagent-manager.ts:164` (ephemeral subagents) and `cron-runner.ts:151` (isolated cron) |

Two live callers, identical API surface (`new SubagentProcess(opts, log)` → `start()` → consume `done` / `getState` / `getResult` / `kill`):
- `SubagentManager.spawn()` — **fire-and-forget**: `subProcess.done.then(...)` fires `subagent:completed` / `subagent:failed` hooks; does NOT await. Reached via MCP tool `rondel_spawn_subagent` → bridge `/subagents/spawn` → `AgentManager.spawnSubagent` (thin facade) → `SubagentManager.spawn`.
- `CronRunner.runIsolated()` — **blocking**: `await subProcess.done`, returns `CronRunOutcome` (= `SubagentResult` shape). Passes NO `maxTurns`.

### Confirmed already-cut-over / dead (no action required for subscription-only correctness)

- **Conversations**: `ConversationManager` constructs `AgentProcessCompat` (aliased `AgentProcess` at `conversation-manager.ts:18`). claude-wrap PTY, `provider:"claude-code"`, `permission.mode:"bypassPermissions"`. **Live, subscription, verified.**
- **Named/persistent cron**: `CronRunner.getOrSpawnNamedSession` → `conversationManager.getOrSpawn` → `AgentProcessCompat`. **Already subscription.**
- **Legacy `agent-process.ts` class**: contains a second `spawn("claude",["-p",...])` (`:332`) but is **never `new`-ed in production** — only re-exported at `agents/index.ts:2`, type-imported elsewhere, and instantiated in tests. **Dead-on-disk.**
- **No API-key dependency anywhere**: zero reads of `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; no `@anthropic-ai` SDK, no `api.anthropic.com`, no `messages.create`, no beta/cloud/ultrareview. The only `API_KEY` string is a docstring example (`mcp-server.ts:1363`). `doctor.ts` checks only the CLI binary, not a key.

**Nothing beyond SubagentProcess was found.** A key-less subscription machine already runs the daemon today — headless `-p` inherits OAuth via `env: process.env`. So this migration is a **functional-cleanliness / no-headless-protocol-anywhere goal**, not a breakage fix. After it lands, the legacy `agent-process.ts` spawner becomes deletable (see §2, optional follow-up).

---

## 2. `SubagentProcessCompat` design (drop-in shim over claude-wrap)

### Strategy: mirror the proven `AgentProcessCompat` cutover exactly

The conversation cutover succeeded by writing a compat class with rondel's exact event/method surface and swapping it in via an **alias import** — leaving the legacy file on disk for instant rollback. We do the identical thing for subagents. The shim reuses the same building blocks the working `AgentProcessCompat` already uses (`FRAMEWORK_SKILLS_DIR` via `addDirs`, `disallowedTools` union, `appendTranscriptEntry` mirroring, `turnComplete`→result mapping).

### New file: `agents/subagent-process-compat.ts`

Implements the full SubagentProcess surface. Both callers only touch: `new(options, log)`, `start()`, `getId()`, `getState()`, `getResult()`, `kill(reason?)`, and `done`.

```ts
// SubagentProcessCompat — drop-in replacement for SubagentProcess backed by the
// claude-wrap SDK (PTY, subscription, never an API key). One-shot semantics:
// start() → send(task) once → first turnComplete is the result → stop().
import { AgentSession } from "claude-wrap";          // match the import path AgentProcessCompat uses
import type { SessionOptions, TurnResult } from "claude-wrap";
import { FRAMEWORK_DISALLOWED_TOOLS, type McpConfigMap } from "./agent-process.js";
import { resolveFrameworkSkillsDir } from "../shared/paths.js";
import { appendTranscriptEntry } from "../shared/transcript.js";
import type { Logger } from "../shared/logger.js";
import type { SubagentState } from "../shared/types/subagents.js";
// Reuse the EXISTING interfaces from subagent-process.ts (re-export or relocate to a types module):
import type { SubagentOptions, SubagentResult } from "./subagent-process.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;            // identical to legacy
const FRAMEWORK_SKILLS_DIR = resolveFrameworkSkillsDir();

export class SubagentProcessCompat {
  private session: AgentSession | null = null;
  private state: SubagentState = "running";
  private resultText?: string;
  private errorText?: string;
  private costUsd?: number;
  private completedAt?: string;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private readonly log: Logger;

  readonly done: Promise<SubagentResult>;
  private resolveDone!: (r: SubagentResult) => void;

  constructor(private readonly options: SubagentOptions, log: Logger) {
    this.log = log.child(`subagent:${options.id}`);
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }

  getId(): string { return this.options.id; }
  getState(): SubagentState { return this.state; }
  getResult(): SubagentResult {
    return { state: this.state, result: this.resultText, error: this.errorText,
             costUsd: this.costUsd, completedAt: this.completedAt };
  }

  start(): void {
    const o = this.options;
    const cwOptions: SessionOptions = {
      provider: "claude-code",
      cwd: o.workingDirectory ?? process.cwd(),
      model: o.model,
      systemPrompt: o.systemPrompt,
      allowedTools: o.allowedTools && o.allowedTools.length > 0 ? [...o.allowedTools] : undefined,
      // UNION with framework block list — preserves legacy semantics exactly.
      disallowedTools: [...new Set([...FRAMEWORK_DISALLOWED_TOOLS, ...(o.disallowedTools ?? [])])],
      addDirs: [FRAMEWORK_SKILLS_DIR],                // replaces --add-dir <skills>
      mcpConfig: o.mcpConfig as SessionOptions["mcpConfig"],   // SDK writes its own temp config; no manual temp-file plumbing
      permission: { mode: "bypassPermissions" },      // == --dangerously-skip-permissions
      // NOTE: maxTurns intentionally NOT plumbed — see "runaway protection" + claude-wrap decision.
    };

    const session = new AgentSession(cwOptions);
    this.session = session;

    // Transcript: mirror the user task + assistant frames like the legacy did.
    if (o.transcriptPath) {
      appendTranscriptEntry(o.transcriptPath, { type: "user", text: o.task, timestamp: new Date().toISOString() }, this.log);
      session.on("text", (e) => appendTranscriptEntry(o.transcriptPath!,
        { type: "assistant", message: { content: [{ type: "text", text: e.text }] }, timestamp: new Date().toISOString() }, this.log));
    }

    // First (and only) turn IS the result. one send() ⇒ exactly one turnComplete.
    session.once("turnComplete", (tr: TurnResult) => {
      if (tr.isError) this.finish("failed", undefined, tr.text || "Unknown error", tr.costUsd);
      else            this.finish("completed", tr.text || "", undefined, tr.costUsd);
    });
    // Fatal error / process crash: onExit→finishTurn('',true) usually fires turnComplete,
    // but guard here so `done` can never hang.
    session.on("error", (e: { fatal?: boolean; message: string }) => {
      if (e.fatal) this.finish("failed", undefined, e.message);
    });
    session.on("exit", () => { if (!this.settled) this.finish("failed", undefined, "session exited before result"); });

    session.start()
      .then(() => session.send(this.options.task))
      .catch((err: unknown) => this.finish("failed", undefined, err instanceof Error ? err.message : String(err)));

    // Runaway protection — replaces --max-turns with a wall-clock bound.
    const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutHandle = setTimeout(() => {
      if (this.state === "running") { this.log.warn(`Subagent timed out after ${timeout}ms`); this.kill("timeout"); }
    }, timeout);
  }

  kill(reason: "killed" | "timeout" = "killed"): void {
    if (this.state === "running") this.finish(reason, undefined, `Subagent ${reason}`);
    else void this.session?.stop().catch(() => {});
  }

  // Mirrors legacy finish(): single-fire guard, teardown BEFORE resolving done.
  private finish(state: SubagentState, result?: string, error?: string, costUsd?: number): void {
    if (this.settled) return;
    this.settled = true;
    this.state = state;
    this.resultText = result;
    this.errorText = error;
    this.costUsd = costUsd;
    this.completedAt = new Date().toISOString();
    if (this.timeoutHandle) { clearTimeout(this.timeoutHandle); this.timeoutHandle = null; }
    const s = this.session;
    this.session = null;
    void (s ? s.stop().catch(() => {}) : Promise.resolve()).then(() => this.resolveDone(this.getResult()));
  }
}
```

### Contract-fidelity checklist (every load-bearing guarantee preserved)

- **`done` resolves, never rejects**, with a `SubagentResult` — both callers depend on this (`CronRunner` awaits it; `SubagentManager` `.then()`s it). Errors map to `state:"failed"`, never a rejection.
- **Teardown before resolve**: `finish()` calls `session.stop()` (idempotent, sends Ctrl-C/`/exit`, waits ≤2.5s for the final Stop hook, then kills + cleanup) and only then resolves `done` — preserving the orphan-process guarantee.
- **Single-fire**: `settled` guard mirrors legacy `if (this.state !== "running") return`. `once("turnComplete")` + the guard prevent double-finish.
- **Live `getResult()`**: returns current fields synchronously, so `SubagentManager.get()/list()` overlay works for running subagents.
- **One send ⇒ one turnComplete**: claude-wrap's `send()` state gate (rejects overlap) + `turnActive` guard guarantee exactly one `turnComplete` per turn regardless of tool-call count. Confirmed in adapter.
- **No-output / crash fallback**: `error(fatal)` and `exit` handlers ensure `done` resolves even if no `turnComplete` arrives (legacy handled this via `handleExit` code===0/non-zero).
- **`-p` arg vector → SessionOptions mapping**: `--model`→`model`, `--system-prompt`→`systemPrompt`, `--dangerously-skip-permissions`→`permission.bypassPermissions`, `--allowedTools`→`allowedTools`, `--disallowedTools` (union)→`disallowedTools`, `--mcp-config <tempfile>`→`mcpConfig` (SDK writes its own temp file — **we drop the manual `$TMPDIR/rondel-mcp` temp-file plumbing entirely**), `--add-dir <skills>`→`addDirs`.
- **`env: process.env`**: claude-wrap inherits the daemon env (subscription OAuth) the same way; no env plumbing change needed.

### Runaway protection (replaces `--max-turns`)

claude-wrap has **no** `maxTurns`/budget/`--max-turns` (confirmed by grep over `src/` — zero hits). The only bound is the shim-side **wall-clock `setTimeout` → `kill("timeout")`**, identical to legacy `DEFAULT_TIMEOUT_MS = 5min`. On timeout, `finish("timeout")` runs `session.stop()` (hard kill), so no leaked PTY.

**`maxTurns` is silently dropped.** Impact is minimal and acceptable:
- The MCP `rondel_spawn_subagent` path never forwards a usable `maxTurns` for tool-restriction purposes anyway, and the **isolated-cron path passes NO `maxTurns`** today.
- `SubagentManager` plumbs `request.maxTurns`, but the wall-clock timeout is the real backstop. A turn that stays under the time limit but loops tools is unbounded — same theoretical exposure the conversation path already accepts.

### Minimal claude-wrap change: **add `maxTurns` to `SessionOptions` — RECOMMENDED, but ship the shim WITHOUT blocking on it**

- **Decision**: Land the shim now using wall-clock-only protection (parity with the conversation cutover, zero library changes, unblocks subscription-only immediately). **In parallel**, add an optional `maxTurns?: number` to claude-wrap `SessionOptions`, wired into `buildArgs()` as `--max-turns <n>` (the CLI documents it for print/headless mode; **behavior under PTY-driven interactive mode is unverified — must be validated live before relying on it**, see open questions). Once verified, plumb `o.maxTurns` into `cwOptions` in the shim to restore semantic (turn-count) runaway protection.
- **Do NOT** add `turnTimeoutMs` to claude-wrap — the shim's `setTimeout` covers wall-clock already; a library-level helper is optional ergonomics, not needed.

### Exactly which rondel files change

1. **`agents/subagent-process-compat.ts`** — NEW (the shim above).
2. **`agents/subagent-manager.ts:20`** — change construction import to alias the compat:
   ```ts
   import { SubagentProcessCompat as SubagentProcess } from "./subagent-process-compat.js";
   ```
   The `new SubagentProcess(options, this.log)` at `:164` and all `done`/`getState`/`getResult`/`kill` usage are unchanged. (Keep the existing `import type { SubagentOptions, SubagentResult }` from the legacy file, or relocate those interfaces — see #4.)
3. **`scheduling/cron-runner.ts`** — same alias swap for its `new SubagentProcess(...)` at `:151`. (Currently imports `SubagentProcess` from the legacy module for construction; repoint to the compat. Keep `import type { McpConfigMap }` as-is.)
4. **`agents/subagent-process.ts`** — **keep on disk for rollback** (mirrors the `agent-process.ts` retention). Rollback = revert two alias imports. To avoid orphaning `SubagentOptions`/`SubagentResult` when the legacy file is eventually deleted, **relocate those two interfaces to `shared/types/subagents.ts`** (next to `SubagentState`/`SubagentInfo`) and import from there in both the legacy file and the compat. Low-risk, mechanical.

**No changes** to `agent-manager.ts` (thin facade), `bridge.ts`, `mcp-server.ts`, or the `SubagentSpawnRequest`/`SubagentInfo` types — the surface is identical.

### Optional follow-up (after smoke passes; not required for subscription-only)

Narrow `agents/index.ts:2` to re-export only `FRAMEWORK_DISALLOWED_TOOLS` + types (not the `AgentProcess` class), relocate those constants/types to a neutral module, then delete the legacy `agent-process.ts` and `subagent-process.ts` spawners. Removes the latent "accidentally re-instantiate a headless `-p` path" footgun.

---

## 3. Broad live smoke plan (parallel-isolated, web-bridge end-to-end)

Six scenarios, each in its **own isolated daemon** (distinct `RONDEL_HOME` ⇒ own OS-assigned port ⇒ own instance-lock/transcripts/ledger), so they run as independent parallel workflow agents. All interaction is through the **synthetic web account** — no Telegram token ever needed. Detection is **asynchronous**: POST only injects the turn (returns `{ok:true}`); the reply appears later in `/history` — so every pass-check **polls history until an assistant turn matches a high-entropy marker**, plus tails `$RONDEL_HOME/state/rondel.log`.

### Shared per-agent setup (identical `alice` in every daemon)

`RONDEL_HOME/config.json`: `{"allowedUsers":["web-user"]}` (must be non-empty).
`RONDEL_HOME/workspaces/global/agents/alice/agent.json`:
```json
{
  "agentName": "alice", "enabled": true, "model": "haiku",
  "workingDirectory": "/abs/smoke/scN/scratch/alice",
  "channels": [{ "channelType": "telegram", "accountId": "alice-tg", "credentialEnvVar": "ALICE_TG_TOKEN" }],
  "tools": { "allowed": ["mcp__rondel__rondel_bash","mcp__rondel__rondel_read_file","mcp__rondel__rondel_write_file","mcp__rondel__rondel_spawn_subagent","Read","Glob","Grep"], "disallowed": [] }
}
```
The telegram binding's `credentialEnvVar` names an **unset** env var (`ALICE_TG_TOKEN`) — discovery passes (field present), then `resolveCredentials` throws and `AgentManager` logs `[alice] Skipping channel binding telegram:alice-tg — ... "ALICE_TG_TOKEN" ... not set` and continues. The synthetic web account (`accountId === "alice"`) is still registered, so the agent works. (Do NOT omit `credentialEnvVar` — that hard-fails discovery.)

### Boot one isolated daemon per scenario

```bash
export RONDEL_HOME=/abs/smoke/scN ; export RONDEL_DAEMON=1
mkdir -p "$RONDEL_HOME/workspaces/global/agents/alice" "$RONDEL_HOME/scratch/alice"
# (write config.json + agent.json)
node /Users/david/Code/rondel/apps/daemon/dist/index.js        # run_in_background
until jq -e -r .bridgeUrl "$RONDEL_HOME/state/rondel.lock" 2>/dev/null | grep -q '^http'; do :; done
BASE=$(jq -r .bridgeUrl "$RONDEL_HOME/state/rondel.lock"); LOG=$RONDEL_HOME/state/rondel.log
```

### Reusable helpers

```bash
send(){ curl -s -XPOST "$BASE/web/messages/send" -H 'content-type: application/json' \
  -d "{\"agent_name\":\"$1\",\"chat_id\":\"$2\",\"text\":\"$3\"}"; }       # expect {"ok":true}
hist(){ curl -s "$BASE/conversations/$1/web/$2/history"; }
wait_reply(){ a=$1;c=$2;m=$3; for i in $(seq 1 120); do \
  hist "$a" "$c" | jq -e --arg m "$m" '.turns|map(select(.role=="assistant"))|map(.text)|any(test($m;"i"))' >/dev/null && return 0; sleep 1; done; return 1; }
```

### Scenario A — Single tool turn (`rondel_bash`)
- **chat** `web-A`. **Send**: `Run the shell command: echo RONDEL_SMOKE_42 . Then reply with exactly the command's stdout.`
- **PASS**: `wait_reply alice web-A 'RONDEL_SMOKE_42'` AND `grep -c 'rondel_bash' "$LOG"` > 0 (also `toolName:"rondel_bash"` in `state/ledger/*.jsonl`).
- **FAIL**: timeout, or reply says it can't run bash / "requires bridge context".

### Scenario B — Multi-turn + context retention + session resume
- **chat** `web-B`.
- msg1: `Remember this code word: PLATYPUS_77. Acknowledge.` → `wait_reply alice web-B 'PLATYPUS|acknowledg|remember'`.
- msg2 (after msg1 idle): `What was the code word I gave you? Reply with just the word.` → `wait_reply alice web-B 'PLATYPUS_77'`.
- **PASS**: msg2 reply contains `PLATYPUS_77` (proves session resume context) AND history ≥4 turns AND `sessionId` non-null and identical across both `hist` calls. Log shows one stable session ("Session established" once, "Resuming session" on turn 2 acceptable — single persistent process also fine, key is one stable `sessionId`).
- **FAIL**: msg2 can't recall the word, or a second session id appears.

### Scenario C — `rondel_spawn_subagent` delegation **(the cutover-critical path)**
- **chat** `web-C`. No second agent — subagents are ephemeral inline-prompt children.
- **Send**: `Delegate to a subagent (system_prompt: 'You are a calculator. Output only the number.') the task: compute 6*7 and return ONLY the number. When the subagent result comes back, reply to me with: SUBAGENT_SAYS=<number>.`
- **Detect**: log `grep 'Subagent spawned: sub_' "$LOG"` (capture id); `grep -E 'subagent:completed|Subagent completed' "$LOG"`; parent follow-up `wait_reply alice web-C 'SUBAGENT_SAYS=42'`; subagent transcript at `ls $RONDEL_HOME/state/transcripts/alice/sub_*.jsonl`.
- **PASS**: sub_ id logged + completed hook fired + parent final reply contains `42` (proves the result was delivered back via `router.sendOrQueue` in a NEW parent turn). **This is the scenario that exercises `SubagentProcessCompat` end-to-end.**
- **FAIL**: `rondel_spawn_subagent requires a system_prompt` error, no sub_ id, hook never fires, or result never delivered to parent.

### Scenario D — File tools (write → read back)
- **chat** `web-D`. Ensure `workingDirectory` exists and is in a writable safe zone.
- **Send**: `Use rondel_write_file to create ./rondel_smoke.txt with exactly the contents FILE_TOKEN_9001 , then use rondel_read_file to read it back, then reply with the file's contents.`
- **PASS**: `wait_reply alice web-D 'FILE_TOKEN_9001'` AND `cat $RONDEL_HOME/scratch/alice/rondel_smoke.txt` == `FILE_TOKEN_9001` AND ledger shows `rondel_write_file` + `rondel_read_file`.
- **FAIL**: write blocked (approval/secret-scan/safe-zone), or read returns wrong content.

### Scenario E — Queue-while-busy → drain (the real "interrupt" semantics)
There is **no mid-turn abort** in rondel; a message arriving while busy is queued and drained after the running turn. This tests unwedge.
- **chat** `web-E`.
- msg1 (long, do NOT wait): `Run rondel_bash: sleep 25 ; echo LONG_DONE . Then reply with exactly LONG_DONE.`
- msg2 (~3s later, while busy): `After the previous task finishes, also reply with exactly SECOND_OK.`
- **PASS**: log shows `[alice:web:web-E] Message queued (agent is busy, queue size: 1)` then `Draining queue`, AND **both** `wait_reply alice web-E 'LONG_DONE'` and `wait_reply alice web-E 'SECOND_OK'` succeed (no deadlock; queued msg completes after long turn).
- **FAIL**: no `Draining queue`, stuck "busy" forever, or only one marker ever appears.

### Scenario F — Crash recovery + resume (conversation path, unchanged by this work but must stay green)
- **chat** `web-F`.
- Step1: `Reply with exactly ALIVE_1.` → `wait_reply alice web-F 'ALIVE_1'`; capture `SID=$(hist alice web-F | jq -r .sessionId)`.
- Step2 (kill the child claude, **not** the daemon, ONCE): `pkill -KILL -f -- "--session-id $SID" || pkill -KILL -f -- "--resume $SID"`.
- Detect in log: `Agent process exited — code:.. signal: SIGKILL` → `Scheduling restart in 5000ms (crash 1/5 today)` → `Resuming session: $SID`. Router emits `⚠️ Agent crashed — restarting...`.
- Step3 (after ~6s backoff): `Reply with exactly ALIVE_2.` → `wait_reply alice web-F 'ALIVE_2'`.
- **PASS**: crash + scheduled-restart + resume markers in log AND `ALIVE_2` lands on the **same** `sessionId`. Kill only once (`MAX_CRASHES_PER_DAY=5`; don't trigger `halted`).
- **FAIL**: state `halted`, `ALIVE_2` never returns, or a brand-new sessionId.

> Note on PTY-driven children (post-cutover): the `claude` child is launched by claude-wrap under a PTY. Confirm at runtime that the child's argv still carries `--session-id`/`--resume <SID>` so F's `pkill -f` pattern matches; if claude-wrap reshapes argv, match by the daemon-logged child pid instead.

### Recommended run ordering / batching

Run **A, C, D first** (single-turn or subagent — lowest token pressure), then **B, E, F** (multi-turn / long / crash). Cap fan-out to **2–3 daemons concurrently** (or stagger starts by a few seconds). C exercises the new shim and also spawns a second `claude` process, so don't co-run C with E/F under tight quota.

### Concurrency / quota guidance

All scenarios share one subscription. Peak concurrent `claude` processes ≈ 7–8 if all six run flat-out (B/E/F multi-turn, C spawns a subagent). This can hit subscription concurrency/RPM caps → 429s that surface as turn errors **or crash-then-backoff that false-triggers F-style log markers in other scenarios**. Mitigations: small fan-out (2–3), stagger starts, pin `model:"haiku"` everywhere except C (keep `sonnet`/`haiku` per cost), 120s `wait_reply` timeouts, and grep each LOG for `overloaded|rate|429` to distinguish throttling from real failure.

---

## 4. Risks + open questions needing a decision

### Risks
- **No turn-count/cost budget in claude-wrap.** Wall-clock timeout is the only bound the shim has at ship time. A subagent that loops tools under the time limit is unbounded — same exposure the conversation path already accepts. Mitigated only if/when `maxTurns` lands in claude-wrap.
- **`costUsd` is an estimate** (local price table, not the CLI's authoritative `total_cost_usd`). `SubagentResult.costUsd` will be approximate post-cutover; hook listeners that display "Subagent completed ($cost)" will show estimates. Do not use for hard budgeting.
- **PTY-driven argv shape (Scenario F + ops).** The cutover changes how the child is spawned; the `pkill -f --session-id` recovery hook and any external process matching must be re-confirmed against PTY argv.
- **Timeout-without-stop leaks PTY** — the shim's `finish("timeout")` MUST call `session.stop()` (it does); any future refactor that resolves `done` before `stop()` reintroduces orphaned PTY/socket/temp-dir.
- **`bypassPermissions` is set explicitly** — claude-wrap's adapter default is `acceptEdits` (which can still prompt and stall a headless one-shot). The shim sets `bypassPermissions` explicitly; never rely on the default.
- **Smoke false-positives from rate limiting** masquerading as crashes, especially polluting F's markers in parallel runs.

### Open questions needing a decision
1. **Ship `maxTurns` in claude-wrap, or accept wall-clock-only?** Recommendation: ship the shim now wall-clock-only; add `maxTurns`→`--max-turns` to claude-wrap in parallel **only after** verifying the installed `claude` CLI honors `--max-turns` under PTY-driven interactive mode (documented for print mode; unverified interactively). Decision owner needed.
2. **Delete legacy `subagent-process.ts` + `agent-process.ts` spawners now, or keep for rollback?** Recommendation: keep both on disk through the smoke window (rollback = revert two alias imports), then delete + narrow `agents/index.ts` re-export in a follow-up. Confirm relocation of `SubagentOptions`/`SubagentResult` to `shared/types/subagents.ts`.
3. **Does any downstream hook listener read `parentAccountId`/`parentChannelType` in a way the shim must reproduce?** The shim doesn't touch `SubagentInfo` (built by `SubagentManager`), so this is preserved — but `index.ts` hook wiring was not opened; confirm no listener depends on a behavior unique to the headless path.
4. **`buildChannelMcpEnv` output shape under the SDK's own mcp-config temp file.** The shim hands `mcpConfig` to claude-wrap (which writes its own temp file). Confirm the SDK preserves the per-server `env` block (RONDEL_* vars) the legacy temp file carried — critical for `rondel_bash`/spawn tools resolving bridge context. **Verify in Scenario A/C** (a tool that "requires bridge context" failing is the tell).
5. **Smoke env specifics**: exact `mcp__rondel__<tool>` prefix (confirm against `mcp-server.ts:24` server name), whether `model:"haiku"`/`"sonnet"` are accepted by the installed CLI, and `rondel_write_file` safe-zone rules for `/abs/smoke/scN/scratch/alice` (Scenario D may need a pre-blessed dir). Resolve empirically during a dry single-daemon run before parallel fan-out.
