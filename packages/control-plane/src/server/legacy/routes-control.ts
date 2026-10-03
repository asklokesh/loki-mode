// CPE24-P4: legacy (port 57374) mappings for session control and the Completion Council. They share the /v1 implementation in
// routes/session_control.ts (fixed action enum, signal files only, same-origin check, audit row). The shim guard (CP token or loopback peer) has already run.
import type { Context } from "hono";
import type { Db } from "../../db/migrate.ts";
import { councilConvergence, councilReport, councilState, councilTranscripts, councilVerdicts, intQ, runControl } from "../routes/session_control.ts";
import { lokiDirOf } from "../routes/cost_ledger.ts";

export function controlMapped(db: Db, repoDir: string): Record<string, (c: Context) => Response> {
  const loki = () => lokiDirOf(repoDir);
  return {
    "POST /api/control/pause": (c) => runControl(db, repoDir, "pause", c, "legacy"),
    "POST /api/control/resume": (c) => runControl(db, repoDir, "resume", c, "legacy"),
    "POST /api/control/stop": (c) => runControl(db, repoDir, "stop", c, "legacy"),
    "POST /api/council/force-review": (c) => runControl(db, repoDir, "council-review", c, "legacy"),
    "GET /api/council/state": (c) => c.json(councilState(loki())),
    "GET /api/council/verdicts": (c) => { const n = intQ(c.req.query("limit"), 1000); return n === null || n === 0 ? c.json({ detail: "limit must be 1..1000" }, 422) : c.json(councilVerdicts(loki(), n)); },
    "GET /api/council/convergence": (c) => c.json(councilConvergence(loki())),
    "GET /api/council/report": (c) => c.json(councilReport(loki())),
    "GET /api/council/transcripts": (c) => {
      const limit = intQ(c.req.query("limit"), 200), iterMin = intQ(c.req.query("iter_min"), Number.MAX_SAFE_INTEGER);
      if (limit === null || limit === 0 || iterMin === null) return c.json({ detail: "limit must be 1..200 and iter_min a non-negative integer" }, 422);
      const r = councilTranscripts(loki(), { limit, since: c.req.query("since"), iter_min: iterMin });
      return "error" in r ? c.json({ detail: r.error }, 400) : c.json(r);
    },
  };
}
