// TEN-UX-03: the one TS bridge to the first-run funnel in autonomy/telemetry.sh.
// Detached and best-effort; every opt-out is enforced by the bash side. Only
// bounded enums cross: never a path, a brief or an error text.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";
import { safeGitRun } from "./safe_git.ts";

export type FunnelKind = "first_run_blocked" | "build_verified";

export function emitFunnel(kind: FunnelKind, key: string): void {
  try {
    const script = resolve(REPO_ROOT, "autonomy", "telemetry.sh");
    if (!existsSync(script)) return;
    const fn = kind === "first_run_blocked" ? 'loki_emit_first_run_blocked "$2"' : 'loki_emit_build_verified_enum VERIFIED "$2"';
    const child = spawn("bash", ["-c", `source "$1" >/dev/null 2>&1 && ${fn} >/dev/null 2>&1`, "_", script, key], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // telemetry is best-effort
  }
}

/** Bounded class of an engine10 preflight refusal, probed from the folder (never from the message text). */
export async function classifyPreflightBlocker(cwd: string): Promise<string> {
  const env = { ...process.env } as Record<string, string>;
  const git = (a: string[]) => safeGitRun(cwd, a, { env, timeoutMs: 5000 });
  try {
    const wt = await git(["rev-parse", "--is-inside-work-tree"]);
    if (wt.exitCode !== 0 || wt.stdout.trim() !== "true") return "not_a_repo";
    const [n, e] = await Promise.all([git(["config", "user.name"]), git(["config", "user.email"])]);
    if (!n.stdout.trim() || !e.stdout.trim()) return "git_identity";
  } catch {
    // fall through to the coarse bucket
  }
  return "other";
}

/** Called once after a run-route command returns: exit 2 is a preflight refusal, exit 0 is VERIFIED or ALREADY_SATISFIED. */
export async function funnelAfterRun(code: number, cwd: string): Promise<void> {
  if (code === 2) emitFunnel("first_run_blocked", await classifyPreflightBlocker(cwd));
  else if (code === 0) emitFunnel("build_verified", "engine10");
}
