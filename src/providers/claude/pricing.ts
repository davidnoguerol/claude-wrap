// Best-effort cost ESTIMATE from token usage. This is NOT the CLI's
// authoritative total_cost_usd (which is stdout-only and unavailable when
// driving the interactive CLI). Prices are USD per million tokens and
// approximate — update as Anthropic pricing changes. Always treat the result
// as an estimate.
import type { UsageEvent } from "../../types.js";

interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per 1M tokens, keyed by a substring matched against the model id.
const PRICES: Array<{ match: RegExp; price: ModelPrice }> = [
  { match: /opus/i, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /sonnet/i, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /haiku/i, price: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 } },
];

const FALLBACK: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** Estimate turn cost in USD from token usage. Returns undefined if the model is
 *  unknown (no point guessing a number with no model context). */
export function estimateCostUsd(model: string | undefined, u: UsageEvent): number | undefined {
  if (!model) return undefined;
  const p = PRICES.find((e) => e.match.test(model))?.price ?? FALLBACK;
  const per = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;
  const cost =
    per(u.inputTokens, p.input) +
    per(u.outputTokens, p.output) +
    per(u.cacheReadTokens, p.cacheRead) +
    per(u.cacheCreationTokens, p.cacheWrite);
  return Math.round(cost * 1e6) / 1e6;
}
