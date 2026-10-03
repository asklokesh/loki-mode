// CPE-25 merge queue and CPE-26 PR risk. The CLI is the source of truth: each route runs `loki merge ...` or `loki review --risk --json`
// with execFile and a fixed argv array (no shell), a timeout and an output cap, in the selected repo. Nothing is reimplemented here.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Context } from "hono";
import { audit } from "../audit.ts";
import { childEnv, registryRepos } from "../spawn.ts";
import { isLoopbackHost } from "../auth.ts";
import { originOk } from "./start.ts";
import type { RouteCtx } from "./index.ts";

const PR = /^[0-9]{1,7}$/;
const REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,99}$/;
const MAX_OUT = 256 * 1024;
const MAX_PRS = 20;

export interface CliResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; capped: boolean; error?: string }

/** Tunables, exported so tests can pin the production values and inject a short timeout. */
export const limits = { mergeRunMs: 600_000, dryRunMs: 60_000, shortMs: 15_000, riskMs: 60_000, graceMs: 2_000, bodyMax: 5_000, maxConcurrent: 2 };

const killGroup = (pid: number | undefined, sig: NodeJS.Signals): void => {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { /* group already gone */ }
};

/** Run the CLI with a fixed argv, detached in its own process group so a timeout or output-cap kill reaches every descendant. Never rejects. */
export function runCli(bin: string, args: string[], cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((done) => {
    let out = "", err = "", size = 0, timedOut = false, capped = false, settled = false, spawnErr: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, hard: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hard) clearTimeout(hard);
      const error = spawnErr ?? (timedOut ? "timed out" : capped ? "output exceeded the size cap" : undefined);
      done({ code: timedOut || capped ? null : code, stdout: out, stderr: err, timedOut, capped, error });
    };
    try {
      const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false, env: { ...childEnv(), ...extraEnv }, windowsHide: true });
      const stop = (): void => {
        killGroup(child.pid, "SIGTERM");
        hard = setTimeout(() => { killGroup(child.pid, "SIGKILL"); finish(null); }, limits.graceMs);
      };
      const take = (which: "o" | "e") => (d: Buffer): void => {
        if (capped) return;
        size += d.length;
        if (size > MAX_OUT) { capped = true; stop(); return; }
        if (which === "o") out += d.toString("utf8"); else err += d.toString("utf8");
      };
      child.stdout!.on("data", take("o"));
      child.stderr!.on("data", take("e"));
      child.once("error", (e) => { spawnErr = e.message; finish(null); });
      child.once("close", (code) => { killGroup(child.pid, "SIGKILL"); finish(code); });
      timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    } catch (e) { spawnErr = (e as Error).message; finish(null); }
  });
}

export interface RiskReport { score: number; level: string; source: string; files: number | null; factors: Array<{ factor: string; points: number; max: number; detail: string }> }

/** Parse `loki review --risk --json`. Anything that is not a well-formed 0-100 report is null (the caller says "not measured"). */
export function parseRisk(out: string): RiskReport | null {
  try {
    const j = JSON.parse(out.trim()) as Record<string, unknown>;
    const factors = j["factors"];
    if (typeof j["score"] !== "number" || !Number.isFinite(j["score"]) || j["score"] < 0 || j["score"] > 100 || !Array.isArray(factors)) return null;
    const fs = factors.map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>) : {}));
    if (!fs.every((f) => typeof f["factor"] === "string" && typeof f["points"] === "number" && typeof f["max"] === "number")) return null;
    return {
      score: j["score"], level: typeof j["level"] === "string" ? j["level"] : "unknown", source: typeof j["source"] === "string" ? j["source"] : "",
      files: typeof j["files"] === "number" && Number.isFinite(j["files"]) && j["files"] >= 0 ? j["files"] : null,
      factors: fs.map((f) => ({ factor: f["factor"] as string, points: f["points"] as number, max: f["max"] as number, detail: typeof f["detail"] === "string" ? f["detail"] : "" })),
    };
  } catch { return null; }
}

export function mount(ctx: RouteCtx): void {
  const { act, db } = ctx;
  const bin = () => ctx.startBin ?? process.env["LOKI_BIN"] ?? "loki";
  const busy = new Set<string>();
  const active = { run: 0, queue: 0, risk: 0 };
  const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

  /** The repo must be one the server knows (cwd or the project registry), never an arbitrary path. Returns the REAL path so every lock and cwd is symlink-proof. */
  const repoFor = (want: unknown): string | null => {
    if (want === undefined || want === null || want === "") return real(ctx.repoDir);
    if (typeof want !== "string" || want.includes("\0")) return null;
    const known = new Map<string, string>();
    for (const k of [ctx.repoDir, ...registryRepos()]) { const r = real(k); if (r) known.set(r, basename(resolve(k))); }
    const wantReal = real(want);
    if (wantReal && known.has(wantReal)) return wantReal;
    const named = [...known].filter(([r, label]) => label === want || basename(r) === want).map(([r]) => r);
    return named.length === 1 ? named[0]! : null;
  };
  /** Small per-route cap on concurrent CLI spawns. */
  const slot = async <T,>(c: Context, kind: "run" | "queue" | "risk", auditKind: string, fn: () => Promise<T>): Promise<T | Response> => {
    if (active[kind] >= limits.maxConcurrent) { audit(db, { kind: auditKind, result: "refused", detail: "too many concurrent requests" }); return c.json({ error: "too many concurrent requests" }, 429); }
    active[kind]++;
    try { return await fn(); } finally { active[kind]--; }
  };
  const refuse = (c: Context, kind: string, target: string | undefined, status: 400 | 403 | 413 | 422, error: string) => {
    audit(db, { kind, target, result: "refused", detail: error });
    return c.json({ error }, status);
  };
  /** Shared guard for mutating calls: loopback JSON, loopback Origin, bounded JSON body. */
  const readBody = async (c: Context, kind: string): Promise<Record<string, unknown> | Response> => {
    if (!ctx.local(c)) return refuse(c, kind, undefined, 403, "loopback JSON requests only");
    if (!originOk(c.req.header("origin"))) return refuse(c, kind, undefined, 403, "origin not allowed");
    const text = await c.req.text();
    if (text.length > limits.bodyMax) return refuse(c, kind, undefined, 413, "body too large");
    try {
      const b = JSON.parse(text) as unknown;
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : refuse(c, kind, undefined, 400, "body must be a JSON object");
    } catch { return refuse(c, kind, undefined, 400, "invalid JSON"); }
  };

  /** Spawning reads (no body, so no JSON check): loopback peer AND loopback Host, so DNS rebinding cannot drive a CLI spawn. Origin is checked after. */
  const readGuard = (c: Context): boolean => ctx.peerIsLoopback(c) && isLoopbackHost(c.req.header("host"));

  act.get("/v1/merge/queue", async (c) => {
    if (!readGuard(c)) return refuse(c, "merge.list", undefined, 403, "loopback only");
    if (!originOk(c.req.header("origin"))) return refuse(c, "merge.list", undefined, 403, "origin not allowed");
    const cwd = repoFor(c.req.query("repo"));
    if (!cwd) return refuse(c, "merge.list", undefined, 422, "repo is not a known project");
    return slot(c, "queue", "merge.list", async () => {
      const r = await runCli(bin(), ["merge", "list"], cwd, limits.shortMs);
      if (r.code !== 0) return c.json({ measured: false, error: r.error ?? `loki merge list exited ${r.code}`, queue: [] });
      const queue = r.stdout.split("\n").map((l) => /^#([0-9]{1,7})$/.exec(l.trim())?.[1]).filter((n): n is string => n !== undefined).map(Number);
      return c.json({ measured: true, queue });
    });
  });

  act.post("/v1/merge/queue", async (c) => {
    const b = await readBody(c, "merge.add");
    if (b instanceof Response) return b;
    const raw = Array.isArray(b["prs"]) ? (b["prs"] as unknown[]) : b["pr"] !== undefined ? [b["pr"]] : [];
    const prs = raw.map((p) => (typeof p === "number" && Number.isInteger(p) ? String(p) : p));
    if (prs.length === 0 || prs.length > MAX_PRS || !prs.every((p) => typeof p === "string" && PR.test(p))) return refuse(c, "merge.add", undefined, 422, `prs must be 1 to ${MAX_PRS} PR numbers (digits only, 7 max)`);
    const cwd = repoFor(b["repo"]);
    if (!cwd) return refuse(c, "merge.add", undefined, 422, "repo is not a known project");
    const list = prs as string[];
    return slot(c, "queue", "merge.add", async () => {
      const r = await runCli(bin(), ["merge", "add", ...list], cwd, limits.shortMs);
      const ok = r.code === 0;
      const error = ok ? undefined : (r.error ?? (r.stderr.trim() || `exit ${r.code}`));
      audit(db, { kind: "merge.add", target: list.map((p) => `#${p}`).join(" "), result: ok ? "ok" : "error", detail: error });
      return c.json({ ok, exit: r.code, output: r.stdout.trim(), error }, ok ? 200 : 500);
    });
  });

  // dryRun is required and must be a boolean: a missing flag never silently becomes a real merge.
  act.post("/v1/merge/run", async (c) => {
    const b = await readBody(c, "merge.run");
    if (b instanceof Response) return b;
    if (typeof b["dryRun"] !== "boolean") return refuse(c, "merge.run", undefined, 422, "dryRun must be a boolean");
    const dry = b["dryRun"];
    const kind = dry ? "merge.dry_run" : "merge.run";
    const cwd = repoFor(b["repo"]);
    if (!cwd) return refuse(c, kind, undefined, 422, "repo is not a known project");
    if (!dry && busy.has(cwd)) { audit(db, { kind, result: "conflict", detail: "merge already running" }); return c.json({ error: "a merge run is already in progress for this repo" }, 409); }
    return slot(c, "run", kind, async () => {
      if (!dry) busy.add(cwd);
      try {
        const ms = dry ? limits.dryRunMs : limits.mergeRunMs;
        // The CLI polls checks per PR; keep its own budget well inside the route timeout so it ends itself before the group kill.
        const poll = 20, tries = Math.max(1, Math.floor((ms / 1000) * 0.8 / poll));
        const r = await runCli(bin(), dry ? ["merge", "run", "--dry-run"] : ["merge", "run"], cwd, ms, { LOKI_MERGE_POLL_S: String(poll), LOKI_MERGE_MAX_POLLS: String(tries) });
        const lines = r.stdout.split("\n").filter(Boolean);
        // Only exit 1 means "PRs left in the queue" (a result). Any other non-zero exit, a timeout or a cap kill is an error.
        const noGh = /gh CLI is required/.test(r.stdout + r.stderr);
        const ran = (r.code === 0 || r.code === 1) && !noGh;
        if (!dry) for (const l of lines) { const m = /^#([0-9]{1,7}): merged$/.exec(l.trim()); if (m) audit(db, { kind: "merge.pr_merged", target: `#${m[1]}`, result: "ok", detail: r.timedOut ? "recorded before timeout" : undefined }); }
        const reason = r.timedOut ? "merge run timed out; the outcome is partial, check the queue and the PRs" : r.capped ? "merge run output exceeded the size cap and was stopped; the outcome is partial" : noGh ? "the gh CLI is required and was not found; nothing was merged" : r.error ?? (!ran ? `loki merge run exited ${r.code}: ${r.stderr.trim().slice(0, 300)}` : undefined);
        audit(db, { kind, result: !ran ? "error" : r.code === 0 ? "ok" : "blocked", detail: reason ?? lines.slice(-1)[0] });
        return c.json({ ok: r.code === 0, ran, dryRun: dry, exit: r.code, lines, timedOut: r.timedOut, capped: r.capped, partial: r.timedOut || r.capped, error: reason }, ran ? 200 : 500);
      } finally { if (!dry) busy.delete(cwd); }
    });
  });

  act.get("/v1/review/risk", async (c) => {
    if (!readGuard(c)) return refuse(c, "risk.read", undefined, 403, "loopback only");
    if (!originOk(c.req.header("origin"))) return refuse(c, "risk.read", undefined, 403, "origin not allowed");
    const pr = c.req.query("pr"), since = c.req.query("since"), staged = c.req.query("staged");
    const given = [pr !== undefined, since !== undefined, staged !== undefined].filter(Boolean).length;
    if (given !== 1) return refuse(c, "risk.read", undefined, 422, "give exactly one of pr, since or staged=1");
    let flags: string[], target: string;
    if (pr !== undefined) {
      if (!PR.test(pr)) return refuse(c, "risk.read", undefined, 422, "pr must be digits only (7 max)");
      flags = ["--pr", pr]; target = `#${pr}`;
    } else if (since !== undefined) {
      if (!REF.test(since)) return refuse(c, "risk.read", undefined, 422, "since must match [A-Za-z0-9._/-]{1,100} with no leading -");
      flags = ["--since", since]; target = `since ${since}`;
    } else {
      if (staged !== "1") return refuse(c, "risk.read", undefined, 422, "staged must be 1");
      flags = ["--staged"]; target = "staged";
    }
    const cwd = repoFor(c.req.query("repo"));
    if (!cwd) return refuse(c, "risk.read", target, 422, "repo is not a known project");
    return slot(c, "risk", "risk.read", async () => {
      const r = await runCli(bin(), ["review", "--risk", "--json", ...flags], cwd, limits.riskMs);
      const parsed = r.code === 0 ? parseRisk(r.stdout) : null;
      if (!parsed) return c.json({ measured: false, reason: r.error ?? (r.code !== 0 ? `loki review exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}` : "output was not a risk report") });
      return c.json({ measured: true, ...parsed });
    });
  });
}
