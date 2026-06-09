#!/usr/bin/env node
// Tiny hook forwarder shipped with claude-wrap. Registered as the command for
// every observed hook event. Reads the event JSON from stdin, sends it to the
// wrapper's Unix socket, and exits 0. Pure observer: never writes stdout, never
// blocks or alters the turn. Usage: cw-hook-forward.mjs <socketPath>
import net from "node:net";

const sockPath = process.argv[2];
let data = "";

const done = () => process.exit(0);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  data += c;
});
process.stdin.on("error", done);
process.stdin.on("end", () => {
  if (!sockPath) return done();
  try {
    // Write-then-end with an ack callback so the payload is flushed before exit,
    // rather than racing process teardown.
    const c = net.connect(sockPath, () => {
      c.write(data, () => c.end());
    });
    c.on("error", done);
    c.on("close", done);
  } catch {
    return done();
  }
  // safety: never linger
  setTimeout(done, 2000);
});
