// CPE-13: GET /v1/stats/cost?group=day,model,repo,provider&since=. Computed from the runs table only.
// Measured = every session priced (cost_usd set). Partial = some sessions priced, run total unknown (partial_usd counts only the priced ones).
// Unmeasured = no priced session (subscription or local provider): never summed as 0.
import { gte } from "drizzle-orm";
import { runs } from "../../db/schema.ts";
import { effectiveVerdict, SUCCESS_VERDICTS } from "../integrity.ts";
import type { RouteCtx } from "./index.ts";

export const COST_DIMS = ["day", "model", "repo", "provider"] as const;
type CostDim = (typeof COST_DIMS)[number];

/** D82: API-key runs default to a $100 per-run cap; subscription runs have no dollar cap. loki.yaml budgets.per_run and --max-cost override. */
export const DEFAULT_API_KEY_CAP_USD = 100;

const NONE = "unknown";
type Run = typeof runs.$inferSelect;
type Acc = { key: Record<string, string>; runs: number; measured_runs: number; partial_runs: number; unmeasured_runs: number; measured_usd: number; partial_usd: number; input_tokens: number; output_tokens: number };
const mk = (key: Record<string, string>): Acc => ({ key, runs: 0, measured_runs: 0, partial_runs: 0, unmeasured_runs: 0, measured_usd: 0, partial_usd: 0, input_tokens: 0, output_tokens: 0 });
const add = (a: Acc, r: Run) => {
  a.runs++;
  if (r.costUsd !== null) { a.measured_runs++; a.measured_usd += r.costUsd; }
  else if (r.measuredSessions > 0) { a.partial_runs++; a.partial_usd += r.partialUsd; }
  else a.unmeasured_runs++;
  a.input_tokens += r.inputTokens;
  a.output_tokens += r.outputTokens;
};
const dimVal = (d: CostDim, r: Run): string =>
  d === "day" ? (r.startedAt ? r.startedAt.slice(0, 10) : NONE) : d === "model" ? (r.model ?? NONE) : d === "provider" ? (r.provider ?? NONE) : (r.originRepo ?? NONE);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const out = (a: Acc) => ({ ...a.key, runs: a.runs, measured_runs: a.measured_runs, partial_runs: a.partial_runs, unmeasured_runs: a.unmeasured_runs, measured_usd: round(a.measured_usd), partial_usd: round(a.partial_usd), input_tokens: a.input_tokens, output_tokens: a.output_tokens });

export function mount(ctx: RouteCtx): void {
  // B8: per-repo breakdown. total_usd sums measured runs only (never invents a zero); avg_usd is over measured runs; verified = plain attested success display verdict.
  ctx.app.get("/v1/cost/repos", (c) => {
    const g = new Map<string, { runs: number; priced: number; usd: number; verified: number }>();
    for (const r of ctx.db.select().from(runs).all()) {
      const k = r.originRepo ?? "(unknown)";
      const a = g.get(k) ?? { runs: 0, priced: 0, usd: 0, verified: 0 };
      a.runs++;
      if (r.costUsd !== null) { a.priced++; a.usd += r.costUsd; }
      const ev = effectiveVerdict({ verdict: r.verdict, tampered: r.tampered === 1, attested: r.attested === 1, sig_checked: r.sigChecked === 1 });
      if (ev !== null && SUCCESS_VERDICTS.has(ev)) a.verified++;
      g.set(k, a);
    }
    const rows = [...g.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([repo, a]) => ({
      repo, runs: a.runs, total_usd: round(a.usd), avg_usd: a.priced ? round(a.usd / a.priced) : null,
      verified_runs: a.verified, usd_per_verified: a.verified ? round(a.usd / a.verified) : null,
    }));
    return c.json({ rows });
  });
  ctx.app.get("/v1/stats/cost", (c) => {
    const dims = (c.req.query("group") ?? "day").split(",").map((s) => s.trim()).filter(Boolean) as CostDim[];
    if (dims.length === 0 || dims.some((d) => !COST_DIMS.includes(d))) {
      return c.json({ error: `group must be a comma list of ${COST_DIMS.join(", ")}` }, 400);
    }
    const since = c.req.query("since");
    if (since !== undefined && Number.isNaN(Date.parse(since))) return c.json({ error: "since must be an ISO date" }, 400);
    const q = ctx.db.select().from(runs);
    const all = since ? q.where(gte(runs.startedAt, since)).all() : q.all();

    const groups = new Map<string, Acc>();
    const total = mk({});
    let priced = 0, unpriced = 0;
    for (const r of all) {
      const key: Record<string, string> = {};
      for (const d of dims) key[d] = dimVal(d, r);
      const id = dims.map((d) => key[d]).join("\u0000");
      let g = groups.get(id);
      if (!g) { g = mk(key); groups.set(id, g); }
      add(g, r);
      add(total, r);
      if (r.measuredSessions > 0) priced++; else unpriced++;
    }
    const rows = [...groups.values()].map(out).sort((a, b) => {
      for (const d of dims) {
        const x = (a as Record<string, unknown>)[d] as string, y = (b as Record<string, unknown>)[d] as string;
        if (x !== y) return d === "day" ? y.localeCompare(x) : x.localeCompare(y);
      }
      return 0;
    });
    const { runs: n, ...rest } = out(total);
    return c.json({
      group: dims, since: since ?? null, rows,
      totals: { runs: n, ...rest },
      // A run with at least one priced session ran on an API key; one with none ran on a subscription or local provider.
      budget: { api_key_default_cap_usd: DEFAULT_API_KEY_CAP_USD, subscription_cap: null, api_key_runs: priced, subscription_runs: unpriced },
    });
  });
}
