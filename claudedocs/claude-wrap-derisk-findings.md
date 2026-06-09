# claude-wrap — De-risk Spike Findings

_Raw structured findings from the 6 validation spikes. Companion to claude-wrap-design.md._

## Claude Code session transcript JSONL schema (data channel for CLI wrapper tailing)

**Confidence:** high

Empirically reverse-engineered Claude Code v2.1.169's session transcript JSONL by running two headless sessions (initial + --resume) with forced tool execution in an isolated cwd, then reading every line. The transcript is an append-only, line-buffered JSONL written incrementally DURING the turn (verified by polling line count + mtime mid-run: grew 18->23->24->...->38 in lockstep with tool steps), making tail -f viable as a live structured channel. Eight distinct line "type" values exist: conversation entries (user, assistant, attachment) and session-metadata entries (queue-operation, ai-title, last-prompt, mode). Critically: (1) a single assistant API response with multiple content blocks (e.g. thinking + tool_use) is SPLIT into multiple JSONL lines that share the same message.id and requestId but have distinct uuid, each carrying an IDENTICAL copy of the usage object — naive summation double-counts tokens; (2) tool results are recorded as a SEPARATE type:"user" line whose message.content[0] is a tool_result block linked by tool_use_id, plus a top-level toolUseResult object (shape varies by tool) and sourceToolAssistantUUID back-pointer; (3) there is NO result/summary line in the transcript — the result JSON goes only to stdout. Turn completion is detectable from the JSONL alone: the terminal assistant line has stop_reason:"end_turn" (intermediate steps use "tool_use"), and a following last-prompt line's leafUuid points exactly to that terminal assistant uuid. Note metadata lines (last-prompt, ai-title, mode) are appended AFTER the end_turn assistant line.

### Facts
- CONFIRMED: claude binary at /Users/david/.local/bin/claude is version 2.1.169 (Claude Code). Today is 2026-06-09 (Tue Jun 9 16:19 BST), per `date` and CLAUDE.md currentDate.
- CONFIRMED: --session-id REJECTS the literal string 'undefined' with 'Error: Invalid session ID. Must be a valid UUID.' A valid UUID is mandatory; I used 00000000-0000-4000-8000-000000000abc.
- CONFIRMED: Transcript path is ~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl . cwd /Users/david/Code/claude-wrap/undefined-transcript maps to dir name -Users-david-Code-claude-wrap-undefined-transcript (every '/' including the leading one replaced by '-').
- CONFIRMED: 8 distinct line types observed across both turns: user, assistant, attachment, queue-operation, ai-title, last-prompt, mode. (queue-operation appears in two subtypes via 'operation': enqueue/dequeue.)
- CONFIRMED: A single assistant response is split across multiple JSONL lines sharing one message.id + requestId but distinct uuid, chained by parentUuid. Lines 6 (thinking) and 7 (tool_use) both had id=msg_012GNNG5PoDa3jtwVPagLnAg and identical usage objects.
- CONFIRMED: EVERY assistant line carries a full message.usage object (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use, service_tier, cache_creation{ephemeral_1h/5m}, inference_geo, iterations[], speed). Because split lines duplicate usage, dedupe by message.id before summing.
- CONFIRMED: Tool results are a SEPARATE type:'user' line. message.content[0] = {tool_use_id, type:'tool_result', content:<string>}; linkage via tool_use_id back to the assistant tool_use block's id; ALSO top-level fields toolUseResult (object) and sourceToolAssistantUUID (= the assistant line's uuid that emitted the tool_use).
- CONFIRMED: toolUseResult shape is tool-specific. Write -> {type:'create',filePath,content,structuredPatch[],originalFile,userModified}. Read -> {type:'text',file:{filePath,content,numLines,startLine,totalLines}}. Bash -> {stdout,stderr,interrupted,isImage,noOutputExpected}.
- CONFIRMED: NO 'result' or 'summary' line type exists in the transcript (grep count 0 for both). The result JSON (with subtype, duration_ms, num_turns, total_cost_usd, modelUsage, stop_reason, uuid) is emitted ONLY to stdout via --output-format json. Its top-level uuid (696477a6...) does NOT appear anywhere in the transcript.
- CONFIRMED: Turn boundary = final assistant line with message.stop_reason=='end_turn'. Intermediate tool-calling assistant lines have stop_reason=='tool_use'. Observed sequences: [tool_use,tool_use,tool_use,tool_use,end_turn] then [tool_use x5,end_turn].
- CONFIRMED: A 'last-prompt' line is written after each completed turn; its leafUuid equals the uuid of that turn's terminal end_turn assistant line (line16.leafUuid==line15.uuid; line35.leafUuid==line34.uuid).
- CONFIRMED: LIVE-APPEND. Polling the file every ~1.5s during a 41s multi-step turn showed monotonic incremental growth (lines 18->23->24->25->26->28->30->31->32, ending 38) with mtime advancing each step. Entries are flushed as the turn progresses, not buffered to the end. tail -f sees them in real time.
- CONFIRMED: Trailing metadata ordering — within a turn the last conversation line is the end_turn assistant, then last-prompt, then ai-title, and (on resume) a 'mode' line ({mode:'normal'}) is appended LAST. A tailer keying purely on end_turn must tolerate these trailing non-conversation lines.
- CONFIRMED: Common conversation-line envelope fields: parentUuid, isSidechain(false here), type, uuid, timestamp(ISO8601 .NNNZ UTC), userType('external'), entrypoint('sdk-cli'), cwd, sessionId, version('2.1.169'), gitBranch('main'). user/assistant add message{}; user-prompt & tool_result add promptId; assistant adds requestId; user tool_result adds toolUseResult + sourceToolAssistantUUID.
- CONFIRMED: permissionMode:'bypassPermissions' and promptSource:'sdk' appear on the initial user prompt line (from --dangerously-skip-permissions + -p). 'attachment' lines have attachment.type (e.g. 'deferred_tools_delta') with addedNames/addedLines/removedNames/readdedNames/pendingMcpServers.
- CONFIRMED: tool_use blocks carry an extra 'caller':{'type':'direct'} field alongside the standard {type:'tool_use', id, name, input}.
- ASSUMED: Field set is stable for headless -p / SDK runs at v2.1.169; interactive TUI sessions may add/omit metadata lines (entrypoint/userType likely differ). Sidechain (Task subagent) entries would set isSidechain:true — not exercised in this probe.

### Contracts

## Data-Channel Contract: Claude Code Session Transcript JSONL (v2.1.169)

### 1. File path derivation rule
```
~/.claude/projects/<MANGLED_CWD>/<SESSION_UUID>.jsonl
```
- `MANGLED_CWD` = absolute cwd with **every** `/` (including leading) replaced by `-`.
  - `/Users/david/Code/claude-wrap/undefined-transcript` -> `-Users-david-Code-claude-wrap-undefined-transcript`
- `SESSION_UUID` = the value passed to `--session-id` (must be a valid UUID; the string `undefined` is rejected).
- The project dir is created with mode `drwx------` (0700).
- WARNING: this is lossy mangling — a real `-` in a path component is indistinguishable from a `/`. To resolve a transcript reliably, prefer the `session_id` from stdout result JSON + known cwd, or scan files and read the `cwd` field inside.

### 2. Line-type catalog (field-level)

Every line is one JSON object with a top-level `"type"`. Two families:

#### A) Conversation lines (share a common envelope)
Common envelope keys: `parentUuid` (str|null), `isSidechain` (bool), `type`, `uuid` (str, unique per line), `timestamp` (ISO8601 UTC, ms precision `...Z`), `userType` ("external"), `entrypoint` ("sdk-cli"), `cwd`, `sessionId`, `version`, `gitBranch`.

**type:"user" (initial prompt)** — adds `promptId`, `permissionMode` ("bypassPermissions"), `promptSource` ("sdk"); `message` = `{role:"user", content:<string>}`.
```json
{"parentUuid":null,"isSidechain":false,"promptId":"906e...","type":"user",
 "message":{"role":"user","content":"Use your tools to do ALL of: ..."},
 "uuid":"3293...","timestamp":"2026-06-09T15:20:14.345Z",
 "permissionMode":"bypassPermissions","promptSource":"sdk","userType":"external",
 "entrypoint":"sdk-cli","cwd":".../undefined-transcript","sessionId":"0000...abc",
 "version":"2.1.169","gitBranch":"main"}
```

**type:"user" (tool_result)** — adds `promptId`, `toolUseResult` (object, tool-specific), `sourceToolAssistantUUID`; `message.content` is a LIST of tool_result blocks.
```json
{"parentUuid":"edfd...","type":"user","promptId":"906e...",
 "message":{"role":"user","content":[
    {"tool_use_id":"toolu_01JNCE...","type":"tool_result",
     "content":"File created successfully at: .../notes.txt ..."}]},
 "uuid":"8e39...","timestamp":"...","toolUseResult":{
    "type":"create","filePath":".../notes.txt","content":"derisk probe",
    "structuredPatch":[],"originalFile":null,"userModified":false},
 "sourceToolAssistantUUID":"edfd...", ...envelope... }
```
- Linkage: `message.content[i].tool_use_id` == the assistant `tool_use` block's `id`. `sourceToolAssistantUUID` == the assistant line `uuid` that emitted it.
- `toolUseResult` shapes observed:
  - Write: `{type:"create",filePath,content,structuredPatch:[],originalFile,userModified}`
  - Read:  `{type:"text",file:{filePath,content,numLines,startLine,totalLines}}`
  - Bash:  `{stdout,stderr,interrupted,isImage,noOutputExpected}`

**type:"assistant"** — adds `requestId`; `message` is the raw Anthropic API message object.
`message` keys: `model, id, type:"message", role:"assistant", content:[...blocks], stop_reason, stop_sequence, stop_details, usage{...}, diagnostics`.
Content block variants: `{type:"thinking", thinking, signature}`, `{type:"tool_use", id, name, input, caller:{type:"direct"}}`, `{type:"text", text}`.
- **Split-line rule**: one API response with N blocks => N separate assistant JSONL lines, SAME `message.id`+`requestId`, distinct `uuid`, chained by `parentUuid`, each duplicating the SAME `usage`. Dedupe by `message.id` for token accounting.
```json
// thinking block line (trimmed)
{"parentUuid":"6a9b...","type":"assistant","requestId":"req_011C...",
 "message":{"model":"claude-opus-4-8","id":"msg_012GNN...","type":"message","role":"assistant",
   "content":[{"type":"thinking","thinking":"...[trimmed]","signature":"EuQB...[trimmed]"}],
   "stop_reason":"tool_use","stop_sequence":null,"stop_details":null,
   "usage":{"input_tokens":2392,"cache_creation_input_tokens":35584,"cache_read_input_tokens":15821,
     "output_tokens":115,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
     "service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":35584,"ephemeral_5m_input_tokens":0},
     "inference_geo":"not_available","iterations":[{...}],"speed":"standard"},
   "diagnostics":null},
 "uuid":"03f5...","timestamp":"2026-06-09T15:20:16.797Z", ...envelope... }
// tool_use block line (same msg id, next uuid)
{"...","message":{"id":"msg_012GNN...","content":[
   {"type":"tool_use","id":"toolu_01JNCE...","name":"Write",
    "input":{"file_path":".../notes.txt","content":"derisk probe"},"caller":{"type":"direct"}}],
   "stop_reason":"tool_use","usage":{...SAME usage...}}, "uuid":"edfd...","parentUuid":"03f5..."}
// terminal text line
{"...","message":{"id":"msg_01LRx...","content":[{"type":"text","text":"COMPLETE"}],
   "stop_reason":"end_turn","usage":{...}}, "uuid":"e5a8...","parentUuid":"1b1e..."}
```

**type:"attachment"** — adds `attachment` object; common envelope minus message. Example `attachment.type:"deferred_tools_delta"` with `addedNames[]`, `addedLines[]`, `removedNames[]`, `readdedNames[]`, `pendingMcpServers[]`. These are interleaved (system-injected context); a tailer for conversation usually ignores them.

#### B) Session-metadata lines (NO envelope; minimal fields)
```json
{"type":"queue-operation","operation":"enqueue","timestamp":"...","sessionId":"...","content":"<prompt text>"}
{"type":"queue-operation","operation":"dequeue","timestamp":"...","sessionId":"..."}   // no content
{"type":"ai-title","aiTitle":"Write, read, and verify notes file","sessionId":"..."}
{"type":"last-prompt","lastPrompt":"<prompt text>","leafUuid":"e5a8...","sessionId":"..."}
{"type":"mode","mode":"normal","sessionId":"..."}   // appeared on --resume run, trailing
```

### 3. Turn-completion detection (from JSONL alone)
PRIMARY signal: the latest `type:"assistant"` line whose `message.stop_reason == "end_turn"`. Intermediate tool-calling steps emit `stop_reason == "tool_use"`. Observed stop_reason stream across the 2 turns: `[tool_use,tool_use,tool_use,tool_use,end_turn, tool_use,tool_use,tool_use,tool_use,tool_use,end_turn]`.
CONFIRMING signal: a subsequent `type:"last-prompt"` line whose `leafUuid` == the terminal assistant line's `uuid` (verified both turns). 
RECOMMENDED tailer logic: treat a turn as COMPLETE upon reading an `assistant` line with `stop_reason:"end_turn"`. Do NOT rely on EOF/quiescence. Be aware trailing `last-prompt`/`ai-title`/`mode` lines arrive immediately AFTER and should not reset the "complete" state. There is NO `result`/`summary` line in the transcript — that data is stdout-only (`--output-format json`).
Other stop_reasons (max_tokens, refusal, tool-loop interruption) were not exercised; a robust reader should treat any non-`tool_use` stop_reason (end_turn, max_tokens, stop_sequence, refusal) as turn-terminal and use stdout result JSON's `stop_reason`/`subtype` as the authoritative cross-check when available.

### 4. Live-append verdict
INCREMENTAL / LINE-BUFFERED — confirmed by mid-run polling during a 41s turn:
```
START lines=18  ... lines=23(+5) -> 24 -> 25 -> 26 -> 28 -> 30 -> 31 -> 32 ... END lines=38
mtime advanced in lockstep with each tool step.
```
Each assistant block, tool_result, and metadata line is flushed to disk as it is produced. `tail -f` (or inotify/FSEvents on size+read) is a valid live structured channel. Reader must handle partial last line (read full lines only; a line may be mid-write) and tolerate non-conversation line types.

### 5. stdout result object (NOT in transcript, for reference/cross-check)
`{type:"result", subtype:"success", is_error, duration_ms, duration_api_ms, ttft_ms, num_turns, result:"<final assistant text>", stop_reason:"end_turn", session_id, total_cost_usd, usage{...}, modelUsage{<model>:{inputTokens,outputTokens,...,costUSD,contextWindow,maxOutputTokens}}, permission_denials[], terminal_reason:"completed", uuid}`. Its `uuid` is independent and not written to the transcript.

### Design implications
- Tailer turn-complete rule: emit 'turn done' when an assistant line with stop_reason != 'tool_use' (normally 'end_turn') is read. Ignore subsequent last-prompt/ai-title/mode lines as trailing metadata; do not treat them as a new turn.
- Token accounting MUST dedupe assistant lines by message.id before summing usage — split thinking/tool_use lines duplicate the identical usage object. Per-turn cost is better taken from the stdout result JSON (total_cost_usd, modelUsage) if the wrapper also captures stdout.
- To reconstruct tool calls: join assistant tool_use blocks to the following user tool_result line via tool_use_id (or sourceToolAssistantUUID). Render tool I/O from toolUseResult (typed per tool) rather than the stringified content block when you need structured fields.
- Parse defensively: a tailer must (a) read only complete newline-terminated lines (last line may be mid-flush), (b) switch on 'type' and skip/handle unknown types (mode, ai-title, queue-operation, attachment) without crashing, since the set may grow across versions.
- Path mangling is lossy (every '/'->'-', and real '-' is ambiguous). For reliable file discovery, derive from the session UUID returned on stdout plus the known launch cwd, or glob and confirm via the in-file 'cwd' field, rather than reverse-engineering the dirname.
- Do not depend on a result/summary line inside the JSONL — it does not exist. If the wrapper needs the structured result (cost, duration, terminal_reason), it must capture process stdout (--output-format json) separately and correlate by sessionId.
- isSidechain:true marks Task/subagent transcripts (not seen here); a UI tailer likely wants to filter or visually nest these. Build the field in from day one.
- permissionMode and promptSource on the initial user line let the wrapper distinguish SDK/headless vs interactive origins; entrypoint='sdk-cli' similarly tags origin.

### Risks
- Token double-counting if usage is summed across all assistant lines (split-line duplication). Mitigate by deduping on message.id.
- Trailing metadata lines (last-prompt, ai-title, mode) arrive AFTER end_turn; a naive 'last line == turn state' reader could misclassify. Key off the assistant stop_reason, not the final physical line.
- Path-mangling ambiguity (real '-' vs '/') can cause a wrapper to open the wrong/duplicate transcript dir. Confirm via in-file cwd.
- Schema is version-pinned to 2.1.169; field names (e.g., diagnostics, stop_details, caller, inference_geo, iterations) and the line-type set can change across releases. Unknown-type tolerance is required.
- Only stop_reason values tool_use and end_turn were observed. max_tokens/refusal/interrupted turns are untested — a reader assuming only those two terminal states could hang or mis-handle truncated turns.
- Partial-line reads during live append: a tailer reading mid-flush will see invalid JSON on the last line; must buffer until newline.
- Interactive (TUI) sessions were not probed; metadata lines and envelope fields (userType, entrypoint, promptSource) likely differ from this headless SDK run.
- The full message.content[0].content string of a tool_result can be large/binary-ish (isImage:true for Bash); a UI must guard against rendering huge or image payloads inline.

### Open questions
- How are turns recorded when stop_reason is max_tokens, refusal, or the turn is user-interrupted/aborted? Does last-prompt.leafUuid still get written, and does a partial assistant line persist?
- Interactive/TUI sessions: do they emit the same 8 line types, and do envelope fields (entrypoint, userType, promptSource, permissionMode) differ? A separate interactive probe is needed before relying on this for non-headless runs.
- Sidechain (Task subagent) entries: are they written into the SAME parent .jsonl with isSidechain:true, or a separate file? Not exercised here.
- Streaming granularity: with --output-format stream-json, are assistant text blocks emitted as deltas in the transcript too, or only the consolidated block as seen here? (This probe used --output-format json.)
- Does the 'mode' line appear on fresh sessions or only on --resume? It was absent in the initial run and present after resume — needs one more controlled fresh-vs-resume comparison.
- Are there additional attachment.type values (beyond deferred_tools_delta) and additional metadata line types (e.g. file-history, compact/summary on long sessions) that a long-running wrapper must handle?


---

## Claude Code hooks as a structured side-channel for an interactive PTY wrapper

**Confidence:** high

Validated empirically (Claude Code v2.1.169, macOS) AND against official docs (code.claude.com/docs/en/hooks + /hooks-guide) that Claude Code hooks deliver event-specific JSON on the hook command's stdin, fire identically in headless and interactive modes, and carry transcript_path on EVERY event for hook->transcript-JSONL correlation. A PostToolUse(matcher "*") + Stop hook pair captured exact payloads: PostToolUse fired once per tool call (Write, Bash) with tool_name/tool_input/tool_response/tool_use_id/duration_ms; Stop fired once at turn-complete with stop_hook_active and last_assistant_message. The tool_use_id in the PostToolUse payload appears verbatim in the transcript JSONL, and Stop.last_assistant_message matches the final assistant turn — confirming tight correlation. Hooks are FIT as the PRIMARY structured event source for tool-calls + turn-complete. Critical caveats for a PTY wrapper: (1) hooks require a settings file (use --settings with absolute path, or .claude/settings.json); (2) --bare disables hooks (and also auth/LSP/plugins) — never launch the wrapped session with --bare; (3) hooks are SYNCHRONOUS by default and BLOCK the turn until the command exits (default timeout 600s) — for passive observation set "async": true so the hook runs in the background without blocking; (4) PostToolUse has no per-event blocking concern for an async observer; Stop CAN be blocked (exit 2 / structured JSON) so a passive observer must exit 0 and write nothing decision-shaped.

### Facts
- see facts above

### Contracts

## 1. settings.json hooks config format (validated)

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "Bash",                      // omit / "" / "*" = all; alnum+_+| = exact or pipe-list; else JS regex
        "hooks": [
          {
            "type": "command",                  // command | http | mcp_tool | prompt | agent
            "command": "/abs/path/to/handler",  // receives event JSON on STDIN
            "timeout": 600,                      // seconds; default 600 for command/http
            "async": true,                       // <-- background, NON-BLOCKING (passive observer)
            "asyncRewake": false                 // implies async; wakes Claude on hook exit 2
          }
        ]
      }
    ],
    "disableAllHooks": false
  }
}
```
Scope/precedence: ~/.claude/settings.json (user) < .claude/settings.json (project) < .claude/settings.local.json < managed policy. CLI: `--settings <file-or-JSON>` merges ADDITIONAL settings (used in test with an absolute path). Live edits are picked up by a file watcher.

The exact test config used (matcher "*" for PostToolUse, "" for Stop) fired correctly:
```json
{ "hooks": {
  "PostToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "cat >> /abs/posttooluse.log" } ] } ],
  "Stop":        [ { "matcher": "",  "hooks": [ { "type": "command", "command": "cat >> /abs/stop.log" } ] } ]
} }
```

## 2. PostToolUse stdin payload — EXACT (captured verbatim)

Write tool call:
```json
{"session_id":"00338778-01ca-408b-ad84-54fe9804cf1f","transcript_path":"/Users/david/.claude/projects/-Users-david-Code-claude-wrap-claude-wrap-hooks/00338778-01ca-408b-ad84-54fe9804cf1f.jsonl","cwd":"/Users/david/Code/claude-wrap/claude-wrap-hooks","permission_mode":"bypassPermissions","effort":{"level":"high"},"hook_event_name":"PostToolUse","tool_name":"Write","tool_input":{"file_path":".../x.txt","content":"hi\n"},"tool_response":{"type":"create","filePath":".../x.txt","content":"hi\n","structuredPatch":[],"originalFile":null,"userModified":false},"tool_use_id":"toolu_0179yJApYqwDYjE5Ws4v269t","duration_ms":11}
```
Bash tool call:
```json
{... ,"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo hi","description":"Echo hi"},"tool_response":{"stdout":"hi","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false},"tool_use_id":"toolu_01EHGWhpQqVj5s5TZ87iDBoh","duration_ms":1046}
```
Field contract (PostToolUse):
- session_id: string
- transcript_path: string (abs path to session JSONL)
- cwd: string
- permission_mode: "default"|"plan"|"acceptEdits"|"auto"|"dontAsk"|"bypassPermissions"
- effort: { level: "low"|"medium"|"high"|"xhigh"|"max" } (tool-use contexts)
- hook_event_name: "PostToolUse"
- tool_name: string (the matched tool)
- tool_input: object — shape per tool (Bash: {command, description}; Write: {file_path, content})
- tool_response: object — shape per tool (Bash: {stdout,stderr,interrupted,isImage,noOutputExpected}; Write: {type,filePath,content,structuredPatch,originalFile,userModified})
- tool_use_id: string "toolu_*"  <-- JOIN KEY into transcript
- duration_ms: number
Note: tool FAILURES go to a SEPARATE event "PostToolUseFailure" {..., tool_name, tool_input, error}. To capture all tool outcomes register BOTH PostToolUse and PostToolUseFailure (or use PostToolBatch for parallel batches).

## 3. Stop stdin payload — EXACT (captured verbatim)
```json
{"session_id":"00338778-01ca-408b-ad84-54fe9804cf1f","transcript_path":".../00338778-...jsonl","cwd":"/Users/david/Code/claude-wrap/claude-wrap-hooks","permission_mode":"bypassPermissions","effort":{"level":"high"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"DONE","background_tasks":[],"session_crons":[]}
```
Field contract (Stop):
- common fields (session_id, transcript_path, cwd, permission_mode, effort, hook_event_name:"Stop")
- stop_hook_active: boolean (true when Claude is already continuing due to a prior Stop-hook block; guard against infinite loops)
- last_assistant_message: string (final turn text — turn-complete payload includes the reply directly)
- background_tasks: array
- session_crons: array
Note: a turn that ends on an API error fires "StopFailure" instead (matcher = error type; output/exit code ignored). For complete turn-complete coverage register Stop + StopFailure (+ SubagentStop for subagents).

## 4. transcript_path correlation (CONFIRMED)
- transcript_path present on EVERY event -> /Users/<u>/.claude/projects/<cwd-slug>/<session_id>.jsonl (0600).
- The hook payload's tool_use_id (e.g. toolu_0179yJApYqwDYjE5Ws4v269t) appears VERBATIM as the tool_use id inside the transcript JSONL.
- Stop.last_assistant_message ("DONE") matches the transcript's final assistant message.
=> A wrapper can use hooks as the realtime event stream and the JSONL (located via transcript_path, joined via tool_use_id) for full message/content detail.

## 5. Interactive-mode / PTY caveats (for the wrapper)
- Hooks fire IDENTICALLY in interactive and headless -p modes; config + stdin-JSON + exit-code contract is the same. (docs)
- REQUIRES a settings file. For a PTY-driven session pass `--settings /abs/wrapper-hooks.json` (or place .claude/settings.json). Use ABSOLUTE paths in commands; cwd is the session cwd, not the settings dir.
- DO NOT use `--bare`: it skips hooks (and LSP/plugins/auth helpers). Hooks are the side-channel, so --bare defeats the design.
- BLOCKING: command hooks are SYNCHRONOUS by default and pause the turn until the process exits (default timeout 600s). For a PASSIVE OBSERVER that must not stall the interactive turn, set "async": true (runs in background, output ignored, non-blocking). Do NOT set asyncRewake unless you want exit-2 to interrupt Claude.
- PASSIVE-SAFE behavior: handler must exit 0 and write nothing to stdout (for Stop/PostToolUse, structured stdout JSON or exit 2 can alter/block the turn). A pure observer = read stdin, fork/forward, exit 0, no stdout.
- Multiple hooks on one event ALL run to completion and outputs merge; one hook's deny does not stop siblings' side effects — so an observer co-existing with a control hook is safe but still runs synchronously unless async.
- matcher caveat: Stop / PostToolBatch / UserPromptSubmit / MessageDisplay / CwdChanged ignore matcher (always fire); for tool events matcher is tool-name based (alnum+_+| = literal/list, anything else = JS regex; MCP tools = mcp__<server>__<tool>).
- Alternative for HEADLESS only: `--include-hook-events` streams hook lifecycle events into the --print/SDK output stream — not usable for an interactive PTY session, where settings-registered hooks are required.

## Test artifacts (cleaned up)
- Throwaway dir /Users/david/Code/claude-wrap/claude-wrap-hooks (settings.json, posttooluse.log, stop.log, x.txt) created, captured, then `rm -rf`'d. Workspace clean for my work. (A pre-existing untracked `undefined-transcript/` from a different task was left untouched.)
- The session transcript persists at ~/.claude/projects/-Users-david-Code-claude-wrap-claude-wrap-hooks/00338778-01ca-408b-ad84-54fe9804cf1f.jsonl (normal session persistence; harmless).

### Design implications
- Use hooks as the PRIMARY structured event source for an interactive PTY-wrapped session: register PostToolUse (tool started/finished w/ inputs+results) + PostToolUseFailure (tool errors) + Stop (turn-complete + final text) + StopFailure (turn ended on API error), all with "async": true so the wrapper observes without blocking the turn.
- Forward the raw stdin JSON object straight to the wrapper (it is already a complete single-line JSON event). No parsing of terminal output needed for these events.
- Correlate to full conversation detail via transcript_path + tool_use_id: hooks give the realtime trigger + summary, the JSONL gives complete message/content/thinking. Tail transcript_path for anything not in the hook payload.
- Use Stop.last_assistant_message for the turn's reply text directly — avoids racing the transcript write. Guard re-entrancy with stop_hook_active.
- Ship hooks via a dedicated settings file passed as `--settings /abs/path` (or write .claude/settings.json) using absolute-path handler commands; the handler should be a tiny forwarder (e.g. write to a unix socket/FIFO/HTTP) that always exits 0.
- Never launch the wrapped CLI with --bare (kills hooks). Verify hooks load via the /hooks menu or a SessionStart canary hook.
- Consider an HTTP hook (type:"http") instead of command for lower per-event fork overhead and to point all events at one wrapper endpoint; same JSON arrives as the POST body. Combine with async for non-blocking.
- For maximal coverage also consider UserPromptSubmit (turn start / prompt text) and SubagentStart/SubagentStop (Task-tool subagents) so the wrapper models nested agent turns.

### Risks
- Synchronous hooks block the interactive turn (up to the 600s timeout) — a slow/hanging observer command would freeze the user's session. MUST use async:true for observers.
- A hook handler that writes JSON to stdout or exits 2 on Stop/PostToolUse can unintentionally alter/block the turn. Observer must exit 0 with empty stdout.
- --bare silently disables ALL hooks (and auth/LSP/plugins) — if the wrapper or user ever adds --bare, the side-channel goes dark with no error.
- Tool FAILURES do not fire PostToolUse — they fire PostToolUseFailure. Registering only PostToolUse silently misses every failed tool call.
- Turn end on API error fires StopFailure (not Stop) and its output/exit code are IGNORED — relying solely on Stop misses error-terminated turns.
- Undocumented-in-basic-example fields (tool_use_id, duration_ms, effort, last_assistant_message, background_tasks, session_crons) are present in v2.1.169 but are not in the minimal doc example — they could change across versions; treat the schema as additive and parse defensively.
- transcript_path file is 0600 and written async; reading it immediately in the hook may race the writer. Prefer the hook payload fields; fall back to transcript with retry.
- matcher "*" works, but docs canonically use "" or omission for match-all; mixing literal vs regex matcher chars (any non-alnum/_/| char flips it to JS regex) is an easy misconfiguration.

### Open questions
- Clean isolation test of --bare disabling hooks was blocked by the auth-skip side effect; confirm on a logged-in machine that a tool-running --bare session produces zero hook invocations (docs say yes).
- Per-event fork cost of command hooks at high tool-call volume in interactive mode (async mitigates blocking but not process churn) — benchmark; HTTP hooks may be cheaper.
- Exact ordering/timing guarantee between an async PostToolUse hook firing and the corresponding transcript line being flushed to disk (for correlation races).
- Whether PostToolBatch fires INSTEAD OF or IN ADDITION TO per-tool PostToolUse when tools run in parallel — affects whether the wrapper should subscribe to both.
- Behavior of async hooks at session exit: are in-flight background observer commands awaited or killed on interactive quit?


---

## Claude Code PTY Control & Interactive CLI Recipe

Claude Code runs an interactive REPL via Ink (React TUI) multiplexed through node-pty for remote bridging. The system detects ready-state via 'idle' session_state_changed events, completes turns when Claude finishes speaking or awaiting input, and handles permissions via control_request/control_response NDJSON protocol. Bootstrap uses term=xterm-256color, HOME/CWD env vars, and oauth-token injection. Turn-done detection is reactive (waiting for idle event), not proactive pattern matching—far more robust than screen polling.

### Facts
- CONFIRMED: node-pty spawn happens at /Users/david/Code/claude-code/src/server/web/pty-server.ts:83 with spawn(CLAUDE_BIN, [], {name: 'xterm-256color', cols, rows, cwd: home, env: {...}}) — args are deliberately empty, only flags passed via stdin-piped CLI.
- CONFIRMED: PTY session wrapper at src/server/web/session-manager.ts:203-229 uses onData listener to capture all output to scrollback buffer + WebSocket, onExit listener to detect PTY exit.
- CONFIRMED: PTY input injection via writeWsEvents() at src/server/web/session-manager.ts:273-298: raw data from WebSocket is parsed for {type: 'resize', type: 'ping'} control messages, else written directly to pty.write(str).
- CONFIRMED: For bridge/daemon spawning, CLI is invoked with args at src/bridge/sessionRunner.ts:287-304: --print, --sdk-url, --session-id, --input-format stream-json, --output-format stream-json, --replay-user-messages, --verbose, --debug-file, --permission-mode.
- CONFIRMED: Auth uses CLAUDE_CODE_OAUTH_TOKEN (preferred) or ANTHROPIC_API_KEY env vars at src/utils/auth.ts. OAuth token passed to spawnPty at pty-server.ts:94 as per user auth adapter.
- CONFIRMED: Turn-done detection is NOT pattern matching; it's session_state_changed('idle') event emitted at src/cli/print.ts after finally block flushes pending events and notifySessionStateChanged('idle') called at line ~5700.
- CONFIRMED: session_state is tracked in src/utils/sessionState.ts with three states: 'idle', 'running', 'requires_action'. Emitted as SDK system event with subtype='session_state_changed' when CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1.
- CONFIRMED: Permission prompts use control_request/control_response NDJSON protocol at src/cli/structuredIO.ts:264+. can_use_tool requests written to stdout, responses read from stdin. Dedup via resolvedToolUseIds Set tracks which tool_use_ids already resolved (max 1000 entries).
- CONFIRMED: Bootstrap ready detection for SDK mode is via first NDJSON message arrival (type 'user' or 'assistant') in bridge/sessionRunner.ts:433-442, NOT screen pattern matching.
- ASSUMED: Bracketed paste sequences are NOT explicitly handled by Claude Code's PTY layer—input is transparent binary pass-through to the CLI's Ink runtime.
- ASSUMED: ANSI stripping/cleaning done at UI render layer (Ink), not PTY capture layer.
- CONFIRMED: Input chunking happens implicitly via Ink's useInput hook at src/ink/hooks/use-input.ts:42-92: single character input fires handler immediately, pasted multi-char input fires handler once with full string.
- CONFIRMED: Exit sequence at src/server/web/pty-server.ts:289-304 uses graceful shutdown with 10-second timeout (SIGTERM → wait 10s → forced exit).

### Contracts


## 1. NODE-PTY SPAWN RECIPE

**File: /Users/david/Code/claude-code/src/server/web/pty-server.ts:78-102**

```typescript
const sessionManager = new SessionManager(
  MAX_SESSIONS,
  (cols, rows, user?: AuthUser) => {
    const userId = user?.id ?? "default";
    const home = userHomeDir(userId);
    return spawn(CLAUDE_BIN, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.WORK_DIR ?? home,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        HOME: home,
        ...(user?.apiKey ? { ANTHROPIC_API_KEY: user.apiKey } : {}),
      },
    });
  },
  // ... grace period, scrollback, rate limits
);
```

**Key Details:**
- **Spawn args:** Empty array `[]` — CLI flags passed via stdin only, not argv
- **Terminal emulation:** `xterm-256color` + COLORTERM=truecolor for 24-bit color support
- **Env setup:** HOME redirected to user-specific dir, TERM set twice (redundant but harmless), WORK_DIR or HOME as cwd
- **Auth injection:** ANTHROPIC_API_KEY set only when user has apiKey (per-user API key mode)
- **Why this way:** Allows same binary to be invoked differently per session without recompile; per-user HOME enables session isolation and config reading

---

## 2. LAUNCH FLAGS & FRESH-VS-RESUME LOGIC

**Bridge mode (src/bridge/sessionRunner.ts:287-304)**

```typescript
const args = [
  ...deps.scriptArgs,  // node path when running npm-installed CLI
  '--print',           // JSON-streaming mode
  '--sdk-url', opts.sdkUrl,
  '--session-id', opts.sessionId,
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--replay-user-messages',  // Replay prior messages from store
  ...(deps.verbose ? ['--verbose'] : []),
  ...(debugFile ? ['--debug-file', debugFile] : []),
  ...(deps.permissionMode ? ['--permission-mode', deps.permissionMode] : []),
];
```

**Fresh vs Resume decision at pty-server.ts:252-263:**
```typescript
const resumeToken = url.searchParams.get("resume");
if (resumeToken) {
  const stored = sessionManager.getSession(resumeToken);
  if (stored && (user.isAdmin || stored.userId === user.id)) {
    const resumed = sessionManager.resume(resumeToken, ws, cols, rows);
    if (resumed) return;  // Reattach to existing PTY
  }
}
// Otherwise create new session
const token = sessionManager.create(ws, cols, rows, user);
```

**Resume path (session-manager.ts:203-229):** Cancel grace timer, send `{type: "resumed", token}`, replay scrollback bytes, resize PTY to new dims, rewire WebSocket listeners.

---

## 3. BOOTSTRAP / READY DETECTION

**File: src/bridge/sessionRunner.ts:369-445**

For SDK/bridge mode (NOT interactive REPL):
```typescript
if (child.stdout) {
  const rl = createInterface({ input: child.stdout })
  rl.on('line', line => {
    if (transcriptStream) {
      transcriptStream.write(line + '\n')
    }
    // Detect control_request + first user message
    let parsed: unknown
    try {
      parsed = jsonParse(line)
    } catch {
      // Non-JSON line, skip
    }
    if (parsed && typeof parsed === 'object') {
      const msg = parsed as Record<string, unknown>
      
      if (msg.type === 'control_request') {
        const request = msg.request as Record<string, unknown> | undefined
        if (request?.subtype === 'can_use_tool' && deps.onPermissionRequest) {
          deps.onPermissionRequest(opts.sessionId, parsed as PermissionRequest, opts.accessToken)
        }
      } else if (
        msg.type === 'user' &&
        !firstUserMessageSeen &&
        opts.onFirstUserMessage
      ) {
        const text = extractUserMessageText(msg)
        if (text) {
          firstUserMessageSeen = true
          opts.onFirstUserMessage(text)  // ← READY signal
        }
      }
    }
  })
}
```

**For interactive REPL (NOT SDK mode):** Ink mounts and renders. No pattern-based ready detection needed—components drive interaction.

**Robustness:** NDJSON-based (structured event arrival) is MORE robust than screen-pattern matching because:
- Immune to TUI rendering timing/buffering
- Independent of Claude version UI changes
- Explicit message contracts (type discriminant)
- No terminal size assumptions

---

## 4. INPUT INJECTION: PASTE, CHUNKING, TIMING

**File: src/server/web/session-manager.ts:273-298 (WebSocket → PTY)**

```typescript
private wireWsEvents(token: string, ws: WebSocket, pty: IPty): void {
  ws.on("message", (data: Buffer | string) => {
    const str = data.toString();
    if (str.startsWith("{")) {
      try {
        const msg = JSON.parse(str) as Record<string, unknown>;
        if (
          msg.type === "resize" &&
          typeof msg.cols === "number" &&
          typeof msg.rows === "number"
        ) {
          pty.resize(msg.cols as number, msg.rows as number);
          return;
        }
        if (msg.type === "ping") {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
          return;
        }
      } catch {
        // Not JSON — treat as terminal input
      }
    }
    pty.write(str);  // ← Raw input pass-through
  });
}
```

**For Ink (src/ink/hooks/use-input.ts:69-89):**
```typescript
const handleData = useEventCallback((event: InputEvent) => {
  if (options.isActive === false) {
    return;
  }
  const { input, key } = event;
  if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
    inputHandler(input, key, event);  // Single-char or multi-char pasted text
  }
});
```

**Characteristics:**
- Bracketed paste sequences: NOT explicitly handled; pass-through to PTY/Ink
- Chunking: Automatic via Ink—single keystroke fires handler immediately, pasted block fires once
- Timing/delays: No artificial delays; event-driven
- Dedup: None (relies on Ink's event ordering)
- Enter key: Handled by onSubmit callback in TextInput component

---

## 5. IDLE / TURN-DONE DETECTION

**File: src/cli/print.ts (main REPL loop)**

Turn-done is detected by **waiting for 'idle' session state**, NOT by pattern matching:

```typescript
// At turn end (finally block)
finally {
  runPhase = 'finally_flush'
  // Flush pending internal events before going idle
  await structuredIO.flushInternalEvents()
  runPhase = 'finally_post_flush'
  if (!isShuttingDown()) {
    notifySessionStateChanged('idle')  // ← EXPLICIT IDLE SIGNAL
    // Drain SDK events before next input
    for (const event of drainSdkEvents()) {
      output.enqueue(event)
    }
  }
  running = false
  // Start idle timer when waiting for input
  idleTimeout.start()
}
```

**File: src/utils/sessionState.ts (state machine)**

```typescript
export type SessionState = 'idle' | 'running' | 'requires_action';

export function notifySessionStateChanged(state: SessionState): void {
  currentState = state;
  // Mirror to SDK event stream (opt-in via env var)
  if (isEnvTruthy(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)) {
    enqueueSdkEvent({
      type: 'system',
      subtype: 'session_state_changed',
      state,
    });
  }
}
```

**Reliability:**
- Deterministic: Fires when run() completes, not dependent on terminal rendering
- Explicitly emitted: Not inferred from absence of output
- Version-stable: Same semantic across Claude Code versions
- Constraint: Only emitted when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`

---

## 6. PERMISSION & TRUST PROMPTS

**Control Request Protocol (src/cli/structuredIO.ts:264+)**

Permissions flow through NDJSON:

```typescript
// Write control_request to stdout
const message: SDKControlRequest = {
  type: 'control_request',
  request_id: requestId,
  request,  // { subtype: 'can_use_tool', tool_name, input, tool_use_id }
};
this.outbound.enqueue(message);

// Wait for control_response from stdin (same request_id)
const response = await new Promise<Response>((resolve, reject) => {
  this.pendingRequests.set(requestId, {
    resolve: (result) => resolve(result),
    reject,
    request,
  });
});
```

**Dedup via resolvedToolUseIds Set (src/cli/structuredIO.ts:175-187):**
```typescript
private trackResolvedToolUseId(request: SDKControlRequest): void {
  if (request.request.subtype === 'can_use_tool') {
    this.resolvedToolUseIds.add(request.request.tool_use_id);
    if (this.resolvedToolUseIds.size > MAX_RESOLVED_TOOL_USE_IDS) {
      // LRU: evict oldest entry
      const first = this.resolvedToolUseIds.values().next().value;
      if (first !== undefined) {
        this.resolvedToolUseIds.delete(first);
      }
    }
  }
}
```

**Trust folder (interactive REPL):** Handled by TrustDialog component at src/interactiveHelpers.tsx:135-139 (shown via Ink, NOT CLI flags).

**Timing for permission prompt navigation:** Not auto-accept; SDK consumer (Claude.ai, VS Code) drives approval flow via stdin control_response.

---

## 7. EXIT & CRASH RECOVERY

**File: src/server/web/pty-server.ts:289-304**

```typescript
function shutdown() {
  console.log("Shutting down...");
  clearInterval(rateLimiterCleanup);
  sessionManager.destroyAll();  // Kill all PTYs
  wss.close(() => {
    server.close(() => {
      console.log("Server closed.");
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);  // 10s grace period
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

**Session cleanup (session-manager.ts:253-264):**
```typescript
pty.onExit(({ exitCode, signal }) => {
  this.wiredPtys.delete(token);
  console.log(
    `[session ${token.slice(0, 8)}] PTY exited: code=${exitCode}, signal=${signal}`,
  );
  const ws = session.ws;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
    ws.close(1000, "PTY exited");
  }
  this.store.destroy(token);
});
```

**Grace period for reconnect (session-manager.ts:203-229):**
```typescript
resume(token: string, ws: WebSocket, cols: number, rows: number): boolean {
  const session = this.store.reattach(token, ws);
  if (!session) return false;
  
  // Cancel grace timer
  console.log(
    `[session ${token.slice(0, 8)}] Resumed (active: ${this.store.size}/${this.maxSessions})`,
  );
  
  // Replay scrollback + resize
  ws.send(JSON.stringify({ type: "resumed", token }));
  const scrollback = session.scrollback.read();
  if (scrollback.length > 0) {
    ws.send(scrollback);
  }
  try {
    session.pty.resize(cols, rows);
  } catch {
    // PTY may have exited
  }
  this.wireWsEvents(token, ws, session.pty);
  return true;
}
```

---

## 8. ANSI STRIPPING & OUTPUT CLEANING

**Handled at UI render layer (Ink), NOT PTY capture:**
- PTY captures raw output (including ANSI codes)
- Scrollback buffer stores raw bytes: `session.scrollback.write(data)`
- ANSI cleaning happens during Ink rendering (theme colors, styled text)
- No explicit stripping in the PTY server path

---

## 9. AUTH APPROACH: OAUTH TOKEN & ENV LAYERING

**File: src/utils/auth.ts**

```typescript
// For non-interactive SSH/remote: CLAUDE_CODE_OAUTH_TOKEN required
if (process.env.ANTHROPIC_UNIX_SOCKET) {
  return !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

// Precedence (checked in order):
// 1. CLAUDE_CODE_OAUTH_TOKEN env var (highest priority)
// 2. CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
// 3. OAuth from file (CCR disk cache)
// 4. ANTHROPIC_API_KEY env var
// 5. apiKeyHelper (config-based key helper)
// 6. None / error

if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  return { source: 'CLAUDE_CODE_OAUTH_TOKEN' as const, hasToken: true };
}
```

**For PTY sessions (pty-server.ts:88-95):**
```typescript
env: {
  ...process.env,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  HOME: home,
  ...(user?.apiKey ? { ANTHROPIC_API_KEY: user.apiKey } : {}),
}
```

**For bridge/daemon (bridge/sessionRunner.ts:306-323):**
```typescript
const env: NodeJS.ProcessEnv = {
  ...deps.env,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,  // ← Strip parent's OAuth
  CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge',
  ...(deps.sandbox && { CLAUDE_CODE_FORCE_SANDBOX: '1' }),
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: opts.accessToken,  // ← Child gets session token
  CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2: '1',
  ...(opts.useCcrV2 && {
    CLAUDE_CODE_USE_CCR_V2: '1',
    CLAUDE_CODE_WORKER_EPOCH: String(opts.workerEpoch),
  }),
};
```

---

## FRAGILITY ASSESSMENT & ROBUSTNESS PROPOSALS

### Currently Fragile (HIGH RISK):

1. **Screen-based bootstrap detection** (not used in SDK mode, but could break if added):
   - Depends on rendering timing, terminal emulation fidelity, TUI version changes
   - PROPOSAL: Already using NDJSON event arrival instead—GOOD DESIGN

2. **Terminal size at spawn time**:
   - If client resizes before sending first WebSocket message, PTY cols/rows may be wrong
   - PROPOSAL: Already supports dynamic resize via `{type: "resize", cols, rows}` messages—GOOD

3. **Session grace period race**:
   - If client reconnects *after* grace timer fires (default 5 min), PTY already killed
   - PROPOSAL: Configurable via GRACE_PERIOD_MS env var; consider longer default or explicit timeout feedback

4. **Control request dedup**:
   - LRU Set evicts after 1000 entries; if >1000 concurrent permission requests, old ones could be re-triggered
   - PROPOSAL: Track by (request_id, tool_use_id) tuple instead; warn at 80% capacity

### Version-Sensitive (MEDIUM RISK):

1. **session_state_changed event**:
   - Only emitted when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` (opt-in feature flag)
   - PROPOSAL: Make it default-on for SDK mode; wrap fallback to activity-based detection

2. **NDJSON message types** (user, assistant, control_request, system):
   - Schema changes across versions could break downstream parsers
   - PROPOSAL: Validate message schema on arrival; log warnings for unknown types

3. **Permission subtype names** ('can_use_tool'):
   - Hardcoded strings in multiple places; renaming would break protocol
   - PROPOSAL: Define as const enum with exhaustive switch validation

### Already Robust (LOW RISK):

1. **Binary input pass-through**: Bracket paste sequences, ctrl chars, raw bytes all handled transparently
2. **PTY exit detection**: Explicit event listener, not timing-based
3. **WebSocket graceful disconnect**: Both sides can recover via resume token
4. **Scrollback replay**: Byte-for-byte capture ensures no content loss on reconnect
5. **Env var injection**: Layered precedence is explicit and documented


### Design implications
- PTY is transparent multiplexer, not a command runner: CLI flags pass via stdin or env vars, not argv. Enables same binary serving multiple sessions with different configs.
- Turn-done detection via reactive state event (idle) rather than proactive pattern matching is architecturally superior—removes timing/rendering dependencies and survives UI version churn.
- Permission flow is bidirectional NDJSON (stdout control_request → stdin control_response) allowing SDK consumer to drive approval, not CLI. Decouples authorization policy from CLI implementation.
- Resume-via-token enables long-lived sessions independent of terminal lifecycle; grace period (5min default) allows reconnect windows for network hiccups without respawn overhead.
- Scrollback buffer (default 100KB) replays on reconnect, creating seamless experience for ephemeral WebSocket connections or client restarts.
- Auth layering (CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY) with env var stripping in child process prevents credential leakage to spawned subprocesses.
- Session-per-user model with per-user home dirs enables isolation and side-by-side multi-tenancy; rate limiting (configurable per-hour quotas) prevents resource exhaustion.
- Idle timeout manager allows graceful shutdown of stale sessions (long-running REPL with no input); prevents PTY zombie accumulation.
- ANSI handling deferred to Ink renderer (not PTY capture) keeps raw output faithful for debugging/logging while rendering cleans up for display.
- no bracketed paste handling in PTY layer means input is maximally transparent; Ink/CLI responsible for paste-vs-keystroke semantics.

### Open questions
- What is the exact timeout between idle notification and killing an idle session? Is it configurable or hardcoded?
- For interactive REPL mode (not SDK), is session_state_changed('idle') event emitted at all, or only for SDK/bridge mode?
- Can the sessionId be re-used across separate REPL invocations, or is it truly session-scoped (unique per instance)?
- What happens if a permission prompt (control_request) is pending when the user sends Ctrl+C? Is it auto-denied or orphaned?
- Are there any benchmarks/SLA guarantees on how fast 'idle' event fires after Claude finishes speaking (latency budget)?
- Can the scrollback buffer size be adjusted per-session, or is it global at 100KB?
- How does the PTY-server handle terminal resize storms (rapid window resizing)? Does it debounce or apply each resize immediately?
- In SDK mode with --replay-user-messages, how are prior tool-result messages integrated? Are they replayed or synthetically reconstructed?


---

## rondelContract

_(spike returned no structured output)_

---

## Auth: daemon interactive Claude Code PTY on Max subscription (no API key) plus Codex

**Confidence:** high

Proven empirically (claude 2.1.169, Max20x) + docs 2026-06-09. CORE FIX: ANTHROPIC_API_KEY outranks the OAuth token and subscription; a stale dead-org key silently bypasses Max (the original breakage) - scrub it.

### Facts
- CONFIRMED empirical: claude auth status = claude.ai/firstParty/max, tier default_claude_max_20x, Keychain creds; ANTHROPIC_API_KEY set makes status show API key active, env -u restores Login method Claude Max account.
- CONFIRMED docs: auth precedence Bedrock/Vertex/Foundry, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKeyHelper, CLAUDE_CODE_OAUTH_TOKEN, subscription; setup-token is subscription, inference-only, one-year, via CLAUDE_CODE_OAUTH_TOKEN; from 2026-06-15 dash-p/Agent SDK use a separate monthly credit (Max20x 200 dollars), interactive keeps the 5h+weekly limits.
- CONFIRMED empirical CODEX: ~/.codex/auth.json auth_mode chatgpt, OPENAI_API_KEY null; codex login status = Logged in using ChatGPT. ASSUMED (not destructively tested): pre-seed hasTrustDialogAccepted true skips the prompt; scrub the env rather than rely on the approval prompt.

### Contracts

SETUP (interactive PTY, Max sub, no API key): 1) Human once: claude auth login --claudeai; verify claude auth status --json gives authMethod claude.ai, apiProvider firstParty, subscriptionType max (creds in macOS Keychain Claude Code-credentials). Headless/no-keychain only: claude setup-token, inject one-year token as CLAUDE_CODE_OAUTH_TOKEN (inference-only, on subscription, NOT API; never with bare mode; not run, opens browser). 2) Pin settings.json forceLoginMethod=claudeai (as managed settings it also hard-blocks API-key/token sessions at startup). 3) Pre-accept trust per dir (only blocking dialog for a daemon interactive launch): ~/.claude.json projects keyed by absolute dir, value hasTrustDialogAccepted=true (binary fn YP3; inherits from an accepted parent; bypass mode also top-level bypassPermissionsModeAccepted=true). 4) Spawn the INTERACTIVE binary (claude, NO dash-p, NO bare mode) under PTY with the scrubbed env. 5) Self-check same env: claude auth status --text must show Login method Claude Max account, or Auth token claude.ai with NO API key line; abort on API key ANTHROPIC_API_KEY.

ENV-SCRUB LIST (the fix) - delete from child env; reason each bypasses subscription: ANTHROPIC_API_KEY (precedence 3, above OAuth(5) and subscription(6); used instead of subscription even if logged in; a stale/dead-org key silently bypasses Max and fails when its billing dies = the original breakage, reproduced empirically); ANTHROPIC_AUTH_TOKEN (precedence 2, sent as Authorization Bearer; leftover gateway token hijacks auth); ANTHROPIC_BASE_URL (reroutes traffic to a proxy/gateway); ANTHROPIC_CUSTOM_HEADERS (can inject auth headers); CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY (precedence 1, force a cloud provider with its own creds and API billing). Do NOT scrub CLAUDE_CODE_OAUTH_TOKEN (headless path, on subscription). Do NOT use bare mode (forces API-key, never reads OAuth/keychain). Ensure no apiKeyHelper in any loaded settings (precedence 4). Build the child env from an ALLOWLIST: keep PATH HOME TERM LANG and CLAUDE_CONFIG_DIR. forceLoginMethod=claudeai is defense-in-depth, not a substitute (only managed settings hard-block).

LIMIT-DETECTION SIGNALS: Primary structured = statusline/hook stdin JSON; rate_limits is OPTIONAL, only present for subscribers after the first API response: rate_limits.five_hour.used_percentage (0 to 100) and .resets_at (unix epoch seconds) for the 5-hour session window; rate_limits.seven_day.used_percentage and .resets_at for the 7-day weekly window (each may be absent); context_window.used_percentage (0 to 100 or null). Soft back-off when five_hour or seven_day used_percentage crosses a threshold such as 90; schedule resume at resets_at. Tolerate missing fields. Secondary text (case-insensitive in PTY screen/transcript/result): usage limit reached; slash upgrade to increase your usage limit; usage credit limit reached (the usage-credit cap, relevant post 2026-06-15); plus API-surfaced 429, rate limited, overloaded, 529, credit balance too low. NOTE Context limit reached is the context window, NOT a usage limit - handle with slash clear or slash compact. Detector: regex the PTY output buffer and the result message; on match stop driving, read resets_at or parse the human reset time, sleep until reset plus jitter, then resume.

WHY interactive PTY: until 2026-06-15 both interactive and dash-p count against the Max 5-hour plus weekly limits; from 2026-06-15 dash-p and Agent SDK draw a SEPARATE monthly Agent SDK credit (Max20x = 200 dollars/mo) and stop counting against interactive limits, while interactive sessions keep the normal 5-hour plus weekly allowance and get NO credit. So driving the interactive PTY stays on the subscription allowance; dash-p would meter against the 200 dollar credit.

CODEX parallel: codex login (no flags) gives ChatGPT-subscription OAuth stored at ~/.codex/auth.json (auth_mode chatgpt, OAuth tokens, OPENAI_API_KEY null), usable to drive sessions; SCRUB OPENAI_API_KEY from the codex child env (a set value flips codex to API-key billing; codex login --with-api-key reads it from stdin); verify scrubbed-env codex login status prints Logged in using ChatGPT.

VERIFIED DOC URLs: code.claude.com/docs/en/iam (precedence 1-6, setup-token, Agent SDK Note); code.claude.com/docs/en/env-vars (ANTHROPIC_API_KEY override wording); code.claude.com/docs/en/settings (forceLoginMethod, apiKeyHelper, managed blocking); code.claude.com/docs/en/costs (rate_limits status line, slash usage); support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan (interactive vs Agent SDK credit, 2026-06-15).


---

## Provider-agnostic abstraction validation: OpenAI Codex CLI (codex-cli 0.130.0) vs cortextOS CodexAppServerPTY

**Confidence:** high

The provider-agnostic abstraction (drive an interactive coding-agent via a side-channel + subscription auth) GENERALIZES to Codex, but NOT through PTY+screen-scrape. cortextOS already proves the clean path: it does NOT drive Codex's TUI by PTY keystrokes. Instead its `CodexAppServerPTY` spawns `codex app-server` (a structured JSON-RPC agent server) under node-pty and speaks JSON-RPC over a Unix-domain socket, exposing the SAME duck-typed surface (spawn/write/kill/onExit/getOutputBuffer/isAlive/getPid) as the Claude `AgentPTY` adapter. So for Codex the best STRUCTURED channel is `codex app-server` (persistent, bidirectional JSON-RPC; thread/turn lifecycle, streaming deltas, token usage, goals, skills, approvals). The best human-like terminal-drive analog is the bare `codex` TUI (PTY-drivable), but it is the WRONG channel here — it leaks (ANSI scraping, no stable event boundaries). For one-shot headless runs `codex exec --json` emits JSONL events but is single-turn (resume re-spawns). Auth: `codex login` uses a ChatGPT subscription; creds live in `~/.codex/auth.json` (`auth_mode` + OAuth `tokens.{id_token,access_token,refresh_token,account_id}`); `OPENAI_API_KEY` is null there and `codex login status` reports "Logged in using ChatGPT". To force subscription, scrub `OPENAI_API_KEY` from the spawned env (and avoid `codex login --with-api-key`). Sessions persist as rollout JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` plus `session_index.jsonl`/`history.jsonl`; resume/fork by UUID or thread-name via `codex resume|fork` and `codex exec resume`. Main leak points: PTY-as-control-channel is a dead end for Codex (use the JSON-RPC server); session identity is a "thread" (thread/start, thread/resume) not a plain session-id; permissions/sandbox are first-class RPC params (approvalPolicy + sandboxPolicy), not interactive y/n prompts; and the inspected ~/.codex is a customized/forked build (has plugins/skills/goals/computer-use/sqlite logs) so some RPC methods like thread/goal/* and skills/* may be non-stock. Confidence high on channel mapping and auth; medium that every cortextOS RPC method exists in stock upstream Codex. No agentic turns were run (quota preserved).

### Facts
- CONFIRMED: `codex --version` => `codex-cli 0.130.0`, binary at /opt/homebrew/bin/codex.
- CONFIRMED: Top-level subcommands include `exec`, `app-server`, `mcp-server`, `remote-control`, `resume`, `fork`, `login`, `review`, `cloud`, `exec-server`. Bare `codex` with no subcommand launches the interactive TUI ('If no subcommand is specified, options will be forwarded to the interactive CLI').
- CONFIRMED: `codex exec --help` shows headless one-shot mode with `--json` (Print events to stdout as JSONL), `-o/--output-last-message <FILE>`, `--output-schema <FILE>` (structured final response), `--ephemeral` (no session files), `--sandbox {read-only,workspace-write,danger-full-access}`, `--dangerously-bypass-approvals-and-sandbox`, and a `resume` subcommand (`codex exec resume [SESSION_ID|--last]`). Prompt can come from arg or stdin.
- CONFIRMED: `codex app-server --help` => '[experimental] Run the app server or related tooling'; `--listen <URL>` supports `stdio://` (default), `unix://`, `unix://PATH`, `ws://IP:PORT`, `off`. Subcommands: `proxy` (proxy stdio bytes to a running app-server control socket via `--sock <SOCKET_PATH>`), `generate-ts`, `generate-json-schema`.
- CONFIRMED: `codex mcp-server` => 'Start Codex as an MCP server (stdio)' — exposes Codex as an MCP server over stdio (alternative structured channel for MCP-native hosts).
- CONFIRMED: `codex remote-control` => '[experimental] Start a headless app-server with remote control enabled'; bare `codex --remote ws://host:port --remote-auth-token-env <ENV>` connects the TUI to a remote app-server websocket.
- CONFIRMED: Auth is ChatGPT subscription. `~/.codex/auth.json` top-level keys: ['auth_mode','OPENAI_API_KEY','tokens','last_refresh']; OPENAI_API_KEY value is null; tokens dict has ['id_token','access_token','refresh_token','account_id']. `codex login status` => 'Logged in using ChatGPT'.
- CONFIRMED: `codex login` supports `--with-api-key` (read key from stdin), `--with-access-token`, `--device-auth`; subcommand `status`. Default browser OAuth login was NOT triggered (avoided).
- CONFIRMED: Sessions persist as rollout JSONL at ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl. Each line is {timestamp,type,payload}. Line types observed: session_meta, turn_context, event_msg, response_item. session_meta.payload keys: [id,timestamp,cwd,originator,cli_version,source,model_provider,base_instructions,git] (originator='codex-tui'). Also ~/.codex/session_index.jsonl ({id,thread_name,updated_at}) and ~/.codex/history.jsonl ({session_id,ts,text}).
- CONFIRMED: event_msg payload.type values seen: task_started (turn_id,model_context_window,collaboration_mode_kind), user_message, token_count (info,rate_limits), agent_message (message,phase,memory_citation), exec_command_end (call_id,process_id,turn_id,command,cwd,parsed_cmd,stdout,stderr,aggregated_output,exit_code,duration,status). response_item payload.type: message(role developer/user/assistant), reasoning, function_call, function_call_output.
- CONFIRMED: Resume/fork. `codex resume [SESSION_ID|thread_name] [--last] [--all] [--include-non-interactive]`; `codex fork [SESSION_ID] [--last]`; `codex exec resume [SESSION_ID|--last]`. SESSION_ID is a UUID or thread name (UUID takes precedence).
- CONFIRMED: cortextOS adapter at /Users/david/Code/cortextos/src/pty/codex-app-server-pty.ts spawns `codex app-server --enable goals --listen unix://./codex.sock` via node-pty and talks JSON-RPC over a WS-framed Unix socket (WsUnixJsonRpcClient). It does NOT send keystrokes to a TUI. Socket default `$CTX_ROOT/state/<agent>/codex.sock`, with /tmp fallback if path >100 bytes (Unix socket limit).
- CONFIRMED: cortextOS JSON-RPC method names used: initialize, initialized(notify), thread/start, thread/resume, thread/list, turn/start, thread/goal/{set,get,clear}, skills/list. Notifications handled: thread/started, thread/status/changed, turn/started, turn/completed, item/agentMessage/delta, item/completed, turn/plan/updated, item/plan/delta, thread/goal/updated, thread/tokenUsage/updated, account/rateLimits/updated, mcpServer/startupStatus/updated, skills/changed, error/warning.
- CONFIRMED: Permissions are RPC params, not interactive prompts. THREAD_PERMISSION_OVERRIDES={approvalPolicy:'never', sandbox:'danger-full-access'}; TURN_PERMISSION_OVERRIDES={approvalPolicy:'never', sandboxPolicy:{type:'dangerFullAccess'}}. Passed into thread/start, thread/resume, turn/start.
- CONFIRMED: Normalized model. /Users/david/Code/cortextos/src/daemon/agent-process.ts:132-136 selects adapter by `config.runtime`: 'hermes'->HermesPTY, 'codex-app-server'->CodexAppServerPTY, else AgentPTY (Claude). Field typed `AgentPTY | CodexAppServerPTY` (duck-typed, same method surface: spawn/write/kill/onExit/isAlive/getPid/getOutputBuffer). README runtime table: claude-code/ClaudePTY, codex-app-server/CodexAppServerPTY (default model gpt-5-codex), hermes/HermesPTY.
- CONFIRMED: Session continuity for codex runtime is tracked by the adapter's own `codex-app-server-thread.json` ({threadId,cwd,updatedAt}) under ctxRoot/state/<agent>/, NOT by scanning Codex rollout files (agent-process.ts:659-676). Thread persistence is by threadId, re-resumed on restart via thread/resume.
- ASSUMED: The inspected ~/.codex is a customized/forked Codex build, not stock upstream OpenAI Codex. Evidence: config.toml model='gpt-5.5' with marketplaces/plugins (browser/documents/spreadsheets/presentations/linear), and ~/.codex contains computer-use/, plugins/, skills/, memories/, logs_2.sqlite, state_5.sqlite, vendor_imports/ — none of which are in stock Codex. The `--enable goals`, thread/goal/*, and skills/* RPC methods are likely build-specific extensions.
- ASSUMED: `codex exec --json` is single-turn per process; multi-turn continuity requires `codex exec resume <id>` which re-spawns the process each turn (consistent with agent-process.ts comment about 'Codex exec-per-turn race'). Not suitable for a long-lived interactive driver; app-server is.
- CONFIRMED: No agentic Codex turns were executed and no browser login triggered — validation used only --help, file inspection, `codex login status`, and cortextOS source.

### Contracts

## Codex → cortextOS normalized-model mapping

| Normalized concept | Claude (reference) | Codex (validated) | Notes / leak |
|---|---|---|---|
| **Control channel** (drive a turn) | PTY keystrokes into `claude` TUI | **`codex app-server` JSON-RPC `turn/start`** over Unix socket. NOT the TUI. | LEAK: PTY-as-control does not generalize. Codex's clean control surface is a structured RPC server, not screen keystrokes. |
| **Structured-event channel** (read output) | `~/.claude/projects/*.jsonl` transcript scrape | **app-server notifications**: `item/agentMessage/delta` (streaming text), `turn/started`/`turn/completed`, `thread/status/changed`, `thread/tokenUsage/updated`, `turn/plan/updated`. Plus persisted **rollout JSONL** at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. | Two-tier: live RPC notifications for real-time, rollout files for after-the-fact replay. Cleaner than Claude's file-only scrape. |
| **Session / resume** | Claude session-id, JSONL presence | **thread** model. Live: `thread/start` → `threadId`; resume `thread/resume {threadId,...}`. CLI: `codex resume\|fork [UUID\|thread_name] [--last]`, `codex exec resume`. Identity persisted by adapter in `codex-app-server-thread.json`. | LEAK: "session" is a "thread"; resume needs explicit threadId tracking, not just file existence. `--include-non-interactive` needed to resume exec sessions. |
| **Tools / permissions** | interactive y/n approval prompts in TUI | **RPC params**: `approvalPolicy` ('never'\|...), `sandbox`/`sandboxPolicy` ({type:'dangerFullAccess'\|'workspaceWrite'\|'readOnly'}) on thread/start & turn/start. CLI: `--sandbox {read-only,workspace-write,danger-full-access}`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`. | LEAK (positive): permissions are declarative/structured, no prompt-scraping needed. Escape hatch: app-server may emit an approval *request* RPC the host must answer (cortextOS replies -32601 to unsupported requests — see handleRpcMessage). |
| **Auth** | ~/.claude creds / subscription | **ChatGPT subscription** via `codex login`; creds in `~/.codex/auth.json` (`auth_mode`, OAuth `tokens`). Scrub `OPENAI_API_KEY` from spawned env to force subscription; do NOT use `codex login --with-api-key`. | Same subscription-auth model as Claude. `--ignore-user-config` still uses CODEX_HOME auth. Set `CODEX_HOME` to isolate per-agent creds. |

## Recommended channels for Codex
- **Control channel: `codex app-server` (JSON-RPC over `unix://` socket)** — persistent process, bidirectional, explicit turn lifecycle. This is the human-equivalent "drive" surface and is far cleaner than the TUI.
- **Structured-event channel: app-server notifications** (primary, real-time) + **rollout JSONL** (`~/.codex/sessions/.../rollout-*.jsonl`, secondary/replay).
- **Avoid**: driving the bare `codex` TUI by PTY keystrokes (ANSI scraping, no stable boundaries). Avoid `codex exec --json` for multi-turn (one-shot per process; resume re-spawns).
- **MCP alternative**: `codex mcp-server` (stdio) if the host is MCP-native, but app-server is richer (goals, skills, plan deltas, token usage).

## Where the abstraction LEAKS (escape hatches needed)
1. **PTY ≠ control channel for Codex.** The abstraction must allow a "structured transport" adapter (JSON-RPC/Unix socket) that satisfies the same duck-typed surface (`spawn/write/kill/onExit/getOutputBuffer/isAlive/getPid`). cortextOS solves this by wrapping the JSON-RPC client behind a class that *looks* like a PTY (`CodexAppServerPTY` reuses `OutputBuffer`, exposes `getPid()=app-server pid`). `write()` is reinterpreted: it buffers until `\r` then maps the line to `turn/start` / local slash-commands rather than raw keystrokes.
2. **Session-id is a thread-id** that must be captured from `thread/start` response and persisted out-of-band; cannot rely on transcript-file presence (a stale Claude JSONL caused a real bug — agent-process.ts:659-666).
3. **Permissions are declarative**, and the server may *push* approval/elevation requests as RPC `method+id` messages the host must answer; needs an explicit responder (cortextOS currently rejects unknown requests with -32601 + an event log — that's the escape hatch slot).
4. **Build variance**: the local ~/.codex is a forked/customized build. `--enable goals`, `thread/goal/*`, `skills/list`, `personality`, `collaboration_mode`, `memory_citation` may be non-stock. For portability, gate these behind capability flags from `initialize` (cortextOS sends `capabilities:{experimentalApi:true}`).
5. **Socket path length** (>100 bytes) breaks Unix sockets → fallback to `/tmp` + a pointer file (resolveSocketPath in codex-app-server-pty.ts:876).

## cortextOS CodexAppServerPTY summary (file: /Users/david/Code/cortextos/src/pty/codex-app-server-pty.ts)
- Spawns `codex app-server --enable goals --listen unix://./codex.sock` under node-pty (PTY only to capture stdout/`[codex-app-server] ready` bootstrap + lifecycle; not for input).
- Connects `WsUnixJsonRpcClient` to the socket; `initialize` → `initialized` → `thread/start|resume` → per-input `turn/start`.
- Turn queue with single-flight `drainQueue`; `turn/completed` resolves a 30-min-timeout completion promise (back-pressure / serialization).
- Streams `item/agentMessage/delta` into OutputBuffer (so downstream consumers see it like terminal output); writes `context_status.json` and appends `codex-tokens.jsonl` from `thread/tokenUsage/updated` for the dashboard cost-parser.
- Local intercepts: `/goal`, `$skill` map to `thread/goal/*` and `skills/list`+skill turn input instead of LLM turns.
- **app-server is the cleaner structured channel than PTY for Codex** — confirmed by cortextOS's own design choice: it deliberately bypasses the TUI and uses JSON-RPC for control + structured notifications for events, while only borrowing the PTY wrapper shape to fit the normalized adapter interface (agent-process.ts:25 types the field `AgentPTY | CodexAppServerPTY`).

## Reproduction commands (non-agentic, used here)
- `codex --version`; `codex --help`; `codex exec --help`; `codex app-server --help`; `codex app-server proxy --help`; `codex mcp-server --help`; `codex remote-control --help`; `codex resume --help`; `codex fork --help`; `codex exec resume --help`; `codex login --help`; `codex login status`.
- Files: `~/.codex/auth.json` (keys only, redacted), `~/.codex/config.toml`, `~/.codex/sessions/.../rollout-*.jsonl`, `~/.codex/session_index.jsonl`, `~/.codex/history.jsonl`.

### Design implications
- Add a 'structured-transport' adapter category to the abstraction: an adapter that satisfies the duck-typed PTY surface (spawn/write/kill/onExit/getOutputBuffer/isAlive/getPid) but backs it with JSON-RPC over a Unix socket. cortextOS proves this is viable; host code never needs to know whether it's keystrokes or RPC.
- Reinterpret write(): buffer until '\r', then route the line to turn/start (or local commands) rather than forwarding raw bytes. This keeps the caller's mental model (type-and-enter) while using the structured channel.
- Track session identity explicitly (threadId from thread/start), persisted out-of-band; never infer 'has prior session' from transcript-file presence for Codex.
- Force subscription auth by scrubbing OPENAI_API_KEY from the spawned env and relying on ~/.codex/auth.json ChatGPT tokens; set CODEX_HOME for per-agent credential isolation.
- Provide an approval-request responder escape hatch: the app-server can push RPC requests (method+id) the host must answer; default to a configurable policy and log unknown requests rather than hanging.
- Gate Codex extension RPCs (goals, skills, personality) behind capability negotiation from initialize, since the local build is customized and stock Codex may not expose them.
- For one-shot/batch use cases prefer `codex exec --json` (+ `--output-schema` for structured final answers); for long-lived interactive driving prefer `codex app-server`. Do not mix: exec is per-process single-turn.
- Handle the Unix-socket 100-byte path limit with a /tmp fallback + pointer file (mirror cortextOS resolveSocketPath).

### Risks
- The inspected ~/.codex is a forked/customized Codex build (gpt-5.5, plugins, skills, goals, computer-use, sqlite logs). Some RPC methods and event types (thread/goal/*, skills/*, personality, collaboration_mode, memory_citation) and config (marketplaces/plugins) may not exist in stock upstream OpenAI Codex — validate against the target build via `codex app-server generate-json-schema` / `generate-ts`.
- app-server is marked '[experimental]' and remote-control is experimental; protocol method names/shapes (thread/start, turn/start) can change between Codex versions. Pin/version-detect via `initialize` clientInfo/capabilities.
- Approval requests may be pushed by the server mid-turn; if the host does not answer (cortextOS replies -32601), a turn could stall or auto-deny. Confirm behavior before relying on approvalPolicy:'never'.
- Subscription quota: app-server turns and exec turns both consume ChatGPT quota — the lightweight validation here deliberately ran NO agentic turns, so live turn/start round-trips, streaming delta cadence, and approval-request emission are UNVERIFIED (reasoned from cortextOS source only).
- codex exec multi-turn via resume re-spawns the process each turn (per agent-process.ts 'exec-per-turn race' comment) — onExit can fire before the next spawn completes; ordering/race handling needed if exec is chosen.
- auth.json access tokens expire (last_refresh field); a long-lived driver must tolerate token refresh, which Codex handles internally but may emit transient auth errors.

### Open questions
- Does stock upstream OpenAI Codex 0.130.0 expose the same app-server JSON-RPC methods (thread/start, turn/start, thread/resume) as this customized build, or are those names build-specific? Resolve via `codex app-server generate-json-schema` / `generate-ts`.
- What exact RPC does the server use to REQUEST an approval/permission elevation (method name + params), and how must the host respond? cortextOS only shows it rejecting unknown requests.
- Is there a documented way to stream events from `codex exec --json` while keeping the process alive for multiple turns, or is app-server the only long-lived option?
- Exact field semantics of thread/tokenUsage/updated (total.totalTokens vs modelContextWindow) across model families for accurate quota/context tracking.
- Does `codex remote-control` / `--remote ws://` provide a supported network transport for the same JSON-RPC, enabling out-of-process drivers without a local Unix socket?


---

