// CPE24-P1: legacy (port 57374) mappings for metrics, cost and fleet spend. Each reads the same source as its /v1 route (routes/metrics.ts,
// routes/cost_ledger.ts, routes/fleet.ts) and keeps the legacy response shape. The shim's guard (legacyGuard) has already run.
import type { Context } from "hono";
import { costSnapshot, costTimeline, lokiDirOf } from "../routes/cost_ledger.ts";
import { fleetRuns, fleetSummary, parseInactive } from "../routes/fleet.ts";
import { buildMetricsText } from "../routes/metrics.ts";

export function metricsMapped(repoDir: string): Record<string, (c: Context) => Response> {
  const inactive = (c: Context) => parseInactive(c.req.query("include_inactive"));
  return {
    "GET /api/cost": (c) => c.json(costSnapshot(lokiDirOf(repoDir))),
    "GET /api/cost/timeline": (c) => c.json(costTimeline(lokiDirOf(repoDir))),
    "GET /metrics": (c) => c.text(buildMetricsText(repoDir), 200, { "content-type": "text/plain; charset=utf-8" }),
    // Legacy rows carry the project path; the guarded shim serves only authenticated or loopback callers, like legacy.
    "GET /api/fleet/runs": (c) => c.json(fleetRuns(inactive(c))),
    "GET /api/fleet/summary": (c) => c.json(fleetSummary(inactive(c))),
  };
}
