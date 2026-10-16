// CPE24-P4: legacy (port 57374) mappings for session control and the Completion Council. They share the /v1 implementation in
// routes/session_control.ts (fixed action enum, signal files only, same-origin check, audit row). The shim guard (CP token or loopback peer) has already run.
import type { Context } from "hono";
import { isLoopbackHost, peerIsLoopback } from "../auth.ts";
import type { Db } from "../../db/migrate.ts";
import { councilConvergence, councilReport, councilState, councilTranscripts, councilVerdicts, intQ, runControl } from "../routes/session_control.ts";
import { lokiDirOf } from "../routes/cost_ledger.ts";

export function controlMapped(db: Db, repoDir: string): Record<string, (c: Context) => Response> {
  const loki = () => lokiDirOf(repoDir);
  // State-changing legacy calls need a loopback peer AND a loopback Host, like /v1 (no JSON requirement: legacy callers send none).
  const ctl = (action: Parameters<typeof runControl>[2]) => (c: Context) => (peerIsLoopback(c) && isLoopbackHost(c.req.header("host"))
    ? runControl(db, repoDir, action, c, "legacy") : c.json({ error: "loopback only" }, 403));
  // Legacy GETs need a loopback Host too (DNS rebinding), the same isLoopbackHost check /v1 uses.
  const rd = (h: (c: Context) => Response) => (c: Context) => (isLoopbackHost(c.req.header("host")) ? h(c) : c.json({ error: "loopback only" }, 403));
  const mapped: Record<string, (c: Context) => Response> = {
    "POST /api/control/pause": ctl("pause"),
    "POST /api/control/resume": ctl("resume"),
    "POST /api/control/stop": ctl("stop"),
    "POST /api/council/force-review": ctl("council-review"),
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
  for (const k of Object.keys(mapped)) if (k.startsWith("GET ")) mapped[k] = rd(mapped[k]!);
  return mapped;
}
