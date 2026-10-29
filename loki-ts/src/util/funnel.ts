// TEN-UX-03: the one TS bridge to the first-run funnel in autonomy/telemetry.sh.
// Detached and best-effort; every opt-out is enforced by the bash side. Only
// bounded enums cross: never a path, a brief or an error text.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, lokiDirFor } from "./paths.ts";
import { tokenFreeEnv } from "./safe_git.ts";

export type FunnelKind = "first_run_blocked" | "build_verified" | "run_started" | "run_finished";

export function emitFunnel(kind: FunnelKind, key: string, extra: readonly string[] = []): void {
  try {
    const script = resolve(REPO_ROOT, "autonomy", "telemetry.sh");
    if (!existsSync(script)) return;
    const fn = kind === "first_run_blocked" ? 'loki_emit_first_run_blocked "$2"' : kind === "run_started" ? "loki_emit_run_started" : kind === "run_finished" ? 'loki_emit_run_finished "$2" "${@:3}"' : 'loki_emit_build_verified_enum VERIFIED "$2"';
    const child = spawn("bash", ["-c", `source "$1" >/dev/null 2>&1 && ${fn} >/dev/null 2>&1`, "_", script, key, ...extra], {
      detached: true,
      stdio: "ignore",
      env: tokenFreeEnv(process.env),
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // telemetry is best-effort
  }
}

/** The fixed enum of refusal classes; the value is chosen by the check that refused, never probed from the folder or parsed from message text. */
export const PREFLIGHT_BLOCKERS = ["not_a_repo", "git_identity", "dirty_tracked_tree", "no_provider", "not_logged_in", "prd_missing", "unsupported_flag", "disk", "other"] as const;
export type PreflightBlocker = (typeof PREFLIGHT_BLOCKERS)[number];
/** Narrows an untrusted value (an event field) to the enum, or null. */
export function blockerOf(v: unknown): PreflightBlocker | null { return typeof v === "string" && (PREFLIGHT_BLOCKERS as readonly string[]).includes(v) ? (v as PreflightBlocker) : null; }

let refusal: PreflightBlocker | null = null;
/** Called by the refusing check right before it returns nonzero. */
export function noteRefusal(b: PreflightBlocker | null): void { if (b) refusal = b; }
/** Reads and clears the noted class. */
export function takeRefusal(): PreflightBlocker | null { const b = refusal; refusal = null; return b; }
/** A refusal that happened inside the run (the intake stage) is in the event log: note its class from the failed intake event. */
export function noteRefusalFromEvents(events: readonly { type: string; stage?: string | null; data: Record<string, unknown> }[]): void {
  noteRefusal(blockerOf(events.find((e) => e.type === "stage.failed" && e.stage === "intake")?.data["blocker"]));
}

const RUN_VERDICTS = ["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"] as const;
const RUN_STAGES = ["intake", "plan", "wall", "implement", "verify", "fix", "commit", "seal", "pr", "deep"] as const;
const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : null);

/** AN-05: the run_finished pairs. Reads the run's receipt.json ONLY through this allowlist (verdict, time, fix_rounds count, exit code); no other receipt key is read, so a path or text in the receipt cannot reach the payload. No fresh receipt (none, or one older than this run) is INTERRUPTED, or BLOCKED on the engine's own blocked exit code 4. */
export function runFinishedArgs(code: number, cwd: string, startedMs?: number): string[] {
  let verdict: string = code === 4 ? "BLOCKED" : "INTERRUPTED";
  const pairs: string[] = [];
  try {
    const root = join(lokiDirFor(cwd), "runs");
    const id = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().pop() ?? null : null; // run ids embed a sortable UTC timestamp
    const file = id ? join(root, id, "receipt.json") : null;
    if (file && existsSync(file) && (startedMs === undefined || statSync(file).mtimeMs >= startedMs)) {
      const r = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if ((RUN_VERDICTS as readonly unknown[]).includes(r["verdict"])) {
        verdict = r["verdict"] as string;
        const time = (r["time"] ?? {}) as Record<string, unknown>;
        const dur = nonNeg(time["total_s"]) ?? nonNeg(time["wall_s"]);
        if (dur !== null) pairs.push(`duration_s=${dur}`);
        const stages = (time["stages"] ?? {}) as Record<string, unknown>;
        for (const st of RUN_STAGES) { const v = nonNeg(stages[st]); if (v !== null) pairs.push(`stage_s_${st}=${v}`); }
        const fr = ((r["cost"] ?? {}) as Record<string, unknown>)["fix_rounds"];
        if (Array.isArray(fr)) pairs.push(`fix_rounds=${fr.length}`);
      }
    }
  } catch {
    // unreadable receipt: the verdict stays INTERRUPTED/BLOCKED
  }
  return [verdict, ...pairs, `exit_code=${Math.max(0, Math.min(255, Math.trunc(code)))}`];
}

/** Called once after a run-route command returns. Every run (not --dry-run) reports run_started and run_finished (AN-05); a noted refusal class is sent for any nonzero exit; exit 2 with none noted is "other"; exit 0 is a build_verified. */
export async function funnelAfterRun(code: number, cwd: string, startedMs?: number, args: readonly string[] = []): Promise<void> {
  const b = takeRefusal();
  if (!args.includes("--dry-run")) {
    const [verdict, ...rest] = runFinishedArgs(code, cwd, startedMs);
    emitFunnel("run_started", "engine10");
    emitFunnel("run_finished", verdict!, rest);
  }
  if (code === 0) emitFunnel("build_verified", "engine10");
  else if (b || code === 2) emitFunnel("first_run_blocked", b ?? "other");
}
