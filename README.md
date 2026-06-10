# claude-wrap

Drive coding-agent CLIs (Claude Code today; Codex planned) by controlling the
**interactive terminal** through a pseudo-terminal, and expose a clean,
structured event API to your own projects.

It exists for one hard requirement: **run on a Claude subscription (Max/Pro),
never an API key.** It spawns the real `claude` CLI under a PTY — as if you were
typing — auto-accepts the workspace-trust prompt, and scrubs API-key environment
variables so usage always draws on your subscription.

> **Status: v0.1.0.** The Claude Code provider is implemented and verified
> end-to-end (including inside a live consumer daemon driving MCP tools). Codex
> is planned. Full design + de-risk evidence: [`claudedocs/claude-wrap-design.md`](claudedocs/claude-wrap-design.md).

## Why

The Agent SDK and headless `claude -p` are easy to bill against the API; if your
API access goes away, anything built on them breaks. claude-wrap drives the
**interactive** CLI, so it authenticates with your subscription, while still
giving you a programmatic API.

## How it works

- **PTY (node-pty)** runs the interactive `claude` TUI: input injection
  (bracketed paste + Enter), liveness, best-effort streaming text, and
  auto-accepting the "trust this folder" dialog.
- **Structured events come from a side-channel, not screen-scraping:**
  - **Hooks** (`SessionStart` / `PreToolUse` / `PostToolUse` / `Stop` / failure
    variants) are forwarded over a Unix socket — the realtime event spine.
  - The **session transcript JSONL** is tailed for token usage and the
    authoritative final text / stop reason.
- **Subscription-only auth:** API-key and cloud-provider env vars are scrubbed
  from the child process, `--bare` is never used, and a `claude auth status`
  self-check aborts if the session isn't a first-party subscription.

## Requirements

- Node ≥ 18 (developed and tested on Node 22).
- The `claude` CLI on `PATH` (or pass `cliPath`), authenticated to a subscription.
- `node-pty` (native). Its prebuilt `spawn-helper` must be executable — this
  package's `postinstall` handles that automatically.

## Install (git dependency)

Not published to npm — consume it from git:

```jsonc
// your package.json
{
  "dependencies": {
    "claude-wrap": "git+ssh://git@github.com/davidnoguerol/claude-wrap.git#v0.1.0"
  },
  // pnpm v10 blocks dependency build scripts by default. Allow these so
  // node-pty builds and the spawn-helper is made executable on install:
  "pnpm": { "onlyBuiltDependencies": ["node-pty", "claude-wrap"] }
}
```

```bash
pnpm install   # fetches from GitHub, builds (tsc via `prepare`), installs node-pty, fixes perms
```

Authenticate the subscription once per machine:

```bash
claude auth login      # interactive; stores creds in the OS keychain
# or, for headless/daemon hosts:
claude setup-token     # prints a CLAUDE_CODE_OAUTH_TOKEN to set in the env
```

## Quick start

```ts
import { AgentSession } from "claude-wrap";

const session = new AgentSession({
  provider: "claude-code",
  cwd: "/path/to/workdir",
  model: "sonnet", // alias or full model id; optional
});

session.on("ready", ({ sessionId }) => console.log("ready:", sessionId));
session.on("text", (e) => process.stdout.write(e.text)); // complete assistant text block
session.on("toolUse", (e) => console.log("tool:", e.name, e.input));
session.on("toolResult", (e) => console.log("tool done:", e.name, "ok=" + e.ok));
session.on("turnComplete", (r) => {
  console.log(`\nturn ${r.stopReason} ~$${r.costUsd ?? "?"}`, r.usage);
});
session.on("error", (e) => console.error("error:", e.message));

await session.start(); // resolves when the session is ready
await session.send("List the files here and summarize the project.");
// ...consume events until turnComplete...
await session.stop();
```

## API

### `new AgentSession(options)`

| option | type | notes |
|---|---|---|
| `provider` | `"claude-code"` | `"codex"` planned |
| `cwd` | `string` | agent working directory |
| `model` | `string?` | alias (`sonnet`/`opus`) or full id |
| `systemPrompt` / `appendSystemPrompt` | `string?` | replace / append the system prompt |
| `allowedTools` / `disallowedTools` | `string[]?` | tool allow / deny lists |
| `addDirs` | `string[]?` | extra `--add-dir` mounts |
| `mcpConfig` | `Record<string, McpServerEntry>?` | MCP servers (wrapped into `--mcp-config`) |
| `permission` | `{ mode }?` | `default` / `acceptEdits` / `bypassPermissions` / `plan` / `auto` / `dontAsk` (default `acceptEdits`) |
| `sessionId` / `resume` | `string?` / `boolean?` | reuse / resume a prior session |
| `env` | `Record<string,string>?` | merged onto the scrubbed env (API keys are removed afterward) |
| `cliPath` | `string?` | override the discovered `claude` binary |

### Methods

`start()`, `send(text, { attachments? })`, `interrupt()`, `stop()`, `restart()`,
`getState()`, `getSessionId()` — all typed.

### Events

`ready`, `state`, `text`, `textDelta`, `toolUse`, `toolResult`, `turnComplete`,
`usage`, `limit`, `error`, `exit`. Payload shapes are in [`src/types.ts`](src/types.ts).

## Known limitations (v0.1.0)

- **Cost is an estimate** (token counts × a bundled price table), not the CLI's
  authoritative `total_cost_usd` — that figure is stdout-only and unavailable
  when driving the interactive CLI. Token counts in `usage` are exact.
- **Attachments** are mounted via `--add-dir` and referenced by path (the agent
  `Read`s them); images are not inlined in-turn.
- **`textDelta` streaming** and a `prompt`-mode interactive permission flow are
  planned, not yet wired.
- **Rate-limit detection** is best-effort (matches usage-limit phrases in the
  terminal); a session that hits a limit recovers on restart.

## Releasing a new version

```bash
# bump "version" in package.json, commit, then:
git tag v0.2.0 && git push origin main v0.2.0
# bump the #v0.2.0 ref in each consumer's package.json and run `pnpm install`.
```

Pinning consumers to a tag means they don't move until you bump the ref.

## Tests

These run a **real** `claude` session on your subscription (they use quota):

```bash
npm run build
node tests/phase1-accept.mjs       # auth + scrub, a Write/Read/Bash turn, deduped usage, resume
node tests/phase2-robustness.mjs   # double-start, interrupt unwedge, env-scrub guards
node tests/trust-accept.mjs        # trust auto-accept in a fresh untrusted cwd
```

## Notes

Private/personal; not for publication to npm. The transcript and hook formats
are pinned to a tested Claude Code version (2.1.x) and may need adapter updates
across major CLI releases — those changes are isolated to
`src/providers/claude/`.
