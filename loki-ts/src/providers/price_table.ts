// PARITY-COST: per-model USD price table (per 1M tokens) used ONLY to estimate cost for providers whose CLI
// does not print a dollar figure (codex, cline, aider). Anything priced from this table is flagged estimated=true.
// The Claude path never reads this file; it keeps using runner/budget.ts and provider-reported dollars.

import { readFileSync, statSync } from "node:fs";

export interface Price { input: number; output: number; cachedInput?: number }

/** USD per 1M tokens. Longest-substring match, case-insensitive. Update as vendors publish new prices. */
export const PRICE_TABLE: Readonly<Record<string, Price>> = Object.freeze({
  "gpt-5.3-codex": { input: 1.75, output: 14.0, cachedInput: 0.175 },
  "gpt-5-codex": { input: 1.25, output: 10.0, cachedInput: 0.125 },
  // Mini and nano tiers: OpenAI API pricing page https://openai.com/api/pricing/ (per 1M tokens).
  // Longest-substring match means these must exist or "gpt-5-mini" resolves to the full "gpt-5" entry.
  "gpt-5-mini": { input: 0.25, output: 2.0, cachedInput: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "gpt-5": { input: 1.25, output: 10.0, cachedInput: 0.125 },
  "gpt-4.1": { input: 2.0, output: 8.0, cachedInput: 0.5 },
  "gpt-4o": { input: 2.5, output: 10.0, cachedInput: 1.25 },
  "o4-mini": { input: 1.1, output: 4.4, cachedInput: 0.275 },
  "o3": { input: 2.0, output: 8.0, cachedInput: 0.5 },
  "claude-opus": { input: 4.0, output: 20.0, cachedInput: 0.2 },
  "claude-sonnet": { input: 2.0, output: 10.0, cachedInput: 0.1 },
  "claude-haiku": { input: 0.1, output: 0.5, cachedInput: 0.01 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini": { input: 1.25, output: 10.0 },
  "deepseek": { input: 0.28, output: 0.42 },
  "minimax": { input: 0.3, output: 1.2 },
});

/** Used when the model is unknown: a mid-range price so the cap still bites, flagged estimated by the caller. */
export const DEFAULT_PRICE: Price = { input: 2.0, output: 10.0, cachedInput: 0.2 };

function validPrice(v: unknown): Price | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!ok(o.input) || !ok(o.output)) return null;
  if (o.cachedInput !== undefined && !ok(o.cachedInput)) return null;
  return o.cachedInput === undefined ? { input: o.input, output: o.output } : { input: o.input, output: o.output, cachedInput: o.cachedInput };
}

let overrideCache: { key: string; table: Record<string, Price> } | null = null;

/**
 * LOKI_PRICE_TABLE=<json file> overrides or extends PRICE_TABLE (keys matched case-insensitively as substrings).
 * A missing, unreadable or non-object file falls back to the built-in table; invalid entries are skipped.
 */
function effectiveTable(): Readonly<Record<string, Price>> {
  const file = process.env.LOKI_PRICE_TABLE;
  if (!file) return PRICE_TABLE;
  try {
    const key = `${file}:${statSync(file).mtimeMs}`;
    if (overrideCache?.key === key) return overrideCache.table;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return PRICE_TABLE;
    const table: Record<string, Price> = { ...PRICE_TABLE };
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const p = validPrice(v);
      if (p && k) table[k.toLowerCase()] = p;
    }
    overrideCache = { key, table };
    return table;
  } catch {
    return PRICE_TABLE;
  }
}

export function priceFor(model: string | null | undefined): { price: Price; matched: boolean } {
  const m = (model ?? "").toLowerCase();
  const table = effectiveTable();
  let best = "";
  for (const k of Object.keys(table)) if (m.includes(k) && k.length > best.length) best = k;
  return best ? { price: table[best]!, matched: true } : { price: DEFAULT_PRICE, matched: false };
}

/** Rough token count: about 4 characters per token. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** Non-finite or negative token counts clamp to 0. */
function tokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function usdFor(model: string | null | undefined, inputTokens: number, outputTokens: number, cachedInputTokens = 0): number {
  const { price } = priceFor(model);
  const input = tokens(inputTokens);
  const cached = Math.min(tokens(cachedInputTokens), input); // cached tokens are a subset of input
  const fresh = input - cached;
  const usd = (fresh * price.input + cached * (price.cachedInput ?? price.input) + tokens(outputTokens) * price.output) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
