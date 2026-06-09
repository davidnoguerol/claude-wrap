// Phase 2 robustness test. Unit checks for the auth-safety fixes (no live CLI),
// then one live session exercising the double-start guard, interrupt() unwedging
// busy->ready, resend-after-interrupt, and clean stop.
import { AgentSession } from "../dist/index.js";
import { buildChildEnv } from "../dist/auth/scrub.js";

const REPO = "/Users/david/Code/claude-wrap";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Unit: auth scrub is the final word ----
process.env.ANTHROPIC_API_KEY = "sk-ant-stale";
process.env.AWS_ACCESS_KEY_ID = "AKIA-stale";
process.env.CLAUDE_CODE_USE_BEDROCK = "1";
const env = buildChildEnv({ ANTHROPIC_API_KEY: "sk-ant-reinjected-by-caller" });
check("caller cannot re-inject ANTHROPIC_API_KEY (scrub runs last)", !("ANTHROPIC_API_KEY" in env));
check("AWS_ACCESS_KEY_ID scrubbed", !("AWS_ACCESS_KEY_ID" in env));
check("CLAUDE_CODE_USE_BEDROCK scrubbed", !("CLAUDE_CODE_USE_BEDROCK" in env));

// ---- Unit: constructor guards ----
let badId = false;
try {
  new AgentSession({ provider: "claude-code", cwd: REPO, sessionId: "bad id with spaces" });
} catch {
  badId = true;
}
check("invalid sessionId rejected", badId);

let badProvider = false;
try {
  new AgentSession({ provider: "codex", cwd: REPO });
} catch {
  badProvider = true;
}
check("unimplemented provider rejected", badProvider);

// ---- Live: double-start guard, interrupt unwedge, resend, stop ----
const s = new AgentSession({
  provider: "claude-code",
  cwd: REPO,
  model: "sonnet",
  permission: { mode: "acceptEdits" },
  allowedTools: ["Bash", "Read", "Write", "Edit"],
});
let tc = null;
s.on("turnComplete", (e) => (tc = e));
s.on("error", (e) => console.log("   [error event]", e.message, "fatal=" + e.fatal));

try {
  await s.start();
  check("started (ready)", s.getState() === "ready", s.getState());

  let doubleStart = false;
  try {
    await s.start();
  } catch {
    doubleStart = true;
  }
  check("double start() rejected", doubleStart);

  await sleep(2500);
  await s.send("Run the bash command: sleep 20 — it will block for 20 seconds. Do nothing else until it finishes.");
  await sleep(4000);
  check("state is busy during long turn", s.getState() === "busy", s.getState());

  await s.interrupt();
  await sleep(3000);
  check("interrupt() unwedged busy->ready", s.getState() === "ready", s.getState());

  tc = null;
  await s.send("Reply with exactly: AFTER_INTERRUPT");
  const dl = Date.now() + 60000;
  while (!tc && Date.now() < dl) await sleep(500);
  check("can send a new turn after interrupt", !!tc && /AFTER_INTERRUPT/.test(tc.text || ""), tc ? JSON.stringify(tc.text).slice(0, 60) : "none");

  await s.stop();
  check("state is stopped after stop()", s.getState() === "stopped");
} catch (e) {
  check("no fatal error during live run", false, e?.message ?? String(e));
  try { await s.stop(); } catch { /* */ }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n===== PHASE 2 ROBUSTNESS: ${passed}/${results.length} checks passed =====`);
process.exit(passed === results.length ? 0 : 1);
