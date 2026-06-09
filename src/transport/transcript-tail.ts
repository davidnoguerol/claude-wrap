// Live tailer for the session transcript JSONL. Polls for size growth, reads
// only the delta through a streaming UTF-8 decoder (so a multibyte char split
// across a read boundary isn't corrupted), buffers partial trailing lines, and
// emits one parsed object per complete line. Tolerates unknown line types (the
// interactive transcript carries more types than headless) and parse errors.
//
// drain() performs one synchronous read+flush on demand — used at turn boundary
// so the final assistant line's usage/stop_reason are ingested before the Stop
// hook is acted on (the hook can beat the poll timer).
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";

export interface TranscriptEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  message?: { id?: string; role?: string; content?: unknown; stop_reason?: string | null; usage?: unknown };
  [k: string]: unknown;
}

export class TranscriptTail extends EventEmitter {
  private offset = 0;
  private buf = "";
  private decoder = new StringDecoder("utf8");
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly filePath: string, private readonly intervalMs = 200) {
    super();
  }

  start(): void {
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      this.drain();
      this.timer = setTimeout(tick, this.intervalMs);
    };
    tick();
  }

  /** One synchronous read of any newly-appended bytes + flush of complete lines.
   *  Idempotent: offset only advances; usage entries dedupe by message.id upstream. */
  drain(): void {
    try {
      const st = fs.statSync(this.filePath);
      if (st.size < this.offset) {
        // truncated / rotated — restart from the top
        this.offset = 0;
        this.buf = "";
        this.decoder = new StringDecoder("utf8");
      }
      if (st.size > this.offset) {
        const fd = fs.openSync(this.filePath, "r");
        try {
          const len = st.size - this.offset;
          const b = Buffer.allocUnsafe(len);
          const read = fs.readSync(fd, b, 0, len, this.offset);
          this.offset += read;
          this.buf += this.decoder.write(b.subarray(0, read));
        } finally {
          fs.closeSync(fd);
        }
        this.flushLines();
      }
    } catch {
      /* file may not exist yet; keep polling */
    }
  }

  private flushLines(): void {
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const t = line.trim();
      if (!t) continue;
      try {
        this.emit("entry", JSON.parse(t) as TranscriptEntry);
      } catch {
        this.emit("bad", t);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
