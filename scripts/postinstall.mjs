// Ensure node-pty's prebuilt `spawn-helper` is executable. Some node-pty
// prebuilds ship it as 0644, which makes pty.fork() fail with
// "posix_spawnp failed". (Source builds set perms themselves; this is a no-op then.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prebuilds = path.join(root, "node_modules", "node-pty", "prebuilds");

try {
  for (const dir of fs.readdirSync(prebuilds)) {
    if (!dir.startsWith("darwin") && !dir.startsWith("linux")) continue;
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
  console.log("[claude-wrap] spawn-helper executable bit ensured");
} catch {
  // node-pty not installed yet, or built from source — nothing to fix.
}
