// In-session fix rounds. One owner for the Stop hook the claude SDK route installs (providers.ts) and for choosing which checks it runs (engine10 implement stage).
// A failing check blocks the stop and goes back into the SAME session instead of a separate fix session. The round cap is per query() call: a resumed or retried session gets its own rounds.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { classifyCheck, commandFor, goRunner } from "../util/check_result.ts";
import { loadProjectApi } from "../project_model/resolve.ts";
import { installOwned } from "../project_model/install.ts";
import { guessRunner } from "../engine10/testmap.ts";
import { harnessLoadReason } from "./load_owner.ts";
import type { TestMap, TestRef } from "../engine10/types.ts";

export interface StopCheck { cwd: string; cmd: string; args: string[]; protect?: boolean } // protect: a Wall test, never harness-owned (as in verify)
export interface StopChecksSpec { checks: StopCheck[]; rounds: number; budgetS: number; repoDir: string; baseSha: string; installCreated?: unknown }
export const STOP_CHECK_ROUNDS = 2, STOP_CHECK_MAX = 4, STOP_CHECK_BUDGET_S = 120, STOP_HOOK_MARGIN_S = 30;

/** Test paths the intake baseline run recorded as failing on the untouched tree; a stop must never be blocked by a failure the code did not cause. Unreadable profile: none. */
function redOnBase(repoDir: string): string[] {
  try { const b = (JSON.parse(readFileSync(join(repoDir, ".loki", "state", "repo-profile.json"), "utf8")) as { baseline?: { failing_ids?: unknown } }).baseline; return Array.isArray(b?.failing_ids) ? b.failing_ids.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
/** The checks to run at Stop, returned as a SessionRunOptions fragment (empty when none): the sealed Wall tests first (runner resolved as verify resolves it), then the impacted tests, at most 4 that exist, run under the project interpreter and not red on base. Off with LOKI_E10_STOP_CHECKS=0. The budget is a quarter of the stage limit at most. */
export function planStopChecks(repoDir: string, outputs: Record<string, any> | undefined, impacted: ReadonlySet<string>, stageLimitS: number, baseSha: string, env: NodeJS.ProcessEnv = process.env): { stopChecks?: StopChecksSpec } {
  try {
    const map = outputs?.intake?.testmap as TestMap | undefined;
    if (env["LOKI_E10_STOP_CHECKS"] === "0" || !map) return {};
    const rel = (p: string): string => (isAbsolute(p) ? relative(repoDir, p) : p);
    const wall = ((outputs?.wall?.files as { path: string; runner?: TestRef["runner"] }[] | undefined) ?? []).flatMap((f): TestRef[] => { const p = rel(f.path), found = map.tests.find((t) => t.path === p && (!f.runner || t.runner === f.runner)); if (found) return [found]; const runner = f.runner ?? guessRunner(basename(p), map.runners, p); return runner && (runner !== "bun" || map.runners.includes("bun") || /[._](?:test|spec)\.[cm]?[jt]sx?$/.test(p)) ? [{ runner, path: p }] : []; }); // the same Wall resolution verify uses
    const red = redOnBase(repoDir), api = loadProjectApi(repoDir), seen = new Set<string>();
    const refs = [...wall.map((t) => [t, true] as const), ...map.tests.filter((t) => impacted.has(t.path)).map((t) => [t, false] as const)].filter(([t]) => existsSync(join(repoDir, t.path)) && !seen.has(`${t.runner}:${t.path}`) && seen.add(`${t.runner}:${t.path}`) && !red.some((id) => id.includes(t.path)));
    const checks = refs.flatMap(([t, protect]) => { const c = commandFor(t, repoDir, api); return c.interpreter === "system" ? [] : [{ cwd: c.cwd, cmd: c.cmd, args: c.args, ...(protect ? { protect } : {}) }]; }).slice(0, STOP_CHECK_MAX); // a system-interpreter result proves nothing (verify: not_run)
    return checks.length ? { stopChecks: { checks, rounds: STOP_CHECK_ROUNDS, budgetS: Math.min(STOP_CHECK_BUDGET_S, Math.floor(stageLimitS / 4)), repoDir, baseSha, installCreated: outputs?.intake?.install_created } } : {};
  } catch { return {}; }
}

export function parseStopChecks(raw: string | undefined): StopChecksSpec | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StopChecksSpec;
    if (!Array.isArray(v.checks) || !v.checks.length || !(v.rounds > 0) || !(v.budgetS > 0) || typeof v.repoDir !== "string" || typeof v.baseSha !== "string") return null;
    if (!v.checks.every((c) => typeof c.cwd === "string" && typeof c.cmd === "string" && Array.isArray(c.args))) return null;
    return v;
  } catch { return null; }
}

const STOP_CHECK_TIMEOUT_MS = 60_000, STOP_FEEDBACK_CHARS = 3000;
/** A Stop hook that runs the spec's checks with verify's own runner (plain env, process-group kill on abort and on close) and classifier. Only a classified failure that is not a harness load error blocks the stop; a missing tool, a timeout, a not_run, a harness failure or an abort allows it, so behaviour is unchanged. The clock starts at each Stop call, never at session start. Verify, the Wall and Seal still judge afterwards. */
export function createStopChecksHook(spec: StopChecksSpec): (input: unknown, toolUseId?: unknown, opts?: { signal?: AbortSignal }) => Promise<Record<string, unknown>> {
  let used = 0; // runOnce is loaded lazily: verify.ts pulls the engine10 graph, which must not load with providers.ts
  return async (_input, _id, opts) => {
    if (used >= spec.rounds) return {};
    const { runOnce } = await import("../engine10/stages/verify.ts"), deadline = Date.now() + spec.budgetS * 1000, signal = opts?.signal ?? new AbortController().signal, failures: string[] = [];
    for (const c of spec.checks) {
      const left = deadline - Date.now();
      if (left < 1000 || signal.aborted) break;
      const a = await runOnce(c.cmd, c.args, c.cwd, signal, { timeoutMs: Math.min(STOP_CHECK_TIMEOUT_MS, left), group: true });
      if (a.ok || a.missing || a.cut) continue;
      const last = c.args[c.args.length - 1] ?? "", cl = classifyCheck({ kind: "test", ok: a.ok, cut: a.cut, missing: a.missing, out: a.out, ...goRunner(c.cmd, c.args), path: /\.[cm]?[jt]s$/.test(last) ? last : undefined });
      if (cl.result !== "fail") continue;
      if (await harnessLoadReason({ repoDir: spec.repoDir, baseSha: spec.baseSha, skip: installOwned(spec.repoDir, spec.installCreated), out: a.out, cmd: c.cmd, args: c.args, signal, cwd: c.cwd, protect: c.protect })) continue;
      failures.push(`$ ${[c.cmd, ...c.args].join(" ")}\n${a.out.trim().slice(-STOP_FEEDBACK_CHARS)}`);
    }
    if (!failures.length) return {};
    used++;
    return { decision: "block", reason: `The repo checks still fail (fix round ${used} of ${spec.rounds}). Fix the code. Do not edit the read-only Wall test files; if another existing test asserts old behaviour that this task changes, you may update that assertion.\n\n${failures.join("\n\n")}`.slice(0, STOP_FEEDBACK_CHARS * 2) };
  };
}
