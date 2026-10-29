// TEN-UX-03: the one TS bridge to the first-run funnel in autonomy/telemetry.sh.
// Detached and best-effort; every opt-out is enforced by the bash side. Only
// bounded enums cross: never a path, a brief or an error text.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";
import { tokenFreeEnv } from "./safe_git.ts";

export type FunnelKind = "first_run_blocked" | "build_verified";

export function emitFunnel(kind: FunnelKind, key: string): void {
  try {
    const script = resolve(REPO_ROOT, "autonomy", "telemetry.sh");
    if (!existsSync(script)) return;
    const fn = kind === "first_run_blocked" ? 'loki_emit_first_run_blocked "$2"' : 'loki_emit_build_verified_enum VERIFIED "$2"';
    const child = spawn("bash", ["-c", `source "$1" >/dev/null 2>&1 && ${fn} >/dev/null 2>&1`, "_", script, key], {
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

/** Called once after a run-route command returns. A noted refusal class is sent for any nonzero exit; exit 2 with none noted is "other"; exit 0 is VERIFIED or ALREADY_SATISFIED. */
export async function funnelAfterRun(code: number, _cwd: string): Promise<void> {
  const b = takeRefusal();
  if (code === 0) emitFunnel("build_verified", "engine10");
  else if (b || code === 2) emitFunnel("first_run_blocked", b ?? "other");
}
