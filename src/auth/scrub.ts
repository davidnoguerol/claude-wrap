// Subscription-only auth enforcement.
// HARD REQUIREMENT: the driven CLI must authenticate via the Claude Max
// subscription (claude.ai OAuth / Keychain), NEVER an API key. Claude Code's
// auth precedence puts ANTHROPIC_API_KEY (and cloud-provider creds) ABOVE the
// subscription, so any such var in the child env silently bypasses Max — the
// exact failure that broke the prior setup. We build the child env from the
// inherited env minus those vars (scrub applied LAST, after caller overrides),
// and self-check before driving.
import { execFileSync } from "node:child_process";

const SCRUB = [
  // direct Anthropic API auth / routing
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  // cloud-provider backends (each routes off the subscription onto paid infra)
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
  // nested-session markers: avoid the child treating itself as a sub-session
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
] as const;

/** Build the child env: inherited env + caller overrides, then API/cloud-billing
 *  vars scrubbed LAST so a caller can never re-inject one. CLAUDE_CODE_OAUTH_TOKEN
 *  is intentionally preserved (it IS the subscription token for daemon use). */
export function buildChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (extra) Object.assign(env, extra);
  for (const k of SCRUB) delete env[k];
  if (!env.TERM) env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

export interface AuthStatus {
  ok: boolean;
  method?: string;
  apiProvider?: string;
  subscriptionType?: string;
  detail: string;
}

/** Verify the CLI is authenticated via subscription, NOT an API key. Runs in the
 *  SCRUBBED env and (if given) the session cwd, so a project-local apiKeyHelper /
 *  settings.env that would inject a key is reflected here too. Fails CLOSED. */
export function checkSubscriptionAuth(cliPath: string, env: NodeJS.ProcessEnv, cwd?: string): AuthStatus {
  let raw: string;
  try {
    raw = execFileSync(cliPath, ["auth", "status"], { env, cwd, encoding: "utf8", timeout: 15000 });
  } catch (e) {
    return { ok: false, detail: `auth status failed: ${(e as Error).message}` };
  }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const method = typeof j.authMethod === "string" ? j.authMethod : undefined;
    const apiProvider = typeof j.apiProvider === "string" ? j.apiProvider : undefined;
    const ok = j.loggedIn === true && apiProvider === "firstParty" && method === "claude.ai";
    const sub = typeof j.subscriptionType === "string" ? j.subscriptionType : undefined;
    const email = typeof j.email === "string" ? j.email : "";
    return {
      ok,
      method,
      apiProvider,
      subscriptionType: sub,
      detail: ok ? `subscription ${sub ?? ""} ${email}`.trim() : `not a subscription session: ${raw.trim().slice(0, 200)}`,
    };
  } catch {
    // Fail CLOSED: an unparseable auth response never authorizes a session.
    return { ok: false, detail: `auth status not parseable as JSON (fail-closed): ${raw.trim().slice(0, 200)}` };
  }
}
