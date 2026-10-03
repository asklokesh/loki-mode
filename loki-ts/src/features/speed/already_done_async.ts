// loki-ts/src/features/speed/already_done_async.ts -- D61-04: the already-done model check moves off the
// critical path behind LOKI_SPEED=1. Deterministic hits gate it (no hit, no cheap-model call); a hit runs the
// confirmation concurrently with the implement session and, once confirmed, stops that session and reports
// the run as already done. The check's result only counts while implement is in flight: a check that is
// cancelled, late or unconfirmed never changes the verdict, so the cold path stays the reference.
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkAlreadyDone, findEvidence, type AlreadyDoneResult } from "../../engine10/already_done.ts";
import type { RepoMap } from "../../engine10/repomap.ts";
import type { RunContext, SessionResult, TestMap } from "../../engine10/types.ts";
import { speedEnabled } from "../warm.ts";

export { speedEnabled };

/** True only when every path the model was shown exists at baseSha and the live tree still equals it (no edit,
 *  no deletion, no untracked stand-in). The model reads every hit file from the live tree implement is editing,
 *  so a change to ANY hit file, cited or not, means the verdict describes work in flight, not the base. Fails
 *  closed on an empty path list or an empty baseSha. */
export function hitsUnchangedFromBase(repoDir: string, baseSha: string, paths: string[]): boolean {
  if (paths.length === 0 || !baseSha) return false;
  const run = (args: string[]): void => { execFileSync("git", ["--literal-pathspecs", ...args], { cwd: repoDir, stdio: "pipe", env: process.env }); };
  try {
    for (const p of paths) run(["cat-file", "-e", `${baseSha}:${p}`]);
    run(["diff", "--quiet", baseSha, "--", ...paths]);
    return true;
  } catch { return false; }
}

/** Extracts baseSha into a run-owned dir so the confirmation session never reads the live tree implement is
 *  editing. Resolves to the exact path created, or null on any failure (the caller then fails closed). */
function pinBaseTree(ctx: RunContext): Promise<string | null> {
  const dest = join(ctx.runDir, "already-done-base");
  try { rmSync(dest, { recursive: true, force: true }); mkdirSync(dest, { recursive: true }); } catch { return Promise.resolve(null); }
  return new Promise((res) => {
    execFile("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", ctx.repoDir, ctx.baseSha, dest], { env: process.env }, (err) => res(err ? null : dest));
  });
}

/** Starts the background check. `apply` merges a confirmed result into the intake data (the same object the
 *  machine stored). Wraps ctx.sessions so the implement session is linked to the check's verdict. */
export function deferAlreadyDone(
  ctx: RunContext, signal: AbortSignal, task: string, repoMap: RepoMap, testMap: TestMap,
  apply: (r: AlreadyDoneResult) => void,
): void {
  const hits = findEvidence(task, repoMap, testMap, ctx.repoDir);
  if (signal.aborted || hits.length === 0) return;
  const inner = ctx.sessions;
  const check = new AbortController(), impl = new AbortController();
  signal.addEventListener("abort", () => check.abort(), { once: true });
  let phase: "pre" | "run" | "done" = "pre", hit: AlreadyDoneResult | null = null, fired = false;
  const fire = (): void => {
    if (!hit || fired) return;
    const h = hit;
    if (!hitsUnchangedFromBase(ctx.repoDir, ctx.baseSha, [...new Set(hits.map((x) => x.path))])) { hit = null; return; }
    try { apply(h); } catch { hit = null; return; }
    fired = true;
    ctx.emit("already.satisfied", "intake", { evidence: h.evidence, deferred: true });
    impl.abort();
  };
  ctx.sessions = {
    run: async (o) => {
      if (o.stage !== "implement") return inner.run(o);
      phase = "run";
      if (o.signal.aborted) impl.abort(); else o.signal.addEventListener("abort", () => impl.abort(), { once: true });
      fire();
      const res = await inner.run({ ...o, signal: impl.signal });
      phase = "done";
      check.abort();
      if (!fired || !hit) return res;
      return { ...res, exit: 0, killed: false, markers: { ...res.markers, alreadyDone: hit.evidence[0] ?? "" } } as SessionResult;
    },
  };
  void (async () => {
    if (!ctx.baseSha) return;
    const pinned = await pinBaseTree(ctx);
    if (!pinned) { rmSync(join(ctx.runDir, "already-done-base"), { recursive: true, force: true }); return; }
    try {
      const r = await checkAlreadyDone({ ...ctx, repoDir: pinned, sessions: inner }, check.signal, task, repoMap, testMap);
      const ph = phase as string;
      if (r && ph !== "done" && !check.signal.aborted) { hit = r; if (ph === "run") fire(); }
    } catch { /* fail closed */ } finally { rmSync(pinned, { recursive: true, force: true }); }
  })();
}
