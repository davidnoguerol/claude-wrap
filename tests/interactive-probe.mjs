// Phase 0 gate: drive a REAL interactive `claude` under a PTY and confirm that
// hooks fire + transcript is written the same way as the headless spikes found.
// This is a throwaway probe, not product code. It must always exit (timeout-guarded).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const pty = require('node-pty');

const CLAUDE = '/Users/david/.local/bin/claude';
const REPO = '/Users/david/Code/claude-wrap';
const SCRATCH = path.join(REPO, 'phase0-scratch');
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const SID = '7b3e1a90-1111-4a2b-8c3d-c0ffeeba5e01';
const EVENTS = path.join(SCRATCH, 'hook-events.jsonl');
const RAW = path.join(SCRATCH, 'pty-raw.log');
const SETTINGS = path.join(SCRATCH, 'hooks-settings.json');
fs.writeFileSync(EVENTS, '');
fs.writeFileSync(RAW, '');

// Pure-observer hook: append the single-line stdin JSON event to EVENTS, exit 0, no stdout.
const fwd = `cat >> ${EVENTS}; printf '\\n' >> ${EVENTS}`;
const obs = [{ type: 'command', command: fwd }];
const settings = {
  hooks: {
    SessionStart:       [{ hooks: obs }],
    UserPromptSubmit:   [{ hooks: obs }],
    PreToolUse:         [{ matcher: '*', hooks: obs }],
    PostToolUse:        [{ matcher: '*', hooks: obs }],
    PostToolUseFailure: [{ matcher: '*', hooks: obs }],
    Stop:               [{ hooks: obs }],
    StopFailure:        [{ hooks: obs }],
  },
};
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

// Subscription-only: scrub API-key + nested-session env from the child.
const env = { ...process.env };
for (const k of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_EXECPATH']) delete env[k];
env.TERM = 'xterm-256color';
env.COLORTERM = 'truecolor';

const args = ['--session-id', SID, '--settings', SETTINGS, '--permission-mode', 'acceptEdits', '--model', 'sonnet'];

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = (...a) => console.log('[probe ' + stamp() + ']', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '').replace(/\x1B[=>]/g, '');
const readEvents = () => { try { return fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { _bad: l.slice(0, 80) }; } }); } catch { return []; } };
const names = () => readEvents().map((e) => e.hook_event_name || e._bad || '?');

log('spawn:', CLAUDE, args.join(' '));
const term = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: REPO, env });
let out = '';
let exited = false;
term.onData((d) => { out += d; try { fs.appendFileSync(RAW, d); } catch {} });
term.onExit((e) => { exited = true; log('PTY exited', JSON.stringify(e)); });

(async () => {
  await sleep(5000);
  log('t+5s clearing any trust/onboarding dialog (Enter). hooks:', names().join(',') || '(none)');
  term.write('\r');
  await sleep(2500);

  const prompt = 'Using your tools, create a file at phase0-scratch/probe.txt containing exactly PROBE_OK, then read it back, then reply with exactly: PHASE0_DONE';
  log('injecting prompt via bracketed paste. hooks:', names().join(',') || '(none)');
  term.write('\x1b[200~' + prompt + '\x1b[201~');
  await sleep(400);
  term.write('\r');

  await sleep(6000);
  log('post-inject check. hooks:', names().join(',') || '(none)');

  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && !exited) {
    const n = names();
    if (n.includes('Stop') || n.includes('StopFailure')) { log('turn-complete hook seen'); break; }
    await sleep(1500);
  }
  if (Date.now() >= deadline) log('TIMEOUT waiting for Stop');
  await sleep(2000); // let trailing transcript/metadata flush

  try { term.write('\x03'); await sleep(300); term.write('/exit\r'); await sleep(800); } catch {}
  try { if (!exited) term.kill(); } catch {}
  await sleep(500);

  // ---------- REPORT ----------
  const events = readEvents();
  const byType = {};
  for (const e of events) { const n = e.hook_event_name || e._bad || '?'; byType[n] = (byType[n] || 0) + 1; }
  let tpath = '';
  try { tpath = execSync(`find ${process.env.HOME}/.claude/projects -name "${SID}.jsonl" 2>/dev/null`).toString().trim().split('\n')[0] || ''; } catch {}
  const lineTypes = {}; const stopReasons = [];
  if (tpath && fs.existsSync(tpath)) {
    for (const l of fs.readFileSync(tpath, 'utf8').split('\n').filter(Boolean)) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      lineTypes[o.type] = (lineTypes[o.type] || 0) + 1;
      if (o.type === 'assistant' && o.message && o.message.stop_reason) stopReasons.push(o.message.stop_reason);
    }
  }
  const trim = (o) => { const s = JSON.stringify(o); return s.length > 600 ? s.slice(0, 600) + '…' : s; };
  const ss = events.find((e) => e.hook_event_name === 'SessionStart');
  const ptu = events.filter((e) => e.hook_event_name === 'PostToolUse');
  const stop = events.find((e) => e.hook_event_name === 'Stop' || e.hook_event_name === 'StopFailure');

  console.log('\n================ PHASE 0 REPORT ================');
  console.log('PTY exited cleanly:', exited);
  console.log('Hook events:', events.length, JSON.stringify(byType));
  console.log('Hook order:', events.map((e) => e.hook_event_name || e._bad || '?').join(' -> '));
  console.log('SessionStart fired:', !!ss, ss ? '| payload: ' + trim(ss) : '');
  console.log('PostToolUse count:', ptu.length, '| tools:', ptu.map((e) => e.tool_name).join(','));
  if (ptu[0]) console.log('  PostToolUse[0]:', trim(ptu[0]));
  console.log('Turn-complete:', stop ? stop.hook_event_name : 'NONE', stop ? '| last_assistant_message=' + JSON.stringify(stop.last_assistant_message) : '');
  if (stop) console.log('  transcript_path:', stop.transcript_path);
  console.log('Transcript located:', tpath || 'NOT FOUND');
  console.log('Transcript line types:', JSON.stringify(lineTypes));
  console.log('Assistant stop_reasons:', stopReasons.join(',') || '(none)');
  console.log('--- raw PTY (ANSI-stripped, last 1500 chars) ---');
  console.log(stripAnsi(out).slice(-1500));
  console.log('================ END REPORT ================');
  process.exit(0);
})();
