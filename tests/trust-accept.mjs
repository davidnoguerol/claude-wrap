// Verify trust auto-accept: an AgentSession in a FRESH untrusted temp dir must
// clear the folder-trust dialog on its own, reach ready, and complete a turn.
import { AgentSession } from "../dist/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-trust-accept-"));
const results = [];
const check = (n, ok, d = "") => {
  results.push(!!ok);
  console.log(`${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = new AgentSession({ provider: "claude-code", cwd: dir, model: "sonnet", permission: { mode: "bypassPermissions" } });
let tc = null;
let ready = null;
s.on("turnComplete", (e) => (tc = e));
s.on("ready", (e) => (ready = e));
s.on("error", (e) => console.log("[err]", e.message, "fatal=" + e.fatal));

const t0 = Date.now();
try {
  await s.start();
  check("auto-accepted trust + reached ready (untrusted cwd)", !!ready, `${((Date.now() - t0) / 1000).toFixed(1)}s sid=${ready?.sessionId}`);
  await sleep(2000);
  await s.send("Reply with exactly the token: TRUST_OK . Do not use any tools.");
  const dl = Date.now() + 60000;
  while (!tc && Date.now() < dl) await sleep(500);
  check("turn completed", !!tc, tc ? `stop=${tc.stopReason}` : "");
  check("response contains TRUST_OK", !!tc && /TRUST_OK/.test(tc.text), tc ? JSON.stringify(tc.text).slice(0, 50) : "none");
  await s.stop();
} catch (e) {
  check("no fatal error", false, e?.message ?? String(e));
  try { await s.stop(); } catch { /* */ }
}
fs.rmSync(dir, { recursive: true, force: true });
const passed = results.filter(Boolean).length;
console.log(`\n===== TRUST AUTO-ACCEPT: ${passed}/${results.length} =====`);
process.exit(passed === results.length ? 0 : 1);
