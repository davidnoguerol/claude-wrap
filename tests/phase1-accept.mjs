// Phase 1 acceptance test — exercises the real AgentSession API against the live
// `claude` CLI on the Max subscription. Verifies the design's Phase 1 criteria.
import { AgentSession } from "../dist/index.js";
import { buildChildEnv, checkSubscriptionAuth } from "../dist/auth/scrub.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "/Users/david/Code/claude-wrap";
const SCRATCH = path.join(REPO, "phase1-scratch");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const CLAUDE = execFileSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).trim();

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Criterion 5: a stale ANTHROPIC_API_KEY must be scrubbed, auth still subscription ----
process.env.ANTHROPIC_API_KEY = "sk-ant-bogus-DEADBEEF-should-be-ignored";
const childEnv = buildChildEnv();
check("scrub removes ANTHROPIC_API_KEY from child env", !("ANTHROPIC_API_KEY" in childEnv));
const auth = checkSubscriptionAuth(CLAUDE, childEnv);
check("auth resolves to subscription despite stale key", auth.ok, auth.detail);
// leave the bogus key set in process.env so the live sessions below also prove scrubbing

const ev = { toolUse: [], toolResult: [], turnComplete: null, ready: null, error: [], text: [] };
const s = new AgentSession({
  provider: "claude-code",
  cwd: REPO,
  model: "sonnet",
  permission: { mode: "acceptEdits" },
  allowedTools: ["Write", "Read", "Bash", "Edit"],
});
s.on("ready", (e) => (ev.ready = e));
s.on("text", (e) => ev.text.push(e));
s.on("toolUse", (e) => ev.toolUse.push(e));
s.on("toolResult", (e) => ev.toolResult.push(e));
s.on("turnComplete", (e) => (ev.turnComplete = e));
s.on("error", (e) => ev.error.push(e));

let sid = "";
try {
  await s.start();
  check("start() resolved on ready (subscription)", !!ev.ready, ev.ready ? `sid=${ev.ready.sessionId} model=${ev.ready.model}` : "");
  sid = s.getSessionId();
  await sleep(2500); // let the Ink REPL settle before first input (mirrors probe timing)

  await s.send(
    "Use your tools to do ALL three steps: (1) Write a file at phase1-scratch/probe.txt containing exactly PHASE1_OK. (2) Read phase1-scratch/probe.txt back. (3) Run the bash command: echo phase1-bash-ok . Then reply with exactly PHASE1_DONE."
  );
  const dl = Date.now() + 90000;
  while (!ev.turnComplete && Date.now() < dl) await sleep(500);

  check("turnComplete fired", !!ev.turnComplete);
  if (ev.turnComplete) {
    check("stopReason == end_turn", ev.turnComplete.stopReason === "end_turn", ev.turnComplete.stopReason);
    check("final text contains PHASE1_DONE", /PHASE1_DONE/.test(ev.turnComplete.text), JSON.stringify(ev.turnComplete.text).slice(0, 80));
  }
  check("text event(s) fired (response path)", ev.text.length > 0 && ev.text.some((t) => /PHASE1_DONE/.test(t.text)), `${ev.text.length} text events`);
  const names = ev.toolUse.map((t) => t.name);
  check("toolUse seen for Write+Read+Bash", ["Write", "Read", "Bash"].every((n) => names.includes(n)), names.join(","));
  check("toolResult count >= toolUse count (>0)", ev.toolResult.length >= ev.toolUse.length && ev.toolResult.length > 0, `use=${ev.toolUse.length} result=${ev.toolResult.length}`);
  check("all toolResults ok", ev.toolResult.length > 0 && ev.toolResult.every((r) => r.ok), ev.toolResult.map((r) => `${r.name}:${r.ok}`).join(","));
  const u = ev.turnComplete?.usage;
  check("usage tokens present (deduped sum)", !!u && (u.inputTokens > 0 || u.outputTokens > 0), u ? `in=${u.inputTokens} out=${u.outputTokens} cacheR=${u.cacheReadTokens} cacheC=${u.cacheCreationTokens}` : "none");
  check("probe.txt written with PHASE1_OK", fs.existsSync(path.join(SCRATCH, "probe.txt")) && fs.readFileSync(path.join(SCRATCH, "probe.txt"), "utf8").includes("PHASE1_OK"));

  // ---- Criterion 4: resume keeps prior context ----
  await s.stop();
  await sleep(1500);
  const s2 = new AgentSession({
    provider: "claude-code",
    cwd: REPO,
    model: "sonnet",
    sessionId: sid,
    resume: true,
    permission: { mode: "acceptEdits" },
    allowedTools: ["Write", "Read", "Bash", "Edit"],
  });
  let tc2 = null;
  s2.on("turnComplete", (e) => (tc2 = e));
  await s2.start();
  await sleep(2500);
  check("resume: same sessionId", s2.getSessionId() === sid);
  await s2.send("Without using any tools, what is the exact path of the file you created earlier in this conversation? Reply with just that path.");
  const dl2 = Date.now() + 90000;
  while (!tc2 && Date.now() < dl2) await sleep(500);
  check("resume: turn completed", !!tc2);
  check("resume: remembers earlier file (context intact)", !!tc2 && /probe\.txt/.test(tc2.text), tc2 ? JSON.stringify(tc2.text).slice(0, 100) : "none");
  await s2.stop();
} catch (e) {
  check("no fatal error during run", false, e?.message ?? String(e));
  try { await s.stop(); } catch { /* */ }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n===== PHASE 1 ACCEPTANCE: ${passed}/${results.length} checks passed =====`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(passed === results.length ? 0 : 1);
