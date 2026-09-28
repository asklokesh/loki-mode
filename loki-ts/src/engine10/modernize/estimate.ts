// loki-ts/src/engine10/modernize/estimate.ts -- M-06: the up-front estimate of cost, wall time and
// risk (docs/v10/MODERNIZE.md section 3.1 "Estimate"), the --budget hard-stop math (section 2, 3.4),
// and the --dry-run print. Pure and deterministic: no model spend, no I/O.
import type { ClusterResult } from "./cluster.ts";

/** Per-unit priors the caller resolves from eta.ts/cost.ts history, or the Legacy-Bench pilot
 *  median (M-27) when there is no history yet. `null` means "not measured": the estimate must
 *  never print $0 or 0s for a quantity nobody has actually measured. */
export interface CostPrior {
  usdPerUnit: number | null;
  p50UnitTimeS: number | null;
}

export interface Estimate {
  units: number;
  waves: number;
  costUsd: number | null;
  wallTimeS: number | null;
  riskHigh: number;
  riskNormal: number;
}

/** Cost: units x per-unit prior. Wall time: critical path (one wave per sequential layer) x
 *  p50 unit time / workers (section 3.1). Risk: count of units cluster.ts flagged highRisk. */
export function estimate(result: ClusterResult, prior: CostPrior, workers: number): Estimate {
  const w = Math.max(1, workers);
  const riskHigh = result.units.filter((u) => u.highRisk).length;
  return {
    units: result.units.length,
    waves: result.waves.length,
    costUsd: prior.usdPerUnit == null ? null : prior.usdPerUnit * result.units.length,
    wallTimeS: prior.p50UnitTimeS == null ? null : (result.waves.length * prior.p50UnitTimeS) / w,
    riskHigh,
    riskNormal: result.units.length - riskHigh,
  };
}

/** Section 2 --budget / section 3.4 caps: "Dispatch stops when spent plus the in-flight estimate
 *  would exceed it." No budget set, or the in-flight cost is unmeasured, never blocks. */
export function budgetExceeded(spentUsd: number, inFlightUsd: number | null, budgetUsd: number | null): boolean {
  if (budgetUsd == null || inFlightUsd == null) return false;
  return spentUsd + inFlightUsd > budgetUsd;
}

function fmtUsd(usd: number | null): string {
  return usd == null ? "not measured" : `$${usd.toFixed(2)}`;
}
function fmtSeconds(s: number | null): string {
  return s == null ? "not measured" : `${Math.round(s)}s`;
}

/** The --dry-run print (section 2: "Prints the unit count, wave plan and estimate, then exits 0"). */
export function formatDryRun(est: Estimate): string {
  return [
    `units: ${est.units}`,
    `waves: ${est.waves}`,
    `cost: ${fmtUsd(est.costUsd)}`,
    `wall time: ${fmtSeconds(est.wallTimeS)}`,
    `risk: ${est.riskHigh} high, ${est.riskNormal} normal`,
  ].join("\n");
}
