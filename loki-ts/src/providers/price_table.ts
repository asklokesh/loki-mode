// PARITY-COST: per-model USD price table (per 1M tokens) used ONLY to estimate cost for providers whose CLI
// does not print a dollar figure (codex, cline, aider). Anything priced from this table is flagged estimated=true.
// The Claude path never reads this file; it keeps using runner/budget.ts and provider-reported dollars.

export interface Price { input: number; output: number; cachedInput?: number }

/** USD per 1M tokens. Longest-substring match, case-insensitive. Update as vendors publish new prices. */
export const PRICE_TABLE: Readonly<Record<string, Price>> = Object.freeze({
  "gpt-5.3-codex": { input: 1.75, output: 14.0, cachedInput: 0.175 },
  "gpt-5-codex": { input: 1.25, output: 10.0, cachedInput: 0.125 },
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

export function priceFor(model: string | null | undefined): { price: Price; matched: boolean } {
  const m = (model ?? "").toLowerCase();
  let best = "";
  for (const k of Object.keys(PRICE_TABLE)) if (m.includes(k) && k.length > best.length) best = k;
  return best ? { price: PRICE_TABLE[best]!, matched: true } : { price: DEFAULT_PRICE, matched: false };
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
