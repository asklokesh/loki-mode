// PARITY-COST: cost measurement for non-Claude providers (codex, cline, aider) in engine10.
// Claude writes result-cost-<iter>.json itself. These providers do not, so cost.ts read them as "not measured" (usd null),
// which meant the per-run dollar cap (e10ext/budget_cap.ts) never applied. This module writes the SAME result-cost file
// shape (see cost.ts header) so the existing cost event, efficiency record and cap path work unchanged:
//   1. provider-reported dollars (aider "Cost: $X session"): estimated=false
//   2. provider-reported tokens (codex, aider, cline), priced from the table: estimated=true
//   3. prompt/response sizes, priced from the table: estimated=true
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimateTokens, usdFor } from "../providers/price_table.ts";

export interface ParsedUsage { input: number; output: number; cached: number; usd: number | null }

const toNum = (s: string): number => {
  const t = s.replace(/,/g, "").trim().toLowerCase();
  const m = /^([\d.]+)\s*([km])?$/.exec(t);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
};

/** aider: "Tokens: 1.2k sent, 340 received. Cost: $0.01 message, $0.02 session." Token lines sum; the last session figure wins. */
export function parseAiderUsage(text: string): ParsedUsage | null {
  const re = /Tokens:\s*([\d.,]+[km]?)\s*sent(?:,\s*([\d.,]+[km]?)\s*cache write)?(?:,\s*([\d.,]+[km]?)\s*cache hit)?,\s*([\d.,]+[km]?)\s*received\.?(?:\s*Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session)?/gi;
  let input = 0, output = 0, cached = 0, session: number | null = null, any = false, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    any = true;
    const i = toNum(m[1]!), o = toNum(m[4]!), c = m[3] ? toNum(m[3]) : 0;
    if (Number.isFinite(i)) input += i;
    if (Number.isFinite(o)) output += o;
    if (Number.isFinite(c)) cached += c;
    if (m[6]) session = Number(m[6]); // aider's session figure is cumulative: the last one is the total
  }
  return any ? { input, output, cached, usd: session !== null && Number.isFinite(session) ? session : null } : null;
}

/** codex: "Token usage: total=1234 input=1000 (+ 500 cached) output=234" or "tokens used\n12,345" (total only). */
export function parseCodexUsage(text: string): ParsedUsage | null {
  const full = /input=([\d,]+)(?:\s*\(\+\s*([\d,]+)\s*cached\))?\s*output=([\d,]+)/gi;
  let input = 0, output = 0, cached = 0, any = false, m: RegExpExecArray | null;
  while ((m = full.exec(text))) {
    any = true;
    input += toNum(m[1]!) || 0; cached += m[2] ? toNum(m[2]) || 0 : 0; output += toNum(m[3]!) || 0;
  }
  if (any) return { input: input + cached, output, cached, usd: null };
  const total = /tokens used\s*[:\n]\s*([\d,]+)/i.exec(text);
  if (total) {
    const t = toNum(total[1]!);
    if (Number.isFinite(t) && t > 0) { const i = Math.round(t * 0.9); return { input: i, output: t - i, cached: 0, usd: null }; } // total only: the split is a guess
  }
  return null;
}

/** cline: JSON usage such as {"tokensIn":123,"tokensOut":45,"totalCost":0.01}; sums every occurrence. */
export function parseClineUsage(text: string): ParsedUsage | null {
  let input = 0, output = 0, usd = 0, any = false, sawUsd = false;
  for (const m of text.matchAll(/"tokensIn"\s*:\s*(\d+)[^{}]*?"tokensOut"\s*:\s*(\d+)(?:[^{}]*?"totalCost"\s*:\s*([\d.]+))?/g)) {
    any = true; input += Number(m[1]); output += Number(m[2]);
    if (m[3]) { usd += Number(m[3]); sawUsd = true; }
  }
  return any ? { input, output, cached: 0, usd: sawUsd ? usd : null } : null;
}

export function parseUsage(provider: string, text: string): ParsedUsage | null {
  if (provider === "aider") return parseAiderUsage(text);
  if (provider === "codex") return parseCodexUsage(text);
  if (provider === "cline") return parseClineUsage(text);
  return null;
}

export const ESTIMATED_PROVIDERS: ReadonlySet<string> = new Set(["codex", "cline", "aider"]);

export interface ProviderCostRecord {
  total_cost_usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
  model: string; estimated: boolean; cost_basis: "provider-dollars" | "provider-tokens" | "size-estimate";
}

export function buildProviderCost(provider: string, model: string, prompt: string, output: string): ProviderCostRecord | null {
  if (!ESTIMATED_PROVIDERS.has(provider)) return null;
  const u = parseUsage(provider, output);
  if (u && u.usd !== null && u.usd >= 0 && u.input + u.output > 0) {
    return { total_cost_usd: u.usd, input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cached, cache_creation_tokens: 0, model, estimated: false, cost_basis: "provider-dollars" };
  }
  if (u && u.input + u.output > 0) {
    return { total_cost_usd: usdFor(model, u.input, u.output, u.cached), input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cached, cache_creation_tokens: 0, model, estimated: true, cost_basis: "provider-tokens" };
  }
  const i = estimateTokens(prompt), o = estimateTokens(output);
  if (i + o === 0) return null; // nothing ran: stays unmeasured, never a fake zero
  return { total_cost_usd: usdFor(model, i, o), input_tokens: i, output_tokens: o, cache_read_tokens: 0, cache_creation_tokens: 0, model, estimated: true, cost_basis: "size-estimate" };
}

/** Writes result-cost-<iter>.json at dest unless the provider already produced one. Returns the record written, or null. */
export function writeProviderCost(dest: string, provider: string, model: string, prompt: string, output: string): ProviderCostRecord | null {
  if (existsSync(dest)) return null;
  const rec = buildProviderCost(provider, model, prompt, output);
  if (!rec) return null;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(rec));
  return rec;
}
