// CPE24-P3: legacy (port 57374) mappings for memory, context, focus and tasks. Each reads the same source as its /v1 route (routes/memory.ts)
// and keeps the legacy response shape. The shim's guard (legacyGuard) has already run; POST /api/focus adds the same loopback, JSON and Origin checks as /v1/focus.
import type { Context } from "hono";
import { contextTracking, focusInfo, lokiFor, memoryEconomics, memoryEpisode, memoryEpisodes, memoryPatterns, memorySkills, mutationAllowed, setFocus, tasksList } from "../routes/memory.ts";

export function memoryMapped(repoDir: string): Record<string, (c: Context) => Response | Promise<Response>> {
  const loki = () => lokiFor(repoDir);
  return {
    "GET /api/tasks": (c) => {
      if (c.req.query("project_id") !== undefined) return c.json({ detail: "project_id filter is not supported by the Control Plane" }, 400);
      return c.json(tasksList(loki(), c.req.query("status")));
    },
    "GET /api/memory/episodes": (c) => {
      const lim = c.req.query("limit") === undefined ? 50 : Number(c.req.query("limit"));
      return Number.isInteger(lim) && lim >= 1 && lim <= 1000 ? c.json(memoryEpisodes(loki(), lim)) : c.json({ detail: "limit must be 1..1000" }, 422);
    },
    "GET /api/memory/episodes/{episode_id}": (c) => { const e = memoryEpisode(loki(), c.req.param("episode_id") ?? ""); return e ? c.json(e) : c.json({ detail: "Episode not found" }, 404); },
    "GET /api/memory/patterns": (c) => c.json(memoryPatterns(loki())),
    "GET /api/memory/patterns/{pattern_id}": (c) => { const p = memoryPatterns(loki()).find((x) => x.id === c.req.param("pattern_id")); return p ? c.json(p) : c.json({ detail: "Pattern not found" }, 404); },
    "GET /api/memory/skills": (c) => c.json(memorySkills(loki())),
    "GET /api/memory/economics": (c) => c.json(memoryEconomics(loki())),
    "GET /api/context": (c) => { const r = contextTracking(loki()); return c.json(r.body, r.status); },
    "POST /api/focus": async (c) => {
      if (!mutationAllowed(c)) return c.json({ detail: "loopback JSON requests only" }, 403);
      const body = await c.req.json().catch(() => null);
      const r = setFocus(repoDir, typeof body === "object" && body !== null ? (body as Record<string, unknown>).project_dir : undefined);
      return r.ok ? c.json(focusInfo(repoDir)) : c.json({ detail: r.error }, 400);
    },
  };
}
