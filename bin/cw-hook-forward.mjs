#!/usr/bin/env node
// Tiny hook forwarder shipped with claude-wrap. Registered as the command for
// every observed hook event. Reads the event JSON from stdin, sends it to the
// wrapper's Unix socket, and exits 0. Pure observer: never writes stdout, never
// blocks or alters the turn.
//
// Usage: cw-hook-forward.mjs <socketPath> [--event <name>]
//
// --event tags payloads that carry no hook_event_name of their own (the
// statusLine channel) so the HookSocket consumer can dispatch them uniformly.
// An existing hook_event_name is never overwritten.
import net from "node:net";

const sockPath = process.argv[2];
const eventTag = process.argv[3] === "--event" ? process.argv[4] : undefined;
let data = "";

const done = () => process.exit(0);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  data += c;
});
process.stdin.on("error", done);
process.stdin.on("end", () => {
  if (!sockPath) return done();
  let payload = data;
  if (eventTag) {
    try {
      const obj = JSON.parse(data);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        if (typeof obj.hook_event_name !== "string") obj.hook_event_name = eventTag;
        payload = JSON.stringify(obj);
      } else {
        payload = JSON.stringify({ hook_event_name: eventTag, raw: data });
      }
    } catch {
      payload = JSON.stringify({ hook_event_name: eventTag, raw: data });
    }
  }
  try {
    // Write-then-end with an ack callback so the payload is flushed before exit,
    // rather than racing process teardown.
    const c = net.connect(sockPath, () => {
      c.write(payload, () => c.end());
    });
    c.on("error", done);
    c.on("close", done);
  } catch {
    return done();
  }
  // safety: never linger
  setTimeout(done, 2000);
});
