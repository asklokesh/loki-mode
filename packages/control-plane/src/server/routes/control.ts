// CPE-09 run control: POST /v1/runs/:source/:run/stop | retry | resume. Loopback-only (registered on `act`, real peer checked by ctx.local), every action audited.
// stop signals only the pid recorded in <run dir>/run.pid after three checks (see verifyRunPid); it never kills by name or pattern.
// retry and resume spawn `loki` through the same argv-only, stripped-env path as /v1/start (spawnStart).
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { verifyRunPid } from "../../../../../loki-ts/src/engine10/run_pid.ts";
import { localRepos, runs } from "../../db/schema.ts";
import { planStart, spawnStart } from "../spawn.ts";
import { blockedQuestion, defaultAnswerDir } from "../answer.ts";
import { audit } from "../audit.ts";
import { loadEvents } from "../runs.ts";
import type { RouteCtx } from "./index.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const busy = new Set<string>();

export function mount(ctx: RouteCtx): void {
  const { act, db } = ctx;
  const bin = ctx.startBin ?? "loki", spawnIt = ctx.spawnImpl ?? spawnStart, answerDir = ctx.answerDir ?? defaultAnswerDir();
  type Done = (status: 200 | 400 | 404 | 409 | 500 | 501, result: string, body: Record<string, unknown>, detail?: string) => Response;

  const guarded = (kind: "stop" | "retry" | "resume", handler: (a: { source: string; run: string; repo: string; runDir: string }, done: Done) => Promise<Response> | Response) =>
    act.post(`/v1/runs/:source/:run/${kind}`, async (c) => {
      if (!ctx.local(c)) return c.json({ error: "loopback JSON requests only" }, 403);
      const source = c.req.param("source"), id = c.req.param("run"), target = `${source}/${id}`;
      const done: Done = (status, result, body, detail) => { audit(db, { kind: `run.${kind}`, target, result, detail }); return c.json(body, status); };
      if (!ID.test(source) || !ID.test(id) || source.includes("..") || id.includes("..")) return done(400, "refused", { error: "invalid run id" }, "invalid id");
      const repoRow = db.select().from(localRepos).where(eq(localRepos.sourceId, source)).get();
      let repo = "";
      try { repo = repoRow ? realpathSync(repoRow.realpath) : ""; } catch { repo = ""; }
      if (!repo) return done(404, "refused", { error: "this run's repo is not known on this machine" });
      const runsRoot = join(repo, ".loki", "runs"), runDir = resolve(runsRoot, id);
      if (!runDir.startsWith(runsRoot + sep)) return done(400, "refused", { error: "invalid run id" }, "path escape");
      return handler({ source, run: id, repo, runDir }, done);
    });

  guarded("stop", (a, done) => {
    const v = verifyRunPid(a.runDir, a.run);
    if (!v.ok) return done(409, "refused", { error: v.reason }, v.reason);
    try { process.kill(v.pid, "SIGTERM"); } catch (e) { return done(500, "error", { error: `could not signal the run: ${(e as Error).message}` }); }
    return done(200, "ok", { ok: true, pid: v.pid }, `SIGTERM pid ${v.pid}`);
  });

  const launch = async (a: { repo: string }, argv: string[], done: Done, env: Record<string, string> = {}): Promise<Response> => {
    if (busy.has(a.repo)) return done(409, "refused", { error: "a run is already starting or running in this repo" });
    busy.add(a.repo);
    const r = await spawnIt(argv, a.repo, () => busy.delete(a.repo), env);
    if ("error" in r) { busy.delete(a.repo); return done(500, "error", { error: r.error }); }
    return done(200, "ok", { ok: true, pid: r.pid, command: argv.slice(1).join(" ") }, argv.slice(1).join(" "));
  };

  // loki has no `retry` command: retry is a fresh `loki start` of the same issue ref (or the recorded task text), never the original argv.
  guarded("retry", (a, done) => {
    if (verifyRunPid(a.runDir, a.run).ok) return done(409, "refused", { error: "this run is still running; stop it first" });
    const row = db.select().from(runs).where(and(eq(runs.sourceId, a.source), eq(runs.runId, a.run))).get();
    if (!row) return done(404, "refused", { error: "run not found" });
    const task = loadEvents(db, a.source, a.run).find((e) => e.type === "stage.completed" && e.stage === "intake")?.data.task;
    const target = row.issueRef || (typeof task === "string" ? task : "");
    const plan = target ? planStart({ target, repo: a.repo }, [a.repo], bin) : null;
    if (!plan || !plan.ok) return done(501, "unsupported", { error: `retry is not supported for this run: ${plan ? plan.error : "no issue ref or task text was recorded"}` });
    return launch(a, plan.argv, done, plan.env);
  });

  // resume = `loki answer <run>`: engine10 has no in-place resume, the answer rides into a fresh run (loki-ts/src/features/blocked_answer.ts).
  guarded("resume", (a, done) => {
    if (verifyRunPid(a.runDir, a.run).ok) return done(409, "refused", { error: "this run is still running" });
    const row = db.select().from(runs).where(and(eq(runs.sourceId, a.source), eq(runs.runId, a.run))).get();
    if (!row) return done(404, "refused", { error: "run not found" });
    if (!blockedQuestion(loadEvents(db, a.source, a.run), row.verdict)) return done(409, "refused", { error: "run is not BLOCKED, so there is nothing to resume" });
    if (!existsSync(join(answerDir, a.source, `${a.run}.answer.txt`))) return done(409, "refused", { error: "no answer recorded for this run; answer it first" });
    return launch(a, [bin, "answer", a.run], done);
  });
}
