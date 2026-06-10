// Ensure node-pty's prebuilt `spawn-helper` is executable. Some node-pty
// prebuilds ship it as 0644, which makes pty.fork() fail with
// "posix_spawnp failed". Resolve node-pty wherever it actually lives (it may be
// hoisted to the consumer's store when claude-wrap is a dependency), not a
// fixed ./node_modules path. (Source builds set perms themselves; no-op then.)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let prebuilds;
try {
  prebuilds = path.join(path.dirname(require.resolve("node-pty/package.json")), "prebuilds");
} catch {
  process.exit(0); // node-pty not resolvable yet — nothing to fix
}

try {
  for (const dir of fs.readdirSync(prebuilds)) {
    if (!dir.startsWith("darwin") && !dir.startsWith("linux")) continue;
    const helper = path.join(prebuilds, dir, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
  console.log("[claude-wrap] spawn-helper executable bit ensured");
} catch {
  /* prebuilds dir absent (source build) — nothing to fix */
}
