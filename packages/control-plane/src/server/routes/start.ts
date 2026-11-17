// CPE-07: POST /v1/runs (and the /v1/start alias) starts a run. Registered on the loopback-only router, so a non-loopback bind never has it.
import type { Context } from "hono";
import { isLoopbackHost } from "../auth.ts";
import { audit } from "../audit.ts";
import { basename, resolve } from "node:path";
import { planStart, registryRepos, spawnStart } from "../spawn.ts";
import { repoPathsByName } from "../repos.ts";
import type { RouteCtx } from "./index.ts";

/** A browser always sends Origin on a cross-site POST. Absent is a non-browser client (allowed, the peer check still applies); present must be a loopback http(s) origin. */
export function originOk(origin: string | undefined | null): boolean {
  if (origin === undefined || origin === null) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.host);
  } catch { return false; }
}

export function mount(ctx: RouteCtx): void {
  const { act, db, repoDir, local } = ctx;
  const inflight = new Set<string>();
  const handler = async (c: Context) => {
    if (!local(c)) return c.json({ error: "loopback JSON requests only" }, 403);
    if (!originOk(c.req.header("origin"))) return c.json({ error: "origin not allowed" }, 403);
    const text = await c.req.text();
    if (text.length > 20_000) return c.json({ error: "body too large" }, 413);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const target = typeof (body as { target?: unknown } | null)?.target === "string" ? (body as { target: string }).target : undefined;
    // The dashboard sends the repository's name as it shows it (the GitHub name). When no known folder has that name, the name is resolved through the
    // checkouts Loki has seen and the origins their runs recorded; one match becomes the path, several stay ambiguous, none is refused as before.
    const b = body as { repo?: unknown } | null, known = [repoDir, ...registryRepos()];
    if (b && typeof b.repo === "string" && b.repo !== "" && !b.repo.includes("/") && !known.some((k) => basename(resolve(k)) === b.repo)) {
      const hits = repoPathsByName(db, b.repo);
      if (hits.length === 1) { known.push(hits[0]!); b.repo = hits[0]!; }
      else if (hits.length > 1) { audit(db, { kind: "run.start", target, result: "refused", detail: `${hits.length} checkouts match ${b.repo}` }); return c.json({ error: `${hits.length} checkouts on this machine belong to ${b.repo}; start the run from the one you mean with loki start` }, 400); }
    }
    const plan = planStart(body, known, ctx.startBin);
    if (!plan.ok) { audit(db, { kind: "run.start", target, result: "refused", detail: plan.error }); return c.json({ error: plan.error }, 400); }
    if (inflight.has(plan.cwd)) { audit(db, { kind: "run.start", target, result: "conflict", detail: "start already in flight" }); return c.json({ error: "a run is already starting or running in this repo" }, 409); }
    inflight.add(plan.cwd);
    const r = await (ctx.spawnImpl ?? spawnStart)(plan.argv, plan.cwd, () => inflight.delete(plan.cwd), plan.env);
    if ("error" in r) { inflight.delete(plan.cwd); audit(db, { kind: "run.start", target, result: "error", detail: r.error }); return c.json({ error: r.error }, 500); }
    audit(db, { kind: "run.start", target, result: "started", detail: `pid ${r.pid}; ${plan.argv.slice(1).join(" ")}` });
    return c.json({ ok: true, pid: r.pid, command: plan.argv.slice(1).join(" ") });
  };
  act.post("/v1/runs", handler);
  act.post("/v1/start", handler);
}
