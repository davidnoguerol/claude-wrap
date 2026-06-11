// Unit tests for the v0.1.2+ surface: hooks settings shape, forwarder event
// tagging, adapter hook→event mapping, and resume history-skip. Run via
// `npm test` (builds first — modules are imported from dist/).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildHooksSettings } from "../dist/providers/claude/hooks-settings.js";
import { ClaudeCodeAdapter } from "../dist/providers/claude/adapter.js";
import { TranscriptTail } from "../dist/transport/transcript-tail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORWARDER = path.join(ROOT, "bin", "cw-hook-forward.mjs");

// --- buildHooksSettings ---

test("buildHooksSettings registers PostCompact and SessionEnd as async observers", () => {
  const s = buildHooksSettings("/tmp/x.sock");
  for (const ev of ["PostCompact", "SessionEnd", "SessionStart", "Stop", "StopFailure", "PostToolUseFailure"]) {
    const entries = s.hooks[ev];
    assert.ok(Array.isArray(entries) && entries.length > 0, `${ev} registered`);
    for (const entry of entries) {
      for (const h of entry.hooks) {
        assert.equal(h.async, true, `${ev} hook is async`);
        assert.match(h.command, /cw-hook-forward\.mjs/);
      }
    }
  }
});

test("buildHooksSettings emits a statusLine command tagged --event StatusLine", () => {
  const s = buildHooksSettings("/tmp/x.sock");
  assert.equal(s.statusLine.type, "command");
  assert.match(s.statusLine.command, /--event StatusLine$/);
  assert.match(s.statusLine.command, /cw-hook-forward\.mjs/);
});

// --- forwarder tagging ---

/** Start a one-shot unix-socket listener; resolves with the received text. */
function listenOnce(sockPath) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      const chunks = [];
      conn.on("data", (d) => chunks.push(d));
      conn.on("end", () => {
        server.close();
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    server.on("error", reject);
    server.listen(sockPath);
  });
}

function runForwarder(sockPath, stdinText, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FORWARDER, sockPath, ...extraArgs], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", () => resolve(undefined));
    child.stdin.end(stdinText);
  });
}

test("forwarder passes untagged payloads through verbatim", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwtest-"));
  const sock = path.join(dir, "h.sock");
  const received = listenOnce(sock);
  const payload = JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "hi" });
  await runForwarder(sock, payload);
  assert.equal(await received, payload);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forwarder injects hook_event_name for --event tagged payloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwtest-"));
  const sock = path.join(dir, "h.sock");
  const received = listenOnce(sock);
  await runForwarder(sock, JSON.stringify({ context_window: { used_percentage: 42 } }), ["--event", "StatusLine"]);
  const parsed = JSON.parse(await received);
  assert.equal(parsed.hook_event_name, "StatusLine");
  assert.equal(parsed.context_window.used_percentage, 42);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forwarder never overwrites an existing hook_event_name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwtest-"));
  const sock = path.join(dir, "h.sock");
  const received = listenOnce(sock);
  await runForwarder(sock, JSON.stringify({ hook_event_name: "Stop" }), ["--event", "StatusLine"]);
  assert.equal(JSON.parse(await received).hook_event_name, "Stop");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forwarder wraps non-JSON tagged payloads instead of dropping them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwtest-"));
  const sock = path.join(dir, "h.sock");
  const received = listenOnce(sock);
  await runForwarder(sock, "not json at all", ["--event", "StatusLine"]);
  const parsed = JSON.parse(await received);
  assert.equal(parsed.hook_event_name, "StatusLine");
  assert.equal(parsed.raw, "not json at all");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- adapter hook→event mapping (no PTY: drive onHook directly) ---

function makeAdapter() {
  // TS `private` is compile-time only — .mjs tests can reach onHook/cleanup.
  return new ClaudeCodeAdapter({ provider: "claude-code", cwd: os.tmpdir() });
}

test("ready event carries transcriptPath from SessionStart", () => {
  const a = makeAdapter();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwtest-"));
  const tp = path.join(dir, "session.jsonl");
  fs.writeFileSync(tp, "");
  let ready;
  a.on("ready", (e) => {
    ready = e;
  });
  a.onHook({ hook_event_name: "SessionStart", transcript_path: tp, model: "claude-test" });
  assert.ok(ready, "ready fired");
  assert.equal(ready.transcriptPath, tp);
  assert.equal(a.getTranscriptPath(), tp);
  a.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("PostCompact maps to a compaction event with trigger + summary", () => {
  const a = makeAdapter();
  let got;
  a.on("compaction", (e) => {
    got = e;
  });
  a.onHook({ hook_event_name: "PostCompact", trigger: "auto", compact_summary: "the summary" });
  assert.deepEqual(got, { trigger: "auto", summary: "the summary" });
  a.onHook({ hook_event_name: "PostCompact", trigger: "weird" });
  assert.deepEqual(got, { trigger: "unknown", summary: undefined });
  a.cleanup();
});

test("SessionEnd maps to a sessionEnd event with reason", () => {
  const a = makeAdapter();
  let got;
  a.on("sessionEnd", (e) => {
    got = e;
  });
  a.onHook({ hook_event_name: "SessionEnd", reason: "clear" });
  assert.deepEqual(got, { reason: "clear" });
  a.cleanup();
});

test("StatusLine maps context_window fields and tolerates nulls", () => {
  const a = makeAdapter();
  let got;
  a.on("contextStatus", (e) => {
    got = e;
  });
  a.onHook({
    hook_event_name: "StatusLine",
    context_window: { used_percentage: 61.5, remaining_percentage: 38.5, total_input_tokens: 123000, context_window_size: 200000 },
    cost: { total_cost_usd: 1.25 },
  });
  assert.equal(got.usedPercentage, 61.5);
  assert.equal(got.remainingPercentage, 38.5);
  assert.equal(got.totalInputTokens, 123000);
  assert.equal(got.contextWindowSize, 200000);
  assert.equal(got.costUsd, 1.25);
  a.onHook({ hook_event_name: "StatusLine", context_window: { used_percentage: null } });
  assert.equal(got.usedPercentage, undefined);
  a.cleanup();
});

// --- resume history-skip (the post-restart "flood" regression) ---

function assistantLine(text) {
  return JSON.stringify({ type: "assistant", uuid: text, message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
}

test("TranscriptTail.seekToEnd skips pre-existing lines, still reads appends", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwtail-"));
  const tp = path.join(dir, "session.jsonl");
  fs.writeFileSync(tp, assistantLine("history-1") + assistantLine("history-2"));

  const tail = new TranscriptTail(tp);
  const seen = [];
  tail.on("entry", (e) => seen.push(e.uuid));
  tail.seekToEnd(); // resume: ignore everything already on disk
  tail.drain();
  assert.deepEqual(seen, [], "no historical lines emitted after seekToEnd");

  fs.appendFileSync(tp, assistantLine("live-1"));
  tail.drain();
  assert.deepEqual(seen, ["live-1"], "only the appended line emitted");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("TranscriptTail without seekToEnd reads from the top (fresh-session path)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwtail-"));
  const tp = path.join(dir, "session.jsonl");
  fs.writeFileSync(tp, assistantLine("from-top"));

  const tail = new TranscriptTail(tp);
  const seen = [];
  tail.on("entry", (e) => seen.push(e.uuid));
  tail.drain();
  assert.deepEqual(seen, ["from-top"], "existing lines emitted when not seeking");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("adapter resume:true does not re-emit historical assistant text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwres-"));
  const tp = path.join(dir, "session.jsonl");
  // Simulate a resumed session whose JSONL already holds prior turns.
  fs.writeFileSync(tp, assistantLine("old reply A") + assistantLine("old reply B"));

  const a = new ClaudeCodeAdapter({ provider: "claude-code", cwd: os.tmpdir(), resume: true, sessionId: "resume-test" });
  const texts = [];
  a.on("text", (e) => texts.push(e.text));
  a.onHook({ hook_event_name: "SessionStart", transcript_path: tp, model: "claude-test" });
  a.tail.drain(); // force the read the poll timer would have done
  assert.deepEqual(texts, [], "no historical assistant text replayed on resume");

  fs.appendFileSync(tp, assistantLine("fresh reply"));
  a.tail.drain();
  assert.deepEqual(texts, ["fresh reply"], "live assistant text still flows");

  a.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("adapter fresh (resume:false) still reads transcript from the top", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwfresh-"));
  const tp = path.join(dir, "session.jsonl");
  fs.writeFileSync(tp, "");

  const a = new ClaudeCodeAdapter({ provider: "claude-code", cwd: os.tmpdir(), sessionId: "fresh-test" });
  const texts = [];
  a.on("text", (e) => texts.push(e.text));
  a.onHook({ hook_event_name: "SessionStart", transcript_path: tp, model: "claude-test" });
  fs.appendFileSync(tp, assistantLine("first reply"));
  a.tail.drain();
  assert.deepEqual(texts, ["first reply"], "fresh session emits its assistant text");

  a.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});
